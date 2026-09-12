import "server-only"
import crypto from "crypto"
import { query } from "@/lib/db"
import { nextRecordId } from "@/lib/record-ids"
import { ensureLetterTables, getCompanySettings } from "@/lib/hr-letters-db"
import { renderLetterTemplate } from "@/lib/hr-letters-render"
import {
  eventByKey,
  type GeneratedLetter,
  type LetterSource,
  type LetterStatus,
  type LetterTemplate,
} from "@/lib/hr-letters-shared"

// ---------------------------------------------------------------------------
// HR Letters — generation orchestrator + source context builders (server-only).
//
// Turns a template (or ad-hoc subject/body) plus a business record into a
// finished, numbered letter. Context builders translate promotion / offboarding
// / recruitment / employee records into the flat variable map the render engine
// consumes, using the exact token names declared in hr-letters-shared.
// ---------------------------------------------------------------------------

export type LetterContext = {
  vars: Record<string, string>
  recipientName: string | null
  recipientMeta: string | null
  employee: Record<string, any> | null
}

function fmtDate(value: unknown): string {
  if (!value) return ""
  const d = value instanceof Date ? value : new Date(String(value))
  if (Number.isNaN(d.getTime())) return String(value)
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "long", year: "numeric" })
}

function str(value: unknown): string {
  return value == null ? "" : String(value)
}

/** First non-empty value among candidate keys in a settings/record map. */
function pick(map: Record<string, any>, ...keys: string[]): string {
  for (const k of keys) {
    const v = map?.[k]
    if (v != null && String(v).trim() !== "") return String(v)
  }
  return ""
}

async function resolveMasterName(table: string, id: unknown): Promise<string> {
  if (!id) return ""
  try {
    const rows = await query<any[]>(`SELECT name FROM ${table} WHERE id = ? LIMIT 1`, [id])
    return str(rows[0]?.name)
  } catch {
    return ""
  }
}

function companyVars(settings: Record<string, string>): Record<string, string> {
  return {
    company_name: pick(settings, "company_name", "org_name", "organization_name", "name", "legal_name"),
    company_email: pick(settings, "company_email", "email", "contact_email", "support_email"),
    company_phone: pick(settings, "company_phone", "phone", "contact_phone", "mobile"),
    company_address: pick(settings, "company_address", "address", "registered_address", "office_address"),
  }
}

async function employeeVars(employeeId: number): Promise<{ vars: Record<string, string>; row: any | null }> {
  const rows = await query<any[]>("SELECT * FROM hr_employees WHERE id = ? LIMIT 1", [employeeId])
  const e = rows[0]
  if (!e) return { vars: {}, row: null }
  return {
    row: e,
    vars: {
      employee_name: str(e.employee_name),
      employee_code: str(e.employee_id),
      designation: str(e.designation),
      department: str(e.department),
      joining_date: fmtDate(e.joining_date),
      confirmation_date: fmtDate(e.confirmation_date ?? e.probation_end_date),
      official_email: str(e.official_email),
      personal_email: str(e.personal_email),
      mobile: str(e.mobile),
      work_location: str(e.work_location),
      employment_type: str(e.employment_type),
      reporting_manager: str(e.reporting_manager),
      employee_grade: str(e.employee_grade ?? e.grade ?? e.band),
    },
  }
}

async function promotionVars(sourceRef: string): Promise<Record<string, string>> {
  try {
    const rows = await query<any[]>(
      "SELECT * FROM hr_promotions WHERE promotion_id = ? OR promotion_code = ? LIMIT 1",
      [sourceRef, sourceRef],
    )
    const p = rows[0]
    if (!p) return {}
    const [prevDes, newDes, prevDep, newDep] = await Promise.all([
      resolveMasterName("hr_designations", p.old_designation_id),
      resolveMasterName("hr_designations", p.new_designation_id),
      resolveMasterName("hr_departments", p.old_department_id),
      resolveMasterName("hr_departments", p.new_department_id),
    ])
    return {
      previous_designation: prevDes,
      new_designation: newDes,
      previous_department: prevDep,
      new_department: newDep,
      previous_salary: str(p.old_salary),
      new_salary: str(p.new_salary),
      effective_date: fmtDate(p.effective_date),
    }
  } catch {
    return {}
  }
}

async function offboardingVars(sourceRef: string): Promise<Record<string, string>> {
  try {
    const rows = await query<any[]>(
      "SELECT * FROM hr_offboarding WHERE offboarding_id = ? OR id = ? LIMIT 1",
      [sourceRef, sourceRef],
    )
    const o = rows[0]
    if (!o) return {}
    let notice = ""
    if (o.notice_period_days != null) notice = `${o.notice_period_days} days`
    else if (o.notice_date && o.last_working_date) {
      const from = new Date(o.notice_date).getTime()
      const to = new Date(o.last_working_date).getTime()
      if (!Number.isNaN(from) && !Number.isNaN(to) && to >= from) {
        notice = `${Math.round((to - from) / 86400000)} days`
      }
    }
    return {
      exit_date: fmtDate(o.last_working_date ?? o.exit_date),
      exit_reason: str(o.exit_reason ?? o.exit_type),
      notice_period: notice,
      tenure: str(o.tenure ?? ""),
    }
  } catch {
    return {}
  }
}

