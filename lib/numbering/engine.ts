import "server-only"
/**
 * SPEC 92 — Numbering Engine: allocation core (Phase 2).
 * ---------------------------------------------------------------------------
 * The one race-safe place that turns a tenant + entity into the next unique
 * number. Everything about WHAT the number looks like lives in the pure model
 * (model.ts); everything about the CONFIG lives in the store (store.ts); this
 * file only owns the atomic counter advance that guarantees no two callers ever
 * receive the same number.
 *
 * Duplicate prevention (Phase 4): allocation runs inside a transaction and
 * relies on the UNIQUE key (tenant_id, entity, period_key) on
 * numbering_counters. The single statement
 *
 *   INSERT ... VALUES (startNumber) ON DUPLICATE KEY UPDATE next_number = next_number + 1
 *
 * is atomic at the row level, and the follow-up SELECT ... FOR UPDATE holds the
 * row lock until commit, so concurrent allocations for the same counter are
 * fully serialized and strictly monotonic. This mirrors the long-standing
 * pattern in lib/record-ids.ts.
 */
import { pool, query } from "@/lib/db"
import { getCurrentTenant, requireCurrentTenantId } from "@/lib/tenant-context"
import { ensureNumberingSchema } from "@/lib/numbering/schema"
import { getRuleRow, loadRule } from "@/lib/numbering/store"
import {
  type NumberingRule,
  advanceCounter,
  normalizeEntity,
  renderNumber,
  resetPeriodKey,
} from "@/lib/numbering/model"

export type Allocation = {
  entity: string
  number: string
  sequence: number
  periodKey: string
  rule: NumberingRule
}

/**
 * Allocate and CONSUME the next number for an entity under the acting tenant.
 * This is the authoritative, side-effecting call — every returned number is
 * unique and will never be handed out again.
 */
export async function allocateNumber(
  entity: string,
  opts: { now?: Date } = {},
): Promise<Allocation> {
  await ensureNumberingSchema()
  const tenantId = requireCurrentTenantId()
  const key = normalizeEntity(entity)
  const { rule } = await loadRule(key)
  const now = opts.now ?? new Date()
  const periodKey = resetPeriodKey(rule, now)

  const connection = await pool.getConnection()
  try {
    await connection.beginTransaction()
    // Atomic advance: create the period counter at startNumber, or bump it.
    await connection.query(
      `INSERT INTO numbering_counters (tenant_id, entity, period_key, next_number)
         VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE next_number = next_number + 1`,
      [tenantId, key, periodKey, rule.startNumber],
    )
    // Read back the value THIS transaction just settled on, holding the lock.
    const [rows] = await connection.query<any[]>(
      `SELECT next_number FROM numbering_counters
        WHERE tenant_id = ? AND entity = ? AND period_key = ?
        FOR UPDATE`,
      [tenantId, key, periodKey],
    )
    const sequence = Number(rows[0]?.next_number ?? rule.startNumber)
    await connection.commit()
    return { entity: key, number: renderNumber(rule, sequence, now), sequence, periodKey, rule }
  } catch (error) {
    await connection.rollback().catch(() => {})
    throw error
  } finally {
    connection.release()
  }
}

/**
 * Preview the next number WITHOUT consuming it. Best-effort and non-binding: a
 * concurrent allocation can claim the previewed value, so this is only for
 * display (the console) — never persist a peeked number.
 */
export async function peekNext(entity: string, opts: { now?: Date } = {}): Promise<Allocation> {
  await ensureNumberingSchema()
  const tenantId = requireCurrentTenantId()
  const key = normalizeEntity(entity)
  const { rule } = await loadRule(key)
  const now = opts.now ?? new Date()
  const periodKey = resetPeriodKey(rule, now)

  const rows = (await query(
    `SELECT next_number FROM numbering_counters
      WHERE tenant_id = ? AND entity = ? AND period_key = ?
      LIMIT 1`,
    [tenantId, key, periodKey],
  )) as { next_number: number }[]

  const current = rows.length ? Number(rows[0].next_number) : null
  const sequence = advanceCounter(current, rule.startNumber)
  return { entity: key, number: renderNumber(rule, sequence, now), sequence, periodKey, rule }
}

/**
 * Restart a sequence: drop the tenant's counters for an entity (optionally a
 * single period bucket). The next allocation begins again at the rule's start
 * number. Returns the number of counter buckets cleared.
 */
export async function resetCounter(entity: string, periodKey?: string): Promise<number> {
  await ensureNumberingSchema()
  const tenantId = requireCurrentTenantId()
  const key = normalizeEntity(entity)
  const sql = periodKey
    ? `DELETE FROM numbering_counters WHERE tenant_id = ? AND entity = ? AND period_key = ?`
    : `DELETE FROM numbering_counters WHERE tenant_id = ? AND entity = ?`
  const params = periodKey ? [tenantId, key, periodKey] : [tenantId, key]
  const res = (await query(sql, params)) as { affectedRows?: number }
  return res?.affectedRows ?? 0
}

/**
 * Phase 3 integration point. Returns an engine-allocated number when the acting
 * tenant has an ACTIVE custom rule for the entity, or null otherwise so the
 * caller keeps its legacy numbering. This is what makes centralized numbering
 * opt-in per tenant per entity without disturbing existing id streams, and it
 * is a no-op (null) outside an authenticated tenant context (e.g. background
 * bootstraps or unit tests).
 */
export async function tryAllocateForEntity(entity: string): Promise<string | null> {
  if (!getCurrentTenant()) return null
  const row = await getRuleRow(entity)
  if (!row || Number(row.active) !== 1) return null
  const allocation = await allocateNumber(entity)
  return allocation.number
}
