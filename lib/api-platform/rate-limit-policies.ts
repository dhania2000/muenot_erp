import "server-only"
import { query } from "@/lib/db"
import { recordPlatformAudit } from "@/lib/platform-roles"
import { listApiKeys } from "@/lib/api-keys-store"
import { applyEndpointOverride, type RateLimitTier } from "@/lib/api-platform/rate-limit-engine"
import type { RateBudget } from "@/lib/api-platform/rate-limit-store"

export class RatePolicyError extends Error { constructor(message: string, public status = 400) { super(message) } }
export type RatePolicyInput = { name: string; targetType: "tenant" | "api_key" | "endpoint"; targetValue: string; tier: RateLimitTier; enabled: boolean }
type Row = { id: number; tenant_id: number; name: string; target_type: RatePolicyInput["targetType"]; target_value: string; second_limit: number; minute_limit: number; hour_limit: number; day_limit: number; enabled: number; created_at: string; updated_at: string }
export type RatePolicy = ReturnType<typeof mapRow>
let ensured: Promise<void> | null = null

export function ensureRatePolicySchema(): Promise<void> {
  if (!ensured) ensured = query(`CREATE TABLE IF NOT EXISTS api_rate_limit_policies (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT, tenant_id INT UNSIGNED NOT NULL,
    name VARCHAR(120) NOT NULL, target_type ENUM('tenant','api_key','endpoint') NOT NULL,
    target_value VARCHAR(255) NOT NULL DEFAULT '',
    second_limit INT UNSIGNED NOT NULL, minute_limit INT UNSIGNED NOT NULL,
    hour_limit INT UNSIGNED NOT NULL, day_limit INT UNSIGNED NOT NULL,
    enabled TINYINT(1) NOT NULL DEFAULT 1,
    created_by INT UNSIGNED NULL, updated_by INT UNSIGNED NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id), UNIQUE KEY uq_api_rate_policy_name (tenant_id,name),
    KEY idx_api_rate_policy_match (tenant_id,enabled,target_type,target_value),
    CONSTRAINT fk_api_rate_policy_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
    CONSTRAINT fk_api_rate_policy_creator FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
    CONSTRAINT fk_api_rate_policy_editor FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL,
    CONSTRAINT ck_api_rate_policy_limits CHECK (second_limit>0 AND minute_limit>0 AND hour_limit>0 AND day_limit>0)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`).then(() => {}).catch(error => { ensured = null; throw error })
  return ensured
}

function mapRow(row: Row) { return { id: Number(row.id), tenantId: Number(row.tenant_id), name: row.name, targetType: row.target_type, targetValue: row.target_value, tier: { second: Number(row.second_limit), minute: Number(row.minute_limit), hour: Number(row.hour_limit), day: Number(row.day_limit) }, enabled: Boolean(row.enabled), createdAt: row.created_at, updatedAt: row.updated_at } }
export async function listRatePolicies(tenantId: number): Promise<RatePolicy[]> {
  await ensureRatePolicySchema()
  return (await query<Row[]>("SELECT * FROM api_rate_limit_policies WHERE tenant_id=? ORDER BY id DESC", [tenantId])).map(mapRow)
}
export async function applicableRateBudgets(tenantId: number, keyId: number, path: string, planTier: RateLimitTier): Promise<RateBudget[]> {
  await ensureRatePolicySchema()
  const rows = await query<Row[]>(`SELECT * FROM api_rate_limit_policies WHERE tenant_id=? AND enabled=1
    AND (target_type='tenant' OR (target_type='api_key' AND target_value=?) OR (target_type='endpoint' AND target_value=?))`, [tenantId, String(keyId), path])
  return rows.map(row => ({ scope: `apiv1:policy:${row.id}`, tier: applyEndpointOverride(planTier, mapRow(row).tier) }))
}

