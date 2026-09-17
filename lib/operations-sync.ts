// =============================================================================
// Operations cross-module sync & business logic (Phases 19-25)
// -----------------------------------------------------------------------------
// Central place where an Operations write produces real, connected side effects
// in other Operations tables — instead of every record type being an isolated
// CRUD island. All functions are:
//   * best-effort — a sync failure is logged and swallowed so it never breaks
//     the primary create/update the user requested;
//   * idempotent — re-running for the same key recomputes from source rows and
//     upserts a single derived row, so repeated approvals never double count;
//   * schema-defensive — every table/column touched is checked with
//     tableColumns() first, because the production database can lag behind the
//     app's expected schema.
//
// Nothing here duplicates Finance, HR, Clients or Calendar systems: it only
// writes to operations_* tables and reads HR/Employee data as a source.
// =============================================================================

import { query, tableColumns } from "@/lib/db"

// --- shared helpers --------------------------------------------------------

/** Normalise a date-ish value to a `YYYY-MM` period bucket, or null. */
export function periodOf(value: unknown): string | null {
  if (!value) return null
  const str = String(value)
  const match = str.match(/^(\d{4})-(\d{2})/)
  return match ? `${match[1]}-${match[2]}` : null
}

function toNumber(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(100, round2(value)))
}

/**
 * Best-effort hourly cost rate for a resource, read from the Resources master.
 * Matches on numeric resource_id first, then falls back to an exact name match.
 * Returns 0 when unknown so cost sync degrades to "no labour cost" rather than
 * inventing a number.
 */
async function resourceHourlyRate(resourceId: unknown, resourceName: unknown): Promise<number> {
  try {
    const cols = await tableColumns("operations_resources")
    if (!cols.has("cost_rate")) return 0
    const idNum = Number(resourceId)
    if (Number.isFinite(idNum) && idNum > 0) {
      const rows = await query<any[]>(
        `SELECT cost_rate, rate_type FROM operations_resources WHERE resource_id = ? LIMIT 1`,
        [idNum],
      )
      if (rows.length) return normaliseToHourly(rows[0])
    }
    if (resourceName) {
      const rows = await query<any[]>(
        `SELECT cost_rate, rate_type FROM operations_resources WHERE resource_name = ? LIMIT 1`,
        [String(resourceName)],
      )
      if (rows.length) return normaliseToHourly(rows[0])
    }
  } catch (error) {
    console.log("[v0] operations-sync resourceHourlyRate failed:", (error as Error).message)
  }
  return 0
}

/** Convert a resource's stored rate to an hourly figure using rate_type. */
function normaliseToHourly(row: { cost_rate: unknown; rate_type: unknown }): number {
  const rate = toNumber(row.cost_rate)
  const type = String(row.rate_type ?? "").toLowerCase()
  if (type === "monthly") return round2(rate / 160)
  if (type === "daily") return round2(rate / 8)
  return rate // hourly / fixed / unknown → treat as hourly
}

/** Approved billable/logged hours for a resource in a period (optionally a project). */
async function approvedHours(
  resourceId: unknown,
  resourceName: unknown,
  period: string,
  projectId?: unknown,
): Promise<{ logged: number; billable: number; nonBillable: number }> {
  const cols = await tableColumns("operations_timesheets")
  if (!cols.size) return { logged: 0, billable: 0, nonBillable: 0 }
  const where: string[] = ["approval_status = 'Approved'", "work_date IS NOT NULL", "LEFT(work_date,7) = ?"]
  const args: any[] = [period]
  // Match the resource by id or name so imported and manually-keyed rows both count.
  if (resourceId !== undefined && resourceId !== null && String(resourceId) !== "") {
    where.push("(resource_id = ? OR resource_name = ?)")
    args.push(String(resourceId), String(resourceName ?? ""))
  } else if (resourceName) {
    where.push("resource_name = ?")
    args.push(String(resourceName))
  }
  if (projectId !== undefined && projectId !== null && String(projectId) !== "") {
    where.push("project_id = ?")
    args.push(String(projectId))
  }
  const nb = cols.has("non_billable_hours") ? "COALESCE(SUM(non_billable_hours),0)" : "0"
  const rows = await query<any[]>(
    `SELECT COALESCE(SUM(hours_worked),0) logged, COALESCE(SUM(billable_hours),0) billable, ${nb} non_billable
       FROM operations_timesheets WHERE ${where.join(" AND ")}`,
    args,
  )
  const r = rows[0] ?? {}
  return { logged: toNumber(r.logged), billable: toNumber(r.billable), nonBillable: toNumber(r.non_billable) }
}

