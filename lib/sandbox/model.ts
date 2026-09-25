/**
 * Production sandbox & configuration change approval — pure domain core.
 * ---------------------------------------------------------------------------
 * Dependency-free (no DB, no `server-only`, no process.env) so the rules that
 * decide what may be copied, what a change looks like, and whether a change may
 * be promoted are unit-testable in isolation. The server store/service layer
 * (store.ts / service.ts) wires these into the tenant-scoped database, the
 * approval engine and the tenant settings config layer.
 *
 * The invariants this file owns:
 *
 *   1. PRODUCTION ISOLATION — a sandbox environment carries its own connection
 *      set that must be distinct from production. `assertSandboxIsolation`
 *      fails closed if a sandbox is ever pointed at the production connection.
 *
 *   2. SECRET REDACTION — a production→sandbox copy must never carry a secret
 *      plaintext across. `sanitizeConfigMap` masks every secret-bearing key,
 *      and `assertSanitized` is the fail-closed check the copy path asserts.
 *
 *   3. PROMOTION GATE — a configuration change may only reach production when it
 *      is approved, the approval is not stale (production has not drifted since
 *      approval), and it has not already been promoted. `evaluatePromotion`
 *      is the single pure decision every promote path routes through.
 */

import { isKnownSecret } from "@/lib/secrets/inventory"

// ---------------------------------------------------------------------------
// Enterprise gating
// ---------------------------------------------------------------------------

/**
 * Only enterprise tenants get a separate sandbox environment. The tenant
 * directory stamps `tenant_type`; anything else is denied the subsystem.
 */
export function isEnterpriseTenant(tenantType: string | null | undefined): boolean {
  return String(tenantType ?? "").toUpperCase() === "ENTERPRISE"
}

// ---------------------------------------------------------------------------
// Status vocabularies
// ---------------------------------------------------------------------------

export const CHANGE_STATUSES = [
  "draft",
  "pending_approval",
  "approved",
  "rejected",
  "promoted",
  "rolled_back",
  "cancelled",
] as const
export type ChangeStatus = (typeof CHANGE_STATUSES)[number]

export const DEPLOY_STATUSES = ["not_deployed", "deploying", "deployed", "failed", "rolled_back"] as const
export type DeployStatus = (typeof DEPLOY_STATUSES)[number]

export const SANDBOX_STATUSES = ["inactive", "active"] as const
export type SandboxStatus = (typeof SANDBOX_STATUSES)[number]

export function toChangeStatus(value: unknown): ChangeStatus {
  return (CHANGE_STATUSES as readonly string[]).includes(String(value)) ? (value as ChangeStatus) : "draft"
}

export function toDeployStatus(value: unknown): DeployStatus {
  return (DEPLOY_STATUSES as readonly string[]).includes(String(value)) ? (value as DeployStatus) : "not_deployed"
}

// ---------------------------------------------------------------------------
// Config maps, diffs and secret redaction
// ---------------------------------------------------------------------------

export type ConfigMap = Record<string, string>

export type DiffOp = "add" | "update" | "remove"

export type ConfigDiffEntry = {
  key: string
  op: DiffOp
  /** Redacted where the key is secret-bearing. */
  before: string | null
  after: string | null
  secret: boolean
}

/** The fixed mask used anywhere a secret value would otherwise be shown. */
export const REDACTED = "••••••••"

/**
 * A key is secret-bearing when the secret inventory knows it, or when its name
 * matches the conventional secret/credential naming heuristics. The heuristic
 * is deliberately broad (fail closed): a false positive only over-redacts,
 * while a miss would leak a credential into a sandbox copy or a stored diff.
 */
export function isSecretKey(key: string): boolean {
  if (isKnownSecret(key)) return true
  return /(secret|password|passwd|token|api[_-]?key|apikey|private[_-]?key|credential|client[_-]?secret|access[_-]?key|auth[_-]?key|signing[_-]?key)/i.test(
    key,
  )
}

/** Redact a single value when its key is secret-bearing and a value exists. */
export function redactValue(key: string, value: string | null): string | null {
  if (value == null || value === "") return value
  return isSecretKey(key) ? REDACTED : value
}

/**
 * Produce a sanitized copy of a production config map suitable for a sandbox:
 * every secret-bearing key is replaced with the fixed mask, non-secret values
 * pass through unchanged. This is the ONLY projection allowed to move config
 * from production into a sandbox.
 */
export function sanitizeConfigMap(map: ConfigMap): ConfigMap {
  const out: ConfigMap = {}
  for (const [key, value] of Object.entries(map)) {
    out[key] = isSecretKey(key) && value !== "" ? REDACTED : value
  }
  return out
}

/**
 * Fail-closed invariant asserted by the copy path: no secret-bearing key in a
 * sandbox map may hold anything but the fixed mask. Throws on any leak.
 */
export function assertSanitized(map: ConfigMap): true {
  for (const [key, value] of Object.entries(map)) {
    if (isSecretKey(key) && value !== "" && value !== REDACTED) {
      throw new Error(`Secret "${key}" leaked a plaintext value into the sandbox copy`)
    }
  }
  return true
}

/**
 * Compute the ordered set of changes between a production baseline and the
 * proposed configuration. Secret values are redacted in the returned diff so
 * the stored/displayed diff never carries a plaintext credential, while the
 * `secret` flag still tells the reviewer a secret is changing.
 */
