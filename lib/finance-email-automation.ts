import { query } from "@/lib/db"
import { renderTemplate } from "@/lib/email"
import {
  buildDedupeKey,
  createFinanceEmail,
  ensureFinanceEmailHubSchema,
  isValidEmail,
  resolvePartyRecipient,
} from "@/lib/finance-email"
import type { FinanceEmailCategory } from "@/lib/finance-email-shared"

/**
 * Event-driven finance email automation — the finance-side mirror of
 * lib/hr-email-automation.ts.
 *
 * Finance workflows (invoicing, receipts, reminders, statements, purchase
 * bills, vendor payments, TDS certificates, ...) call `emitFinanceEmailEvent`
 * after a state change. This module maps the event to a template (a
 * finance_email_templates row when configured, otherwise a built-in default),
 * resolves the party recipient + variables, and hands the composed message to
 * the same `createFinanceEmail` pipeline used by the manual composer — so
 * automated mail lands in the one `finance_emails` table with tracking,
 * dedupe and history.
 *
 * Design rules mirrored from HR:
 *  - No full email bodies are hard-coded inside module handlers.
 *  - Every event is individually enable/disable-able.
 *  - Sends are idempotent via a deterministic dedupe key.
 *  - Failures never bubble up into the host workflow (fire-and-forget).
 */

export type FinanceEmailEventKey =
  | "invoice_issued"
  | "invoice_overdue"
  | "payment_received"
  | "payment_reminder"
  | "statement_sent"
  | "purchase_order_sent"
  | "purchase_bill_recorded"
  | "vendor_payment_made"
  | "tds_certificate_issued"

type EventDef = {
  key: FinanceEmailEventKey
  label: string
  group: string
  category: FinanceEmailCategory
  module: string
  ccAccountsDefault: boolean
  defaultSubject: string
  /** Inner HTML (wrapped in central branding at render time). */
  defaultBody: string
  /** Variable names available to this event's template, for the settings UI. */
  variables: string[]
}

const COMMON_VARS = ["party_name", "first_name", "party_id", "gstin", "pan", "company_name"]

// ---------------------------------------------------------------------------
// Central branding wrapper — one place, not per workflow.
// ---------------------------------------------------------------------------
const COMPANY_NAME = process.env.COMPANY_NAME || "Muenot"

function brandedHtml(inner: string): string {
  return `<div style="font-family:Arial,Helvetica,sans-serif;color:#1f2937;max-width:600px;margin:0 auto;line-height:1.6">
  <div style="padding:16px 0;border-bottom:2px solid #e5e7eb;font-size:18px;font-weight:700;color:#111827">${COMPANY_NAME} · Finance</div>
  <div style="padding:20px 0;font-size:14px">${inner}</div>
  <div style="padding:16px 0;border-top:1px solid #e5e7eb;font-size:12px;color:#6b7280">
    This is an automated message from the ${COMPANY_NAME} accounts team. Please do not reply directly to this email.
  </div>
</div>`
}

const p = (text: string) => `<p style="margin:0 0 12px">${text}</p>`