/** Monthly available capacity for a resource (defaults to 160h when unknown). */
async function resourceCapacity(resourceId: unknown, resourceName: unknown): Promise<number> {
  try {
    const cols = await tableColumns("operations_resources")
    if (!cols.has("capacity_hours")) return 160
    const idNum = Number(resourceId)
    let rows: any[] = []
    if (Number.isFinite(idNum) && idNum > 0) {
      rows = await query<any[]>(`SELECT capacity_hours FROM operations_resources WHERE resource_id = ? LIMIT 1`, [idNum])
    }
    if (!rows.length && resourceName) {
      rows = await query<any[]>(`SELECT capacity_hours FROM operations_resources WHERE resource_name = ? LIMIT 1`, [String(resourceName)])
    }
    const cap = toNumber(rows[0]?.capacity_hours)
    return cap > 0 ? cap : 160
  } catch {
    return 160
  }
}

// --- Phase 19: Resource Utilization ---------------------------------------

/**
 * Recompute the timesheet-derived utilization row for a resource/period and
 * upsert a single synced row (project_id left NULL so it never clobbers a
 * manually keyed, project-scoped utilization entry).
 */
async function recomputeUtilization(resourceId: unknown, resourceName: unknown, period: string): Promise<void> {
  const cols = await tableColumns("operations_utilization")
  if (!cols.size) return
  const { logged, billable, nonBillable } = await approvedHours(resourceId, resourceName, period)
  const available = await resourceCapacity(resourceId, resourceName)
  const utilizationPercent = clampPercent(available > 0 ? (logged / available) * 100 : 0)
  const billablePercent = clampPercent(logged > 0 ? (billable / logged) * 100 : 0)

  const existing = await query<any[]>(
    `SELECT id FROM operations_utilization
      WHERE resource_id = ? AND period = ? AND (project_id IS NULL OR project_id = '')
      ORDER BY id LIMIT 1`,
    [String(resourceId ?? ""), period],
  )
  const data: Record<string, unknown> = {
    resource_id: String(resourceId ?? ""),
    resource_name: resourceName ?? null,
    period,
    billable_hours: round2(billable),
    non_billable_hours: round2(nonBillable),
    available_hours: round2(available),
    utilization_percent: utilizationPercent,
    billable_percent: billablePercent,
    status: "Synced",
  }
  await upsert("operations_utilization", cols, data, existing[0]?.id)
}

// --- Phase 19: Project Cost (labour from approved timesheets) --------------

/**
 * Roll approved timesheet hours × resource hourly rate into a single synced
 * Operations project-cost row per project/period. This FEEDS Operations cost
 * tracking; it does not write to the Finance module.
 */
