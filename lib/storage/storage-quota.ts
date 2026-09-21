import "server-only"
import { query } from "@/lib/db"
import { currentTenantId, scopedWhere, tenantInsert, tenantUpdate } from "@/lib/tenant-scope"
import { getTenantEntitlements } from "@/lib/platform/entitlement-guard"
import { isUnlimited, type Quota } from "@/lib/platform/entitlements"
import { getStorageUsage } from "./file-metadata"
import { BYTES_PER_GB, bytesToGb, formatBytes, gbToBytes } from "./format"

export { BYTES_PER_GB, bytesToGb, formatBytes, gbToBytes } from "./format"

/**
 * SPEC 35 — Tenant storage quotas.
 * ---------------------------------------------------------------------------
 * A tenant's stored bytes are governed by a QUOTA that has to reconcile three
 * concerns the rest of the app already models separately, without duplicating
 * any of them:
 *
 *   • PLAN quota   — the `storage_gb` entitlement of the tenant's subscription
 *                    plan (SPEC 17). `null` there means unlimited. This is the
 *                    default ceiling and it moves automatically when a tenant
 *                    upgrades/downgrades.
 *   • CUSTOM quota — a per-tenant override an operator can set (e.g. a
 *                    negotiated add-on) that supersedes the plan number for that
 *                    tenant only. `null` = "inherit the plan".
 *   • Usage        — the live footprint from the SPEC 32 `file_objects` model
 *                    (`getStorageUsage`), which this module also breaks down
 *                    PER MODULE for the dashboard.
 *
 * On top of that sit a WARNING THRESHOLD (percent at which the tenant is warned
 * before hitting the wall) and a HARD LIMIT flag (whether crossing the ceiling
 * actually blocks new uploads or is merely reported). The module is split into
 * a pure layer (resolution, status, the upload gate — unit-tested without a DB)
 * and a DB-backed layer (settings persistence, usage, the dashboard). Every
 * DB path is tenant-scoped through the SPEC 2 helpers.
 */

const TABLE = "storage_quota_settings"

/** Default percent-of-quota at which a tenant is warned. */
export const DEFAULT_WARN_THRESHOLD = 80

// ---------------------------------------------------------------------------
// Phase 1 — the quota MODEL (pure, DB-free, unit-testable)
// ---------------------------------------------------------------------------

/** Where a tenant's effective quota came from. */
export type QuotaSource = "custom" | "plan"

/** A tenant's quota configuration knobs. */
export type QuotaSettings = {
  /** Per-tenant override in bytes; null = inherit the plan quota. */
  customQuotaBytes: number | null
  /** Percent (1–100) of the quota at which the tenant is warned. */
  warnThresholdPercent: number
  /** When true, exceeding the quota BLOCKS new uploads; when false it only warns. */
  hardLimit: boolean
  /** Master switch: when false the quota is tracked/reported but never blocks. */
  enforced: boolean
}

/** The safe default configuration for a tenant with no stored settings. */
export const DEFAULT_QUOTA_SETTINGS: QuotaSettings = {
  customQuotaBytes: null,
  warnThresholdPercent: DEFAULT_WARN_THRESHOLD,
  hardLimit: false,
  enforced: true,
}

export type QuotaStatus = "ok" | "warning" | "over" | "unlimited"

/** Clamp an arbitrary warning threshold into a sane 1–100 percent. */
export function normalizeWarnThreshold(value: unknown): number {
  if (value == null || value === "") return DEFAULT_WARN_THRESHOLD
  const n = Number(value)
  if (!Number.isFinite(n)) return DEFAULT_WARN_THRESHOLD
  return Math.min(100, Math.max(1, Math.round(n)))
}

/**
 * Resolve the EFFECTIVE quota from the plan number and the custom override.
 * A custom override always wins (including an explicit unlimited); otherwise the
 * plan quota applies. `null` (either side) means unlimited. Returned bytes are
 * `null` when unlimited.
 */
export function resolveEffectiveQuota(
  planQuotaGb: Quota,
  customQuotaBytes: number | null,
): { quotaBytes: number | null; source: QuotaSource } {
  if (customQuotaBytes != null) {
    return { quotaBytes: Math.max(0, Math.floor(customQuotaBytes)), source: "custom" }
  }
  if (isUnlimited(planQuotaGb)) return { quotaBytes: null, source: "plan" }
  return { quotaBytes: gbToBytes(planQuotaGb as number), source: "plan" }
}

