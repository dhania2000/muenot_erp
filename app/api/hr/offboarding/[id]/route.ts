import { NextRequest, NextResponse } from "next/server"
import { query } from "@/lib/db"
import { requireFeature } from "@/lib/api-auth"
import { logEmployeeEvent } from "@/lib/hr-employee-events"
import {
  ensureOffboardingSchema,
  logOffboardingEvent,
  settlementTotal,
  buildCompletionChecklist,
  gateBlocked,
  parseNoticeDays,
  addDays,
  CLOSED_STATUSES,
} from "@/lib/hr-offboarding"
import { emitHrEmailEvent } from "@/lib/hr-email-automation"

const EMPLOYEE_SELECT = `
  e.id AS emp_pk, e.employee_id AS employee_code, e.employee_name, e.department, e.designation,
  e.reporting_manager, e.joining_date, e.employment_type, e.work_mode, e.employment_status,
  e.shift, e.notice_period, e.official_email, e.personal_email, e.user_id`

/** Safe query — returns [] when a referenced table doesn't exist in this ERP
 *  instance (e.g. optional modules), so the 360 view degrades gracefully. */
async function safe<T = any>(sql: string, params: any[] = []): Promise<T[]> {
  try {
    return await query<T[]>(sql, params)
  } catch {
    return []
  }
}

async function loadCase(id: number) {
  const rows = await query<any[]>(
    `SELECT o.*, ${EMPLOYEE_SELECT} FROM hr_offboarding o JOIN hr_employees e ON e.id = o.employee_id WHERE o.id = ? LIMIT 1`,
    [id],
  )
  return rows[0] || null
}

async function loadAggregates(caseRow: any) {
  const empPk = caseRow.employee_id
  const empName = caseRow.employee_name

  const [clearances, assets, timeline] = await Promise.all([
    query<any[]>("SELECT * FROM hr_offboarding_clearances WHERE offboarding_id = ? ORDER BY sort_order, id", [caseRow.id]),
    query<any[]>("SELECT * FROM hr_offboarding_assets WHERE offboarding_id = ? ORDER BY id", [caseRow.id]),
    query<any[]>("SELECT * FROM hr_offboarding_timeline WHERE offboarding_id = ? ORDER BY created_at DESC, id DESC", [
      caseRow.id,
    ]),
  ])

  // Attendance — last punch + recent rows (keyed by hr_employees.id).
  const attendanceRows = await safe<any>(
    "SELECT id, date, status, check_in, check_out FROM hr_attendance WHERE employee_id = ? ORDER BY date DESC LIMIT 5",
    [empPk],
  )
  const lastAttendance = attendanceRows[0]?.date || null

  // Attendance regularisation — pending items for this employee.
  const regRows = await safe<any>(
    "SELECT id, status FROM hr_attendance_regularisation WHERE employee_id = ? ORDER BY id DESC",
    [empPk],
  )
  const pendingRegularisations = regRows.filter((r) => String(r.status || "").toLowerCase() === "pending").length

  // Leave — balances by employee id; pending requests by name (matching the
  // ERP's existing leave keying).
  const leaveBalances = await safe<any>("SELECT * FROM hr_leave_balances WHERE employee_id = ?", [empPk])
  const leaveRequests = await safe<any>(
    "SELECT id, leave_type, from_date, to_date, status FROM hr_leave_requests WHERE employee_name = ? ORDER BY id DESC LIMIT 20",
    [empName],
  )
  const pendingLeaveRequests = leaveRequests.filter((r) => String(r.status || "").toLowerCase() === "pending").length

  // Employee documents (keyed by hr_employees.id).
  const documents = await safe<any>(
    "SELECT id, doc_type, file_name, status, created_at FROM hr_employee_documents WHERE employee_id = ? ORDER BY created_at DESC",
    [empPk],
  )

  // Letters generated for this employee (Experience / Relieving / NOC etc).
  const letters = await safe<any>(
    "SELECT id, letter_id, letter_type, status, created_at FROM hr_letters WHERE employee_id = ? ORDER BY created_at DESC",
    [empPk],
  )

  // Open HR support tickets.
  const tickets = await safe<any>(
    "SELECT id, ticket_id, subject, status FROM hr_support_tickets WHERE employee_id = ? ORDER BY id DESC LIMIT 20",
    [empPk],
  )
  const openTickets = tickets.filter((t) => !["Resolved", "Closed", "Cancelled"].includes(String(t.status || ""))).length

  const checklist = buildCompletionChecklist({
    caseRow,
    clearances,
    assets,
    pendingRegularisations,
    pendingLeaveRequests,
    openTickets,
  })

  return {
    clearances,
    assets,
    timeline,
    attendance: { lastAttendance, recent: attendanceRows, pendingRegularisations, regularisations: regRows.length },
    leave: { balances: leaveBalances, requests: leaveRequests, pendingLeaveRequests },
    documents,
    letters,
    tickets: { openTickets, list: tickets },
    checklist,
    checklistComplete: checklist.filter((c) => c.ok).length,
    checklistTotal: checklist.length,
  }
}