// ---------------------------------------------------------------------------
// Event catalog — the single source of truth for automated finance mail.
// ---------------------------------------------------------------------------
export const FINANCE_EMAIL_EVENTS: Record<FinanceEmailEventKey, EventDef> = {
  invoice_issued: {
    key: "invoice_issued",
    label: "Sales invoice issued",
    group: "Sales",
    category: "Invoice",
    module: "sales-invoices",
    ccAccountsDefault: false,
    defaultSubject: "Invoice {{invoice_no}} from {{company_name}}",
    defaultBody:
      p("Dear {{party_name}},") +
      p("Please find your invoice <strong>{{invoice_no}}</strong> dated {{invoice_date}} for <strong>{{amount}}</strong>, due on {{due_date}}.") +
      p("We appreciate your business. Kindly remit payment by the due date."),
    variables: [...COMMON_VARS, "invoice_no", "invoice_date", "due_date", "amount", "balance_due"],
  },
  invoice_overdue: {
    key: "invoice_overdue",
    label: "Invoice overdue notice",
    group: "Sales",
    category: "Dunning",
    module: "sales-invoices",
    ccAccountsDefault: true,
    defaultSubject: "Overdue: Invoice {{invoice_no}} ({{days_overdue}} days)",
    defaultBody:
      p("Dear {{party_name}},") +
      p("Our records show invoice <strong>{{invoice_no}}</strong> for {{amount}} was due on {{due_date}} and is now <strong>{{days_overdue}} day(s) overdue</strong>.") +
      p("Please arrange payment of the outstanding balance {{balance_due}} at the earliest, or reply if this has already been settled."),
    variables: [...COMMON_VARS, "invoice_no", "invoice_date", "due_date", "amount", "balance_due", "days_overdue"],
  },
  payment_received: {
    key: "payment_received",
    label: "Payment received / receipt",
    group: "Sales",
    category: "Receipt",
    module: "receipts",
    ccAccountsDefault: false,
    defaultSubject: "Payment received — receipt {{receipt_no}}",
    defaultBody:
      p("Dear {{party_name}},") +
      p("We have received your payment of <strong>{{amount}}</strong> on {{payment_date}} via {{payment_mode}}. Receipt no: <strong>{{receipt_no}}</strong>{{against_invoice}}.") +
      p("Thank you. Your current outstanding balance is {{balance_due}}."),
    variables: [...COMMON_VARS, "receipt_no", "payment_date", "payment_mode", "amount", "balance_due", "invoice_no"],
  },
  payment_reminder: {
    key: "payment_reminder",
    label: "Payment reminder (upcoming due)",
    group: "Sales",
    category: "Payment Reminder",
    module: "sales-invoices",
    ccAccountsDefault: false,
    defaultSubject: "Reminder: Invoice {{invoice_no}} due {{due_date}}",
    defaultBody:
      p("Dear {{party_name}},") +
      p("This is a friendly reminder that invoice <strong>{{invoice_no}}</strong> for {{amount}} is due on <strong>{{due_date}}</strong>.") +
      p("Please disregard this note if payment is already in progress."),
    variables: [...COMMON_VARS, "invoice_no", "invoice_date", "due_date", "amount", "balance_due"],
  },
  statement_sent: {
    key: "statement_sent",
    label: "Account statement sent",
    group: "Sales",
    category: "Statement",
    module: "statements",
    ccAccountsDefault: false,
    defaultSubject: "Your account statement for {{period}}",
    defaultBody:
      p("Dear {{party_name}},") +
      p("Please find your account statement for <strong>{{period}}</strong>. Closing balance: <strong>{{closing_balance}}</strong>.") +
      p("Reach out to our accounts team if you have any questions about the entries."),
    variables: [...COMMON_VARS, "period", "opening_balance", "closing_balance", "total_debit", "total_credit"],
  },
  purchase_order_sent: {
    key: "purchase_order_sent",
    label: "Purchase order sent to vendor",
    group: "Purchase",
    category: "Purchase",
    module: "purchase-orders",
    ccAccountsDefault: true,
    defaultSubject: "Purchase Order {{po_no}} from {{company_name}}",
    defaultBody:
      p("Dear {{party_name}},") +
      p("Please find purchase order <strong>{{po_no}}</strong> dated {{po_date}} for a total of <strong>{{amount}}</strong>.") +
      p("Kindly confirm acceptance and expected delivery date."),
    variables: [...COMMON_VARS, "po_no", "po_date", "amount", "expected_date"],
  },
  purchase_bill_recorded: {
    key: "purchase_bill_recorded",
    label: "Purchase bill recorded",
    group: "Purchase",
    category: "Vendor",
    module: "purchase-bills",
    ccAccountsDefault: true,
    defaultSubject: "Bill {{bill_no}} recorded — {{company_name}}",
    defaultBody:
      p("Dear {{party_name}},") +
      p("We have recorded your bill <strong>{{bill_no}}</strong> dated {{bill_date}} for <strong>{{amount}}</strong>, scheduled for payment by {{due_date}}.") +
      p("Thank you for your continued partnership."),
    variables: [...COMMON_VARS, "bill_no", "bill_date", "due_date", "amount"],
  },
  vendor_payment_made: {
    key: "vendor_payment_made",
    label: "Vendor payment made",
    group: "Purchase",
    category: "Vendor",
    module: "payments",
    ccAccountsDefault: false,
    defaultSubject: "Payment advice {{payment_no}} from {{company_name}}",
    defaultBody:
      p("Dear {{party_name}},") +
      p("We have released a payment of <strong>{{amount}}</strong> on {{payment_date}} via {{payment_mode}} (ref {{payment_no}}){{against_bill}}.") +
      p("Please acknowledge receipt at your convenience."),
    variables: [...COMMON_VARS, "payment_no", "payment_date", "payment_mode", "amount", "bill_no"],
  },
  tds_certificate_issued: {
    key: "tds_certificate_issued",
    label: "TDS certificate issued",
    group: "Compliance",
    category: "TDS",
    module: "tds-filing",
    ccAccountsDefault: false,
    defaultSubject: "TDS certificate for {{period}} — {{company_name}}",
    defaultBody:
      p("Dear {{party_name}},") +
      p("Please find the TDS certificate for <strong>{{period}}</strong>. TDS deducted: <strong>{{tds_amount}}</strong> under section {{section}} on a base of {{base_amount}}.") +
      p("Kindly retain this for your records and tax filing."),
    variables: [...COMMON_VARS, "period", "section", "tds_amount", "base_amount", "certificate_no"],
  },
}