/** Percent of quota consumed, or null when unlimited / undefined quota. */
export function usagePercent(usedBytes: number, quotaBytes: number | null): number | null {
  if (quotaBytes == null || quotaBytes <= 0) return null
  return (Math.max(0, usedBytes) / quotaBytes) * 100
}

/** Classify current usage against the quota + warning threshold. Pure. */
export function computeQuotaStatus(
  usedBytes: number,
  quotaBytes: number | null,
  warnThresholdPercent: number,
): QuotaStatus {
  if (quotaBytes == null) return "unlimited"
  if (usedBytes >= quotaBytes) return "over"
  const pct = usagePercent(usedBytes, quotaBytes)
  if (pct != null && pct >= warnThresholdPercent) return "warning"
  return "ok"
}

export type QuotaDecision = {
  /** Whether the incoming upload is permitted. */
  allowed: boolean
  /** Whether the incoming bytes would take the tenant over the quota. */
  wouldExceed: boolean
  /** Bytes already stored. */
  usedBytes: number
  /** Projected bytes after this upload. */
  projectedBytes: number
  /** Effective quota (null = unlimited). */
  quotaBytes: number | null
  /** Bytes still available (null = unlimited). */
  remainingBytes: number | null
  /** Status the tenant is/would be in after the upload. */
  status: QuotaStatus
  /** A user-facing explanation. */
  reason: string
}

/**
 * The core upload gate. Pure and total: given current usage, the incoming size,
 * the effective quota and the settings, decide whether the upload may proceed.
 *
 * Blocking only happens when the quota is FINITE, the tenant is over it after
 * this upload, enforcement is on AND the hard-limit flag is set. In every other
 * case the upload is allowed but the returned `status`/`wouldExceed` let callers
 * surface a warning. This mirrors the soft-vs-hard convention used by the usage
 * metering limits (SPEC 19).
 */
export function decideUpload(
  usedBytes: number,
  incomingBytes: number,
  quotaBytes: number | null,
  settings: Pick<QuotaSettings, "warnThresholdPercent" | "hardLimit" | "enforced">,
): QuotaDecision {
  const used = Math.max(0, Math.floor(usedBytes))
  const incoming = Math.max(0, Math.floor(incomingBytes))
  const projected = used + incoming

  if (quotaBytes == null) {
    return {
      allowed: true,
      wouldExceed: false,
      usedBytes: used,
      projectedBytes: projected,
      quotaBytes: null,
      remainingBytes: null,
      status: "unlimited",
      reason: "Unlimited storage",
    }
  }

  const remaining = Math.max(0, quotaBytes - used)
  const wouldExceed = projected > quotaBytes
  const status = computeQuotaStatus(projected, quotaBytes, settings.warnThresholdPercent)
  const block = wouldExceed && settings.enforced && settings.hardLimit

  return {
    allowed: !block,
    wouldExceed,
    usedBytes: used,
    projectedBytes: projected,
    quotaBytes,
    remainingBytes: remaining,
    status,
    reason: block
      ? `Storage quota exceeded: this upload needs ${formatBytes(incoming)} but only ${formatBytes(remaining)} of ${formatBytes(quotaBytes)} remains.`
      : wouldExceed
        ? "Upload allowed but storage quota is exceeded."
        : status === "warning"
          ? "Upload allowed; storage is nearing its quota."
          : "Within quota",
  }
}

// ---------------------------------------------------------------------------
// Phase 2/3 — settings persistence (self-healing schema, tenant-scoped)
// ---------------------------------------------------------------------------

let schemaEnsured = false