export async function GET(_request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await requireFeature("hr.view_offboarding")
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  await ensureOffboardingSchema()

  const { id } = await ctx.params
  const caseRow = await loadCase(Number(id))
  if (!caseRow) return NextResponse.json({ error: "Not found" }, { status: 404 })

  const canManage = await requireFeature("hr.manage_offboarding")
  const aggregates = await loadAggregates(caseRow)

  // Exit interview data is confidential — only expose to managers/HR.
  if (!canManage) caseRow.exit_interview_data = null

  return NextResponse.json({ case: caseRow, ...aggregates, canManage: Boolean(canManage) })
}

export async function PATCH(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await requireFeature("hr.manage_offboarding")
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 403 })
  await ensureOffboardingSchema()

  const { id } = await ctx.params
  const caseId = Number(id)
  const body = await request.json()
  const action = String(body.action || "")

  const caseRow = await loadCase(caseId)
  if (!caseRow) return NextResponse.json({ error: "Not found" }, { status: 404 })

  const actor = { actorId: session.userId, actorName: session.name }
  const empMeta = { employeeId: caseRow.employee_id, employeeRef: caseRow.employee_code, employeeName: caseRow.employee_name }

  switch (action) {
    case "update_case":
      return updateCase(caseId, caseRow, body, session, empMeta)
    case "add_clearance":
      return addClearance(caseId, body, empMeta, actor)
    case "update_clearance":
      return updateClearance(caseId, caseRow, body, empMeta, actor)
    case "add_asset":
      return addAsset(caseId, body, empMeta, actor)
    case "update_asset":
      return updateAsset(caseId, caseRow, body, empMeta, actor)
    case "update_settlement":
      return updateSettlement(caseId, caseRow, body, session, empMeta)
    case "update_kt":
      return updateKt(caseId, body, empMeta, actor)
    case "update_exit_interview":
      return updateExitInterview(caseId, body, empMeta, actor)
    case "update_rehire":
      return updateRehire(caseId, body, empMeta, actor)
    case "complete":
      return completeCase(caseId, caseRow, body, session, empMeta)
    case "cancel":
      return cancelCase(caseId, caseRow, body, session, empMeta)
    default:
      return NextResponse.json({ error: "Unknown action" }, { status: 400 })
  }
}

// --- Case core fields (with notice recalculation & status transitions) ------
async function updateCase(caseId: number, caseRow: any, body: any, session: any, empMeta: any) {
  const fields = ["exit_type", "exit_reason", "notice_date", "last_working_date", "status", "remarks", "support_document"]
  const updates = fields.filter((f) => Object.prototype.hasOwnProperty.call(body, f))
  if (!updates.length) return NextResponse.json({ error: "No changes provided" }, { status: 400 })

  const setParts = updates.map((f) => `${f} = ?`)
  const values = updates.map((f) => body[f] ?? null)

  // Recalculate expected LWD if the notice date changed.
  if (updates.includes("notice_date")) {
    const noticeDays = caseRow.notice_period_days ?? parseNoticeDays(caseRow.notice_period)
    const expected = addDays(body.notice_date, noticeDays)
    setParts.push("expected_last_working_date = ?")
    values.push(expected)
  }

  await query(`UPDATE hr_offboarding SET ${setParts.join(", ")} WHERE id = ?`, [...values, caseId])

  const changed = updates.filter((f) => String(caseRow[f] ?? "") !== String(body[f] ?? ""))
  if (changed.length) {
    await logOffboardingEvent({
      offboardingId: caseId,
      ...empMeta,
      eventType: "updated",
      summary: `Updated ${changed.join(", ")}`,
      details: Object.fromEntries(changed.map((f) => [f, { from: caseRow[f] ?? null, to: body[f] ?? null }])),
      actorId: session.userId,
      actorName: session.name,
      mirrorToEmployee: changed.includes("last_working_date") || changed.includes("exit_type"),
    })
  }
  return NextResponse.json({ ok: true })
}

