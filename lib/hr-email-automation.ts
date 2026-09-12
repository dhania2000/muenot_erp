import { query } from "@/lib/db"
import { renderTemplate } from "@/lib/email"
import {
  buildDedupeKey,
  createHrEmail,
  ensureHrEmailHubSchema,
  isValidEmail,
  resolveEmployeeRecipient,
} from "@/lib/hr-email"
import type { HrEmailCategory } from "@/lib/hr-email-shared"

/**
 * Phase 2 — event-driven HR email automation.
 *
 * HR workflows (leave, shift change, promotion, support, offboarding, ...) call
 * `emitHrEmailEvent(...)` after a state change. This module maps the event to a
 * template (an hr_email_templates row when configured, otherwise a built-in
 * default), resolves recipient + variables, and hands the composed message to
 * the same `createHrEmail` pipeline used by the manual composer — so automated
 * mail lands in the one `hr_emails` table with tracking, dedupe and history.
 *
 * Design rules honoured here:
 *  - No full email bodies are hard-coded inside module handlers (spec §28).
 *  - Every event is individually enable/disable-able (spec §29).
 *  - Sends are idempotent via a deterministic dedupe key (spec §15).
 *  - Failures never bubble up into the host workflow (fire-and-forget).
 */

export type HrEmailEventKey =
  | "leave_submitted"
  | "leave_approved"
  | "leave_rejected"
  | "leave_cancelled"
  | "shift_change_submitted"
  | "shift_change_approved"
  | "shift_change_rejected"
  | "promotion_effective"
  | "support_ticket_created"
  | "offboarding_initiated"
  | "offboarding_completed"

type EventDef = {
  key: HrEmailEventKey
  label: string
  group: string
  category: HrEmailCategory
  module: string
  ccManagerDefault: boolean
  defaultSubject: string
  /** Inner HTML (wrapped in central branding at render time). */
  defaultBody: string
  /** Variable names available to this event's template, for the settings UI. */
  variables: string[]
}

const COMMON_VARS = ["employee_name", "first_name", "employee_id", "department", "designation", "company_name"]

// ---------------------------------------------------------------------------
// Central branding wrapper (spec §42/§43) — one place, not per workflow.
// ---------------------------------------------------------------------------
const COMPANY_NAME = process.env.COMPANY_NAME || "Muenot"

function brandedHtml(inner: string): string {
  return `<div style="font-family:Arial,Helvetica,sans-serif;color:#1f2937;max-width:600px;margin:0 auto;line-height:1.6">
  <div style="padding:16px 0;border-bottom:2px solid #e5e7eb;font-size:18px;font-weight:700;color:#111827">${COMPANY_NAME} · HR</div>
  <div style="padding:20px 0;font-size:14px">${inner}</div>
  <div style="padding:16px 0;border-top:1px solid #e5e7eb;font-size:12px;color:#6b7280">
    This is an automated message from the ${COMPANY_NAME} HR team. Please do not reply directly to this email.
  </div>
</div>`
}

const p = (text: string) => `<p style="margin:0 0 12px">${text}</p>`