export async function ensureStorageQuotaSchema(): Promise<void> {
  if (schemaEnsured) return
  await query(
    `CREATE TABLE IF NOT EXISTS ${TABLE} (
      id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      tenant_id BIGINT NOT NULL,
      custom_quota_bytes BIGINT DEFAULT NULL,
      warn_threshold_percent TINYINT UNSIGNED NOT NULL DEFAULT ${DEFAULT_WARN_THRESHOLD},
      hard_limit TINYINT(1) NOT NULL DEFAULT 0,
      enforced TINYINT(1) NOT NULL DEFAULT 1,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_sqs_tenant (tenant_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  )
  schemaEnsured = true
}

type QuotaSettingsRow = {
  custom_quota_bytes: string | number | null
  warn_threshold_percent: number
  hard_limit: number
  enforced: number
}

/** Read the current tenant's quota settings (defaults when none stored). */
export async function getQuotaSettings(): Promise<QuotaSettings> {
  await ensureStorageQuotaSchema()
  const { where, params } = scopedWhere(TABLE, "", [])
  const rows = await query<QuotaSettingsRow[]>(
    `SELECT custom_quota_bytes, warn_threshold_percent, hard_limit, enforced FROM ${TABLE} ${where} LIMIT 1`,
    params,
  )
  const row = rows[0]
  if (!row) return { ...DEFAULT_QUOTA_SETTINGS }
  return {
    customQuotaBytes: row.custom_quota_bytes == null ? null : Number(row.custom_quota_bytes),
    warnThresholdPercent: normalizeWarnThreshold(row.warn_threshold_percent),
    hardLimit: Number(row.hard_limit) === 1,
    enforced: Number(row.enforced) === 1,
  }
}

export type QuotaSettingsInput = {
  /** Override in bytes; null clears the override (inherit plan). Omit to leave unchanged. */
  customQuotaBytes?: number | null
  /** Convenience: set the override in GB instead of bytes. */
  customQuotaGb?: number | null
  warnThresholdPercent?: number
  hardLimit?: boolean
  enforced?: boolean
}

/** Create or update the current tenant's quota settings (upsert). */
export async function setQuotaSettings(input: QuotaSettingsInput): Promise<QuotaSettings> {
  await ensureStorageQuotaSchema()
  const current = await getQuotaSettings()

  let customQuotaBytes = current.customQuotaBytes
  if (input.customQuotaBytes !== undefined) {
    customQuotaBytes = input.customQuotaBytes == null ? null : Math.max(0, Math.floor(input.customQuotaBytes))
  } else if (input.customQuotaGb !== undefined) {
    customQuotaBytes = input.customQuotaGb == null ? null : gbToBytes(input.customQuotaGb)
  }

  const next: QuotaSettings = {
    customQuotaBytes,
    warnThresholdPercent:
      input.warnThresholdPercent !== undefined
        ? normalizeWarnThreshold(input.warnThresholdPercent)
        : current.warnThresholdPercent,
    hardLimit: input.hardLimit !== undefined ? input.hardLimit : current.hardLimit,
    enforced: input.enforced !== undefined ? input.enforced : current.enforced,
  }

  const { where, params } = scopedWhere(TABLE, "", [])
  const existing = await query<{ id: number }[]>(`SELECT id FROM ${TABLE} ${where} LIMIT 1`, params)
  const values = {
    custom_quota_bytes: next.customQuotaBytes,
    warn_threshold_percent: next.warnThresholdPercent,
    hard_limit: next.hardLimit ? 1 : 0,
    enforced: next.enforced ? 1 : 0,
  }
  if (existing[0]) {
    await tenantUpdate(TABLE, values, "id = ?", [existing[0].id])
  } else {
    await tenantInsert(TABLE, values)
  }
  return next
}

// ---------------------------------------------------------------------------
// Phase 2 — usage calculation (total + per-module)
// ---------------------------------------------------------------------------

export type ModuleUsage = { module: string; files: number; bytes: number }

/**
 * Storage footprint for the current tenant broken down by owning module. Uses
 * the same "live objects only" predicate as `getStorageUsage` so the per-module
 * rows always sum to the reported total.
 */
export async function getStorageUsageByModule(): Promise<ModuleUsage[]> {
  const { where, params } = scopedWhere("file_objects", "upload_status = 'completed' AND is_current = 1", [])
  const rows = await query<{ module: string; files: number | string; bytes: number | string }[]>(
    `SELECT module, COUNT(*) AS files, COALESCE(SUM(size_bytes), 0) AS bytes
       FROM file_objects ${where}
      GROUP BY module
      ORDER BY bytes DESC`,
    params,
  )
  return rows.map((r) => ({
    module: r.module || "misc",
    files: Number(r.files ?? 0),
    bytes: Number(r.bytes ?? 0),
  }))
}

// ---------------------------------------------------------------------------
// Phase 3 — resolution + enforcement
// ---------------------------------------------------------------------------

export type ResolvedQuota = {
  quotaBytes: number | null
  source: QuotaSource
  planQuotaGb: Quota
  settings: QuotaSettings
}

/** Resolve the effective quota for the current tenant (plan ⊕ custom override). */
export async function resolveStorageQuota(): Promise<ResolvedQuota> {
  const tenantId = currentTenantId()
  const [settings, ent] = await Promise.all([getQuotaSettings(), getTenantEntitlements(tenantId)])
  const planQuotaGb = ent.storage_gb
  const { quotaBytes, source } = resolveEffectiveQuota(planQuotaGb, settings.customQuotaBytes)
  return { quotaBytes, source, planQuotaGb, settings }
}

/**
 * Enforcement entry point the upload facade calls before accepting bytes.
 * Resolves the quota + current usage and applies the pure `decideUpload` gate.
 * Never throws for quota reasons — returns a decision the caller turns into a
 * user-facing error. Fails OPEN on unexpected errors so a quota-subsystem
 * outage cannot wedge every upload in the product.
 */
export async function checkStorageQuota(incomingBytes: number): Promise<QuotaDecision> {
  try {
    const [{ quotaBytes, settings }, usage] = await Promise.all([resolveStorageQuota(), getStorageUsage()])
    return decideUpload(usage.bytes, incomingBytes, quotaBytes, settings)
  } catch (err) {
    console.error("[v0] checkStorageQuota failed (allowing upload):", err)
    return {
      allowed: true,
      wouldExceed: false,
      usedBytes: 0,
      projectedBytes: Math.max(0, Math.floor(incomingBytes)),
      quotaBytes: null,
      remainingBytes: null,
      status: "unlimited",
      reason: "Quota check unavailable",
    }
  }
}

// ---------------------------------------------------------------------------
// Phase 4 — dashboard + alerts
// ---------------------------------------------------------------------------

export type QuotaAlertLevel = "warning" | "critical"
export type QuotaAlert = { level: QuotaAlertLevel; message: string }

export type StorageQuotaDashboard = {
  usedBytes: number
  files: number
  quotaBytes: number | null
  source: QuotaSource
  planQuotaGb: Quota
  percent: number | null
  status: QuotaStatus
  remainingBytes: number | null
  settings: QuotaSettings
  perModule: ModuleUsage[]
  alerts: QuotaAlert[]
}

/** Everything a tenant-facing storage-usage dashboard needs in one resolved shot. */
export async function getStorageQuotaDashboard(): Promise<StorageQuotaDashboard> {
  const [{ quotaBytes, source, planQuotaGb, settings }, usage, perModule] = await Promise.all([
    resolveStorageQuota(),
    getStorageUsage(),
    getStorageUsageByModule(),
  ])

  const percent = usagePercent(usage.bytes, quotaBytes)
  const status = computeQuotaStatus(usage.bytes, quotaBytes, settings.warnThresholdPercent)
  const remainingBytes = quotaBytes == null ? null : Math.max(0, quotaBytes - usage.bytes)

  const alerts: QuotaAlert[] = []
  if (status === "over") {
    alerts.push({
      level: "critical",
      message: settings.hardLimit
        ? `Storage quota reached (${formatBytes(usage.bytes)} of ${formatBytes(quotaBytes as number)}). New uploads are blocked.`
        : `Storage quota exceeded (${formatBytes(usage.bytes)} of ${formatBytes(quotaBytes as number)}).`,
    })
  } else if (status === "warning") {
    alerts.push({
      level: "warning",
      message: `Storage is at ${Math.round(percent ?? 0)}% of the ${formatBytes(quotaBytes as number)} quota.`,
    })
  }

  return {
    usedBytes: usage.bytes,
    files: usage.files,
    quotaBytes,
    source,
    planQuotaGb,
    percent,
    status,
    remainingBytes,
    settings,
    perModule,
    alerts,
  }
}