async function recruitmentVars(sourceRef: string): Promise<{ vars: Record<string, string>; recipientName: string | null }> {
  try {
    const rows = await query<any[]>(
      "SELECT * FROM recruit_offers WHERE offer_id = ? OR id = ? LIMIT 1",
      [sourceRef, sourceRef],
    )
    const o = rows[0]
    if (!o) return { vars: {}, recipientName: null }
    const salary = [str(o.salary), str(o.currency)].filter(Boolean).join(" ")
    return {
      vars: {
        candidate_name: str(o.candidate_name),
        offered_designation: str(o.job_title),
        offered_department: str(o.department ?? ""),
        offered_salary: salary,
        proposed_joining_date: fmtDate(o.joining_date),
        offer_valid_till: fmtDate(o.expiry_date),
      },
      recipientName: str(o.candidate_name) || null,
    }
  } catch {
    return { vars: {}, recipientName: null }
  }
}

/**
 * Build the flat variable map for a letter from the employee/company records
 * plus any event-source record. `letterNumber`/`issueDate` fill the letter
 * group tokens. `extraVars` (manual overrides) win over everything.
 */
export async function buildLetterContext(opts: {
  source: LetterSource
  employeeId?: number | null
  sourceRef?: string | null
  letterNumber?: string
  issueDate?: string | null
  extraVars?: Record<string, string>
}): Promise<LetterContext> {
  const settings = await getCompanySettings()
  const vars: Record<string, string> = { ...companyVars(settings) }

  const now = new Date()
  vars.letter_number = opts.letterNumber || ""
  vars.letter_date = fmtDate(opts.issueDate || now)
  vars.today = fmtDate(now)

  let recipientName: string | null = null
  let recipientMeta: string | null = null
  let employee: any | null = null

  if (opts.employeeId) {
    const { vars: ev, row } = await employeeVars(opts.employeeId)
    Object.assign(vars, ev)
    employee = row
    if (row) {
      recipientName = str(row.employee_name) || null
      recipientMeta = [str(row.employee_id), [str(row.designation), str(row.department)].filter(Boolean).join(", ")]
        .filter(Boolean)
        .join(" · ")
    }
  }

  if (opts.sourceRef) {
    if (opts.source === "promotion") Object.assign(vars, await promotionVars(opts.sourceRef))
    else if (opts.source === "offboarding") Object.assign(vars, await offboardingVars(opts.sourceRef))
    else if (opts.source === "recruitment") {
      const { vars: rv, recipientName: rn } = await recruitmentVars(opts.sourceRef)
      Object.assign(vars, rv)
      if (rn) {
        recipientName = rn
        recipientMeta = [rv.offered_designation, rv.offered_department].filter(Boolean).join(", ") || null
      }
    }
  }

  if (opts.extraVars) {
    for (const [k, v] of Object.entries(opts.extraVars)) {
      if (v != null && String(v).trim() !== "") vars[k] = String(v)
    }
  }

  return { vars, recipientName, recipientMeta, employee }
}

export async function getTemplateForGeneration(templateId: number): Promise<LetterTemplate | null> {
  await ensureLetterTables()
  const rows = await query<any[]>("SELECT * FROM hr_letter_templates WHERE id = ? LIMIT 1", [templateId])
  const t = rows[0]
  if (!t) return null
  return {
    ...t,
    required_variables: parseJsonArray(t.required_variables),
  } as LetterTemplate
}