export function diffConfig(base: ConfigMap, proposed: ConfigMap): ConfigDiffEntry[] {
  const keys = Array.from(new Set([...Object.keys(base), ...Object.keys(proposed)])).sort()
  const entries: ConfigDiffEntry[] = []
  for (const key of keys) {
    const hasBase = Object.prototype.hasOwnProperty.call(base, key)
    const hasProposed = Object.prototype.hasOwnProperty.call(proposed, key)
    const beforeRaw = hasBase ? base[key] : null
    const afterRaw = hasProposed ? proposed[key] : null
    if (beforeRaw === afterRaw) continue
    const op: DiffOp = !hasBase || beforeRaw == null || beforeRaw === "" ? "add" : !hasProposed || afterRaw == null || afterRaw === "" ? "remove" : "update"
    entries.push({
      key,
      op,
      before: redactValue(key, beforeRaw),
      after: redactValue(key, afterRaw),
      secret: isSecretKey(key),
    })
  }
  return entries
}

/** The keys a change touches, derived from its (unredacted) proposed values. */
export function changedKeys(base: ConfigMap, proposed: ConfigMap): string[] {
  return diffConfig(base, proposed).map((e) => e.key)
}

// ---------------------------------------------------------------------------
// Baseline hashing + staleness
// ---------------------------------------------------------------------------

/**
 * A deterministic, order-independent fingerprint of the production values for a
 * specific set of keys. Two production states with the same values for those
 * keys hash identically; any drift changes the hash. Uses a small non-crypto
 * rolling hash — this is a change-detection fingerprint, not a security token.
 */
export function baselineHash(map: ConfigMap, keys: string[]): string {
  const canonical = keys
    .slice()
    .sort()
    .map((k) => `${k}=${Object.prototype.hasOwnProperty.call(map, k) ? map[k] : "\u0000"}`)
    .join("\n")
  let h1 = 0x811c9dc5
  let h2 = 0x1000193
  for (let i = 0; i < canonical.length; i++) {
    const c = canonical.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0
    h2 = Math.imul(h2 + c + 1, 0x85ebca6b) >>> 0
  }
  return `${h1.toString(16).padStart(8, "0")}${h2.toString(16).padStart(8, "0")}`
}

/**
 * An approval is stale when the production values for the change's keys have
 * drifted since the approval was captured. Promoting a stale approval would
 * silently overwrite intervening production changes, so it is denied.
 */
export function isApprovalStale(approvedBaselineHash: string | null, currentProductionHash: string): boolean {
  if (!approvedBaselineHash) return true
  return approvedBaselineHash !== currentProductionHash
}

// ---------------------------------------------------------------------------
// Production isolation
// ---------------------------------------------------------------------------

export type SandboxConnection = {
  schema: string | null
  connectionRef: string | null
}

/**
 * A sandbox must never share the production connection set. At least one of the
 * connection ref / schema must differ so sandbox reads and writes can never
 * land on production data. Fails closed when they are identical.
 */
export function assertSandboxIsolation(production: SandboxConnection, sandbox: SandboxConnection): true {
  const sameRef = (production.connectionRef ?? "") === (sandbox.connectionRef ?? "")
  const sameSchema = (production.schema ?? "") === (sandbox.schema ?? "")
  if (sameRef && sameSchema) {
    throw new Error("Sandbox connection set must differ from production (production isolation)")
  }
  return true
}

export function isSandboxIsolated(production: SandboxConnection, sandbox: SandboxConnection): boolean {
  try {
    return assertSandboxIsolation(production, sandbox)
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Promotion gate
// ---------------------------------------------------------------------------

export type PromotionInput = {
  changeStatus: ChangeStatus
  /** Status of the linked approval engine request. */
  approvalStatus: "pending" | "approved" | "rejected" | "cancelled" | "auto_approved" | null
  approvedBaselineHash: string | null
  currentProductionHash: string
  /** Whether the sandbox connection set is isolated from production. */
  isolated: boolean
}

export type PromotionDecision =
  | { ok: true }
  | { ok: false; code: "NOT_APPROVED" | "STALE_APPROVAL" | "ALREADY_PROMOTED" | "NOT_ISOLATED"; reason: string }

/**
 * The single pure gate every promotion routes through. Denies promotion unless
 * the change is approved, isolated from production, not already promoted, and
 * the approval is still fresh against current production state.
 */
export function evaluatePromotion(input: PromotionInput): PromotionDecision {
  if (input.changeStatus === "promoted") {
    return { ok: false, code: "ALREADY_PROMOTED", reason: "This change has already been promoted to production." }
  }
  if (!input.isolated) {
    return { ok: false, code: "NOT_ISOLATED", reason: "Sandbox is not isolated from production." }
  }
  const approved = input.changeStatus === "approved" && (input.approvalStatus === "approved" || input.approvalStatus === "auto_approved")
  if (!approved) {
    return { ok: false, code: "NOT_APPROVED", reason: "Change must be approved before it can be promoted." }
  }
  if (isApprovalStale(input.approvedBaselineHash, input.currentProductionHash)) {
    return {
      ok: false,
      code: "STALE_APPROVAL",
      reason: "Production configuration changed after approval. Re-review is required before promotion.",
    }
  }
  return { ok: true }
}
