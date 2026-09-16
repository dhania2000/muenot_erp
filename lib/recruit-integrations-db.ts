import "server-only"
import { query } from "@/lib/db"
import { nextRecordId } from "@/lib/record-ids"
import { nextDocumentId } from "@/lib/settings/numbering"

/**
 * Cross-module recruitment integrations that sit on top of the operational
 * worksuite recruit_* pipeline:
 *
 *   1. Requisition -> Job link + approval workflow
 *   2. Candidate -> HR Employee handoff
 *   3. Pre-joining / BGV / Reference checks
 *
 * The backing schema ships as database/migrations/2026-10-06-recruit-integrations.sql.
 * Until that migration is applied the new tables/columns won't exist, so reads
 * degrade gracefully (empty + `migrationPending`) instead of crashing the UI.
 */

export class MigrationPendingError extends Error {
  constructor(message = "Recruitment integrations migration has not been applied yet.") {
    super(message)
    this.name = "MigrationPendingError"
  }
}

function isMissingSchema(err: any): boolean {
  const code = err?.code || err?.original?.code
  return code === "ER_NO_SUCH_TABLE" || code === "ER_BAD_FIELD_ERROR"
}

/** Run a read that may hit not-yet-migrated schema; return a fallback instead of throwing. */
async function safeRead<T>(fn: () => Promise<T>, fallback: T): Promise<{ data: T; migrationPending: boolean }> {
  try {
    return { data: await fn(), migrationPending: false }
  } catch (err) {
    if (isMissingSchema(err)) return { data: fallback, migrationPending: true }
    throw err
  }
}

// ===========================================================================
// 1. Requisition -> Job link + approval workflow
// ===========================================================================
export type RequisitionRow = {
  requisition_id: string
  requisition_date: string | null
  job_title: string | null
  department: string | null
  location: string | null
  employment_type: string | null
  work_mode: string | null
  experience_required: string | null
  required_qualification: string | null
  required_skills: string | null
  rate_salary: string | null
  required_resources: number | null
  filled_resources: number | null
  pending_resources: number | null
  priority: string | null
  hiring_manager: string | null
  recruiter: string | null
  remarks: string | null
  status: string | null
  approval_status: string
  approved_by_name: string | null
  approved_at: string | null
  approval_notes: string | null
  linked_job_id: string | null
  linked_job_status?: string | null
  hired_count?: number
}

export async function listRequisitions() {
  return safeRead<RequisitionRow[]>(
    () =>
      query<RequisitionRow[]>(
        `SELECT r.*, j.status AS linked_job_status,
           (SELECT COUNT(*) FROM recruit_applications a
             WHERE a.job_id = r.linked_job_id AND a.stage = 'hired') AS hired_count
         FROM recruitment_requisitions r
         LEFT JOIN recruit_jobs j ON j.job_id = r.linked_job_id
         ORDER BY r.requisition_date DESC, r.id DESC
         LIMIT 500`,
      ),
    [],
  )
}

export async function getRequisition(requisitionId: string): Promise<RequisitionRow | null> {
  const rows = await query<RequisitionRow[]>(
    "SELECT * FROM recruitment_requisitions WHERE requisition_id = ? LIMIT 1",
    [requisitionId],
  )
  return rows[0] ?? null
}

const APPROVAL_TRANSITIONS: Record<string, string[]> = {
  submit: ["draft", "rejected"], // -> pending_approval
  approve: ["pending_approval"], // -> approved
  reject: ["pending_approval"], // -> rejected
  reset: ["approved", "rejected", "pending_approval"], // -> draft
}

const APPROVAL_RESULT: Record<string, string> = {
  submit: "pending_approval",
  approve: "approved",
  reject: "rejected",
  reset: "draft",
}

export async function setRequisitionApproval(
  requisitionId: string,
  action: "submit" | "approve" | "reject" | "reset",
  opts: { userId: number | null; userName: string | null; notes?: string | null },
) {
  const req = await getRequisition(requisitionId)
  if (!req) throw new Error("Requisition not found")
  const from = APPROVAL_TRANSITIONS[action]
  if (!from) throw new Error("Unknown approval action")
  const current = req.approval_status || "draft"
  if (!from.includes(current)) {
    throw new Error(`Cannot ${action} a requisition that is "${current}".`)
  }
  const next = APPROVAL_RESULT[action]
  const isApprovalDecision = action === "approve" || action === "reject"
  await query(
    `UPDATE recruitment_requisitions
       SET approval_status = ?,
           approved_by = ?,
           approved_by_name = ?,
           approved_at = ?,
           approval_notes = ?
     WHERE requisition_id = ?`,
    [
      next,
      isApprovalDecision ? opts.userId : null,
      isApprovalDecision ? opts.userName : null,
      isApprovalDecision ? new Date() : null,
      opts.notes ?? req.approval_notes ?? null,
      requisitionId,
    ],
  )
  return { approval_status: next }
}