async function addClearance(caseId: number, body: any, empMeta: any, actor: any) {
  if (!body.department) return NextResponse.json({ error: "Department is required" }, { status: 400 })
  await query(
    "INSERT INTO hr_offboarding_clearances (offboarding_id, department, responsible_name, status, is_mandatory) VALUES (?,?,?,?,?)",
    [caseId, body.department, body.responsible_name || null, "Pending", body.is_mandatory === false ? 0 : 1],
  )
  await logOffboardingEvent({
    offboardingId: caseId,
    ...empMeta,
    eventType: "clearance_added",
    summary: `Clearance task added: ${body.department}`,
    ...actor,
  })
  return NextResponse.json({ ok: true })
}

async function updateClearance(caseId: number, caseRow: any, body: any, empMeta: any, actor: any) {
  const clearanceId = Number(body.clearance_id)
  if (!clearanceId) return NextResponse.json({ error: "clearance_id is required" }, { status: 400 })
  const rows = await query<any[]>("SELECT * FROM hr_offboarding_clearances WHERE id = ? AND offboarding_id = ? LIMIT 1", [
    clearanceId,
    caseId,
  ])
  const clearance = rows[0]
  if (!clearance) return NextResponse.json({ error: "Clearance not found" }, { status: 404 })

  const status = body.status || clearance.status
  const setParts: string[] = ["status = ?", "comments = ?", "responsible_name = ?", "rejection_reason = ?"]
  const values: any[] = [
    status,
    body.comments ?? clearance.comments,
    body.responsible_name ?? clearance.responsible_name,
    status === "Rejected" ? body.rejection_reason ?? clearance.rejection_reason : null,
  ]
  if (status === "In Progress" && !clearance.started_at) setParts.push("started_at = NOW()")
  if (status === "Cleared" || status === "Not Applicable") setParts.push("completed_at = NOW()")

  await query(`UPDATE hr_offboarding_clearances SET ${setParts.join(", ")} WHERE id = ?`, [...values, clearanceId])

  await logOffboardingEvent({
    offboardingId: caseId,
    ...empMeta,
    eventType: "clearance_updated",
    summary: `${clearance.department} clearance → ${status}`,
    details: { from: clearance.status, to: status, comments: body.comments || null },
    ...actor,
  })

  // Advance case lifecycle when all mandatory clearances are cleared.
  await maybeAdvanceToSettlement(caseId, caseRow)
  return NextResponse.json({ ok: true })
}

async function maybeAdvanceToSettlement(caseId: number, caseRow: any) {
  if (!["Notice Period", "Clearance Pending"].includes(caseRow.status)) return
  const [pending] = await query<any[]>(
    "SELECT COUNT(*) AS c FROM hr_offboarding_clearances WHERE offboarding_id = ? AND is_mandatory = 1 AND status NOT IN ('Cleared','Not Applicable')",
    [caseId],
  )
  const next = Number(pending?.c || 0) === 0 ? "Settlement Pending" : "Clearance Pending"
  if (next !== caseRow.status) await query("UPDATE hr_offboarding SET status = ? WHERE id = ?", [next, caseId])
}

async function addAsset(caseId: number, body: any, empMeta: any, actor: any) {
  if (!body.asset_name) return NextResponse.json({ error: "Asset name is required" }, { status: 400 })
  await query(
    "INSERT INTO hr_offboarding_assets (offboarding_id, asset_name, asset_code, assigned_date, return_status) VALUES (?,?,?,?,?)",
    [caseId, body.asset_name, body.asset_code || null, body.assigned_date || null, body.return_status || "Return Pending"],
  )
  await logOffboardingEvent({
    offboardingId: caseId,
    ...empMeta,
    eventType: "asset_added",
    summary: `Asset tracked: ${body.asset_name}`,
    ...actor,
  })
  return NextResponse.json({ ok: true })
}

async function updateAsset(caseId: number, _caseRow: any, body: any, empMeta: any, actor: any) {
  const assetId = Number(body.asset_id)
  if (!assetId) return NextResponse.json({ error: "asset_id is required" }, { status: 400 })
  const rows = await query<any[]>("SELECT * FROM hr_offboarding_assets WHERE id = ? AND offboarding_id = ? LIMIT 1", [
    assetId,
    caseId,
  ])
  const asset = rows[0]
  if (!asset) return NextResponse.json({ error: "Asset not found" }, { status: 404 })

  const status = body.return_status || asset.return_status
  const setParts = ["return_status = ?", "asset_condition = ?", "remarks = ?"]
  const values: any[] = [status, body.asset_condition ?? asset.asset_condition, body.remarks ?? asset.remarks]
  if (status === "Returned") setParts.push("return_date = COALESCE(return_date, CURDATE())")

  await query(`UPDATE hr_offboarding_assets SET ${setParts.join(", ")} WHERE id = ?`, [...values, assetId])
  await logOffboardingEvent({
    offboardingId: caseId,
    ...empMeta,
    eventType: "asset_updated",
    summary: `Asset ${asset.asset_name} → ${status}`,
    details: { from: asset.return_status, to: status },
    ...actor,
  })
  return NextResponse.json({ ok: true })
}