// ---------------------------------------------------------------------------
// Event catalog — the single source of truth for automated HR mail.
// ---------------------------------------------------------------------------
export const HR_EMAIL_EVENTS: Record<HrEmailEventKey, EventDef> = {
  leave_submitted: {
    key: "leave_submitted",
    label: "Leave request submitted",
    group: "Leave",
    category: "Leave",
    module: "leave-requests",
    ccManagerDefault: true,
    defaultSubject: "Leave request {{request_id}} received",
    defaultBody:
      p("Hi {{employee_name}},") +
      p("We have received your {{leave_type}} request <strong>{{request_id}}</strong> for {{from_date}} to {{to_date}} ({{days}} day(s)).") +
      p("Status: <strong>{{status}}</strong>. You'll be notified once it is reviewed."),
    variables: [...COMMON_VARS, "request_id", "leave_type", "from_date", "to_date", "days", "status", "reason"],
  },
  leave_approved: {
    key: "leave_approved",
    label: "Leave request approved",
    group: "Leave",
    category: "Leave",
    module: "leave-requests",
    ccManagerDefault: true,
    defaultSubject: "Your leave request {{request_id}} is approved",
    defaultBody:
      p("Hi {{employee_name}},") +
      p("Good news — your {{leave_type}} request <strong>{{request_id}}</strong> for {{from_date}} to {{to_date}} ({{days}} day(s)) has been <strong>approved</strong>.") +
      p("Enjoy your time off. Please ensure a smooth handover before you leave."),
    variables: [...COMMON_VARS, "request_id", "leave_type", "from_date", "to_date", "days", "status"],
  },
  leave_rejected: {
    key: "leave_rejected",
    label: "Leave request rejected",
    group: "Leave",
    category: "Leave",
    module: "leave-requests",
    ccManagerDefault: true,
    defaultSubject: "Update on your leave request {{request_id}}",
    defaultBody:
      p("Hi {{employee_name}},") +
      p("Your {{leave_type}} request <strong>{{request_id}}</strong> for {{from_date}} to {{to_date}} could not be approved.") +
      p("Please reach out to your manager or HR if you have any questions."),
    variables: [...COMMON_VARS, "request_id", "leave_type", "from_date", "to_date", "days", "status", "remarks"],
  },
  leave_cancelled: {
    key: "leave_cancelled",
    label: "Leave request cancelled",
    group: "Leave",
    category: "Leave",
    module: "leave-requests",
    ccManagerDefault: false,
    defaultSubject: "Leave request {{request_id}} cancelled",
    defaultBody:
      p("Hi {{employee_name}},") +
      p("Your {{leave_type}} request <strong>{{request_id}}</strong> ({{from_date}} to {{to_date}}) has been cancelled."),
    variables: [...COMMON_VARS, "request_id", "leave_type", "from_date", "to_date", "status"],
  },
  shift_change_submitted: {
    key: "shift_change_submitted",
    label: "Shift change request submitted",
    group: "Shift",
    category: "Attendance",
    module: "shift-change-requests",
    ccManagerDefault: true,
    defaultSubject: "Shift change request {{request_id}} received",
    defaultBody:
      p("Hi {{employee_name}},") +
      p("Your shift change request <strong>{{request_id}}</strong> from {{current_shift}} to {{requested_shift}} (effective {{effective_date}}) has been received and is <strong>{{status}}</strong>."),
    variables: [...COMMON_VARS, "request_id", "current_shift", "requested_shift", "effective_date", "status"],
  },
  shift_change_approved: {
    key: "shift_change_approved",
    label: "Shift change request approved",
    group: "Shift",
    category: "Attendance",
    module: "shift-change-requests",
    ccManagerDefault: true,
    defaultSubject: "Your shift change request {{request_id}} is approved",
    defaultBody:
      p("Hi {{employee_name}},") +
      p("Your shift change request <strong>{{request_id}}</strong> to {{requested_shift}} (effective {{effective_date}}) has been <strong>approved</strong>."),
    variables: [...COMMON_VARS, "request_id", "current_shift", "requested_shift", "effective_date", "status"],
  },
  shift_change_rejected: {
    key: "shift_change_rejected",
    label: "Shift change request rejected",
    group: "Shift",
    category: "Attendance",
    module: "shift-change-requests",
    ccManagerDefault: false,
    defaultSubject: "Update on your shift change request {{request_id}}",
    defaultBody:
      p("Hi {{employee_name}},") +
      p("Your shift change request <strong>{{request_id}}</strong> to {{requested_shift}} could not be approved. Please contact HR for details."),
    variables: [...COMMON_VARS, "request_id", "current_shift", "requested_shift", "effective_date", "status"],
  },
  promotion_effective: {
    key: "promotion_effective",
    label: "Promotion effective",
    group: "Promotion",
    category: "Promotion",
    module: "promotions",
    ccManagerDefault: true,
    defaultSubject: "Congratulations on your promotion, {{first_name}}!",
    defaultBody:
      p("Hi {{employee_name}},") +
      p("Congratulations! Effective {{effective_date}}, you have been promoted from {{old_designation}} to <strong>{{new_designation}}</strong>{{department_change}}.") +
      p("We appreciate your contribution and look forward to your continued success."),
    variables: [
      ...COMMON_VARS,
      "promotion_id",
      "old_designation",
      "new_designation",
      "old_department",
      "new_department",
      "effective_date",
    ],
  },
  support_ticket_created: {
    key: "support_ticket_created",
    label: "HR support ticket created",
    group: "Support",
    category: "General",
    module: "support",
    ccManagerDefault: false,
    defaultSubject: "We received your HR ticket {{ticket_id}}",
    defaultBody:
      p("Hi {{employee_name}},") +
      p("Your HR support ticket <strong>{{ticket_id}}</strong> — \"{{subject}}\" ({{priority}} priority) has been logged.") +
      p("Our team will get back to you shortly. Current status: <strong>{{status}}</strong>."),
    variables: [...COMMON_VARS, "ticket_id", "subject", "priority", "status"],
  },
  offboarding_initiated: {
    key: "offboarding_initiated",
    label: "Offboarding initiated",
    group: "Offboarding",
    category: "Offboarding",
    module: "offboarding",
    ccManagerDefault: false,
    defaultSubject: "Your offboarding process has started",
    defaultBody:
      p("Hi {{employee_name}},") +
      p("Your offboarding has been initiated. Your last working date is planned for <strong>{{last_working_date}}</strong>.") +
      p("HR will guide you through clearance and exit formalities."),
    variables: [...COMMON_VARS, "exit_type", "last_working_date", "notice_date"],
  },
  offboarding_completed: {
    key: "offboarding_completed",
    label: "Offboarding completed / exit",
    group: "Offboarding",
    category: "Offboarding",
    module: "offboarding",
    ccManagerDefault: false,
    defaultSubject: "Farewell from {{company_name}}",
    defaultBody:
      p("Hi {{employee_name}},") +
      p("Your offboarding is now complete as of {{last_working_date}}. Thank you for your contributions to {{company_name}}.") +
      p("We wish you all the best in your future endeavours."),
    variables: [...COMMON_VARS, "exit_type", "last_working_date"],
  },
}

