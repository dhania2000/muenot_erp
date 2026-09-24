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
// Derive a risk register row's quantitative score and severity band from its
// probability × impact grid so the values stay consistent and cannot be edited
// by hand. Low/Medium/High map to 1/2/3; score 1-9 buckets into Low..Critical.
export function computeRiskScoring(row: Record<string, any>): { risk_score?: number; risk_level?: string } {
  const scale: Record<string, number> = { low: 1, medium: 2, high: 3 }
  const p = scale[String(row.probability ?? "").trim().toLowerCase()]
  const i = scale[String(row.impact ?? "").trim().toLowerCase()]
  if (!p || !i) return {}
  const score = p * i
  let level: string
  if (score >= 6) level = "Critical"
  else if (score >= 4) level = "High"
  else if (score >= 2) level = "Medium"
  else level = "Low"
  return { risk_score: score, risk_level: level }
}

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

// --- Phase 28: Issue → Escalation auto-flagging ----------------------------

/**
 * Raise (or refresh) an Escalation for an Issue when it becomes High/Critical
 * severity, goes overdue, or is SLA-related. Idempotent on a per-issue
 * reference (`ISS-<id>`) so repeated saves update the same escalation instead of
 * stacking duplicates. Writes only to operations_escalations — the existing
 * Issues register stays the primary source.
 */
export async function syncIssue(row: Record<string, any>, issueId: number | string): Promise<void> {
  try {
    if (!row || issueId === undefined || issueId === null) return
    const escCols = await tableColumns("operations_escalations")
    if (!escCols.size) return

    const priority = String(row.priority ?? "").toLowerCase()
    const status = String(row.status ?? "").toLowerCase()
    const isClosed = ["resolved", "closed"].includes(status)
    const highSeverity = ["high", "critical"].includes(priority)

    let overdue = false
    if (!isClosed && row.due_date) {
      const due = new Date(String(row.due_date))
      if (!Number.isNaN(due.getTime())) overdue = due.getTime() < Date.now()
    }

    const slaBreach = [row.issue_category, row.issue_type]
      .map((v) => String(v ?? "").toLowerCase())
      .some((v) => v.includes("sla"))

    // Nothing to flag: closed issues, or issues that meet none of the triggers.
    if (isClosed || (!highSeverity && !overdue && !slaBreach)) return

    const reasons: string[] = []
    if (highSeverity) reasons.push("High severity")
    if (overdue) reasons.push("Overdue")
    if (slaBreach) reasons.push("SLA breach")

    const escNo = `ISS-${issueId}`
    const existing = await query<any[]>(
      `SELECT id FROM operations_escalations WHERE escalation_no = ? LIMIT 1`,
      [escNo],
    )
    const today = new Date().toISOString().slice(0, 10)
    const data: Record<string, unknown> = {
      escalation_no: escNo,
      project_id: row.project_id ?? null,
      client_name: row.client_name ?? null,
      raised_by: row.reported_by ?? null,
      escalation_level: highSeverity ? "Level 2" : "Level 1",
      category: reasons.join(", "),
      description: `Auto-escalated from issue #${issueId}: ${row.title ?? ""}`.trim(),
      impact: row.business_impact ?? row.client_impact ?? row.impact ?? null,
      assigned_to: row.assigned_to ?? null,
      raised_date: existing[0]?.id ? undefined : today,
      target_resolution: row.due_date ?? null,
      status: "Open",
      remarks: `Auto-generated escalation from Issues register [ref:${escNo}]`,
    }
    // Drop undefined so an existing raised_date is preserved on refresh.
    for (const k of Object.keys(data)) if (data[k] === undefined) delete data[k]
    await upsert("operations_escalations", escCols, data, existing[0]?.id)
  } catch (error) {
    console.log("[v0] operations-sync syncIssue failed:", (error as Error).message)
  }
}

// --- Phase 30: SLA breach → Corrective Action (CAPA) -----------------------

/**
 * When an SLA monitoring row is Breached, spawn a linked Corrective Action so
 * every breach lands in the CAPA pipeline automatically. Idempotent on
 * `SLA-<id>`. Reuses operations_corrective_actions — no new CAPA store.
 */
export async function syncSlaBreach(row: Record<string, any>, slaId: number | string): Promise<void> {
  try {
    if (!row || slaId === undefined || slaId === null) return
    if (String(row.sla_status ?? "").toLowerCase() !== "breached sla") return
    const caCols = await tableColumns("operations_corrective_actions")
    if (!caCols.size) return

    const ref = `SLA-${slaId}`
    const existing = await query<any[]>(
      `SELECT id FROM operations_corrective_actions WHERE reference_no = ? LIMIT 1`,
      [ref],
    )
    const delay = row.delay_days !== undefined && row.delay_days !== null ? `${row.delay_days} day` : "an unplanned"
    const data: Record<string, unknown> = {
      reference_no: ref,
      project_id: row.project_id ?? null,
      source_type: "SLA Breach",
      issue_summary: `SLA breach on ${row.sla_metric ?? "SLA metric"} (${delay} delay)`,
      action_owner: row.owner ?? null,
      target_date: row.actual_completion ?? row.due_date ?? null,
      status: "Open",
      remarks: `Auto-generated from SLA monitoring breach [ref:${ref}]`,
    }
    await upsert("operations_corrective_actions", caCols, data, existing[0]?.id)
  } catch (error) {
    console.log("[v0] operations-sync syncSlaBreach failed:", (error as Error).message)
  }
}

