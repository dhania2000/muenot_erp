/**
 * Central Sales CRM email-template engine.
 *
 * This is the single source of truth for:
 *  - the variable catalog every Sales module can personalize an email with,
 *  - the render pipeline that merges those variables into a subject/body, and
 *  - the sample context used for live previews in the template editor.
 *
 * The renderer is a strict superset of the legacy `renderTemplate` in
 * `lib/email.ts`: a plain `{{contact_person}}` placeholder still resolves the
 * exact same way, so existing templates and the send flow keep working while
 * gaining fallbacks and conditional blocks.
 *
 * Supported syntax:
 *   {{ key }}                 -> value, or "" when missing
 *   {{ key | Default text }}  -> value, or "Default text" when missing/empty
 *   {{#if key}}...{{/if}}     -> body only when key has a non-empty value
 *   {{#unless key}}...{{/unless}} -> body only when key is missing/empty
 * Conditional blocks may be nested.
 */

export type TemplateVariable = {
  /** Placeholder token used inside `{{ }}`. */
  key: string
  /** Human label shown in the variable palette. */
  label: string
  /** Grouping used to organize the palette. */
  group: string
  /** Example value used for live previews. */
  sample: string
  /** Short description of what the value resolves to. */
  description: string
}

export type TemplateVariableGroup = {
  group: string
  variables: TemplateVariable[]
}

/**
 * The full catalog of variables the ERP can actually resolve today, grouped by
 * the entity they come from. Keys map to columns/derived values available in
 * the Sales modules (leads, companies, quotations, contracts, meetings) plus
 * the sending user and organization branding.
 */
export const VARIABLE_CATALOG: TemplateVariable[] = [
  // --- Contact / Lead ---
  { key: "contact_person", label: "Contact name", group: "Contact & Lead", sample: "Priya Sharma", description: "Primary contact person on the lead." },
  { key: "first_name", label: "First name", group: "Contact & Lead", sample: "Priya", description: "First word of the contact's name." },
  { key: "email", label: "Contact email", group: "Contact & Lead", sample: "priya@acme.com", description: "Recipient email address." },
  { key: "designation", label: "Designation", group: "Contact & Lead", sample: "Head of Procurement", description: "Contact's job title." },
  { key: "phone", label: "Phone", group: "Contact & Lead", sample: "+91 98765 43210", description: "Contact phone number." },
  { key: "lead_source", label: "Lead source", group: "Contact & Lead", sample: "Website", description: "Where the lead came from." },
  { key: "lead_status", label: "Lead status", group: "Contact & Lead", sample: "Qualified", description: "Current stage of the lead." },
  { key: "country", label: "Country", group: "Contact & Lead", sample: "India", description: "Contact / company country." },

  // --- Company ---
  { key: "company_name", label: "Company name", group: "Company", sample: "Acme Corporation", description: "The lead or account company." },
  { key: "company_email", label: "Company email", group: "Company", sample: "hello@acme.com", description: "Company-level email address." },
  { key: "industry", label: "Industry", group: "Company", sample: "Manufacturing", description: "Company industry / sector." },
  { key: "website", label: "Website", group: "Company", sample: "acme.com", description: "Company website." },

  // --- Quotation / Deal ---
  { key: "quotation_number", label: "Quotation number", group: "Quotation & Deal", sample: "QT-0042", description: "Reference number of the linked quotation." },
  { key: "quotation_amount", label: "Quotation amount", group: "Quotation & Deal", sample: "₹4,50,000", description: "Total value of the quotation." },
  { key: "quotation_valid_until", label: "Valid until", group: "Quotation & Deal", sample: "30 Sep 2026", description: "Quotation expiry date." },
  { key: "deal_stage", label: "Deal stage", group: "Quotation & Deal", sample: "Proposal", description: "Current pipeline stage." },
  { key: "deal_value", label: "Deal value", group: "Quotation & Deal", sample: "₹4,50,000", description: "Estimated deal value." },

  // --- Contract ---
  { key: "contract_number", label: "Contract number", group: "Contract", sample: "CON-0007", description: "Reference number of the linked contract." },
  { key: "contract_value", label: "Contract value", group: "Contract", sample: "₹12,00,000", description: "Total contract value." },
  { key: "contract_start_date", label: "Start date", group: "Contract", sample: "01 Oct 2026", description: "Contract start date." },
  { key: "contract_end_date", label: "End date", group: "Contract", sample: "30 Sep 2027", description: "Contract end date." },

  // --- Meeting ---
  { key: "meeting_title", label: "Meeting title", group: "Meeting", sample: "Product Demo", description: "Title of the scheduled meeting." },
  { key: "meeting_date", label: "Meeting date", group: "Meeting", sample: "18 Sep 2026", description: "Scheduled meeting date." },
  { key: "meeting_time", label: "Meeting time", group: "Meeting", sample: "3:00 PM IST", description: "Scheduled meeting time." },
  { key: "meeting_link", label: "Meeting link", group: "Meeting", sample: "https://meet.google.com/abc-defg-hij", description: "Video conference / location link." },

  // --- Sender & Organization ---
  { key: "sender_name", label: "Your name", group: "Sender & Org", sample: "Rahul Verma", description: "Name of the user sending the email." },
  { key: "sender_email", label: "Your email", group: "Sender & Org", sample: "rahul@muenot.co.in", description: "Sending user's email address." },
  { key: "sender_designation", label: "Your designation", group: "Sender & Org", sample: "Account Executive", description: "Sending user's job title." },
  { key: "sender_phone", label: "Your phone", group: "Sender & Org", sample: "+91 90000 12345", description: "Sending user's phone." },
  { key: "company_signature", label: "Company signature", group: "Sender & Org", sample: "Muenot Business Team", description: "Organization signature block." },
  { key: "today", label: "Today's date", group: "Sender & Org", sample: "13 Sep 2026", description: "The date the email is sent." },
]