function parseJsonArray(value: unknown): string[] | null {
  if (!value) return null
  if (Array.isArray(value)) return value as string[]
  try {
    const parsed = JSON.parse(String(value))
    return Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

export type GenerateLetterInput = {
  templateId?: number | null
  subjectOverride?: string | null
  bodyOverride?: string | null
  letterType?: string | null
  category?: string | null
  audience?: string | null
  eventKey?: string | null
  source?: LetterSource | null
  sourceRef?: string | null
  employeeId?: number | null
  issueDate?: string | null
  status?: LetterStatus
  extraVars?: Record<string, string>
  supersedesId?: number | null
  actorId?: number | null
  /** Skip the required-variable completeness check (draft-friendly). */
  allowMissing?: boolean
}

export type GenerateLetterResult =
  | { ok: true; letter: GeneratedLetter; deduped?: boolean }
  | { ok: false; error: string; code?: number; missing?: string[] }

/** Core orchestrator: render, number, persist and link a letter. */
export async function generateLetter(input: GenerateLetterInput): Promise<GenerateLetterResult> {
  await ensureLetterTables()

  const template = input.templateId ? await getTemplateForGeneration(input.templateId) : null
  if (input.templateId && !template) return { ok: false, error: "Template not found", code: 404 }

  const eventKey = input.eventKey || template?.event_key || "manual"
  const source = (input.source || (template ? (eventByKey(template.event_key).source as LetterSource) : null) || eventByKey(eventKey).source) as LetterSource
  const subjectTpl = input.subjectOverride ?? template?.subject ?? ""
  const bodyTpl = input.bodyOverride ?? template?.body ?? ""
  if (!subjectTpl.trim() || !bodyTpl.trim()) {
    return { ok: false, error: "A template or subject and body are required", code: 400 }
  }

  const letterType = input.letterType || template?.letter_type || "Other"
  const category = input.category || template?.category || "General"
  const audience = input.audience || template?.audience || "Employee"
  const issueDate = (input.issueDate || new Date().toISOString().slice(0, 10)).slice(0, 10)

  const letterNumber = await nextRecordId("LTR")

  const context = await buildLetterContext({
    source,
    employeeId: input.employeeId,
    sourceRef: input.sourceRef,
    letterNumber,
    issueDate,
    extraVars: input.extraVars,
  })

  // Required-variable completeness (from the template definition).
  if (!input.allowMissing && template?.required_variables?.length) {
    const missing = template.required_variables.filter((token) => {
      const base = token.split(".")[0]
      const v = context.vars[base] ?? context.vars[token]
      return v == null || String(v).trim() === ""
    })
    if (missing.length) return { ok: false, error: "Missing required values", code: 422, missing }
  }

  const subject = renderLetterTemplate(subjectTpl, context.vars)
  const body = renderLetterTemplate(bodyTpl, context.vars)
  const status: LetterStatus = input.status || "Generated"

  // Event letters are deduped by their source record + template; manual repeats
  // are always allowed.
  const dedupeKey =
    source !== "manual" && input.sourceRef
      ? crypto
          .createHash("sha1")
          .update([input.templateId ?? "", input.employeeId ?? "", source, input.sourceRef, eventKey].join("|"))
          .digest("hex")
      : null

  if (dedupeKey) {
    const existing = await query<any[]>(
      "SELECT id FROM hr_letters WHERE dedupe_key = ? AND status <> 'Cancelled' LIMIT 1",
      [dedupeKey],
    )
    if (existing[0]) {
      const letter = await getLetter(Number(existing[0].id))
      if (letter) return { ok: true, letter, deduped: true }
    }
  }

  const result = await query<any>(
    `INSERT INTO hr_letters
      (letter_number, employee_id, template_id, template_version, letter_type, category, audience,
       subject, body, issue_date, status, source, source_ref, event_key, recipient_name,
       supersedes_id, dedupe_key, variables_snapshot, created_by, issued_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, ${status === "Issued" || status === "Delivered" ? "NOW()" : "NULL"})`,
    [
      letterNumber,
      input.employeeId ?? null,
      input.templateId ?? null,
      template?.version ?? null,
      letterType,
      category,
      audience,
      subject,
      body,
      issueDate,
      status,
      source,
      input.sourceRef ?? null,
      eventKey,
      context.recipientName,
      input.supersedesId ?? null,
      dedupeKey,
      JSON.stringify(context.vars),
      input.actorId ?? null,
    ],
  )
  const newId = Number((result as any).insertId)

  // Lineage: link the superseded letter both ways.
  if (input.supersedesId) {
    await query("UPDATE hr_letters SET superseded_by = ?, status = 'Cancelled' WHERE id = ?", [
      newId,
      input.supersedesId,
    ]).catch(() => {})
  }

  // Bump template usage stats.
  if (input.templateId) {
    await query(
      "UPDATE hr_letter_templates SET usage_count = usage_count + 1, last_used_at = NOW() WHERE id = ?",
      [input.templateId],
    ).catch(() => {})
  }

  const letter = await getLetter(newId)
  if (!letter) return { ok: false, error: "Failed to load created letter", code: 500 }
  return { ok: true, letter }
}

/** Load a single letter with employee display fields joined. */
export async function getLetter(id: number): Promise<GeneratedLetter | null> {
  await ensureLetterTables()
  const rows = await query<any[]>(
    `SELECT l.*, e.employee_name, e.employee_id AS employee_code, e.designation, e.department
       FROM hr_letters l LEFT JOIN hr_employees e ON e.id = l.employee_id
      WHERE l.id = ? LIMIT 1`,
    [id],
  )
  const row = rows[0]
  if (!row) return null
  return { ...row, variables_snapshot: undefined } as GeneratedLetter
}

/** Re-run generation for an existing letter, superseding it with a fresh copy. */
export async function regenerateLetter(id: number, actorId?: number | null): Promise<GenerateLetterResult> {
  const rows = await query<any[]>("SELECT * FROM hr_letters WHERE id = ? LIMIT 1", [id])
  const prev = rows[0]
  if (!prev) return { ok: false, error: "Letter not found", code: 404 }
  return generateLetter({
    templateId: prev.template_id,
    subjectOverride: prev.template_id ? null : prev.subject,
    bodyOverride: prev.template_id ? null : prev.body,
    letterType: prev.letter_type,
    category: prev.category,
    audience: prev.audience,
    eventKey: prev.event_key,
    source: prev.source,
    sourceRef: prev.source_ref,
    employeeId: prev.employee_id,
    issueDate: new Date().toISOString().slice(0, 10),
    status: "Generated",
    supersedesId: id,
    actorId: actorId ?? null,
    allowMissing: true,
  })
}