async function recomputeProjectLabourCost(projectId: unknown, period: string): Promise<void> {
  if (projectId === undefined || projectId === null || String(projectId) === "") return
  const cols = await tableColumns("operations_project_cost")
  if (!cols.size) return
  const tsCols = await tableColumns("operations_timesheets")
  if (!tsCols.size) return

  const rows = await query<any[]>(
    `SELECT resource_id, resource_name, COALESCE(SUM(hours_worked),0) hours
       FROM operations_timesheets
      WHERE approval_status = 'Approved' AND project_id = ? AND LEFT(work_date,7) = ?
      GROUP BY resource_id, resource_name`,
    [String(projectId), period],
  )
  let actualCost = 0
  for (const r of rows) {
    const rate = await resourceHourlyRate(r.resource_id, r.resource_name)
    actualCost += toNumber(r.hours) * rate
  }
  actualCost = round2(actualCost)

  const project = await query<any[]>(
    `SELECT project_name, client_name FROM operations_projects WHERE project_id = ? LIMIT 1`,
    [Number(projectId) || 0],
  ).catch(() => [] as any[])

  const existing = await query<any[]>(
    `SELECT id FROM operations_project_cost
      WHERE project_id = ? AND period = ? AND cost_category = 'Labour (Timesheets)'
      ORDER BY id LIMIT 1`,
    [String(projectId), period],
  )
  const data: Record<string, unknown> = {
    project_id: String(projectId),
    project_name: project[0]?.project_name ?? null,
    client_name: project[0]?.client_name ?? null,
    cost_category: "Labour (Timesheets)",
    cost_head: "Approved timesheet effort",
    actual_cost: actualCost,
    period,
    status: "Synced",
    remarks: "Auto-calculated from approved timesheets",
  }
  await upsert("operations_project_cost", cols, data, existing[0]?.id)
}

// --- Phase 19: Project / task effort --------------------------------------

/** Update a task's actual_hours to the sum of its approved timesheet hours. */
async function recomputeTaskEffort(taskId: unknown): Promise<void> {
  if (taskId === undefined || taskId === null || String(taskId) === "") return
  const cols = await tableColumns("operations_tasks")
  if (!cols.has("actual_hours")) return
  const rows = await query<any[]>(
    `SELECT COALESCE(SUM(hours_worked),0) hours FROM operations_timesheets
      WHERE approval_status = 'Approved' AND task_id = ?`,
    [String(taskId)],
  )
  const hours = round2(toNumber(rows[0]?.hours))
  const idNum = Number(taskId)
  if (Number.isFinite(idNum) && idNum > 0) {
    await query(`UPDATE operations_tasks SET actual_hours = ? WHERE id = ?`, [hours, idNum])
  }
}

// --- Phase 21: Productivity (derived) --------------------------------------

/**
 * Derive a productivity snapshot for a resource/period from real source rows —
 * Tasks (assigned + completed + estimated hours), Timesheets (logged/billable),
 * and Deliverables (accepted). Upserts one row per resource/period.
 */
