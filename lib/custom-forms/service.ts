import "server-only"
/**
 * SPEC 95 — Custom Forms: submission service (Phase 2).
 * ---------------------------------------------------------------------------
 * Owns the SUBMISSION side of the engine: capturing values against a form,
 * driving the draft → submitted / pending → approved / rejected workflow, and
 * serving the approval queue. All validation and conditional visibility runs
 * through the pure model, so the same rules the browser renders are the ones
 * the server enforces — the client is never trusted.
 *
 * Every statement is tenant-scoped via the request context.
 */
import { query } from "@/lib/db"
import { requireCurrentTenantId } from "@/lib/tenant-context"
import { ensureCustomFormSchema } from "@/lib/custom-forms/schema"
import { getFormById } from "@/lib/custom-forms/store"
import {
  type FormDefinition,
  type ReviewDecision,
  type SubmissionStatus,
  applyReview,
  statusOnSubmit,
  validateSubmission,
} from "@/lib/custom-forms/model"
import type { TenantRole } from "@/lib/role-model"

export type FormSubmission = {
  id: number
  formId: number
  formVersion: number
  status: SubmissionStatus
  values: Record<string, unknown>
  submittedBy: number | null
  submittedAt: string | null
  reviewedBy: number | null
  reviewedAt: string | null
  reviewNote: string
  createdAt: string
}

type SubmissionRow = {
  id: number
  form_id: number
  form_version: number
  status: string
  values_json: string | null
  submitted_by: number | null
  submitted_at: string | null
  reviewed_by: number | null
  reviewed_at: string | null
  review_note: string
  created_at: string
}

