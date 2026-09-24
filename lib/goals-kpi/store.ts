import "server-only"
import { query } from "@/lib/db"
import { ensureGoalsKpiSchema } from "./schema"
import {
  computeKpi,
  rollup,
  rollupByScope,
  type KpiRollup,
} from "./calc"
import {
  isKpiDirection,
  isKpiPeriod,
  isKpiScope,
  scopeRequiresSubject,
  type KpiCheckin,
  type KpiGoal,
  type KpiGoalComputed,
  type KpiLifecycle,
} from "./config"

/**
 * SPEC 135 — Goal / KPI Engine · data-access layer.
 * ---------------------------------------------------------------------------
 * The only module that touches the `kpi_goals` / `kpi_checkins` tables. Every
 * statement is bounded to the acting `tenantId` so a tenant can never read or
 * mutate another tenant's goals — the data-layer guard (lib/tenant-guard.ts)
 * enforces that the predicate is present. Pure progress math lives in calc.ts;
 * this layer only persists and reads rows and hands them to the calculator.
 */

/** Coerce a raw MySQL row (DECIMALs arrive as strings) into a typed KpiGoal. */
function mapGoal(row: any): KpiGoal {
  return {
    id: Number(row.id),
    name: String(row.name),
    description: row.description ?? null,
    scope: row.scope,
    scope_ref_id: row.scope_ref_id ?? null,
    scope_ref_label: row.scope_ref_label ?? null,
    unit: row.unit ?? null,
    direction: row.direction,
    target_value: Number(row.target_value),
    actual_value: Number(row.actual_value),
    weight: Number(row.weight),
    period_type: row.period_type,
    period_start: row.period_start ?? null,
    period_end: row.period_end ?? null,
    lifecycle: row.lifecycle,
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  }
}

function mapCheckin(row: any): KpiCheckin {
  return {
    id: Number(row.id),
    kpi_id: Number(row.kpi_id),
    actual_value: Number(row.actual_value),
    note: row.note ?? null,
    created_by: row.created_by == null ? null : Number(row.created_by),
    created_at: String(row.created_at),
  }
}

export type ListGoalsFilters = {
  scope?: string
  lifecycle?: KpiLifecycle | "all"
  search?: string
}

/** All goals for a tenant matching the given filters, newest first. */
export async function listGoals(tenantId: number, filters: ListGoalsFilters = {}): Promise<KpiGoal[]> {
  await ensureGoalsKpiSchema()
  const where: string[] = ["tenant_id = ?"]
  const args: any[] = [tenantId]

  const lifecycle = filters.lifecycle ?? "active"
  if (lifecycle !== "all") {
    where.push("lifecycle = ?")
    args.push(lifecycle)
  }
  if (filters.scope && isKpiScope(filters.scope)) {
    where.push("scope = ?")
    args.push(filters.scope)
  }
  const search = (filters.search ?? "").trim()
  if (search) {
    where.push("(name LIKE ? OR description LIKE ? OR scope_ref_label LIKE ?)")
    const like = `%${search}%`
    args.push(like, like, like)
  }

  const rows = await query<any[]>(
    `SELECT * FROM kpi_goals WHERE ${where.join(" AND ")} ORDER BY created_at DESC, id DESC`,
    args,
  )
  return rows.map(mapGoal)
}

/** Goals enriched with computed progress + a summary and per-scope roll-up. */
export async function listComputed(
  tenantId: number,
  filters: ListGoalsFilters = {},
): Promise<{ goals: KpiGoalComputed[]; summary: KpiRollup; byScope: Record<string, KpiRollup> }> {
  const goals = (await listGoals(tenantId, filters)).map(computeKpi)
  return { goals, summary: rollup(goals), byScope: rollupByScope(goals) }
}

export async function getGoal(tenantId: number, id: number): Promise<KpiGoal | null> {
  await ensureGoalsKpiSchema()
  const rows = await query<any[]>(`SELECT * FROM kpi_goals WHERE tenant_id = ? AND id = ? LIMIT 1`, [tenantId, id])
  return rows.length ? mapGoal(rows[0]) : null
}

export type GoalInput = {
  name: string
  description?: string | null
  scope: string
  scope_ref_id?: string | null
  scope_ref_label?: string | null
  unit?: string | null
  direction?: string
  target_value: number
  actual_value?: number
  weight?: number
  period_type?: string
  period_start?: string | null
  period_end?: string | null
}

export class ValidationError extends Error {}

function validate(input: GoalInput): void {
  if (!input.name || !input.name.trim()) throw new ValidationError("Name is required.")
  if (!isKpiScope(input.scope)) throw new ValidationError("Invalid scope.")
  if (input.direction != null && !isKpiDirection(input.direction)) throw new ValidationError("Invalid direction.")
  if (input.period_type != null && !isKpiPeriod(input.period_type)) throw new ValidationError("Invalid period type.")
  if (!Number.isFinite(Number(input.target_value))) throw new ValidationError("Target must be a number.")
  if (input.weight != null && (!Number.isFinite(Number(input.weight)) || Number(input.weight) < 0))
    throw new ValidationError("Weight must be a non-negative number.")
  if (scopeRequiresSubject(input.scope as any) && !(input.scope_ref_label && input.scope_ref_label.trim()))
    throw new ValidationError("This scope requires a subject (who/what the KPI measures).")
  if ((input.period_type ?? "monthly") === "custom" && (!input.period_start || !input.period_end))
    throw new ValidationError("Custom period requires a start and end date.")
}

