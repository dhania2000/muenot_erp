import "server-only"
/**
 * SPEC 40 — Configuration inheritance: server store.
 * ---------------------------------------------------------------------------
 * The only module that touches the database for inherited policies. It loads
 * the raw overrides for a resolution context and defers every precedence /
 * override-legality decision to the pure engine in model.ts. Writes are:
 *
 *   - tenant-scoped (every statement binds tenant_id),
 *   - validated + legality-checked (canOverrideAt / validatePolicyValue),
 *   - authority-gated for governed (critical) fields,
 *   - idempotent (an unchanged write is a no-op that reports `unchanged`),
 *   - audited by the caller (route) with the returned change summary.
 *
 * Global overrides are stored with scope_id = 0 so the (tenant, key, level,
 * scope_id) unique key holds (MySQL treats NULLs as distinct).
 */
import { query, tableColumns } from "@/lib/db"
import {
  RESOLUTION_ORDER,
  SCOPE_LEVELS,
  canOverrideAt,
  isScopeLevel,
  maskResolved,
  resolveInherited,
  validatePolicyValue,
  type InheritResolution,
  type OverrideLayer,
  type ScopeLevel,
} from "./model"
import {
  getPolicyField,
  policyFieldsForDomain,
  type PolicyDomain,
  type PolicyField,
} from "./policies"

const TABLE = "setting_overrides"
const GLOBAL_SCOPE_ID = 0

export class SettingInheritanceError extends Error {
  constructor(
    message: string,
    readonly code: "setup_required" | "invalid" | "forbidden" | "not_found",
    readonly status: number,
  ) {
    super(message)
    this.name = "SettingInheritanceError"
  }
}

async function assertSchema(): Promise<void> {
  const cols = await tableColumns(TABLE)
  for (const c of ["tenant_id", "policy_key", "scope_level", "scope_id", "svalue"]) {
    if (!cols.has(c)) {
      throw new SettingInheritanceError(
        "Configuration inheritance is not set up. Run the SPEC 40 migration.",
        "setup_required",
        503,
      )
    }
  }
}

/**
 * The org scope chain a value is resolved against. Each id is an org-unit id
 * for company/branch/department and a user id for user; omit a level to skip it.
 */
export type PolicyScopeContext = {
  companyId?: number | null
  branchId?: number | null
  departmentId?: number | null
  userId?: number | null
}

function contextPairs(ctx: PolicyScopeContext): { level: ScopeLevel; scopeId: number }[] {
  const pairs: { level: ScopeLevel; scopeId: number }[] = [{ level: "global", scopeId: GLOBAL_SCOPE_ID }]
  if (ctx.companyId != null) pairs.push({ level: "company", scopeId: ctx.companyId })
  if (ctx.branchId != null) pairs.push({ level: "branch", scopeId: ctx.branchId })
  if (ctx.departmentId != null) pairs.push({ level: "department", scopeId: ctx.departmentId })
  if (ctx.userId != null) pairs.push({ level: "user", scopeId: ctx.userId })
  return pairs
}

type OverrideRow = { policy_key: string; scope_level: string; scope_id: number; svalue: string | null }

/** Load the stored overrides that apply to a context for a set of keys. */
async function loadOverrides(
  tenantId: number,
  keys: string[],
  ctx: PolicyScopeContext,
): Promise<Map<string, OverrideLayer[]>> {
  const pairs = contextPairs(ctx)
  const byKey = new Map<string, OverrideLayer[]>()
  if (keys.length === 0) return byKey

  // Build an OR of (scope_level = ? AND scope_id = ?) so only the exact scope
  // ids in the chain are read — never another branch's or user's override.
  const scopeClauses = pairs.map(() => "(scope_level = ? AND scope_id = ?)").join(" OR ")
  const scopeParams = pairs.flatMap((p) => [p.level, p.scopeId])
  const keyPlaceholders = keys.map(() => "?").join(", ")

  const rows = (await query<OverrideRow[]>(
    `SELECT policy_key, scope_level, scope_id, svalue
       FROM \`${TABLE}\`
      WHERE tenant_id = ? AND policy_key IN (${keyPlaceholders}) AND (${scopeClauses})`,
    [tenantId, ...keys, ...scopeParams],
  )) as OverrideRow[]

  for (const r of rows) {
    if (!isScopeLevel(r.scope_level)) continue
    const list = byKey.get(r.policy_key) ?? []
    list.push({ level: r.scope_level, scopeId: Number(r.scope_id) || null, value: r.svalue })
    byKey.set(r.policy_key, list)
  }
  return byKey
}

export type ResolvedPolicyEntry = InheritResolution & { masked: string; secret: boolean; governed: boolean; label: string; domain: PolicyDomain }

/** Resolve every field in a domain for a context, masking secrets. */
export async function resolvePolicyDomain(
  tenantId: number,
  domain: PolicyDomain,
  ctx: PolicyScopeContext,
): Promise<ResolvedPolicyEntry[]> {
  await assertSchema()
  const fields = policyFieldsForDomain(domain)
  const overrides = await loadOverrides(tenantId, fields.map((f) => f.key), ctx)
  return fields.map((field) => {
    const res = resolveInherited(field, overrides.get(field.key) ?? [])
    const masked = maskResolved(field, res)
    return { ...masked, secret: !!field.secret, governed: !!field.governed, label: field.label, domain: field.domain }
  })
}

