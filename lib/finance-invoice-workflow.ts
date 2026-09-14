import "server-only"
import { query } from "@/lib/db"
import type { SessionPayload } from "@/lib/auth"

/**
 * Two-stage invoice approval workflow (Freelance + FTE).
 *
 *   Assigned employee approves/rejects  ->  their reporting manager
 *   approves/rejects  ->  "Ready for Disbursement".
 *
 * Visibility is scoped: a regular employee only ever sees invoices where they
 * are the assignee or the assignee's reporting manager. Admins (HR/Finance who
 * create + assign invoices) have full view + download access at every stage.
 * The manager is snapshotted onto the row (`workflow_manager_id`) at write time
 * so per-user scoping never depends on a fragile live join to HR.
 */

export const INVOICE_WORKFLOW_MODULES = new Set(["freelance-invoices", "fte-invoices"])

export const WF = {
  PENDING_EMPLOYEE: "Pending Employee Approval",
  PENDING_MANAGER: "Pending Manager Approval",
  READY: "Ready for Disbursement",
  REJECTED_EMPLOYEE: "Rejected by Employee",
  REJECTED_MANAGER: "Rejected by Manager",
} as const

export type WorkflowAction =
  | "employee_approve"
  | "employee_reject"
  | "manager_approve"
  | "manager_reject"

/** Assignee + business-id columns per invoice module. */
const MODULE_META: Record<string, { table: string; idColumn: string; assigneeId: string }> = {
  "freelance-invoices": { table: "freelance_invoices", idColumn: "freelance_invoice_id", assigneeId: "freelancer_id" },
  "fte-invoices": { table: "fte_invoices", idColumn: "fte_invoice_id", assigneeId: "employee_id" },
}

function meta(moduleKey: string) {
  const m = MODULE_META[moduleKey]
  if (!m) throw new Error(`Not an invoice workflow module: ${moduleKey}`)
  return m
}

export type EmpIdentity = {
  id: number
  employee_id: string
  employee_name: string
  reporting_manager: string | null
}

/** The HR employee linked to the session by login email, or null if unmapped. */
export async function resolveSessionEmployee(session: SessionPayload): Promise<EmpIdentity | null> {
  if (!session?.email) return null
  const rows = await query<EmpIdentity[]>(
    `SELECT id, employee_id, employee_name, reporting_manager
       FROM hr_employees
       WHERE official_email = ? OR personal_email = ?
       ORDER BY archived_at IS NULL DESC
       LIMIT 1`,
    [session.email, session.email],
  )
  return rows[0] ?? null
}

type Viewer = { isAdmin: boolean; emp: EmpIdentity | null }

async function resolveViewer(session: SessionPayload): Promise<Viewer> {
  const isAdmin = session.role === "admin"
  return { isAdmin, emp: isAdmin ? null : await resolveSessionEmployee(session) }
}

export type RowCaps = {
  relation: "full" | "assignee" | "manager" | "none"
  canView: boolean
  canDownload: boolean
  canEmployeeAct: boolean
  canManagerAct: boolean
}

const HIDDEN: RowCaps = {
  relation: "none",
  canView: false,
  canDownload: false,
  canEmployeeAct: false,
  canManagerAct: false,
}

function computeCaps(moduleKey: string, row: Record<string, any>, viewer: Viewer): RowCaps {
  const { assigneeId } = meta(moduleKey)
  const status = row.workflow_status || WF.PENDING_EMPLOYEE

  // HR / Finance / admin: full access, and may push either stage through.
  if (viewer.isAdmin) {
    return {
      relation: "full",
      canView: true,
      canDownload: true,
      canEmployeeAct: status === WF.PENDING_EMPLOYEE,
      canManagerAct: status === WF.PENDING_MANAGER,
    }
  }

  const emp = viewer.emp
  if (!emp) return HIDDEN

  const same = (a: any, b: any) => a != null && b != null && String(a) === String(b)
  const isAssignee = same(row[assigneeId], emp.employee_id)
  const isManager = same(row.workflow_manager_id, emp.employee_id)

  if (isAssignee) {
    // Can view always; can download only once they have approved (i.e. moved
    // the invoice past their own stage). Can act only while awaiting them.
    return {
      relation: "assignee",
      canView: true,
      canDownload: status !== WF.PENDING_EMPLOYEE && status !== WF.REJECTED_EMPLOYEE,
      canEmployeeAct: status === WF.PENDING_EMPLOYEE,
      canManagerAct: false,
    }
  }

  if (isManager) {
    const reached = status === WF.PENDING_MANAGER || status === WF.READY || status === WF.REJECTED_MANAGER
    return {
      relation: "manager",
      canView: reached,
      canDownload: reached,
      canEmployeeAct: false,
      canManagerAct: status === WF.PENDING_MANAGER,
    }
  }

  return HIDDEN
}

/**
 * Filter a list of invoice rows down to what the viewer may see and annotate
 * each surviving row with its per-user capabilities (`__caps`). Admins keep
 * every row; regular employees keep only their own + their reports' invoices.
 */
