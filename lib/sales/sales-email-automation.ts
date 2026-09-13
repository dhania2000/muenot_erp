import { query } from "@/lib/db"
import { renderEmailTemplate } from "@/lib/sales/email-template-engine"
import {
  ensureSalesEmailScheduleSchema,
  sendScheduledSalesEmailRow,
} from "@/lib/sales/sales-email-scheduler"
import { buildRecipientKey, generateTrackingToken } from "@/lib/email"
import type { SalesEmailCategory } from "@/lib/sales/sales-email-shared"

/**
 * Event-driven Sales email automation — the sales counterpart of
 * lib/hr-email-automation.ts.
 *
 * A sales workflow (lead won/lost, follow-up due, quotation sent, ...) calls
 * `emitSalesEmailEvent(...)` after a state change. This module maps the event
 * to a template (a sales_email_templates row when configured, otherwise a
 * built-in default), resolves the recipient + variables, and hands the composed
 * message to the same sales_emails pipeline used by the manual composer — so
 * automated mail lands in one table with tracking, dedupe and history.
 *
 * Design rules:
 *  - Every event is individually enable/disable-able.
 *  - All events ship DISABLED by default (opt-in); nothing auto-sends until an
 *    admin turns it on in the Automation tab.
 *  - Sends are idempotent via a deterministic dedupe key.
 *  - Failures never bubble up into the host workflow (fire-and-forget).
 */

export type SalesEmailEventKey =
  | "lead_created"
  | "lead_won"
  | "lead_lost"
  | "followup_due"
  | "quotation_sent"
  | "onboarding_started"

type EventDef = {
  key: SalesEmailEventKey
  label: string
  group: string
  category: SalesEmailCategory
  module: string
  defaultSubject: string
  /** Inner HTML, wrapped in central branding at render time. */
  defaultBody: string
  /** Variable names available to this event's template, for the settings UI. */
  variables: string[]
}

const COMMON_VARS = ["contact_person", "company_name", "email", "designation", "country"]

const COMPANY_NAME = process.env.COMPANY_NAME || "Muenot"

function brandedHtml(inner: string): string {
  return `<div style="font-family:Arial,Helvetica,sans-serif;color:#1f2937;max-width:600px;margin:0 auto;line-height:1.6">
  <div style="padding:16px 0;border-bottom:2px solid #e5e7eb;font-size:18px;font-weight:700;color:#111827">${COMPANY_NAME} · Sales</div>
  <div style="padding:20px 0;font-size:14px">${inner}</div>
  <div style="padding:16px 0;border-top:1px solid #e5e7eb;font-size:12px;color:#6b7280">
    This is an automated message from the ${COMPANY_NAME} sales team.
  </div>
</div>`
}

const p = (text: string) => `<p style="margin:0 0 12px">${text}</p>`

// ---------------------------------------------------------------------------
// Event catalog — the single source of truth for automated sales mail.
// ---------------------------------------------------------------------------
export const SALES_EMAIL_EVENTS: Record<SalesEmailEventKey, EventDef> = {
  lead_created: {
    key: "lead_created",
    label: "New lead created",
    group: "Lifecycle",
    category: "Introduction",
    module: "leads",
    defaultSubject: "Thanks for connecting with {{company_name}}",
    defaultBody:
      p("Hi {{contact_person}},") +
      p("Thank you for your interest. We&apos;ve received your details and a member of our team will reach out shortly.") +
      p("We look forward to working with you."),
    variables: [...COMMON_VARS],
  },
  lead_won: {
    key: "lead_won",
    label: "Lead marked won",
    group: "Lifecycle",
    category: "Thank You",
    module: "leads",
    defaultSubject: "Welcome aboard, {{contact_person}}!",
    defaultBody:
      p("Hi {{contact_person}},") +
      p("We&apos;re thrilled to have {{company_name}} on board. Our team will be in touch with the next steps.") +
      p("Thank you for choosing us."),
    variables: [...COMMON_VARS],
  },
  lead_lost: {
    key: "lead_lost",
    label: "Lead marked lost",
    group: "Lifecycle",
    category: "Nurture",
    module: "leads",
    defaultSubject: "We&apos;d still love to help, {{contact_person}}",
    defaultBody:
      p("Hi {{contact_person}},") +
      p("We understand now may not be the right time. Should anything change, we&apos;d be glad to pick the conversation back up.") +
      p("Wishing {{company_name}} all the best."),
    variables: [...COMMON_VARS],
  },
  followup_due: {
    key: "followup_due",
    label: "Follow-up reminder due",
    group: "Engagement",
    category: "Follow Up",
    module: "followups",
    defaultSubject: "Following up on our conversation",
    defaultBody:
      p("Hi {{contact_person}},") +
      p("Just circling back on our recent conversation. Let me know if you have any questions or if there&apos;s anything I can help with."),
    variables: [...COMMON_VARS, "followup_note", "due_date"],
  },
  quotation_sent: {
    key: "quotation_sent",
    label: "Quotation sent",
    group: "Engagement",
    category: "Quotation",
    module: "quotations",
    defaultSubject: "Your quotation from {{company_name}}",
    defaultBody:
      p("Hi {{contact_person}},") +
      p("Please find your quotation attached. Feel free to reach out with any questions."),
    variables: [...COMMON_VARS, "quotation_id", "amount"],
  },
  onboarding_started: {
    key: "onboarding_started",
    label: "Onboarding started",
    group: "Lifecycle",
    category: "Onboarding",
    module: "onboarding",
    defaultSubject: "Getting started with {{company_name}}",
    defaultBody:
      p("Hi {{contact_person}},") +
      p("Welcome! Your onboarding has started. We&apos;ll guide you through each step to get you up and running."),
    variables: [...COMMON_VARS],
  },
}