function parseJson<T>(raw: string | null, fallback: T): T {
  if (raw == null) return fallback
  if (typeof raw === "object") return raw as T
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

function rowToSubmission(row: SubmissionRow): FormSubmission {
  return {
    id: Number(row.id),
    formId: Number(row.form_id),
    formVersion: Number(row.form_version) || 1,
    status: (row.status as SubmissionStatus) ?? "draft",
    values: parseJson<Record<string, unknown>>(row.values_json, {}),
    submittedBy: row.submitted_by == null ? null : Number(row.submitted_by),
    submittedAt: row.submitted_at,
    reviewedBy: row.reviewed_by == null ? null : Number(row.reviewed_by),
    reviewedAt: row.reviewed_at,
    reviewNote: row.review_note ?? "",
    createdAt: row.created_at,
  }
}

const SUB_COLUMNS = `id, form_id, form_version, status, values_json, submitted_by, submitted_at,
                     reviewed_by, reviewed_at, review_note, created_at`

/**
 * Submit values against a form. Values are validated + conditionally filtered
 * through the pure model: hidden fields are dropped, hidden required fields are
 * not enforced. The resulting status depends on whether the form requires
 * approval (pending) or not (submitted).
 */
export async function submitForm(
  formId: number,
  rawValues: Record<string, unknown>,
  actor: number | null,
): Promise<{ ok: true; submission: FormSubmission } | { ok: false; errors: Record<string, string> | string[] }> {
  const form = await getFormById(formId)
  if (!form) return { ok: false, errors: ["Form not found."] }
  if (form.status !== "published") return { ok: false, errors: ["This form is not accepting submissions."] }

  const validation = validateSubmission(form, rawValues)
  if (!validation.ok) return { ok: false, errors: validation.errors }

  await ensureCustomFormSchema()
  const tenantId = requireCurrentTenantId()
  const status = statusOnSubmit(form.approval.enabled)

  const result = (await query(
    `INSERT INTO custom_form_submissions
       (tenant_id, form_id, form_version, status, values_json, submitted_by, submitted_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?, NOW(), ?)`,
    [tenantId, formId, form.version, status, JSON.stringify(validation.values), actor, actor],
  )) as { insertId?: number }

  const submission = await getSubmissionById(result.insertId ?? 0)
  if (!submission) return { ok: false, errors: ["Could not record the submission."] }
  return { ok: true, submission }
}

/** One submission by id, scoped to the tenant. */
export async function getSubmissionById(id: number): Promise<FormSubmission | null> {
  await ensureCustomFormSchema()
  const tenantId = requireCurrentTenantId()
  const rows = (await query(
    `SELECT ${SUB_COLUMNS} FROM custom_form_submissions WHERE tenant_id = ? AND id = ? LIMIT 1`,
    [tenantId, id],
  )) as SubmissionRow[]
  return rows[0] ? rowToSubmission(rows[0]) : null
}

/** All submissions for one form, newest first, optionally filtered by status. */
export async function listSubmissions(
  formId: number,
  status?: SubmissionStatus,
): Promise<FormSubmission[]> {
  await ensureCustomFormSchema()
  const tenantId = requireCurrentTenantId()
  const params: unknown[] = [tenantId, formId]
  let sql = `SELECT ${SUB_COLUMNS} FROM custom_form_submissions WHERE tenant_id = ? AND form_id = ?`
  if (status) {
    sql += ` AND status = ?`
    params.push(status)
  }
  sql += ` ORDER BY created_at DESC, id DESC`
  const rows = (await query(sql, params)) as SubmissionRow[]
  return rows.map(rowToSubmission)
}

/** The tenant's approval queue: every submission awaiting a decision. */
export async function listPendingSubmissions(): Promise<Array<FormSubmission & { formTitle: string }>> {
  await ensureCustomFormSchema()
  const tenantId = requireCurrentTenantId()
  const rows = (await query(
    `SELECT s.id, s.form_id, s.form_version, s.status, s.values_json, s.submitted_by, s.submitted_at,
            s.reviewed_by, s.reviewed_at, s.review_note, s.created_at, f.title AS form_title
       FROM custom_form_submissions s
       JOIN custom_forms f ON f.id = s.form_id AND f.tenant_id = s.tenant_id
      WHERE s.tenant_id = ? AND s.status = 'pending'
      ORDER BY s.submitted_at ASC, s.id ASC`,
    [tenantId],
  )) as Array<SubmissionRow & { form_title: string }>
  return rows.map((r) => ({ ...rowToSubmission(r), formTitle: r.form_title }))
}

/**
 * Apply an approver decision to a pending submission. Re-derives the legal
 * transition and the reviewer's authority from the pure model against the
 * form's live approval config; the client cannot force a state.
 */
export async function reviewSubmission(
  submissionId: number,
  decision: ReviewDecision,
  reviewerRole: TenantRole,
  reviewer: number | null,
  note: string,
): Promise<{ ok: true; submission: FormSubmission } | { ok: false; error: string }> {
  const submission = await getSubmissionById(submissionId)
  if (!submission) return { ok: false, error: "Submission not found." }
  const form: FormDefinition | null = await getFormById(submission.formId)
  if (!form) return { ok: false, error: "Form not found." }

  const transition = applyReview(submission.status, decision, form.approval, reviewerRole)
  if (!transition.ok) return { ok: false, error: transition.error }

  const tenantId = requireCurrentTenantId()
  await query(
    `UPDATE custom_form_submissions
        SET status = ?, reviewed_by = ?, reviewed_at = NOW(), review_note = ?
      WHERE tenant_id = ? AND id = ?`,
    [transition.status, reviewer, String(note ?? "").slice(0, 1000), tenantId, submissionId],
  )

  const updated = await getSubmissionById(submissionId)
  if (!updated) return { ok: false, error: "Could not update the submission." }
  return { ok: true, submission: updated }
}

/** Count submissions per status for one form (for the admin summary badges). */
export async function submissionCounts(formId: number): Promise<Record<SubmissionStatus, number>> {
  await ensureCustomFormSchema()
  const tenantId = requireCurrentTenantId()
  const rows = (await query(
    `SELECT status, COUNT(*) AS n FROM custom_form_submissions
      WHERE tenant_id = ? AND form_id = ? GROUP BY status`,
    [tenantId, formId],
  )) as { status: string; n: number }[]
  const out: Record<SubmissionStatus, number> = {
    draft: 0,
    submitted: 0,
    pending: 0,
    approved: 0,
    rejected: 0,
  }
  for (const r of rows) {
    if (r.status in out) out[r.status as SubmissionStatus] = Number(r.n)
  }
  return out
}