export const HR_EMAIL_EVENT_KEYS = Object.keys(HR_EMAIL_EVENTS) as HrEmailEventKey[]

// ---------------------------------------------------------------------------
// Config schema (self-healing, mirrors the migration).
// ---------------------------------------------------------------------------
let ensured: Promise<void> | null = null

export function ensureHrEmailAutomationSchema(): Promise<void> {
  if (!ensured) ensured = doEnsure()
  return ensured
}

async function doEnsure() {
  await query(
    `CREATE TABLE IF NOT EXISTS hr_email_automations (
      event_key   VARCHAR(60)  NOT NULL PRIMARY KEY,
      enabled     TINYINT(1)   NOT NULL DEFAULT 1,
      template_id BIGINT UNSIGNED NULL,
      cc_manager  TINYINT(1)   NOT NULL DEFAULT 0,
      updated_by  BIGINT UNSIGNED NULL,
      updated_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  )
  // Seed any missing events with their defaults.
  for (const key of HR_EMAIL_EVENT_KEYS) {
    const def = HR_EMAIL_EVENTS[key]
    await query("INSERT IGNORE INTO hr_email_automations (event_key, enabled, cc_manager) VALUES (?,1,?)", [
      key,
      def.ccManagerDefault ? 1 : 0,
    ])
  }
}

export type HrEmailAutomationConfig = {
  event_key: HrEmailEventKey
  enabled: boolean
  template_id: number | null
  cc_manager: boolean
}

export async function getAutomationConfig(key: HrEmailEventKey): Promise<HrEmailAutomationConfig> {
  await ensureHrEmailAutomationSchema()
  const rows = await query<any[]>(
    "SELECT event_key, enabled, template_id, cc_manager FROM hr_email_automations WHERE event_key = ? LIMIT 1",
    [key],
  )
  const def = HR_EMAIL_EVENTS[key]
  const row = rows[0]
  if (!row) {
    return { event_key: key, enabled: true, template_id: null, cc_manager: def.ccManagerDefault }
  }
  return {
    event_key: key,
    enabled: !!row.enabled,
    template_id: row.template_id == null ? null : Number(row.template_id),
    cc_manager: !!row.cc_manager,
  }
}

export async function listAutomationConfigs() {
  await ensureHrEmailAutomationSchema()
  const rows = await query<any[]>(
    "SELECT event_key, enabled, template_id, cc_manager, updated_at FROM hr_email_automations",
  )
  const byKey = new Map(rows.map((r) => [r.event_key, r]))
  return HR_EMAIL_EVENT_KEYS.map((key) => {
    const def = HR_EMAIL_EVENTS[key]
    const row = byKey.get(key)
    return {
      event_key: key,
      label: def.label,
      group: def.group,
      category: def.category,
      module: def.module,
      variables: def.variables,
      default_subject: def.defaultSubject,
      enabled: row ? !!row.enabled : true,
      template_id: row && row.template_id != null ? Number(row.template_id) : null,
      cc_manager: row ? !!row.cc_manager : def.ccManagerDefault,
      updated_at: row?.updated_at ?? null,
    }
  })
}

export async function updateAutomationConfig(
  key: HrEmailEventKey,
  patch: { enabled?: boolean; template_id?: number | null; cc_manager?: boolean },
  updatedBy?: number | null,
): Promise<boolean> {
  if (!HR_EMAIL_EVENTS[key]) return false
  await ensureHrEmailAutomationSchema()
  const sets: string[] = []
  const args: any[] = []
  if (typeof patch.enabled === "boolean") {
    sets.push("enabled = ?")
    args.push(patch.enabled ? 1 : 0)
  }
  if ("template_id" in patch) {
    sets.push("template_id = ?")
    args.push(patch.template_id == null ? null : Number(patch.template_id))
  }
  if (typeof patch.cc_manager === "boolean") {
    sets.push("cc_manager = ?")
    args.push(patch.cc_manager ? 1 : 0)
  }
  if (!sets.length) return false
  sets.push("updated_by = ?")
  args.push(updatedBy ?? null)
  await query(`UPDATE hr_email_automations SET ${sets.join(", ")} WHERE event_key = ?`, [...args, key])
  return true
}

// ---------------------------------------------------------------------------
// Recipient / manager resolution helpers
// ---------------------------------------------------------------------------
async function resolveManagerEmail(managerName: string | null | undefined): Promise<string | null> {
  const name = (managerName || "").trim()
  if (!name) return null
  try {
    const rows = await query<any[]>(
      `SELECT COALESCE(NULLIF(official_email,''), personal_email) AS email
       FROM hr_employees
       WHERE employee_name = ? AND (archived_at IS NULL OR archived_at = '')
       LIMIT 1`,
      [name],
    )
    const email = rows[0]?.email
    return isValidEmail(email) ? String(email).trim() : null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// The emitter
// ---------------------------------------------------------------------------
export type HrEmailEventContext = {
  /** Numeric hr_employees.id of the primary recipient. */
  employeeId?: number | null
  /** Explicit recipient when there is no employee record (external). */
  toEmail?: string | null
  toName?: string | null
  /** Human-facing source record identifier (e.g. LR-2026-0015). */
  sourceRecordId?: string | null
  /** Extra {{variables}} resolved from the source record. */
  vars?: Record<string, string | number | null | undefined>
  /** Reporting manager name, used when the event CCs the manager. */
  managerName?: string | null
  /** Who triggered the workflow (stored as created_by). */
  actorId?: number | null
}

/**
 * Fire an automated HR email for `eventKey`. Fully guarded — any failure is
 * logged and swallowed so it can never break the workflow that triggered it.
 */
export async function emitHrEmailEvent(
  eventKey: HrEmailEventKey,
  ctx: HrEmailEventContext,
): Promise<void> {
  try {
    const def = HR_EMAIL_EVENTS[eventKey]
    if (!def) return

    await ensureHrEmailHubSchema()
    const cfg = await getAutomationConfig(eventKey)
    if (!cfg.enabled) return

    // Resolve recipient + base variables.
    let toEmail = (ctx.toEmail || "").trim()
    let toName = ctx.toName ?? null
    let vars: Record<string, string> = {}

    if (ctx.employeeId) {
      const resolved = await resolveEmployeeRecipient(ctx.employeeId)
      if (!resolved) return // no usable email — skip silently
      toEmail = resolved.email
      toName = resolved.name
      vars = { ...resolved.vars }
    }
    if (!isValidEmail(toEmail)) return

    // Merge in source-record variables + central branding vars.
    vars.company_name = COMPANY_NAME
    for (const [k, v] of Object.entries(ctx.vars || {})) {
      vars[k] = v == null ? "" : String(v)
    }
    if (!vars.first_name && vars.employee_name) {
      vars.first_name = vars.employee_name.split(" ")[0] || ""
    }

    // Subject/body come from a mapped template or the built-in default.
    let subjectTpl = def.defaultSubject
    let bodyTpl = def.defaultBody
    let usedTemplateId: number | null = null
    if (cfg.template_id) {
      const tplRows = await query<any[]>(
        "SELECT id, subject, body FROM hr_email_templates WHERE id = ? AND status = 'Active' LIMIT 1",
        [cfg.template_id],
      )
      if (tplRows[0]) {
        subjectTpl = tplRows[0].subject
        bodyTpl = tplRows[0].body
        usedTemplateId = Number(tplRows[0].id)
      }
    }

    const subject = renderTemplate(subjectTpl, vars).trim()
    const innerBody = renderTemplate(bodyTpl, vars)
    // Wrap default templates in branding; custom templates are used as-is.
    const body = usedTemplateId ? innerBody : brandedHtml(innerBody)
    if (!subject || !body.trim()) return

    // CC the reporting manager when configured.
    let cc: string | null = null
    if (cfg.cc_manager) {
      const managerEmail = await resolveManagerEmail(ctx.managerName ?? vars.reporting_manager)
      if (managerEmail && managerEmail.toLowerCase() !== toEmail.toLowerCase()) cc = managerEmail
    }

    // Deterministic dedupe: same event + record + recipient never double-sends.
    const dedupeKey = buildDedupeKey("auto", eventKey, ctx.sourceRecordId, toEmail)

    await createHrEmail({
      employeeId: ctx.employeeId ?? null,
      toEmail,
      toName,
      cc,
      subject,
      body,
      templateId: usedTemplateId,
      category: def.category,
      sourceModule: def.module,
      sourceRecordId: ctx.sourceRecordId ?? null,
      emailType: "Automated",
      mode: "send",
      createdBy: ctx.actorId ?? null,
      dedupeKey,
      render: false,
    })
  } catch (error) {
    console.log(`[v0] emitHrEmailEvent(${eventKey}) failed:`, (error as Error).message)
  }
}