export const FINANCE_EMAIL_EVENT_KEYS = Object.keys(FINANCE_EMAIL_EVENTS) as FinanceEmailEventKey[]

// ---------------------------------------------------------------------------
// Config schema (self-healing, mirrors the migration).
// ---------------------------------------------------------------------------
let ensured: Promise<void> | null = null

export function ensureFinanceEmailAutomationSchema(): Promise<void> {
  if (!ensured) ensured = doEnsure()
  return ensured
}

async function doEnsure() {
  await query(
    `CREATE TABLE IF NOT EXISTS finance_email_automations (
      event_key   VARCHAR(60)  NOT NULL PRIMARY KEY,
      enabled     TINYINT(1)   NOT NULL DEFAULT 1,
      template_id BIGINT UNSIGNED NULL,
      cc_accounts TINYINT(1)   NOT NULL DEFAULT 0,
      updated_by  BIGINT UNSIGNED NULL,
      updated_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  )
  // Seed any missing events with their defaults.
  for (const key of FINANCE_EMAIL_EVENT_KEYS) {
    const def = FINANCE_EMAIL_EVENTS[key]
    await query("INSERT IGNORE INTO finance_email_automations (event_key, enabled, cc_accounts) VALUES (?,1,?)", [
      key,
      def.ccAccountsDefault ? 1 : 0,
    ])
  }
}

export type FinanceEmailAutomationConfig = {
  event_key: FinanceEmailEventKey
  enabled: boolean
  template_id: number | null
  cc_accounts: boolean
}

export async function getAutomationConfig(key: FinanceEmailEventKey): Promise<FinanceEmailAutomationConfig> {
  await ensureFinanceEmailAutomationSchema()
  const rows = await query<any[]>(
    "SELECT event_key, enabled, template_id, cc_accounts FROM finance_email_automations WHERE event_key = ? LIMIT 1",
    [key],
  )
  const def = FINANCE_EMAIL_EVENTS[key]
  const row = rows[0]
  if (!row) {
    return { event_key: key, enabled: true, template_id: null, cc_accounts: def.ccAccountsDefault }
  }
  return {
    event_key: key,
    enabled: !!row.enabled,
    template_id: row.template_id == null ? null : Number(row.template_id),
    cc_accounts: !!row.cc_accounts,
  }
}

export async function listAutomationConfigs() {
  await ensureFinanceEmailAutomationSchema()
  const rows = await query<any[]>(
    "SELECT event_key, enabled, template_id, cc_accounts, updated_at FROM finance_email_automations",
  )
  const byKey = new Map(rows.map((r) => [r.event_key, r]))
  return FINANCE_EMAIL_EVENT_KEYS.map((key) => {
    const def = FINANCE_EMAIL_EVENTS[key]
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
      cc_accounts: row ? !!row.cc_accounts : def.ccAccountsDefault,
      updated_at: row?.updated_at ?? null,
    }
  })
}

export async function updateAutomationConfig(
  key: FinanceEmailEventKey,
  patch: { enabled?: boolean; template_id?: number | null; cc_accounts?: boolean },
  updatedBy?: number | null,
): Promise<boolean> {
  if (!FINANCE_EMAIL_EVENTS[key]) return false
  await ensureFinanceEmailAutomationSchema()
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
  if (typeof patch.cc_accounts === "boolean") {
    sets.push("cc_accounts = ?")
    args.push(patch.cc_accounts ? 1 : 0)
  }
  if (!sets.length) return false
  sets.push("updated_by = ?")
  args.push(updatedBy ?? null)
  await query(`UPDATE finance_email_automations SET ${sets.join(", ")} WHERE event_key = ?`, [...args, key])
  return true
}

// ---------------------------------------------------------------------------
// Accounts inbox resolution (finance equivalent of HR's "CC manager").
// ---------------------------------------------------------------------------
function resolveAccountsEmail(): string | null {
  const email = (process.env.FINANCE_ACCOUNTS_EMAIL || process.env.ACCOUNTS_EMAIL || "").trim()
  return isValidEmail(email) ? email : null
}

// ---------------------------------------------------------------------------
// The emitter
// ---------------------------------------------------------------------------
export type FinanceEmailEventContext = {
  /** Numeric customers_vendors.id of the primary recipient. */
  partyId?: number | null
  /** Explicit recipient when there is no party record (external). */
  toEmail?: string | null
  toName?: string | null
  /** Human-facing source record identifier (e.g. INV-2026-0015). */
  sourceRecordId?: string | null
  /** Extra {{variables}} resolved from the source record. */
  vars?: Record<string, string | number | null | undefined>
  /** Who triggered the workflow (stored as created_by). */
  actorId?: number | null
}

/**
 * Fire an automated finance email for `eventKey`. Fully guarded — any failure
 * is logged and swallowed so it can never break the workflow that triggered it.
 */
export async function emitFinanceEmailEvent(
  eventKey: FinanceEmailEventKey,
  ctx: FinanceEmailEventContext,
): Promise<void> {
  try {
    const def = FINANCE_EMAIL_EVENTS[eventKey]
    if (!def) return

    await ensureFinanceEmailHubSchema()
    const cfg = await getAutomationConfig(eventKey)
    if (!cfg.enabled) return

    // Resolve recipient + base variables.
    let toEmail = (ctx.toEmail || "").trim()
    let toName = ctx.toName ?? null
    let vars: Record<string, string> = {}

    if (ctx.partyId) {
      const resolved = await resolvePartyRecipient(ctx.partyId)
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
    if (!vars.first_name && vars.party_name) {
      vars.first_name = vars.party_name.split(" ")[0] || ""
    }

    // Subject/body come from a mapped template or the built-in default.
    let subjectTpl = def.defaultSubject
    let bodyTpl = def.defaultBody
    let usedTemplateId: number | null = null
    if (cfg.template_id) {
      const tplRows = await query<any[]>(
        "SELECT id, subject, body FROM finance_email_templates WHERE id = ? AND status = 'Active' LIMIT 1",
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

    // CC the accounts inbox when configured.
    let cc: string | null = null
    if (cfg.cc_accounts) {
      const accountsEmail = resolveAccountsEmail()
      if (accountsEmail && accountsEmail.toLowerCase() !== toEmail.toLowerCase()) cc = accountsEmail
    }

    // Deterministic dedupe: same event + record + recipient never double-sends.
    const dedupeKey = buildDedupeKey("auto", eventKey, ctx.sourceRecordId, toEmail)

    await createFinanceEmail({
      partyId: ctx.partyId ?? null,
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
    console.log(`[v0] emitFinanceEmailEvent(${eventKey}) failed:`, (error as Error).message)
  }
}