// --- Phase 33: SOP version history -----------------------------------------

/** Actor identity captured on an audited change (SOP snapshot, approval stamp). */
export type Actor = { id?: number | null; name?: string | null }

/**
 * Snapshot an SOP's current field values into operations_sop_versions so every
 * create/edit preserves an immutable historical version. The live SOP row stays
 * the single latest record; old versions are never overwritten or lost.
 */
export async function snapshotSop(
  row: Record<string, any>,
  sopId: number | string,
  changeType: "Created" | "Updated",
  actor?: Actor,
): Promise<void> {
  try {
    const idNum = Number(sopId)
    if (!Number.isFinite(idNum) || idNum <= 0) return
    const cols = await tableColumns("operations_sop_versions")
    if (!cols.size) return
    const data: Record<string, unknown> = {
      sop_id: idNum,
      sop_code: row.sop_code ?? null,
      version: row.version ?? null,
      title: row.title ?? null,
      category: row.category ?? null,
      department: row.department ?? null,
      description: row.description ?? null,
      owner: row.owner ?? null,
      effective_date: row.effective_date ?? null,
      review_date: row.review_date ?? null,
      next_review_date: row.next_review_date ?? null,
      approval_status: row.approval_status ?? null,
      document_url: row.document_url ?? null,
      status: row.status ?? null,
      remarks: row.remarks ?? null,
      change_type: changeType,
      snapshot_by: actor?.id ?? null,
      snapshot_by_name: actor?.name ?? null,
    }
    await insert("operations_sop_versions", cols, data)
  } catch (error) {
    console.log("[v0] operations-sync snapshotSop failed:", (error as Error).message)
  }
}

// --- Phase 40: Client approval decision audit ------------------------------

/**
 * When a client approval carries a final decision (Approved / Rejected / On
 * Hold) and has not yet been stamped, record the acting user and timestamp
 * automatically. Uses the existing approval flow — no separate audit store.
 */
export async function stampClientApprovalDecision(
  approvalId: number | string,
  actor?: Actor,
): Promise<void> {
  try {
    const idNum = Number(approvalId)
    if (!Number.isFinite(idNum) || idNum <= 0) return
    const cols = await tableColumns("operations_client_approvals")
    if (!cols.has("decided_by") || !cols.has("decided_at")) return

    const rows = await query<any[]>(
      `SELECT decision, decision_date, decided_at FROM operations_client_approvals WHERE id = ? LIMIT 1`,
      [idNum],
    )
    if (!rows.length) return
    const decision = String(rows[0].decision ?? "").toLowerCase()
    const isFinal = ["approved", "rejected", "on hold"].includes(decision)
    if (!isFinal) return
    // Only stamp the first time a decision is recorded so the original decision
    // time/user is preserved across later unrelated edits.
    if (rows[0].decided_at) return

    const sets = ["decided_by = ?", "decided_at = NOW()"]
    const args: any[] = [actor?.name ?? null]
    if (cols.has("decision_date") && !rows[0].decision_date) {
      sets.push("decision_date = CURDATE()")
    }
    args.push(idNum)
    await query(`UPDATE operations_client_approvals SET ${sets.join(", ")} WHERE id = ?`, args)
  } catch (error) {
    console.log("[v0] operations-sync stampClientApprovalDecision failed:", (error as Error).message)
  }
}

// --- Phases 34-35: Checklist completion from items -------------------------

/**
 * Recompute a checklist's total_items / completed_items / completion_percent
 * from its item rows. "Not Applicable" items are excluded from the denominator
 * so completion reflects only actionable work. Status is auto-advanced to
 * Completed / In Progress based on the derived percentage.
 */
export async function recomputeChecklistFromItems(checklistId: number | string): Promise<void> {
  try {
    const idNum = Number(checklistId)
    if (!Number.isFinite(idNum) || idNum <= 0) return
    const itemCols = await tableColumns("operations_checklist_items")
    const listCols = await tableColumns("operations_checklists")
    if (!itemCols.size || !listCols.size) return

    const rows = await query<any[]>(
      `SELECT item_status, COUNT(*) c FROM operations_checklist_items
        WHERE checklist_id = ? GROUP BY item_status`,
      [idNum],
    )
    let applicable = 0
    let completed = 0
    for (const r of rows) {
      const st = String(r.item_status ?? "").toLowerCase()
      const c = toNumber(r.c)
      if (st === "not applicable") continue
      applicable += c
      if (st === "completed") completed += c
    }
    const percent = clampPercent(applicable > 0 ? (completed / applicable) * 100 : 0)

    const sets: string[] = []
    const args: any[] = []
    if (listCols.has("total_items")) { sets.push("total_items = ?"); args.push(applicable) }
    if (listCols.has("completed_items")) { sets.push("completed_items = ?"); args.push(completed) }
    if (listCols.has("completion_percent")) { sets.push("completion_percent = ?"); args.push(percent) }
    if (listCols.has("status")) {
      const status = applicable === 0 ? "Not Started" : percent >= 100 ? "Completed" : completed > 0 ? "In Progress" : "Not Started"
      sets.push("status = ?"); args.push(status)
    }
    if (!sets.length) return
    args.push(idNum)
    await query(`UPDATE operations_checklists SET ${sets.join(", ")} WHERE id = ?`, args)
  } catch (error) {
    console.log("[v0] operations-sync recomputeChecklistFromItems failed:", (error as Error).message)
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
