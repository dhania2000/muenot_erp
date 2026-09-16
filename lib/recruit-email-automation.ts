import "server-only"
import { query } from "@/lib/db"
import {
  buildMessageId,
  buildRecruitThreadId,
  ensureRecruitEmailTables,
  hydrateDepartmentSMTP,
  isEmailConfigured,
  sendEmail,
} from "@/lib/email"

/**
 * Recruitment reminder + email automation (Phases 41 & 46).
 *
 * Runs on the existing scheduler (Vercel Cron → /api/cron/recruit-reminders).
 * It scans the two canonical, due-date-bearing surfaces of the unified
 * recruitment flow — Recruitment Tasks (the target of the Phase 43 task
 * automation) and Recruitment Follow-ups — and, for every item that is due,
 * creates ONE reminder for the owning recruiter / assignee.
 *
 * Phase 41 (automatic follow-up): due follow-ups are identified, a reminder is
 * created exactly once, and overdue follow-ups are flagged.
 * Phase 46 (email automation): the task type maps to a reminder category
 * (Interview, Feedback, Offer, Offer Expiry, Joining, Follow-up, Document
 * Pending, BGV Pending, Reference Pending), rendered from a central template.
 *
 * Idempotency (both phases): a UNIQUE dedupe key
 * `${event}:${sourceRef}:${dueDate}` in `recruitment_reminder_log` guarantees
 * the same reminder is never created twice for the same due date. Re-scheduling
 * an item (new due date) is allowed to produce a fresh reminder.
 *
 * The whole run is failure-tolerant: a bad row or a send error is logged and
 * skipped, never thrown, so one item can't stall the sweep.
 */

const COMPANY_NAME = process.env.COMPANY_NAME || "Muenot"

export type RecruitReminderEvent =
  | "interview_reminder"
  | "feedback_reminder"
  | "offer_reminder"
  | "offer_expiry"
  | "joining_reminder"
  | "followup_reminder"
  | "document_pending"
  | "bgv_pending"
  | "reference_pending"
  | "task_reminder"

const EVENT_LABEL: Record<RecruitReminderEvent, string> = {
  interview_reminder: "Interview reminder",
  feedback_reminder: "Interview feedback pending",
  offer_reminder: "Offer follow-up reminder",
  offer_expiry: "Offer expiry reminder",
  joining_reminder: "Joining confirmation reminder",
  followup_reminder: "Candidate follow-up due",
  document_pending: "Candidate documents pending",
  bgv_pending: "Background verification pending",
  reference_pending: "Reference check pending",
  task_reminder: "Recruitment task due",
}

/** Map a Recruitment Task type + timing to a Phase 46 reminder category. */
function eventForTask(taskType: string, isOverdue: boolean): RecruitReminderEvent {
  switch (String(taskType || "").toLowerCase()) {
    case "interview":
      return "interview_reminder"
    case "feedback":
      return "feedback_reminder"
    case "offer":
      return isOverdue ? "offer_expiry" : "offer_reminder"
    case "joining":
      return "joining_reminder"
    case "document":
      return "document_pending"
    case "bgv":
      return "bgv_pending"
    case "reference":
      return "reference_pending"
    case "follow-up":
      return "followup_reminder"
    default:
      return "task_reminder"
  }
}

function brandedHtml(inner: string): string {
  return `<div style="font-family:Arial,Helvetica,sans-serif;color:#1f2937;max-width:600px;margin:0 auto;line-height:1.6">
  <div style="padding:16px 0;border-bottom:2px solid #e5e7eb;font-size:18px;font-weight:700;color:#111827">${COMPANY_NAME} · Recruitment</div>
  <div style="padding:20px 0;font-size:14px">${inner}</div>
  <div style="padding:16px 0;border-top:1px solid #e5e7eb;font-size:12px;color:#6b7280">
    This is an automated reminder from the ${COMPANY_NAME} recruitment team.
  </div>
</div>`
}

const p = (text: string) => `<p style="margin:0 0 12px">${text}</p>`

type ReminderContext = {
  event: RecruitReminderEvent
  recipientName: string | null
  candidateName: string | null
  jobTitle: string | null
  dueDate: string | null
  detail: string | null
}