async function updateSettlement(caseId: number, caseRow: any, body: any, session: any, empMeta: any) {
  const breakdown = body.settlement_breakdown ?? caseRow.settlement_breakdown ?? null
  const parsedBreakdown = typeof breakdown === "string" ? JSON.parse(breakdown || "null") : breakdown
  const total = settlementTotal(parsedBreakdown)
  const status = body.settlement_status || caseRow.settlement_status

  // Prevent self-approval: the initiator cannot approve the settlement.
  const approving = ["Approved", "Processed", "Completed"].includes(status)
  const wasApproved = ["Approved", "Processed", "Completed"].includes(caseRow.settlement_status)
  if (approving && !wasApproved && session.role !== "admin" && Number(caseRow.created_by) === Number(session.userId)) {
    return NextResponse.json({ error: "You cannot approve a settlement you initiated" }, { status: 403 })
  }

  const setParts = ["settlement_status = ?", "settlement_breakdown = ?", "settlement_amount = ?", "settlement_notes = ?"]
  const values: any[] = [status, parsedBreakdown ? JSON.stringify(parsedBreakdown) : null, total, body.settlement_notes ?? caseRow.settlement_notes]
  if (approving && !wasApproved) {
    setParts.push("settlement_approved_by = ?", "settlement_approved_at = NOW()")
    values.push(session.userId)
  }
  await query(`UPDATE hr_offboarding SET ${setParts.join(", ")} WHERE id = ?`, [...values, caseId])

  await logOffboardingEvent({
    offboardingId: caseId,
    ...empMeta,
    eventType: "settlement_updated",
    summary: `Settlement ${status} (total ${total})`,
    details: { status, total },
    actorId: session.userId,
    actorName: session.name,
    mirrorToEmployee: approving && !wasApproved,
  })
  return NextResponse.json({ ok: true, total })
}

async function updateKt(caseId: number, body: any, empMeta: any, actor: any) {
  const status = body.kt_status || "Pending"
  const setParts = ["kt_status = ?", "kt_handover_to = ?", "kt_notes = ?"]
  const values: any[] = [status, body.kt_handover_to || null, body.kt_notes || null]
  if (status === "Completed") setParts.push("kt_completed_at = NOW()")
  await query(`UPDATE hr_offboarding SET ${setParts.join(", ")} WHERE id = ?`, [...values, caseId])
  await logOffboardingEvent({
    offboardingId: caseId,
    ...empMeta,
    eventType: "kt_updated",
    summary: `Knowledge transfer → ${status}`,
    ...actor,
  })
  return NextResponse.json({ ok: true })
}

async function updateExitInterview(caseId: number, body: any, empMeta: any, actor: any) {
  const status = body.exit_interview_status || "Completed"
  await query("UPDATE hr_offboarding SET exit_interview_status = ?, exit_interview_data = ? WHERE id = ?", [
    status,
    body.exit_interview_data ? JSON.stringify(body.exit_interview_data) : null,
    caseId,
  ])
  await logOffboardingEvent({
    offboardingId: caseId,
    ...empMeta,
    eventType: "exit_interview_updated",
    summary: `Exit interview → ${status}`,
    ...actor,
  })
  return NextResponse.json({ ok: true })
}

async function updateRehire(caseId: number, body: any, empMeta: any, actor: any) {
  await query("UPDATE hr_offboarding SET rehire_eligibility = ?, rehire_reason = ? WHERE id = ?", [
    body.rehire_eligibility || null,
    body.rehire_reason || null,
    caseId,
  ])
  await logOffboardingEvent({
    offboardingId: caseId,
    ...empMeta,
    eventType: "rehire_updated",
    summary: `Rehire eligibility → ${body.rehire_eligibility || "Cleared"}`,
    ...actor,
  })
  return NextResponse.json({ ok: true })
}