/** Resolve a single policy key for a context (used by other modules to enforce). */
export async function resolvePolicyKey(
  tenantId: number,
  key: string,
  ctx: PolicyScopeContext,
): Promise<InheritResolution> {
  await assertSchema()
  const field = getPolicyField(key)
  if (!field) throw new SettingInheritanceError(`Unknown policy "${key}".`, "not_found", 404)
  const overrides = await loadOverrides(tenantId, [key], ctx)
  return resolveInherited(field, overrides.get(key) ?? [])
}

export type SetOverrideInput = {
  key: string
  level: ScopeLevel
  scopeId: number | null
  /** null clears the override at this level (falls back to the broader scope). */
  value: string | null
}

export type SetOverrideResult = {
  key: string
  level: ScopeLevel
  scopeId: number
  action: "created" | "updated" | "cleared" | "unchanged"
  previous: string | null
  value: string | null
  governed: boolean
}

/**
 * Create, update or clear a single override, enforcing override legality,
 * value validation and (for governed fields) actor authority. Returns a change
 * summary the route audits. Idempotent: an identical value is `unchanged`.
 */
export async function setPolicyOverride(
  tenantId: number,
  input: SetOverrideInput,
  actor: { userId: number; isAdmin: boolean; hasGovernanceGrant: boolean },
): Promise<SetOverrideResult> {
  await assertSchema()
  const field = getPolicyField(input.key)
  if (!field) throw new SettingInheritanceError(`Unknown policy "${input.key}".`, "not_found", 404)
  if (!isScopeLevel(input.level)) throw new SettingInheritanceError("Unknown scope level.", "invalid", 400)
  if (!canOverrideAt(field, input.level)) {
    throw new SettingInheritanceError(
      `"${field.label}" cannot be overridden at the ${input.level} level.`,
      "invalid",
      400,
    )
  }

  const scopeId = input.level === "global" ? GLOBAL_SCOPE_ID : input.scopeId
  if (input.level !== "global" && (scopeId == null || !Number.isSafeInteger(scopeId) || scopeId <= 0)) {
    throw new SettingInheritanceError(`A scope id is required to override at the ${input.level} level.`, "invalid", 400)
  }

  // Governed (critical) fields require an authorised actor — segregation of duty
  // for master configuration changes.
  if (field.governed && !actor.isAdmin && !actor.hasGovernanceGrant) {
    throw new SettingInheritanceError(
      `"${field.label}" is a governed policy and can only be changed by an authorised administrator.`,
      "forbidden",
      403,
    )
  }

  const existingRows = (await query<{ svalue: string | null }[]>(
    `SELECT svalue FROM \`${TABLE}\` WHERE tenant_id = ? AND policy_key = ? AND scope_level = ? AND scope_id = ? LIMIT 1`,
    [tenantId, field.key, input.level, scopeId],
  )) as { svalue: string | null }[]
  const previous = existingRows[0]?.svalue ?? null

  // Clear.
  if (input.value == null || String(input.value).trim() === "") {
    if (previous == null) {
      return { key: field.key, level: input.level, scopeId: scopeId!, action: "unchanged", previous, value: null, governed: !!field.governed }
    }
    await query(
      `DELETE FROM \`${TABLE}\` WHERE tenant_id = ? AND policy_key = ? AND scope_level = ? AND scope_id = ?`,
      [tenantId, field.key, input.level, scopeId],
    )
    return { key: field.key, level: input.level, scopeId: scopeId!, action: "cleared", previous, value: null, governed: !!field.governed }
  }

  const valid = validatePolicyValue(field, input.value)
  if (!valid.ok) throw new SettingInheritanceError(valid.error, "invalid", 400)

  if (previous === valid.value) {
    return { key: field.key, level: input.level, scopeId: scopeId!, action: "unchanged", previous, value: valid.value, governed: !!field.governed }
  }

  // Upsert (idempotent on the unique key).
  await query(
    `INSERT INTO \`${TABLE}\` (tenant_id, policy_key, scope_level, scope_id, svalue, updated_by)
       VALUES (?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE svalue = VALUES(svalue), updated_by = VALUES(updated_by)`,
    [tenantId, field.key, input.level, scopeId, valid.value, actor.userId],
  )

  return {
    key: field.key,
    level: input.level,
    scopeId: scopeId!,
    action: previous == null ? "created" : "updated",
    previous,
    value: valid.value,
    governed: !!field.governed,
  }
}

/** List raw overrides for a tenant (governance/audit view), newest keys first. */
export async function listOverrides(
  tenantId: number,
  opts: { key?: string } = {},
): Promise<{ key: string; level: ScopeLevel; scopeId: number; value: string | null }[]> {
  await assertSchema()
  const where = ["tenant_id = ?"]
  const args: unknown[] = [tenantId]
  if (opts.key) {
    where.push("policy_key = ?")
    args.push(opts.key)
  }
  const rows = (await query<OverrideRow[]>(
    `SELECT policy_key, scope_level, scope_id, svalue FROM \`${TABLE}\`
      WHERE ${where.join(" AND ")} ORDER BY policy_key, scope_level LIMIT 1000`,
    args,
  )) as OverrideRow[]
  return rows
    .filter((r) => isScopeLevel(r.scope_level))
    .map((r) => {
      const field = getPolicyField(r.policy_key)
      const value = field?.secret ? (r.svalue ? "••••••••" : null) : r.svalue
      return { key: r.policy_key, level: r.scope_level as ScopeLevel, scopeId: Number(r.scope_id), value }
    })
}

export { SCOPE_LEVELS, RESOLUTION_ORDER }
export type { PolicyField }