/** Catalog grouped by entity, preserving catalog order within each group. */
export function groupedVariables(): TemplateVariableGroup[] {
  const order: string[] = []
  const map = new Map<string, TemplateVariable[]>()
  for (const v of VARIABLE_CATALOG) {
    if (!map.has(v.group)) {
      map.set(v.group, [])
      order.push(v.group)
    }
    map.get(v.group)!.push(v)
  }
  return order.map((group) => ({ group, variables: map.get(group)! }))
}

/** Sample context (key -> sample value) used to drive the live preview. */
export function sampleContext(): Record<string, string> {
  const ctx: Record<string, string> = {}
  for (const v of VARIABLE_CATALOG) ctx[v.key] = v.sample
  return ctx
}

const KNOWN_KEYS = new Set(VARIABLE_CATALOG.map((v) => v.key))

/** True when a placeholder key is part of the documented catalog. */
export function isKnownVariable(key: string): boolean {
  return KNOWN_KEYS.has(key)
}

/** Extract every distinct placeholder/condition key referenced in a template. */
export function extractVariables(text: string): string[] {
  if (!text) return []
  const keys = new Set<string>()
  const re = /\{\{\s*(?:#(?:if|unless)\s+)?([\w.]+)\s*(?:\|[^}]*)?\}\}/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const key = m[1]
    if (key && key !== "if" && key !== "unless") keys.add(key)
  }
  return [...keys]
}

/** Placeholder keys used in a template that are NOT in the catalog. */
export function unknownVariables(text: string): string[] {
  return extractVariables(text).filter((k) => !isKnownVariable(k))
}

function hasValue(vars: Record<string, unknown>, key: string): boolean {
  const v = vars[key]
  return v != null && String(v).trim() !== ""
}

/**
 * Resolve `{{#if}}` / `{{#unless}}` blocks, innermost first so nesting works.
 * We repeatedly collapse the innermost block (one whose body contains no other
 * block-open tag) until none remain.
 */
function resolveConditionals(text: string, vars: Record<string, unknown>): string {
  const blockRe = /\{\{\s*#(if|unless)\s+([\w.]+)\s*\}\}((?:(?!\{\{\s*#(?:if|unless)\b)[\s\S])*?)\{\{\s*\/\1\s*\}\}/
  let out = text
  let guard = 0
  while (guard++ < 1000) {
    const next = out.replace(blockRe, (_full, kind: string, key: string, body: string) => {
      const present = hasValue(vars, key)
      const keep = kind === "if" ? present : !present
      return keep ? body : ""
    })
    if (next === out) break
    out = next
  }
  return out
}

/** Replace `{{ key }}` and `{{ key | fallback }}` with resolved values. */
function resolvePlaceholders(text: string, vars: Record<string, unknown>): string {
  return text.replace(/\{\{\s*([\w.]+)\s*(?:\|\s*([^}]*?)\s*)?\}\}/g, (_full, key: string, fallback?: string) => {
    const v = vars[key]
    if (v != null && String(v).trim() !== "") return String(v)
    return fallback != null ? fallback : ""
  })
}

/**
 * Render a template string against a variable context. Backward compatible with
 * the legacy `{{field}}` replacement while adding fallbacks and conditionals.
 */
export function renderEmailTemplate(text: string, vars: Record<string, unknown> = {}): string {
  if (!text) return ""
  return resolvePlaceholders(resolveConditionals(text, vars), vars)
}

/** Convenience: render both subject and body in one call. */
export function renderTemplateParts(
  parts: { subject: string; body: string },
  vars: Record<string, unknown> = {},
): { subject: string; body: string } {
  return {
    subject: renderEmailTemplate(parts.subject, vars),
    body: renderEmailTemplate(parts.body, vars),
  }
}

export const TEMPLATE_STATUSES = ["Draft", "Active", "Archived"] as const
export type TemplateStatus = (typeof TEMPLATE_STATUSES)[number]

export const SALES_TEMPLATE_MODULES = [
  "General",
  "Leads",
  "Follow-ups",
  "Companies",
  "Meetings",
  "Quotations",
  "Contracts",
  "Onboarding",
] as const