export const SALES_EMAIL_EVENT_KEYS = Object.keys(SALES_EMAIL_EVENTS) as SalesEmailEventKey[]

// ---------------------------------------------------------------------------
// Schema — extra sales_emails columns (for categories/automation/analytics)
// plus the per-event config table. Self-healing, safe to call repeatedly.
// ---------------------------------------------------------------------------
let ensured: Promise<void> | null = null

export function ensureSalesEmailHubSchema(): Promise<void> {
  if (!ensured) ensured = doEnsure()
  return ensured
}

async function ensureColumn(table: string, column: string, definition: string) {
  const rows = await query<any[]>(
    `SELECT 1 FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ? LIMIT 1`,
    [table, column],
  )
  if (rows.length === 0) {
    await query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`)
  }
}

async function doEnsure() {
  // Scheduling columns + expanded status enum come from the scheduler helper.
  await ensureSalesEmailScheduleSchema()

  // Hub metadata columns used by categories, automation and analytics.
  await ensureColumn("sales_emails", "category", "VARCHAR(40) NOT NULL DEFAULT 'General'")
  await ensureColumn("sales_emails", "email_type", "VARCHAR(12) NOT NULL DEFAULT 'Manual'")
  await ensureColumn("sales_emails", "source_module", "VARCHAR(60) NOT NULL DEFAULT 'manual'")
  await ensureColumn("sales_emails", "source_record_id", "VARCHAR(80) DEFAULT NULL")
  await ensureColumn("sales_emails", "cc", "VARCHAR(500) DEFAULT NULL")
  await ensureColumn("sales_emails", "bcc", "VARCHAR(500) DEFAULT NULL")

  await query(
    `CREATE TABLE IF NOT EXISTS sales_email_automations (
      event_key   VARCHAR(60)  NOT NULL PRIMARY KEY,
      enabled     TINYINT(1)   NOT NULL DEFAULT 0,
      template_id INT UNSIGNED NULL,
      updated_by  INT UNSIGNED NULL,
      updated_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  )
  // Seed any missing events — DISABLED by default (opt-in automation).
  for (const key of SALES_EMAIL_EVENT_KEYS) {
    await query("INSERT IGNORE INTO sales_email_automations (event_key, enabled) VALUES (?, 0)", [key])
  }
}

export type SalesEmailAutomationConfig = {
  event_key: SalesEmailEventKey
  enabled: boolean
  template_id: number | null
}

export async function getSalesAutomationConfig(
  key: SalesEmailEventKey,
): Promise<SalesEmailAutomationConfig> {
  await ensureSalesEmailHubSchema()
  const rows = await query<any[]>(
    "SELECT event_key, enabled, template_id FROM sales_email_automations WHERE event_key = ? LIMIT 1",
    [key],
  )
  const row = rows[0]
  if (!row) return { event_key: key, enabled: false, template_id: null }
  return {
    event_key: key,
    enabled: !!row.enabled,
    template_id: row.template_id == null ? null : Number(row.template_id),
  }
}

export async function listSalesAutomationConfigs() {
  await ensureSalesEmailHubSchema()
  const rows = await query<any[]>(
    "SELECT event_key, enabled, template_id, updated_at FROM sales_email_automations",
  )
  const byKey = new Map(rows.map((r) => [r.event_key, r]))
  return SALES_EMAIL_EVENT_KEYS.map((key) => {
    const def = SALES_EMAIL_EVENTS[key]
    const row = byKey.get(key)
    return {
      event_key: key,
      label: def.label,
      group: def.group,
      category: def.category,
      module: def.module,
      variables: def.variables,
      default_subject: def.defaultSubject,
      enabled: row ? !!row.enabled : false,
      template_id: row && row.template_id != null ? Number(row.template_id) : null,
      updated_at: row?.updated_at ?? null,
    }
  })
}

export async function updateSalesAutomationConfig(
  key: SalesEmailEventKey,
  patch: { enabled?: boolean; template_id?: number | null },
  updatedBy?: number | null,
): Promise<boolean> {
  if (!SALES_EMAIL_EVENTS[key]) return false
  await ensureSalesEmailHubSchema()
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
  if (!sets.length) return false
  sets.push("updated_by = ?")
  args.push(updatedBy ?? null)
  await query(`UPDATE sales_email_automations SET ${sets.join(", ")} WHERE event_key = ?`, [...args, key])
  return true
}

// ---------------------------------------------------------------------------
// The emitter
// ---------------------------------------------------------------------------
export type SalesEmailEventContext = {
  /** Linked sales_leads.id, used to resolve recipient + variables. */
  leadId?: number | null
  /** Explicit recipient when there is no lead (or to override it). */
  toEmail?: string | null
  toName?: string | null
  /** Human-facing source record identifier (e.g. quotation id). */
  sourceRecordId?: string | null
  /** Extra {{variables}} resolved from the source record. */
  vars?: Record<string, string | number | null | undefined>
  /** Who triggered the workflow (stored as sent_by). */
  actorId?: number | null
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/**
 * Fire an automated sales email for `eventKey`. Fully guarded — any failure is
 * logged and swallowed so it can never break the workflow that triggered it.
 */
export async function emitSalesEmailEvent(
  eventKey: SalesEmailEventKey,
  ctx: SalesEmailEventContext,
): Promise<void> {
  try {
    const def = SALES_EMAIL_EVENTS[eventKey]
    if (!def) return

    await ensureSalesEmailHubSchema()
    const cfg = await getSalesAutomationConfig(eventKey)
    if (!cfg.enabled) return // opt-in: disabled events never send

    // Resolve recipient + base variables.
    let toEmail = (ctx.toEmail || "").trim()
    let toName = ctx.toName ?? null
    let vars: Record<string, string> = {}

    if (ctx.leadId) {
      const leadRows = await query<any[]>(
        `SELECT contact_person, company_name, email, company_email, designation, country
         FROM sales_leads WHERE id = ? LIMIT 1`,
        [ctx.leadId],
      )
      const lead = leadRows[0]
      if (lead) {
        if (!toEmail) toEmail = String(lead.email || lead.company_email || "").trim()
        if (!toName) toName = lead.contact_person || null
        for (const [k, v] of Object.entries(lead)) vars[k] = v == null ? "" : String(v)
      }
    }
    if (!EMAIL_RE.test(toEmail)) return

    vars.company_name = vars.company_name || COMPANY_NAME
    for (const [k, v] of Object.entries(ctx.vars || {})) {
      vars[k] = v == null ? "" : String(v)
    }

    // Subject/body from a mapped template or the built-in default.
    let subjectTpl = def.defaultSubject
    let bodyTpl = def.defaultBody
    let usedTemplateId: number | null = null
    if (cfg.template_id) {
      const tplRows = await query<any[]>(
        "SELECT id, subject, body FROM sales_email_templates WHERE id = ? LIMIT 1",
        [cfg.template_id],
      )
      if (tplRows[0]) {
        subjectTpl = tplRows[0].subject
        bodyTpl = tplRows[0].body
        usedTemplateId = Number(tplRows[0].id)
      }
    }

    const subject = renderEmailTemplate(subjectTpl, vars).trim()
    const innerBody = renderEmailTemplate(bodyTpl, vars)
    const body = usedTemplateId ? innerBody : brandedHtml(innerBody)
    if (!subject || !body.trim()) return

    // Deterministic dedupe: same event + record + recipient never double-sends.
    const dedupeKey = `auto:${eventKey}:${ctx.sourceRecordId ?? ""}:${toEmail.toLowerCase()}`.slice(0, 80)
    const existing = await query<any[]>(
      "SELECT id FROM sales_emails WHERE idempotency_key = ? LIMIT 1",
      [dedupeKey],
    )
    if (existing[0]) return

    const token = generateTrackingToken()
    const recipientKey = buildRecipientKey(ctx.leadId ?? null, toEmail)

    // Insert as a Queued row and dispatch immediately via the scheduler path so
    // threading/tracking match the manual + scheduled flows.
    const result = await query<any>(
      `INSERT INTO sales_emails
         (lead_id, template_id, to_email, to_name, subject, body, tracking_token,
          status, sent_by, recipient_key, mail_type, idempotency_key,
          category, email_type, source_module, source_record_id, department)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'Queued', ?, ?, 'new', ?, ?, 'Automated', ?, ?, 'sales')`,
      [
        ctx.leadId ?? null,
        usedTemplateId,
        toEmail,
        toName,
        subject,
        body,
        token,
        ctx.actorId ?? null,
        recipientKey,
        dedupeKey,
        def.category,
        def.module,
        ctx.sourceRecordId ?? null,
      ],
    )
    await sendScheduledSalesEmailRow(Number(result.insertId))
  } catch (error) {
    console.log(`[v0] emitSalesEmailEvent(${eventKey}) failed:`, (error as Error).message)
  }
}