function buildReminder(ctx: ReminderContext): { subject: string; html: string } {
  const label = EVENT_LABEL[ctx.event]
  const who = ctx.candidateName ? ` for ${ctx.candidateName}` : ""
  const role = ctx.jobTitle ? ` (${ctx.jobTitle})` : ""
  const due = ctx.dueDate ? new Date(ctx.dueDate).toISOString().slice(0, 10) : null
  const subject = `${label}${who}${role}`

  const inner =
    p(`Hi ${ctx.recipientName || "there"},`) +
    p(`<strong>${label}</strong>${who}${role}${due ? ` is due on <strong>${due}</strong>` : ""}.`) +
    (ctx.detail ? p(ctx.detail) : "") +
    p(`Please action this in the ${COMPANY_NAME} Recruitment workspace.`)

  return { subject, html: brandedHtml(inner) }
}

let logTableEnsured = false
async function ensureReminderLog(): Promise<void> {
  if (logTableEnsured) return
  await query(
    `CREATE TABLE IF NOT EXISTS recruitment_reminder_log (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT,
      dedupe_key VARCHAR(190) NOT NULL,
      event_key VARCHAR(60) NOT NULL,
      source_module VARCHAR(60) DEFAULT NULL,
      source_ref VARCHAR(80) DEFAULT NULL,
      to_email VARCHAR(190) DEFAULT NULL,
      email_status VARCHAR(20) DEFAULT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_recruit_reminder (dedupe_key),
      KEY idx_recruit_reminder_ref (source_module, source_ref)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  )
  logTableEnsured = true
}

/**
 * Claim a reminder atomically. Returns true only for the first caller to see
 * this dedupe key — subsequent runs (or a concurrent invocation) get false and
 * skip, so a reminder is created exactly once per due date.
 */
async function claimReminder(
  dedupeKey: string,
  event: RecruitReminderEvent,
  sourceModule: string,
  sourceRef: string,
  toEmail: string | null,
): Promise<boolean> {
  const res = (await query(
    `INSERT IGNORE INTO recruitment_reminder_log (dedupe_key, event_key, source_module, source_ref, to_email)
     VALUES (?, ?, ?, ?, ?)`,
    [dedupeKey, event, sourceModule, sourceRef, toEmail],
  )) as any
  return Number(res?.affectedRows ?? 0) > 0
}

/** Resolve a recruiter/owner name to a real mailbox via HR → Employees. */
async function resolveEmployeeEmail(name: string | null | undefined): Promise<string | null> {
  const n = String(name ?? "").trim()
  if (!n) return null
  try {
    const rows = (await query(
      `SELECT COALESCE(NULLIF(official_email,''), personal_email) AS email
       FROM hr_employees
       WHERE employee_name = ? OR employee_id = ?
       LIMIT 1`,
      [n, n],
    )) as any[]
    const email = String(rows[0]?.email ?? "").trim()
    return email || null
  } catch {
    return null
  }
}

async function safeRows(sql: string): Promise<any[]> {
  try {
    return (await query(sql)) as any[]
  } catch {
    // Table may not exist yet on a brand-new install — nothing to remind.
    return []
  }
}

function dayBucket(dateStr: any): string {
  const d = dateStr ? new Date(dateStr) : new Date()
  const valid = !Number.isNaN(d.getTime()) ? d : new Date()
  return valid.toISOString().slice(0, 10)
}

export type RecruitReminderResult = {
  scanned: number
  created: number
  emailed: number
  skipped: number
  overdueFollowups: number
  emailConfigured: boolean
}

/**
 * Scan due recruitment work and create de-duplicated reminders. Sends an email
 * when SMTP is configured and the owner has a resolvable mailbox; otherwise the
 * reminder is still recorded (the notification exists) and no email goes out.
 */
export async function runRecruitmentReminders(): Promise<RecruitReminderResult> {
  await ensureReminderLog()
  await ensureRecruitEmailTables()

  const emailConfigured = isEmailConfigured("recruit")
  if (emailConfigured) {
    await hydrateDepartmentSMTP("recruit").catch(() => {})
  }

  const result: RecruitReminderResult = {
    scanned: 0,
    created: 0,
    emailed: 0,
    skipped: 0,
    overdueFollowups: 0,
    emailConfigured,
  }

  // --- Recruitment Tasks: due or overdue, still open --------------------------
  const tasks = await safeRows(
    `SELECT task_id, task_title, task_type, assigned_to, candidate_name, application_id,
            job_title, due_date, status,
            (due_date < CURDATE()) AS is_overdue
     FROM recruitment_tasks
     WHERE status IN ('Pending','In Progress')
       AND due_date IS NOT NULL AND due_date <= CURDATE()`,
  )

  // --- Recruitment Follow-ups: due (or reminder due), still active ------------
  const followups = await safeRows(
    `SELECT followup_id, followup_type, owner, candidate_name, job_title, requisition_id,
            next_followup_date, reminder, reminder_date, status
     FROM recruitment_followups
     WHERE status IN ('Open','Scheduled','Overdue')
       AND (
         (next_followup_date IS NOT NULL AND next_followup_date <= CURDATE())
         OR (reminder = 'Yes' AND reminder_date IS NOT NULL AND reminder_date <= CURDATE())
       )`,
  )

  result.scanned = tasks.length + followups.length

  const dispatch = async (
    event: RecruitReminderEvent,
    sourceModule: string,
    sourceRef: string,
    dueBucket: string,
    ctx: ReminderContext,
    ownerName: string | null,
    applicationId: string | null,
  ) => {
    const toEmail = await resolveEmployeeEmail(ownerName)
    const dedupeKey = `${event}:${sourceRef}:${dueBucket}`
    const claimed = await claimReminder(dedupeKey, event, sourceModule, sourceRef, toEmail)
    if (!claimed) {
      result.skipped += 1
      return
    }
    result.created += 1

    if (!emailConfigured || !toEmail) return

    const { subject, html } = buildReminder(ctx)
    const threadId = buildRecruitThreadId(applicationId, toEmail)
    const messageId = buildMessageId("recruit", "recruit")
    let status: "Sent" | "Failed" = "Sent"
    let errorMessage: string | null = null
    try {
      await sendEmail({
        to: toEmail,
        subject,
        html,
        department: "recruit",
        messageId,
        references: messageId,
        headers: { "X-Entity-Ref-ID": threadId },
      })
      result.emailed += 1
    } catch (err: any) {
      status = "Failed"
      errorMessage = String(err?.message ?? err).slice(0, 500)
      console.error("[recruit-reminders] send failed", { event, sourceRef, code: err?.code })
    }

    await query(
      `UPDATE recruitment_reminder_log SET email_status = ? WHERE dedupe_key = ?`,
      [status, dedupeKey],
    ).catch(() => {})

    await query(
      `INSERT INTO recruit_emails
         (application_id, template_id, to_email, to_name, subject, body, status, error_message, sent_by,
          message_id, in_reply_to, references_header, thread_id)
       VALUES (?, NULL, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, ?, ?)`,
      [applicationId, toEmail, ownerName, subject, html, status, errorMessage, messageId, messageId, threadId],
    ).catch(() => {})
  }

  for (const t of tasks) {
    try {
      const overdue = Number(t.is_overdue) === 1
      const event = eventForTask(t.task_type, overdue)
      await dispatch(
        event,
        "recruitment_tasks",
        String(t.task_id),
        dayBucket(t.due_date),
        {
          event,
          recipientName: t.assigned_to || null,
          candidateName: t.candidate_name || null,
          jobTitle: t.job_title || null,
          dueDate: t.due_date || null,
          detail: t.task_title ? `Task: ${t.task_title}${overdue ? " (overdue)" : ""}` : null,
        },
        t.assigned_to || null,
        t.application_id || null,
      )
    } catch (e) {
      result.skipped += 1
      console.error("[recruit-reminders] task row failed", e)
    }
  }

  for (const f of followups) {
    try {
      const due = f.next_followup_date || f.reminder_date
      await dispatch(
        "followup_reminder",
        "recruitment_followups",
        String(f.followup_id),
        dayBucket(due),
        {
          event: "followup_reminder",
          recipientName: f.owner || null,
          candidateName: f.candidate_name || null,
          jobTitle: f.job_title || null,
          dueDate: due || null,
          detail: f.followup_type ? `Follow-up type: ${f.followup_type}` : null,
        },
        f.owner || null,
        null,
      )
    } catch (e) {
      result.skipped += 1
      console.error("[recruit-reminders] followup row failed", e)
    }
  }

  // Phase 41: flag genuinely overdue follow-ups so the pipeline shows them as
  // Overdue. Done after the scan so a due-today item is still reminded first.
  try {
    const res = (await query(
      `UPDATE recruitment_followups
         SET status = 'Overdue'
       WHERE status IN ('Open','Scheduled')
         AND next_followup_date IS NOT NULL
         AND next_followup_date < CURDATE()`,
    )) as any
    result.overdueFollowups = Number(res?.affectedRows ?? 0)
  } catch {
    // recruitment_followups may not exist yet — nothing to flag.
  }

  return result
}