export async function createJobFromRequisition(requisitionId: string, userId: number | null) {
  const req = await getRequisition(requisitionId)
  if (!req) throw new Error("Requisition not found")
  if (req.approval_status !== "approved") {
    throw new Error("Only an approved requisition can be turned into a job.")
  }
  if (req.linked_job_id) {
    throw new Error("A job has already been created from this requisition.")
  }

  const jobId = await nextDocumentId("job")
  const hash = (await import("crypto")).randomBytes(16).toString("hex")
  const description =
    [req.remarks, req.required_qualification ? `Qualification: ${req.required_qualification}` : null]
      .filter(Boolean)
      .join("\n\n") || null

  await query(
    `INSERT INTO recruit_jobs
      (job_id, public_hash, title, department, location, job_type, work_mode, status, positions,
       experience, currency, skills, description, requirements, show_on_careers, requisition_id, created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      jobId,
      hash,
      req.job_title || "Untitled role",
      req.department || null,
      req.location || null,
      req.employment_type || null,
      req.work_mode || null,
      "open",
      Number(req.required_resources) || 1,
      req.experience_required || null,
      "INR",
      req.required_skills || null,
      description,
      req.required_qualification || null,
      1,
      requisitionId,
      userId,
    ],
  )
  await query("UPDATE recruitment_requisitions SET linked_job_id = ? WHERE requisition_id = ?", [jobId, requisitionId])
  return { job_id: jobId, public_hash: hash }
}

/**
 * Recompute a requisition's filled/pending headcount from its linked job's
 * hires and auto-close both when the target headcount is reached. Called after
 * a candidate is hired / converted to an employee.
 */
export async function syncRequisitionFromLinkedJob(jobId: string | null | undefined) {
  if (!jobId) return
  const reqs = await query<RequisitionRow[]>(
    "SELECT * FROM recruitment_requisitions WHERE linked_job_id = ? LIMIT 5",
    [jobId],
  )
  if (!reqs.length) return
  const [{ hired = 0 } = { hired: 0 }] = await query<any[]>(
    "SELECT COUNT(*) AS hired FROM recruit_applications WHERE job_id = ? AND stage = 'hired'",
    [jobId],
  )
  for (const req of reqs) {
    const required = Number(req.required_resources) || 0
    const filled = Number(hired)
    const pending = Math.max(required - filled, 0)
    const filledUp = required > 0 && filled >= required
    await query(
      `UPDATE recruitment_requisitions
         SET filled_resources = ?, pending_resources = ?, status = ?
       WHERE requisition_id = ?`,
      [filled, pending, filledUp ? "Filled" : req.status || "Open", req.requisition_id],
    )
    if (filledUp) {
      await query("UPDATE recruit_jobs SET status = 'closed' WHERE job_id = ? AND status <> 'closed'", [jobId])
    }
  }
}

// ===========================================================================
// 2. Candidate -> HR Employee handoff
// ===========================================================================
export type HandoffRow = {
  offer_id: string
  application_id: string | null
  candidate_name: string | null
  job_title: string | null
  salary: number | null
  currency: string
  joining_date: string | null
  status: string
  hired_employee_id: string | null
  email: string | null
  phone: string | null
  job_id: string | null
  department: string | null
}

export async function listHandoffCandidates() {
  return safeRead<HandoffRow[]>(
    () =>
      query<HandoffRow[]>(
        `SELECT o.offer_id, o.application_id, o.candidate_name, o.job_title, o.salary, o.currency,
                o.joining_date, o.status, o.hired_employee_id,
                a.email, a.phone, a.job_id,
                j.department
         FROM recruit_offers o
         LEFT JOIN recruit_applications a ON a.application_id = o.application_id
         LEFT JOIN recruit_jobs j ON j.job_id = a.job_id
         WHERE o.status = 'accepted'
         ORDER BY o.updated_at DESC
         LIMIT 500`,
      ),
    [],
  )
}

const EMPLOYEE_COLUMNS = new Set([
  "employee_name", "gender", "dob", "personal_email", "official_email", "mobile",
  "department", "designation", "reporting_manager", "employment_type", "joining_date",
  "work_location", "work_mode", "employment_status", "onboarding_status", "notes",
])

export async function convertOfferToEmployee(
  offerId: string,
  overrides: Record<string, any>,
  userId: number | null,
) {
  const rows = await query<HandoffRow[]>(
    `SELECT o.*, a.email, a.phone, a.location, a.job_id, j.department, j.work_mode
     FROM recruit_offers o
     LEFT JOIN recruit_applications a ON a.application_id = o.application_id
     LEFT JOIN recruit_jobs j ON j.job_id = a.job_id
     WHERE o.offer_id = ? LIMIT 1`,
    [offerId],
  )
  const offer: any = rows[0]
  if (!offer) throw new Error("Offer not found")
  if (offer.hired_employee_id) {
    throw new Error(`This candidate is already employee ${offer.hired_employee_id}.`)
  }
  if (offer.status !== "accepted") {
    throw new Error("Only an accepted offer can be converted into an employee.")
  }

  const base: Record<string, any> = {
    employee_name: offer.candidate_name || "New Employee",
    personal_email: offer.email || null,
    mobile: offer.phone || null,
    designation: offer.job_title || null,
    department: offer.department || null,
    work_mode: offer.work_mode || null,
    work_location: offer.location || null,
    joining_date: offer.joining_date || null,
    employment_type: "Full Time",
    employment_status: "Active",
    onboarding_status: "Pre-boarding",
    notes: `Converted from recruitment offer ${offer.offer_id}`,
  }
  // Apply caller overrides, but only for real employee columns.
  for (const [k, v] of Object.entries(overrides || {})) {
    if (EMPLOYEE_COLUMNS.has(k) && v !== undefined && v !== "") base[k] = v
  }

  const employeeId = await nextRecordId("EMP")
  const fields = ["employee_id", ...Object.keys(base)]
  const values = [employeeId, ...Object.keys(base).map((k) => base[k])]
  await query(
    `INSERT INTO hr_employees (${fields.join(",")}, created_by) VALUES (${fields.map(() => "?").join(",")}, ?)`,
    [...values, userId],
  )

  // Link back so the handoff can only happen once, and roll the hire up.
  await query("UPDATE recruit_offers SET hired_employee_id = ? WHERE offer_id = ?", [employeeId, offerId])
  if (offer.application_id) {
    await query(
      "UPDATE recruit_applications SET hired_employee_id = ?, stage = 'hired' WHERE application_id = ?",
      [employeeId, offer.application_id],
    )
  }
  await syncRequisitionFromLinkedJob(offer.job_id)

  return { employee_id: employeeId }
}

// ===========================================================================
// 3. Pre-joining / BGV / Reference checks
// ===========================================================================
export type OnboardingCandidate = {
  application_id: string
  candidate_name: string | null
  job_title: string | null
  email: string | null
  phone: string | null
  offer_status: string | null
  hired_employee_id: string | null
  bgv_total: number
  bgv_cleared: number
  ref_total: number
  ref_cleared: number
  task_total: number
  task_done: number
}

export async function listOnboardingCandidates() {
  return safeRead<OnboardingCandidate[]>(
    () =>
      query<OnboardingCandidate[]>(
        `SELECT a.application_id, a.candidate_name, a.job_title, a.email, a.phone,
                a.hired_employee_id,
                o.status AS offer_status,
                (SELECT COUNT(*) FROM recruit_bgv_checks b WHERE b.application_id = a.application_id) AS bgv_total,
                (SELECT COUNT(*) FROM recruit_bgv_checks b WHERE b.application_id = a.application_id AND b.status = 'completed') AS bgv_cleared,
                (SELECT COUNT(*) FROM recruit_reference_checks r WHERE r.application_id = a.application_id) AS ref_total,
                (SELECT COUNT(*) FROM recruit_reference_checks r WHERE r.application_id = a.application_id AND r.status = 'completed') AS ref_cleared,
                (SELECT COUNT(*) FROM recruit_prejoining_tasks t WHERE t.application_id = a.application_id) AS task_total,
                (SELECT COUNT(*) FROM recruit_prejoining_tasks t WHERE t.application_id = a.application_id AND t.status = 'done') AS task_done
         FROM recruit_applications a
         LEFT JOIN recruit_offers o ON o.application_id = a.application_id
         WHERE a.stage IN ('offered', 'hired') OR o.status IN ('sent', 'accepted')
         GROUP BY a.application_id
         ORDER BY a.updated_at DESC
         LIMIT 500`,
      ),
    [],
  )
}

export async function listBgvChecks(applicationId?: string) {
  const { data } = await safeRead<any[]>(
    () =>
      applicationId
        ? query<any[]>("SELECT * FROM recruit_bgv_checks WHERE application_id = ? ORDER BY created_at DESC", [applicationId])
        : query<any[]>("SELECT * FROM recruit_bgv_checks ORDER BY created_at DESC LIMIT 1000"),
    [],
  )
  return data
}

export async function createBgvCheck(data: any, userId: number | null) {
  const bgvId = await nextRecordId("BGV")
  await query(
    `INSERT INTO recruit_bgv_checks
      (bgv_id, application_id, candidate_name, check_type, agency, status, result, initiated_at, completed_at, remarks, created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [
      bgvId, data.application_id || null, data.candidate_name || null, data.check_type || "Identity",
      data.agency || null, data.status || "pending", data.result || null, data.initiated_at || null,
      data.completed_at || null, data.remarks || null, userId,
    ],
  )
  return { bgv_id: bgvId }
}

export async function updateBgvCheck(bgvId: string, data: any) {
  await query(
    `UPDATE recruit_bgv_checks SET check_type=?, agency=?, status=?, result=?, initiated_at=?, completed_at=?, remarks=? WHERE bgv_id=?`,
    [
      data.check_type || "Identity", data.agency || null, data.status || "pending", data.result || null,
      data.initiated_at || null, data.completed_at || null, data.remarks || null, bgvId,
    ],
  )
}

export async function deleteBgvCheck(bgvId: string) {
  await query("DELETE FROM recruit_bgv_checks WHERE bgv_id = ?", [bgvId])
}

export async function listReferenceChecks(applicationId?: string) {
  const { data } = await safeRead<any[]>(
    () =>
      applicationId
        ? query<any[]>("SELECT * FROM recruit_reference_checks WHERE application_id = ? ORDER BY created_at DESC", [applicationId])
        : query<any[]>("SELECT * FROM recruit_reference_checks ORDER BY created_at DESC LIMIT 1000"),
    [],
  )
  return data
}

export async function createReferenceCheck(data: any, userId: number | null) {
  const referenceId = await nextRecordId("RFC")
  await query(
    `INSERT INTO recruit_reference_checks
      (reference_id, application_id, candidate_name, referee_name, relationship, company, contact, status, rating, feedback, checked_at, created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      referenceId, data.application_id || null, data.candidate_name || null, data.referee_name || null,
      data.relationship || null, data.company || null, data.contact || null, data.status || "pending",
      Number(data.rating) || 0, data.feedback || null, data.checked_at || null, userId,
    ],
  )
  return { reference_id: referenceId }
}

export async function updateReferenceCheck(referenceId: string, data: any) {
  await query(
    `UPDATE recruit_reference_checks SET referee_name=?, relationship=?, company=?, contact=?, status=?, rating=?, feedback=?, checked_at=? WHERE reference_id=?`,
    [
      data.referee_name || null, data.relationship || null, data.company || null, data.contact || null,
      data.status || "pending", Number(data.rating) || 0, data.feedback || null, data.checked_at || null, referenceId,
    ],
  )
}

export async function deleteReferenceCheck(referenceId: string) {
  await query("DELETE FROM recruit_reference_checks WHERE reference_id = ?", [referenceId])
}

export async function listPrejoiningTasks(applicationId?: string) {
  const { data } = await safeRead<any[]>(
    () =>
      applicationId
        ? query<any[]>("SELECT * FROM recruit_prejoining_tasks WHERE application_id = ? ORDER BY due_date ASC, created_at DESC", [applicationId])
        : query<any[]>("SELECT * FROM recruit_prejoining_tasks ORDER BY due_date ASC, created_at DESC LIMIT 1000"),
    [],
  )
  return data
}

export async function createPrejoiningTask(data: any, userId: number | null) {
  const taskId = await nextRecordId("PJT")
  await query(
    `INSERT INTO recruit_prejoining_tasks
      (task_id, application_id, candidate_name, task, category, owner, due_date, status, remarks, created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [
      taskId, data.application_id || null, data.candidate_name || null, data.task || "Task",
      data.category || null, data.owner || null, data.due_date || null, data.status || "pending",
      data.remarks || null, userId,
    ],
  )
  return { task_id: taskId }
}

export async function updatePrejoiningTask(taskId: string, data: any) {
  await query(
    `UPDATE recruit_prejoining_tasks SET task=?, category=?, owner=?, due_date=?, status=?, remarks=? WHERE task_id=?`,
    [
      data.task || "Task", data.category || null, data.owner || null, data.due_date || null,
      data.status || "pending", data.remarks || null, taskId,
    ],
  )
}

export async function deletePrejoiningTask(taskId: string) {
  await query("DELETE FROM recruit_prejoining_tasks WHERE task_id = ?", [taskId])
}
