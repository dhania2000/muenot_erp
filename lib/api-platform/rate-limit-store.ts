import "server-only"
import { createHash } from "node:crypto"
import type { RowDataPacket } from "mysql2"
import { pool, query } from "@/lib/db"
import type { RateLimitDecision, RateLimitTier, RateWindowKey } from "@/lib/api-platform/rate-limit-engine"

const WINDOWS: { name: RateWindowKey; ms: number }[] = [
  { name: "second", ms: 1000 }, { name: "minute", ms: 60_000 },
  { name: "hour", ms: 3_600_000 }, { name: "day", ms: 86_400_000 },
]
type Counter = { name: RateWindowKey; used: number; resetAt: number }
type CountRow = RowDataPacket & { request_count: number }
type AbuseRow = RowDataPacket & { strikes: number; window_reset_ms: number; blocked_until_ms: number }
export type RateBudget = { scope: string; tier: RateLimitTier }
let ensured: Promise<void> | null = null

export function ensureSharedRateLimitSchema(): Promise<void> {
  if (!ensured) ensured = (async () => {
    await query(`CREATE TABLE IF NOT EXISTS api_rate_limit_counters (
    tenant_id INT UNSIGNED NOT NULL,
    scope_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    window_name VARCHAR(8) NOT NULL, window_start_ms BIGINT UNSIGNED NOT NULL,
    reset_at_ms BIGINT UNSIGNED NOT NULL, request_count INT UNSIGNED NOT NULL DEFAULT 0,
    PRIMARY KEY (tenant_id,scope_hash,window_name,window_start_ms),
    KEY idx_api_rate_counter_expiry (reset_at_ms),
    CONSTRAINT fk_api_rate_counter_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
    await query(`CREATE TABLE IF NOT EXISTS api_rate_limit_abuse (
      tenant_id INT UNSIGNED NOT NULL,
      scope_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      strikes INT UNSIGNED NOT NULL DEFAULT 0,
      window_reset_ms BIGINT UNSIGNED NOT NULL DEFAULT 0,
      blocked_until_ms BIGINT UNSIGNED NOT NULL DEFAULT 0,
      PRIMARY KEY (tenant_id,scope_hash),
      KEY idx_api_rate_abuse_expiry (blocked_until_ms,window_reset_ms),
      CONSTRAINT fk_api_rate_abuse_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
  })().catch(error => { ensured = null; throw error })
  return ensured
}

function digest(scope: string): string { return createHash("sha256").update(scope).digest("hex") }
function headers(tier: RateLimitTier, counts: Counter[], retryAfter: number) {
  const result: Record<string, string> = {}
  for (const { name, used } of counts) {
    const suffix = name[0].toUpperCase() + name.slice(1)
    result[`X-RateLimit-Limit-${suffix}`] = String(tier[name])
    result[`X-RateLimit-Remaining-${suffix}`] = String(Math.max(0, tier[name] - used))
  }
  const minute = counts.find(item => item.name === "minute")!
  result["X-RateLimit-Limit"] = String(tier.minute)
  result["X-RateLimit-Remaining"] = String(Math.max(0, tier.minute - minute.used))
  result["X-RateLimit-Reset"] = String(Math.ceil(minute.resetAt / 1000))
  if (retryAfter) result["Retry-After"] = String(retryAfter)
  return result
}

/** All four windows are locked and consumed in one transaction. A rejection consumes none. */
export async function enforceSharedRateLimits(tenantId: number, budgets: RateBudget[]): Promise<RateLimitDecision> {
  if (!Number.isSafeInteger(tenantId) || tenantId <= 0) throw new Error("Tenant is required for API rate limiting")
  if (!budgets.length || budgets.some(budget => !budget.scope || WINDOWS.some(window => !Number.isSafeInteger(budget.tier[window.name]) || budget.tier[window.name] <= 0))) throw new Error("Invalid rate-limit budget")
  await ensureSharedRateLimitSchema()
  const now = Date.now()
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    const abuseHash = digest(budgets[0].scope)
    await conn.query(`INSERT INTO api_rate_limit_abuse (tenant_id,scope_hash) VALUES (?,?)
      ON DUPLICATE KEY UPDATE strikes=strikes`, [tenantId, abuseHash])
    const [abuseRows] = await conn.query<AbuseRow[]>(`SELECT strikes,window_reset_ms,blocked_until_ms
      FROM api_rate_limit_abuse WHERE tenant_id=? AND scope_hash=? FOR UPDATE`, [tenantId, abuseHash])
    const abuse = abuseRows[0]
    if (!abuse) throw new Error("Rate-limit abuse record unavailable")
    if (Number(abuse.blocked_until_ms) > now) {
      const retryAfter = Math.max(1, Math.ceil((Number(abuse.blocked_until_ms) - now) / 1000))
      await conn.commit()
      return { allowed: false, limited: false, abuse: true, window: null, retryAfter,
        headers: { "Retry-After": String(retryAfter), "X-RateLimit-Limit": String(budgets[0].tier.minute),
          "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": String(Math.ceil(Number(abuse.blocked_until_ms) / 1000)) } }
    }
    const locked: { budget: RateBudget; hash: string; counters: Counter[] }[] = []
    // Stable lock order avoids cross-policy deadlocks when concurrent requests
    // hit overlapping key/tenant/endpoint budgets in different orders.
    for (const budget of [...budgets].sort((a, b) => a.scope.localeCompare(b.scope))) {
      const hash = digest(budget.scope)
      const counters: Counter[] = []
      for (const window of WINDOWS) {
        const start = Math.floor(now / window.ms) * window.ms
        const resetAt = start + window.ms
        await conn.query(`INSERT INTO api_rate_limit_counters (tenant_id,scope_hash,window_name,window_start_ms,reset_at_ms,request_count)
          VALUES (?,?,?,?,?,0) ON DUPLICATE KEY UPDATE request_count=request_count`, [tenantId, hash, window.name, start, resetAt])
        const [rows] = await conn.query<CountRow[]>(`SELECT request_count FROM api_rate_limit_counters
          WHERE tenant_id=? AND scope_hash=? AND window_name=? AND window_start_ms=? FOR UPDATE`, [tenantId, hash, window.name, start])
        if (!rows[0]) throw new Error("Rate-limit counter unavailable")
        counters.push({ name: window.name, used: Number(rows[0].request_count), resetAt })
      }
      locked.push({ budget, hash, counters })
    }
    const blocked = locked.map(group => ({ group, window: group.counters.find(item => item.used >= group.budget.tier[item.name]) })).find(item => item.window)
    const offending = blocked?.window
    if (offending) {
      const previousStrikes = Number(abuse.window_reset_ms) > now ? Number(abuse.strikes) : 0
      const tripped = previousStrikes + 1 >= 10
      const blockedUntil = tripped ? now + 300_000 : 0
      await conn.query(`UPDATE api_rate_limit_abuse SET strikes=?,window_reset_ms=?,blocked_until_ms=?
        WHERE tenant_id=? AND scope_hash=?`, [tripped ? 0 : previousStrikes + 1, now + 60_000, blockedUntil, tenantId, abuseHash])
      const retryAfter = tripped ? 300 : Math.max(1, Math.ceil((offending.resetAt - now) / 1000))
      await conn.commit()
      return { allowed: false, limited: true, abuse: tripped, window: offending.name, retryAfter, headers: headers(blocked!.group.budget.tier, blocked!.group.counters, retryAfter) }
    }
    for (const group of locked) {
      for (const counter of group.counters) {
        const start = counter.resetAt - WINDOWS.find(window => window.name === counter.name)!.ms
        await conn.query(`UPDATE api_rate_limit_counters SET request_count=request_count+1
          WHERE tenant_id=? AND scope_hash=? AND window_name=? AND window_start_ms=?`, [tenantId, group.hash, counter.name, start])
        counter.used += 1
      }
    }
    await conn.commit()
    const primary = locked.find(group => group.budget.scope === budgets[0].scope)!
    return { allowed: true, limited: false, abuse: false, window: null, retryAfter: 0, headers: headers(primary.budget.tier, primary.counters, 0) }
  } catch (error) { await conn.rollback().catch(() => {}); throw error } finally { conn.release() }
}

export function enforceSharedRateLimit(tenantId: number, scope: string, tier: RateLimitTier) {
  return enforceSharedRateLimits(tenantId, [{ scope, tier }])
}

/** Current shared counters for the tenant's own API keys, without consuming budget. */
export async function snapshotSharedRateLimits(tenantId: number, keyIds: number[]): Promise<{ keyId: number; windows: Counter[] }[]> {
  await ensureSharedRateLimitSchema()
  if (!keyIds.length) return []
  const now = Date.now()
  const hashes = keyIds.map(id => digest(`apiv1:key:${id}`))
  const rows = await query<(RowDataPacket & { scope_hash: string; window_name: RateWindowKey; request_count: number; reset_at_ms: number })[]>(
    `SELECT scope_hash,window_name,request_count,reset_at_ms FROM api_rate_limit_counters
      WHERE tenant_id=? AND scope_hash IN (${hashes.map(() => "?").join(",")}) AND reset_at_ms>?`, [tenantId, ...hashes, now])
  return keyIds.map((keyId, index) => ({ keyId, windows: rows.filter(row => row.scope_hash === hashes[index]).map(row => ({ name: row.window_name, used: Number(row.request_count), resetAt: Number(row.reset_at_ms) })) }))
}

/** Call from existing maintenance/scheduler jobs; no user data is removed. */
export async function pruneSharedRateLimitCounters(): Promise<number> {
  await ensureSharedRateLimitSchema()
  const result = await query<{ affectedRows: number }>("DELETE FROM api_rate_limit_counters WHERE reset_at_ms < ?", [Date.now() - 86_400_000])
  await query("DELETE FROM api_rate_limit_abuse WHERE window_reset_ms < ? AND blocked_until_ms < ?", [Date.now() - 86_400_000, Date.now()])
  return Number(result.affectedRows ?? 0)
}