export async function validateRatePolicyInput(value: unknown, tenantId: number): Promise<RatePolicyInput> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RatePolicyError("Policy must be an object.")
  const data = value as Record<string, unknown>
  const name = typeof data.name === "string" ? data.name.trim() : ""
  if (!name || name.length > 120) throw new RatePolicyError("Policy name is required (max 120 characters).")
  const targetType = data.targetType
  if (targetType !== "tenant" && targetType !== "api_key" && targetType !== "endpoint") throw new RatePolicyError("Invalid target type.")
  const targetValue = typeof data.targetValue === "string" ? data.targetValue.trim() : ""
  if (targetType === "tenant" && targetValue) throw new RatePolicyError("Tenant policy has no target value.")
  if (targetType === "api_key") {
    const id = Number(targetValue)
    if (!Number.isSafeInteger(id) || id <= 0 || !(await listApiKeys(tenantId)).some(key => key.id === id)) throw new RatePolicyError("API key does not belong to this tenant.")
  }
  if (targetType === "endpoint" && (!/^\/api\/v1\/[a-z0-9/_-]+$/.test(targetValue) || targetValue.length > 255)) throw new RatePolicyError("Endpoint must be an exact /api/v1/ path.")
  const tier = data.tier
  if (!tier || typeof tier !== "object" || Array.isArray(tier)) throw new RatePolicyError("All rate-limit windows are required.")
  const rawTier = tier as Record<string, unknown>
  const limits = {} as RateLimitTier
  for (const key of ["second", "minute", "hour", "day"] as const) {
    const limit = rawTier[key]
    if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit <= 0 || limit > 1_000_000_000) throw new RatePolicyError(`${key} limit must be a positive integer.`)
    limits[key] = limit
  }
  if (typeof data.enabled !== "boolean") throw new RatePolicyError("Enabled must be a boolean.")
  return { name, targetType, targetValue, tier: limits, enabled: data.enabled }
}

function params(input: RatePolicyInput) { return [input.name, input.targetType, input.targetValue, input.tier.second, input.tier.minute, input.tier.hour, input.tier.day, input.enabled ? 1 : 0] }
function duplicate(error: unknown): never { if (error && typeof error === "object" && "code" in error && error.code === "ER_DUP_ENTRY") throw new RatePolicyError("A policy with this name already exists.", 409); throw error }

export async function createRatePolicy(tenantId: number, value: unknown, actorId: number): Promise<RatePolicy> {
  const input = await validateRatePolicyInput(value, tenantId)
  await ensureRatePolicySchema()
  let id: number
  try { const result = await query<{ insertId: number }>(`INSERT INTO api_rate_limit_policies
    (tenant_id,name,target_type,target_value,second_limit,minute_limit,hour_limit,day_limit,enabled,created_by,updated_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`, [tenantId, ...params(input), actorId, actorId]); id = Number(result.insertId) } catch (error) { duplicate(error) }
  await recordPlatformAudit({ actorUserId: actorId, action: "api_rate_policy_created", targetTenantId: tenantId, detail: { policyId: id, targetType: input.targetType } })
  return (await getRatePolicy(tenantId, id))!
}
export async function getRatePolicy(tenantId: number, id: number): Promise<RatePolicy | null> {
  await ensureRatePolicySchema()
  const rows = await query<Row[]>("SELECT * FROM api_rate_limit_policies WHERE tenant_id=? AND id=? LIMIT 1", [tenantId, id])
  return rows[0] ? mapRow(rows[0]) : null
}
export async function updateRatePolicy(tenantId: number, id: number, value: unknown, actorId: number): Promise<RatePolicy> {
  const input = await validateRatePolicyInput(value, tenantId)
  await ensureRatePolicySchema()
  try {
    const result = await query<{ affectedRows: number }>(`UPDATE api_rate_limit_policies SET name=?,target_type=?,target_value=?,second_limit=?,minute_limit=?,hour_limit=?,day_limit=?,enabled=?,updated_by=? WHERE tenant_id=? AND id=?`, [...params(input), actorId, tenantId, id])
    if (!result.affectedRows) throw new RatePolicyError("Policy not found.", 404)
  } catch (error) { duplicate(error) }
  await recordPlatformAudit({ actorUserId: actorId, action: "api_rate_policy_updated", targetTenantId: tenantId, detail: { policyId: id, targetType: input.targetType, enabled: input.enabled } })
  return (await getRatePolicy(tenantId, id))!
}
export async function deleteRatePolicy(tenantId: number, id: number, actorId: number): Promise<void> {
  await ensureRatePolicySchema()
  const result = await query<{ affectedRows: number }>("DELETE FROM api_rate_limit_policies WHERE tenant_id=? AND id=?", [tenantId, id])
  if (!result.affectedRows) throw new RatePolicyError("Policy not found.", 404)
  await recordPlatformAudit({ actorUserId: actorId, action: "api_rate_policy_deleted", targetTenantId: tenantId, detail: { policyId: id } })
}