async function completeCase(caseId: number, caseRow: any, body: any, session: any, empMeta: any) {
  if (caseRow.status === "Completed") return NextResponse.json({ error: "Already completed" }, { status: 400 })
  if (CLOSED_STATUSES.includes(caseRow.status) && caseRow.status !== "Completed")
    return NextResponse.json({ error: "Case is cancelled/withdrawn" }, { status: 400 })

  const aggregates = await loadAggregates(caseRow)
  const blocked = gateBlocked(aggregates.checklist)
  const override = Boolean(body.override)

  if (blocked.length && !override) {
    return NextResponse.json(
      { error: "Completion gate not satisfied", blocked, checklist: aggregates.checklist },
      { status: 422 },
    )
  }
  if (blocked.length && override && !body.override_reason) {
    return NextResponse.json({ error: "Override reason is required" }, { status: 400 })
  }

  const finalLwd = caseRow.last_working_date || caseRow.expected_last_working_date

  await query(
    `UPDATE hr_offboarding SET status = 'Completed', completed_at = NOW(), completed_by = ?,
       override_used = ?, override_reason = ? WHERE id = ?`,
    [session.userId, blocked.length && override ? 1 : 0, override ? body.override_reason || null : null, caseId],
  )

  // Finalize the employee: Ex-Employee status + exit fields, and disable the
  // linked ERP login where one exists. Historical records are preserved.
  await query(
    "UPDATE hr_employees SET employment_status = 'Ex-Employee', exit_status = 'Exited', exit_date = ?, status_changed_at = NOW() WHERE id = ?",
    [finalLwd || null, caseRow.employee_id],
  )
  if (caseRow.user_id) {
    try {
      await query("UPDATE users SET status = 'inactive' WHERE id = ?", [caseRow.user_id])
    } catch {
      // users.status column may differ; account deactivation is best-effort.
    }
  }

  await logEmployeeEvent({
    employeeId: caseRow.employee_id,
    employeeRef: caseRow.employee_code,
    employeeName: caseRow.employee_name,
    type: "status_changed",
    summary: `Offboarding completed (${caseRow.offboarding_id}) — marked Ex-Employee`,
    changes: [{ field: "employment_status", label: "Status", from: caseRow.employment_status, to: "Ex-Employee" }],
    actorId: session.userId,
    actorName: session.name,
  })
  await logOffboardingEvent({
    offboardingId: caseId,
    ...empMeta,
    eventType: "completed",
    summary: blocked.length && override ? "Exit completed (override used)" : "Exit completed",
    details: { override: blocked.length && override, override_reason: body.override_reason || null, final_lwd: finalLwd },
    actorId: session.userId,
    actorName: session.name,
  })

  // Send the farewell / exit-complete email (guarded).
  await emitHrEmailEvent("offboarding_completed", {
    employeeId: Number(caseRow.employee_id),
    sourceRecordId: caseRow.offboarding_id,
    actorId: session.userId,
    managerName: caseRow.reporting_manager ?? null,
    vars: {
      exit_type: caseRow.exit_type ?? "",
      last_working_date: String(finalLwd || "").slice(0, 10),
    },
  })

  return NextResponse.json({ ok: true })
}

async function cancelCase(caseId: number, caseRow: any, body: any, session: any, empMeta: any) {
  if (CLOSED_STATUSES.includes(caseRow.status))
    return NextResponse.json({ error: "Case is already closed" }, { status: 400 })

  const target = body.mode === "withdraw" ? "Withdrawn" : "Cancelled"
  await query(
    "UPDATE hr_offboarding SET status = ?, cancelled_at = NOW(), cancelled_by = ?, cancel_reason = ? WHERE id = ?",
    [target, session.userId, body.reason || null, caseId],
  )

  // Restore the employee to their prior active status. History is preserved —
  // the offboarding record and all sub-records remain intact.
  const restore = caseRow.previous_employment_status || "Active"
  await query("UPDATE hr_employees SET employment_status = ?, status_changed_at = NOW() WHERE id = ?", [
    restore,
    caseRow.employee_id,
  ])

  await logEmployeeEvent({
    employeeId: caseRow.employee_id,
    employeeRef: caseRow.employee_code,
    employeeName: caseRow.employee_name,
    type: "status_changed",
    summary: `Offboarding ${target.toLowerCase()} (${caseRow.offboarding_id}) — restored to ${restore}`,
    changes: [{ field: "employment_status", label: "Status", from: "Notice Period", to: restore }],
    actorId: session.userId,
    actorName: session.name,
  })
  await logOffboardingEvent({
    offboardingId: caseId,
    ...empMeta,
    eventType: target.toLowerCase(),
    summary: `Offboarding ${target.toLowerCase()}`,
    details: { reason: body.reason || null, restored_status: restore },
    actorId: session.userId,
    actorName: session.name,
  })
  return NextResponse.json({ ok: true })
}