export async function scopeAndAnnotateInvoices(
  moduleKey: string,
  rows: Record<string, any>[],
  session: SessionPayload,
): Promise<{ rows: Record<string, any>[]; fullAccess: boolean }> {
  const viewer = await resolveViewer(session)
  const out: Record<string, any>[] = []
  for (const row of rows) {
    const caps = computeCaps(moduleKey, row, viewer)
    if (!caps.canView) continue
    out.push({ ...row, __caps: caps })
  }
  return { rows: out, fullAccess: viewer.isAdmin }
}

/** Download gate used by the per-invoice PDF routes. */
export async function canDownloadInvoice(
  moduleKey: string,
  dbId: number,
  session: SessionPayload,
): Promise<boolean> {
  const { table } = meta(moduleKey)
  const [row] = (await query<any[]>(`SELECT * FROM ${table} WHERE id = ? LIMIT 1`, [dbId])) as any[]
  if (!row) return false
  const viewer = await resolveViewer(session)
  return computeCaps(moduleKey, row, viewer).canDownload
}

/**
 * Snapshot the assignee's reporting manager onto the invoice so scoping and the
 * second approval stage have a stable target. Keyed by the immutable business
 * id, so it works identically after a create or an edit. Best-effort — a
 * missing HR record simply leaves the manager blank (admin can still finalize).
 */
export async function snapshotInvoiceManager(moduleKey: string, finalRow: Record<string, any>) {
  const { table, idColumn, assigneeId } = meta(moduleKey)
  const businessId = finalRow[idColumn]
  if (!businessId) return

  let managerId: string | null = null
  let managerName: string | null = null

  const assignee = finalRow[assigneeId]
  if (assignee) {
    const [emp] = (await query<any[]>(
      `SELECT reporting_manager FROM hr_employees WHERE employee_id = ? LIMIT 1`,
      [assignee],
    )) as any[]
    const managerRef = emp?.reporting_manager
    if (managerRef) {
      const [mgr] = (await query<any[]>(
        `SELECT employee_id, employee_name FROM hr_employees
           WHERE employee_name = ? OR employee_id = ?
           ORDER BY archived_at IS NULL DESC LIMIT 1`,
        [managerRef, managerRef],
      )) as any[]
      managerId = mgr?.employee_id ?? null
      managerName = mgr?.employee_name ?? managerRef
    }
  }

  await query(`UPDATE ${table} SET workflow_manager_id = ?, workflow_manager_name = ? WHERE ${idColumn} = ?`, [
    managerId,
    managerName,
    businessId,
  ])
}

export type ActionResult = { ok: true; status: string } | { error: string; code: number }

/** Perform an approve/reject transition after re-checking the actor's rights. */
export async function performWorkflowAction(
  moduleKey: string,
  dbId: number,
  action: WorkflowAction,
  reason: string | null,
  session: SessionPayload,
): Promise<ActionResult> {
  const { table } = meta(moduleKey)
  const [row] = (await query<any[]>(`SELECT * FROM ${table} WHERE id = ? LIMIT 1`, [dbId])) as any[]
  if (!row) return { error: "Invoice not found", code: 404 }

  const viewer = await resolveViewer(session)
  const caps = computeCaps(moduleKey, row, viewer)

  const isEmployeeAction = action === "employee_approve" || action === "employee_reject"
  if (isEmployeeAction ? !caps.canEmployeeAct : !caps.canManagerAct) {
    return { error: "You are not allowed to perform this action at the current stage.", code: 403 }
  }

  if ((action === "employee_reject" || action === "manager_reject") && !reason?.trim()) {
    return { error: "A rejection reason is required.", code: 400 }
  }

  let next: string
  let sql: string
  let args: any[]

  switch (action) {
    case "employee_approve":
      next = WF.PENDING_MANAGER
      sql = `UPDATE ${table} SET workflow_status = ?, employee_approved_at = NOW(),
               workflow_rejected_by = NULL, workflow_rejection_reason = NULL WHERE id = ?`
      args = [next, dbId]
      break
    case "employee_reject":
      next = WF.REJECTED_EMPLOYEE
      sql = `UPDATE ${table} SET workflow_status = ?, workflow_rejected_by = 'Employee',
               workflow_rejection_reason = ? WHERE id = ?`
      args = [next, reason!.trim(), dbId]
      break
    case "manager_approve":
      next = WF.READY
      sql = `UPDATE ${table} SET workflow_status = ?, manager_approved_at = NOW() WHERE id = ?`
      args = [next, dbId]
      break
    case "manager_reject":
      next = WF.REJECTED_MANAGER
      sql = `UPDATE ${table} SET workflow_status = ?, workflow_rejected_by = 'Manager',
               workflow_rejection_reason = ? WHERE id = ?`
      args = [next, reason!.trim(), dbId]
      break
  }

  await query(sql, args)
  return { ok: true, status: next }
}