export async function recomputeProductivity(
  resourceId: unknown,
  resourceName: unknown,
  period: string,
): Promise<void> {
  const cols = await tableColumns("operations_productivity")
  if (!cols.size) return
  const name = resourceName ? String(resourceName) : ""

  // Tasks assigned to / completed by this resource in the period.
  let tasksAssigned = 0
  let tasksCompleted = 0
  let estimatedHours = 0
  const taskCols = await tableColumns("operations_tasks")
  if (taskCols.size && name) {
    const dateCol = taskCols.has("due_date") ? "due_date" : "updated_at"
    const est = taskCols.has("estimated_hours") ? "COALESCE(SUM(estimated_hours),0)" : "0"
    const rows = await query<any[]>(
      `SELECT COUNT(*) assigned,
              SUM(CASE WHEN status IN ('Done','Completed','Closed') THEN 1 ELSE 0 END) completed,
              ${est} estimated
         FROM operations_tasks
        WHERE assigned_to = ? AND LEFT(${dateCol},7) = ?`,
      [name, period],
    ).catch(() => [] as any[])
    tasksAssigned = toNumber(rows[0]?.assigned)
    tasksCompleted = toNumber(rows[0]?.completed)
    estimatedHours = toNumber(rows[0]?.estimated)
  }

  // Deliverables owned by this resource, accepted in the period.
  let deliverablesCompleted = 0
  const delCols = await tableColumns("operations_deliverables")
  if (delCols.size && name) {
    const dateCol = delCols.has("accepted_date") ? "accepted_date" : "updated_at"
    const rows = await query<any[]>(
      `SELECT COUNT(*) done FROM operations_deliverables
        WHERE owner = ? AND status IN ('Accepted','Completed','Closed') AND LEFT(${dateCol},7) = ?`,
      [name, period],
    ).catch(() => [] as any[])
    deliverablesCompleted = toNumber(rows[0]?.done)
  }

  const { logged, billable } = await approvedHours(resourceId, resourceName, period)

  const taskCompletion = clampPercent(tasksAssigned > 0 ? (tasksCompleted / tasksAssigned) * 100 : 0)
  const billablePercent = clampPercent(logged > 0 ? (billable / logged) * 100 : 0)
  const efficiency = clampPercent(logged > 0 ? (estimatedHours / logged) * 100 : 0)
  // Blended productivity score: delivery throughput, billability, and effort
  // efficiency. Purely derived — no static seed values.
  const productivityScore = clampPercent(0.5 * taskCompletion + 0.3 * billablePercent + 0.2 * efficiency)

  const existing = await query<any[]>(
    `SELECT id FROM operations_productivity WHERE resource_id = ? AND period = ? ORDER BY id LIMIT 1`,
    [String(resourceId ?? ""), period],
  )
  const data: Record<string, unknown> = {
    resource_id: String(resourceId ?? ""),
    resource_name: resourceName ?? null,
    period,
    tasks_assigned: tasksAssigned,
    tasks_completed: tasksCompleted,
    deliverables_completed: deliverablesCompleted,
    estimated_hours: round2(estimatedHours),
    logged_hours: round2(logged),
    billable_hours: round2(billable),
    task_completion_percent: taskCompletion,
    efficiency_percent: efficiency,
    billable_percent: billablePercent,
    productivity_score: productivityScore,
    source: "derived",
    status: "Synced",
  }
  await upsert("operations_productivity", cols, data, existing[0]?.id)
}

// --- Phase 19 orchestrator: approved timesheet fan-out ---------------------

/**
 * Called after a timesheet is created/updated. When the row is Approved it
 * fans out to utilization, productivity, project labour cost and task effort.
 * Safe to call on every write — non-approved rows are ignored.
 */
export async function syncTimesheet(row: Record<string, any>): Promise<void> {
  try {
    if (!row) return
    if (String(row.approval_status ?? "").toLowerCase() !== "approved") return
    const period = periodOf(row.work_date)
    if (!period) return
    await recomputeUtilization(row.resource_id, row.resource_name, period)
    await recomputeProductivity(row.resource_id, row.resource_name, period)
    await recomputeProjectLabourCost(row.project_id, period)
    await recomputeTaskEffort(row.task_id)
  } catch (error) {
    console.log("[v0] operations-sync syncTimesheet failed:", (error as Error).message)
  }
}

// --- Phase 23: SLA breach detection ----------------------------------------

/**
 * Derive delay + SLA status from due vs actual completion. Returns fields to be
 * merged into the SLA row BEFORE it is written, so a breach is recorded
 * automatically instead of relying on manual data entry.
 */
export function computeSlaTracking(row: Record<string, any>): { delay_days?: number; sla_status?: string } {
  const due = row.due_date ? new Date(String(row.due_date)) : null
  const actual = row.actual_completion ? new Date(String(row.actual_completion)) : null
  if (!due || Number.isNaN(due.getTime())) return {}

  const reference = actual && !Number.isNaN(actual.getTime()) ? actual : new Date()
  const msPerDay = 1000 * 60 * 60 * 24
  const delayDays = Math.round((reference.getTime() - due.getTime()) / msPerDay)

  let status: string
  if (!actual) {
    // Still open: breached only once past due, otherwise on track / at risk.
    if (delayDays > 0) status = "Breached SLA"
    else if (delayDays >= -2) status = "At Risk"
    else status = "Met SLA"
  } else {
    status = delayDays > 0 ? "Breached SLA" : "Met SLA"
  }
  return { delay_days: delayDays, sla_status: status }
}