export async function createGoal(tenantId: number, input: GoalInput, userId: number | null): Promise<number> {
  await ensureGoalsKpiSchema()
  validate(input)
  const result = await query<any>(
    `INSERT INTO kpi_goals
      (tenant_id, name, description, scope, scope_ref_id, scope_ref_label, unit, direction,
       target_value, actual_value, weight, period_type, period_start, period_end, created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      tenantId,
      input.name.trim(),
      input.description?.trim() || null,
      input.scope,
      input.scope_ref_id || null,
      input.scope_ref_label?.trim() || null,
      input.unit?.trim() || null,
      input.direction || "increase",
      Number(input.target_value),
      Number(input.actual_value ?? 0),
      input.weight == null ? 1 : Number(input.weight),
      input.period_type || "monthly",
      input.period_start || null,
      input.period_end || null,
      userId,
    ],
  )
  return Number(result.insertId)
}

const UPDATABLE = new Set([
  "name",
  "description",
  "scope",
  "scope_ref_id",
  "scope_ref_label",
  "unit",
  "direction",
  "target_value",
  "actual_value",
  "weight",
  "period_type",
  "period_start",
  "period_end",
])

export async function updateGoal(tenantId: number, id: number, input: Partial<GoalInput>): Promise<boolean> {
  await ensureGoalsKpiSchema()
  const existing = await getGoal(tenantId, id)
  if (!existing) return false
  // Validate the merged result so partial updates cannot produce an invalid row.
  validate({ ...existing, ...input } as GoalInput)

  const sets: string[] = []
  const args: any[] = []
  for (const [key, value] of Object.entries(input)) {
    if (!UPDATABLE.has(key)) continue
    sets.push(`${key} = ?`)
    if (["target_value", "actual_value", "weight"].includes(key)) args.push(Number(value))
    else if (value === "" ) args.push(null)
    else args.push(value ?? null)
  }
  if (!sets.length) return true
  args.push(tenantId, id)
  await query(`UPDATE kpi_goals SET ${sets.join(", ")} WHERE tenant_id = ? AND id = ?`, args)
  return true
}

/** Flip a goal between active and archived. */
export async function setLifecycle(tenantId: number, id: number, lifecycle: KpiLifecycle): Promise<boolean> {
  await ensureGoalsKpiSchema()
  const result = await query<any>(`UPDATE kpi_goals SET lifecycle = ? WHERE tenant_id = ? AND id = ?`, [
    lifecycle,
    tenantId,
    id,
  ])
  return Number(result.affectedRows) > 0
}

export async function deleteGoal(tenantId: number, id: number): Promise<boolean> {
  await ensureGoalsKpiSchema()
  await query(`DELETE FROM kpi_checkins WHERE tenant_id = ? AND kpi_id = ?`, [tenantId, id])
  const result = await query<any>(`DELETE FROM kpi_goals WHERE tenant_id = ? AND id = ?`, [tenantId, id])
  return Number(result.affectedRows) > 0
}

export async function listCheckins(tenantId: number, kpiId: number): Promise<KpiCheckin[]> {
  await ensureGoalsKpiSchema()
  const rows = await query<any[]>(
    `SELECT * FROM kpi_checkins WHERE tenant_id = ? AND kpi_id = ? ORDER BY created_at DESC, id DESC`,
    [tenantId, kpiId],
  )
  return rows.map(mapCheckin)
}

/**
 * Record a progress check-in and mirror the new value onto the goal's running
 * actual. Returns null when the goal does not exist for this tenant.
 */
export async function addCheckin(
  tenantId: number,
  kpiId: number,
  actualValue: number,
  note: string | null,
  userId: number | null,
): Promise<{ id: number; goal: KpiGoalComputed } | null> {
  await ensureGoalsKpiSchema()
  if (!Number.isFinite(Number(actualValue))) throw new ValidationError("Actual value must be a number.")
  const goal = await getGoal(tenantId, kpiId)
  if (!goal) return null

  const result = await query<any>(
    `INSERT INTO kpi_checkins (tenant_id, kpi_id, actual_value, note, created_by) VALUES (?,?,?,?,?)`,
    [tenantId, kpiId, Number(actualValue), note?.trim() || null, userId],
  )
  await query(`UPDATE kpi_goals SET actual_value = ? WHERE tenant_id = ? AND id = ?`, [
    Number(actualValue),
    tenantId,
    kpiId,
  ])
  const updated = await getGoal(tenantId, kpiId)
  return { id: Number(result.insertId), goal: computeKpi(updated as KpiGoal) }
}