// --- Phase 24: Scorecard auto-total ---------------------------------------

/**
 * Recalculate a scorecard's weighted total from its criteria rows and persist
 * total_score / max_score / score_percent / result. Called whenever a criteria
 * row for the scorecard changes, or the scorecard itself is saved.
 */
export async function recalcScorecard(scorecardId: unknown): Promise<void> {
  try {
    if (scorecardId === undefined || scorecardId === null || String(scorecardId) === "") return
    const scCols = await tableColumns("operations_scorecards")
    const critCols = await tableColumns("operations_scorecard_criteria")
    if (!scCols.size || !critCols.size) return

    const criteria = await query<any[]>(
      `SELECT weight, max_score, score FROM operations_scorecard_criteria WHERE scorecard_id = ?`,
      [String(scorecardId)],
    )
    let total = 0
    let max = 0
    for (const c of criteria) {
      const weight = toNumber(c.weight) || 1
      const score = toNumber(c.score)
      const maxScore = toNumber(c.max_score) || 100
      total += score * weight
      max += maxScore * weight
    }
    const percent = clampPercent(max > 0 ? (total / max) * 100 : 0)
    const result = percent >= 85 ? "Excellent" : percent >= 70 ? "Satisfactory" : percent >= 50 ? "Needs Improvement" : "Poor"

    const idNum = Number(scorecardId)
    if (!Number.isFinite(idNum) || idNum <= 0) return
    const sets: string[] = []
    const args: any[] = []
    if (scCols.has("total_score")) { sets.push("total_score = ?"); args.push(round2(total)) }
    if (scCols.has("max_score")) { sets.push("max_score = ?"); args.push(round2(max)) }
    if (scCols.has("score_percent")) { sets.push("score_percent = ?"); args.push(percent) }
    if (scCols.has("result")) { sets.push("result = ?"); args.push(result) }
    if (!sets.length) return
    args.push(idNum)
    await query(`UPDATE operations_scorecards SET ${sets.join(", ")} WHERE id = ?`, args)
  } catch (error) {
    console.log("[v0] operations-sync recalcScorecard failed:", (error as Error).message)
  }
}

/**
 * Update a criteria row's weighted_score, then recalc its parent scorecard.
 * Returns the weighted score so the caller can reflect it if needed.
 */
export async function syncScorecardCriteria(row: Record<string, any>, id: number | string): Promise<void> {
  try {
    const critCols = await tableColumns("operations_scorecard_criteria")
    if (!critCols.size) return
    const weight = toNumber(row.weight) || 1
    const score = toNumber(row.score)
    const weighted = round2(score * weight)
    const idNum = Number(id)
    if (critCols.has("weighted_score") && Number.isFinite(idNum) && idNum > 0) {
      await query(`UPDATE operations_scorecard_criteria SET weighted_score = ? WHERE id = ?`, [weighted, idNum])
    }
    if (row.scorecard_id) await recalcScorecard(row.scorecard_id)
  } catch (error) {
    console.log("[v0] operations-sync syncScorecardCriteria failed:", (error as Error).message)
  }
}

// --- Phase 25: Quality Actions --------------------------------------------

/**
 * When a Quality/SLA review flags a problem (Needs Improvement, an escalation,
 * or a recorded root cause), spawn a linked Issue and a Corrective Action —
 * once per review. Idempotency is enforced with a stable reference tag so a
 * repeated save of the same review never creates duplicates.
 */
export async function spawnQualityActions(row: Record<string, any>, reviewId: number | string): Promise<void> {
  try {
    if (!row || reviewId === undefined || reviewId === null) return
    const status = String(row.status ?? "").toLowerCase()
    const hasEscalation = row.client_escalation && !["", "none", "no"].includes(String(row.client_escalation).toLowerCase())
    const flagged = status === "needs improvement" || hasEscalation || Boolean(row.root_cause)
    if (!flagged) return

    const ref = `QR-${reviewId}`

    // Corrective Action (idempotent on reference_no).
    const caCols = await tableColumns("operations_corrective_actions")
    if (caCols.size) {
      const exists = await query<any[]>(
        `SELECT id FROM operations_corrective_actions WHERE reference_no = ? LIMIT 1`,
        [ref],
      )
      if (!exists.length) {
        const data: Record<string, unknown> = {
          reference_no: ref,
          project_id: row.project_id ?? null,
          source_type: "Quality Review",
          issue_summary: `Quality review ${ref}: ${row.client_escalation ? "client escalation" : "needs improvement"}`,
          root_cause: row.root_cause ?? null,
          corrective_action: row.corrective_action ?? null,
          action_owner: row.action_owner ?? null,
          target_date: row.action_due_date ?? null,
          status: "Open",
          remarks: "Auto-generated from Quality & SLA review",
        }
        await insert("operations_corrective_actions", caCols, data)
      }
    }

    // Issue register entry. `title` is NOT NULL and also serves as the
    // idempotency key so a repeated review save never raises a duplicate issue.
    const issueCols = await tableColumns("operations_issues")
    if (issueCols.size) {
      const title = `Quality review ${ref}`
      const exists = await query<any[]>(
        `SELECT issue_id FROM operations_issues WHERE title = ? LIMIT 1`,
        [title],
      ).catch(() => [] as any[])
      if (!exists.length) {
        const data: Record<string, unknown> = {
          title,
          project_id: row.project_id ?? null,
          client_name: row.client_name ?? null,
          issue_type: "Quality",
          issue_category: hasEscalation ? "Client Escalation" : "Quality Gap",
          priority: hasEscalation ? "High" : "Medium",
          description: `Raised automatically from quality review ${ref}`,
          root_cause: row.root_cause ?? null,
          corrective_action: row.corrective_action ?? null,
          assigned_to: row.action_owner ?? null,
          target_date: row.action_due_date ?? null,
          status: "Open",
          remarks: `Auto-generated from Quality & SLA review [ref:${ref}]`,
        }
        await insert("operations_issues", issueCols, data)
      }
    }
  } catch (error) {
    console.log("[v0] operations-sync spawnQualityActions failed:", (error as Error).message)
  }
}

// --- generic write helpers (column-filtered) -------------------------------

/** Insert `data`, keeping only keys that exist as columns on `table`. */
async function insert(table: string, cols: Set<string>, data: Record<string, unknown>): Promise<void> {
  const keys = Object.keys(data).filter((k) => cols.has(k))
  if (!keys.length) return
  const values = keys.map((k) => (data[k] === "" ? null : data[k]))
  const placeholders = keys.map(() => "?").join(",")
  await query(`INSERT INTO ${table} (${keys.join(",")}) VALUES (${placeholders})`, values)
}

/** Upsert: update the row at `id` if provided, otherwise insert. */
async function upsert(table: string, cols: Set<string>, data: Record<string, unknown>, id?: number): Promise<void> {
  const keys = Object.keys(data).filter((k) => cols.has(k))
  if (!keys.length) return
  const values = keys.map((k) => (data[k] === "" ? null : data[k]))
  if (id) {
    const setClause = keys.map((k) => `${k} = ?`).join(",")
    await query(`UPDATE ${table} SET ${setClause} WHERE id = ?`, [...values, id])
  } else {
    const placeholders = keys.map(() => "?").join(",")
    await query(`INSERT INTO ${table} (${keys.join(",")}) VALUES (${placeholders})`, values)
  }
}
