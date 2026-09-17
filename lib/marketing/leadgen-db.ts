import "server-only"
import crypto from "crypto"
import { pool, query } from "@/lib/db"
import { nextRecordId } from "@/lib/record-ids"
import {
  ensureContactSchema,
  recordContactActivity,
  normalizeEmail,
  normalizePhone,
  isValidEmail,
  splitName,
  fullNameOf,
} from "@/lib/marketing/contacts-db"
import {
  ensureLeadLifecycleSchema,
  createLead,
  recordAudit,
  notify,
} from "@/lib/sales/lead-lifecycle"

/**
 * Lead Generation service.
 *
 * A `leadgen_forms` row is a public capture surface (embed / hosted page /
 * popup). Each form owns an ordered set of `leadgen_form_fields`, and every
 * public submit becomes a `leadgen_submissions` row.
 *
 * This module is the ONE place that mutates lead-gen state so there is a single
 * source of truth for:
 *   - race-safe form / submission code generation (record_id_sequences)
 *   - a public, unguessable token per form for embedding without auth
 *   - server-side validation, honeypot + rate limiting on the public endpoint
 *   - field -> contact/lead mapping (the single mapping the module trusts)
 *   - submission processing: it NEVER duplicates masters — it upserts the
 *     canonical `marketing_contacts` row and, when configured, hands the lead
 *     to the Sales lead lifecycle via `createLead` (so the sales pipeline,
 *     audit log, notifications and history all stay authoritative)
 *   - append-only audit via the shared sales_audit_log + in-app notifications
 *   - the runtime schema self-heal that mirrors a migration for existing DBs
 */

// ---------------------------------------------------------------------------
// Domain constants
// ---------------------------------------------------------------------------

export const FORM_STATUSES = ["Draft", "Published", "Paused", "Archived"] as const
export type FormStatus = (typeof FORM_STATUSES)[number]

export const FORM_TYPES = ["Embed", "Hosted", "Popup"] as const
export type FormType = (typeof FORM_TYPES)[number]

export const FIELD_TYPES = [
  "text",
  "email",
  "tel",
  "textarea",
  "number",
  "select",
  "checkbox",
  "hidden",
] as const
export type FieldType = (typeof FIELD_TYPES)[number]

export const SUBMISSION_STATUSES = ["New", "Converted", "Spam", "Duplicate"] as const
export type SubmissionStatus = (typeof SUBMISSION_STATUSES)[number]

/**
 * The canonical field mappings a form field may target. These are the ONLY
 * keys the processor will route into the Contacts / Sales masters. Anything
 * else is preserved verbatim in the submission JSON but never written to a
 * master column.
 */
export const FIELD_MAPPINGS = [
  { key: "first_name", label: "First name" },
  { key: "last_name", label: "Last name" },
  { key: "full_name", label: "Full name" },
  { key: "email", label: "Email" },
  { key: "phone", label: "Phone" },
  { key: "company_name", label: "Company" },
  { key: "job_title", label: "Job title / designation" },
  { key: "country", label: "Country" },
  { key: "city", label: "City" },
  { key: "state", label: "State" },
  { key: "website", label: "Website" },
  { key: "message", label: "Message / notes" },
  { key: "budget", label: "Budget / estimated value" },
  { key: "consent", label: "Marketing consent" },
  { key: "none", label: "Do not map (store only)" },
] as const

export type LeadGenForm = {
  id: number
  form_code: string
  public_token: string
  name: string
  description: string | null
  type: FormType
  status: FormStatus
  submit_label: string
  success_message: string | null
  redirect_url: string | null
  theme_color: string | null
  campaign: string | null
  lead_source: string | null
  default_owner_id: number | null
  notify_user_id: number | null
  auto_create_lead: number
  view_count: number
  submission_count: number
  created_by: number | null
  archived_at: string | null
  row_version: number
  created_at: string
  updated_at: string
  [key: string]: unknown
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class FormNotFoundError extends Error {
  constructor(message = "Form not found") {
    super(message)
    this.name = "FormNotFoundError"
  }
}

export class SubmissionRejectedError extends Error {
  status: number
  fields?: Record<string, string>
  constructor(message: string, status = 400, fields?: Record<string, string>) {
    super(message)
    this.name = "SubmissionRejectedError"
    this.status = status
    this.fields = fields
  }
}

// ---------------------------------------------------------------------------
// Runtime schema self-heal (mirrors a migration for existing databases)
// ---------------------------------------------------------------------------

let ensured = false

export async function ensureLeadGenSchema(): Promise<void> {
  if (ensured) return

  await query(
    `CREATE TABLE IF NOT EXISTS leadgen_forms (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      form_code VARCHAR(40) NOT NULL,
      public_token VARCHAR(48) NOT NULL,
      name VARCHAR(190) NOT NULL,
      description VARCHAR(500) NULL,
      type ENUM('Embed','Hosted','Popup') NOT NULL DEFAULT 'Hosted',
      status ENUM('Draft','Published','Paused','Archived') NOT NULL DEFAULT 'Draft',
      submit_label VARCHAR(80) NOT NULL DEFAULT 'Submit',
      success_message VARCHAR(500) NULL,
      redirect_url VARCHAR(500) NULL,
      theme_color VARCHAR(20) NULL,
      campaign VARCHAR(190) NULL,
      lead_source VARCHAR(120) NULL,
      default_owner_id INT UNSIGNED NULL,
      notify_user_id INT UNSIGNED NULL,
      auto_create_lead TINYINT(1) NOT NULL DEFAULT 1,
      view_count INT UNSIGNED NOT NULL DEFAULT 0,
      submission_count INT UNSIGNED NOT NULL DEFAULT 0,
      created_by INT UNSIGNED NULL,
      archived_at DATETIME NULL,
      row_version INT UNSIGNED NOT NULL DEFAULT 1,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_form_code (form_code),
      UNIQUE KEY uq_form_token (public_token),
      KEY idx_lgf_status (status),
      KEY idx_lgf_owner (default_owner_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  )

  await query(
    `CREATE TABLE IF NOT EXISTS leadgen_form_fields (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      form_id BIGINT UNSIGNED NOT NULL,
      field_key VARCHAR(60) NOT NULL,
      label VARCHAR(150) NOT NULL,
      type ENUM('text','email','tel','textarea','number','select','checkbox','hidden') NOT NULL DEFAULT 'text',
      placeholder VARCHAR(190) NULL,
      help_text VARCHAR(255) NULL,
      required TINYINT(1) NOT NULL DEFAULT 0,
      options JSON NULL,
      maps_to VARCHAR(40) NOT NULL DEFAULT 'none',
      sort_order INT NOT NULL DEFAULT 0,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      KEY idx_lgff_form (form_id, sort_order),
      UNIQUE KEY uq_lgff_key (form_id, field_key)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  )

  await query(
    `CREATE TABLE IF NOT EXISTS leadgen_submissions (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      submission_code VARCHAR(40) NOT NULL,
      form_id BIGINT UNSIGNED NOT NULL,
      form_code VARCHAR(40) NULL,
      data JSON NULL,
      full_name VARCHAR(190) NULL,
      email VARCHAR(190) NULL,
      email_normalized VARCHAR(190) NULL,
      phone VARCHAR(40) NULL,
      company_name VARCHAR(190) NULL,
      status ENUM('New','Converted','Spam','Duplicate') NOT NULL DEFAULT 'New',
      contact_id BIGINT UNSIGNED NULL,
      lead_id INT UNSIGNED NULL,
      lead_code VARCHAR(40) NULL,
      is_spam TINYINT(1) NOT NULL DEFAULT 0,
      ip VARCHAR(64) NULL,
      user_agent VARCHAR(255) NULL,
      referrer VARCHAR(500) NULL,
      utm JSON NULL,
      processed_at DATETIME NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_submission_code (submission_code),
      KEY idx_lgs_form (form_id, created_at),
      KEY idx_lgs_status (status),
      KEY idx_lgs_email (email_normalized),
      KEY idx_lgs_created (created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  )

  // Lightweight event log — one row per public view, so the funnel can compare
  // views vs. submissions over time without bloating the submissions table.
  await query(
    `CREATE TABLE IF NOT EXISTS leadgen_form_events (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      form_id BIGINT UNSIGNED NOT NULL,
      type ENUM('view','submit') NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      KEY idx_lge_form (form_id, type, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  )

  // Register module features so the permission matrix can gate this screen.
  await query(
    `INSERT IGNORE INTO features (module_id,name,slug,description,sort_order)
     SELECT id,'Lead Generation','marketing.lead_generation.view','View lead capture forms and submissions',60 FROM modules WHERE slug='marketing'`,
  ).catch(() => {})
  await query(
    `INSERT IGNORE INTO features (module_id,name,slug,description,sort_order)
     SELECT id,'Manage Lead Generation','marketing.lead_generation.manage','Create, edit and publish lead capture forms',61 FROM modules WHERE slug='marketing'`,
  ).catch(() => {})

  ensured = true
}

// ---------------------------------------------------------------------------
// Token + code helpers
// ---------------------------------------------------------------------------

function generateToken(): string {
  return crypto.randomBytes(18).toString("base64url")
}

// ---------------------------------------------------------------------------
// Field defaults + validation
// ---------------------------------------------------------------------------

/** The starter field set a brand-new form is created with. */
export function defaultFields(): Array<Record<string, any>> {
  return [
    { field_key: "full_name", label: "Full name", type: "text", required: 1, maps_to: "full_name", sort_order: 0 },
    { field_key: "email", label: "Email", type: "email", required: 1, maps_to: "email", sort_order: 1 },
    { field_key: "phone", label: "Phone", type: "tel", required: 0, maps_to: "phone", sort_order: 2 },
    { field_key: "company_name", label: "Company", type: "text", required: 0, maps_to: "company_name", sort_order: 3 },
    { field_key: "message", label: "How can we help?", type: "textarea", required: 0, maps_to: "message", sort_order: 4 },
  ]
}

function cleanFieldKey(raw: string, fallback: string): string {
  const key = String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60)
  return key || fallback
}

/** Normalize + de-dupe a set of field definitions coming from the builder. */
export function normalizeFields(input: any[]): Array<Record<string, any>> {
  const seen = new Set<string>()
  const out: Array<Record<string, any>> = []
  ;(Array.isArray(input) ? input : []).forEach((f, i) => {
    const type = (FIELD_TYPES as readonly string[]).includes(f?.type) ? f.type : "text"
    let key = cleanFieldKey(f?.field_key || f?.label || "", `field_${i + 1}`)
    while (seen.has(key)) key = `${key}_${i}`
    seen.add(key)
    const mapsTo = FIELD_MAPPINGS.some((m) => m.key === f?.maps_to) ? f.maps_to : "none"
    const options =
      type === "select" && Array.isArray(f?.options)
        ? f.options.map((o: any) => String(o).trim()).filter(Boolean)
        : null
    out.push({
      field_key: key,
      label: String(f?.label ?? key).trim().slice(0, 150) || key,
      type,
      placeholder: f?.placeholder ? String(f.placeholder).slice(0, 190) : null,
      help_text: f?.help_text ? String(f.help_text).slice(0, 255) : null,
      required: f?.required ? 1 : 0,
      options: options && options.length ? options : null,
      maps_to: mapsTo,
      sort_order: i,
    })
  })
  return out
}

// ---------------------------------------------------------------------------
// Form CRUD
// ---------------------------------------------------------------------------

const FORM_WRITABLE = new Set([
  "name",
  "description",
  "type",
  "submit_label",
  "success_message",
  "redirect_url",
  "theme_color",
  "campaign",
  "lead_source",
  "default_owner_id",
  "notify_user_id",
  "auto_create_lead",
])

function buildFormColumns(body: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {}
  for (const key of Object.keys(body)) {
    if (!FORM_WRITABLE.has(key)) continue
    let value = body[key]
    if (value === "") value = null
    if (key === "auto_create_lead") value = value ? 1 : 0
    if (key === "type" && !(FORM_TYPES as readonly string[]).includes(value)) value = "Hosted"
    if ((key === "default_owner_id" || key === "notify_user_id") && value != null) value = Number(value) || null
    out[key] = value
  }
  return out
}

export async function listForms(opts: {
  search?: string
  status?: string
  includeArchived?: boolean
} = {}): Promise<LeadGenForm[]> {
  const where: string[] = []
  const args: any[] = []
  if (!opts.includeArchived) where.push("f.archived_at IS NULL")
  if (opts.status && (FORM_STATUSES as readonly string[]).includes(opts.status)) {
    where.push("f.status = ?")
    args.push(opts.status)
  }
  if (opts.search) {
    where.push("(f.name LIKE ? OR f.form_code LIKE ? OR f.campaign LIKE ?)")
    const like = `%${opts.search}%`
    args.push(like, like, like)
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : ""
  return query<any[]>(
    `SELECT f.*, u.name AS default_owner_name,
            (SELECT COUNT(*) FROM leadgen_form_fields ff WHERE ff.form_id = f.id) AS field_count,
            (SELECT COUNT(*) FROM leadgen_submissions s WHERE s.form_id = f.id AND s.lead_id IS NOT NULL) AS lead_count
       FROM leadgen_forms f
       LEFT JOIN users u ON u.id = f.default_owner_id
       ${whereSql}
       ORDER BY f.created_at DESC`,
    args,
  )
}

export async function getFormById(id: number): Promise<(LeadGenForm & { fields: any[] }) | null> {
  const rows = await query<any[]>(
    `SELECT f.*, u.name AS owner_name FROM leadgen_forms f
       LEFT JOIN users u ON u.id = f.default_owner_id WHERE f.id = ? LIMIT 1`,
    [id],
  )
  if (!rows.length) return null
  const fields = await getFormFields(id)
  return { ...(rows[0] as LeadGenForm), fields }
}

/** Public read: only a Published form is served to the world. */
export async function getPublicForm(token: string): Promise<(LeadGenForm & { fields: any[] }) | null> {
  const rows = await query<any[]>(
    `SELECT * FROM leadgen_forms WHERE public_token = ? AND status = 'Published' AND archived_at IS NULL LIMIT 1`,
    [token],
  )
  if (!rows.length) return null
  const fields = await getFormFields(rows[0].id)
  return { ...(rows[0] as LeadGenForm), fields }
}

export async function getFormFields(formId: number): Promise<any[]> {
  const rows = await query<any[]>(
    `SELECT * FROM leadgen_form_fields WHERE form_id = ? ORDER BY sort_order ASC, id ASC`,
    [formId],
  )
  return rows.map((r) => ({ ...r, required: !!r.required, options: parseJson(r.options) }))
}

function parseJson(value: any): any {
  if (value == null) return null
  if (typeof value === "object") return value
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

export async function createForm(body: Record<string, any>, actorId: number): Promise<{ id: number; form_code: string }> {
  const columns = buildFormColumns(body)
  if (!columns.name) throw new SubmissionRejectedError("A form name is required", 400, { name: "Required" })
  const code = await nextRecordId("LGF", { allowCustom: true, digits: 4 })
  const token = generateToken()

  const fields = ["form_code", "public_token", ...Object.keys(columns), "status", "created_by"]
  const values = [code, token, ...Object.keys(columns).map((k) => columns[k]), "Draft", actorId]
  const res = await query<any>(
    `INSERT INTO leadgen_forms (${fields.join(",")}) VALUES (${fields.map(() => "?").join(",")})`,
    values,
  )
  const id = Number(res.insertId)

  const rawFields = Array.isArray(body.fields) && body.fields.length ? body.fields : defaultFields()
  await setFormFields(id, rawFields)

  await recordAudit(null, {
    entityType: "leadgen_form",
    entityId: code,
    action: "created",
    summary: `Lead form "${columns.name}" created`,
    actorId,
  })
  return { id, form_code: code }
}

export async function updateForm(id: number, body: Record<string, any>, actorId: number): Promise<void> {
  const form = await getFormById(id)
  if (!form) throw new FormNotFoundError()
  const columns = buildFormColumns(body)
  if (Object.keys(columns).length) {
    const sets = Object.keys(columns).map((k) => `${k} = ?`)
    await query(
      `UPDATE leadgen_forms SET ${sets.join(", ")}, row_version = row_version + 1 WHERE id = ?`,
      [...Object.keys(columns).map((k) => columns[k]), id],
    )
  }
  if (Array.isArray(body.fields)) await setFormFields(id, body.fields)

  await recordAudit(null, {
    entityType: "leadgen_form",
    entityId: form.form_code,
    action: "updated",
    summary: `Lead form "${form.name}" updated`,
    actorId,
  })
}

export async function setFormFields(formId: number, rawFields: any[]): Promise<void> {
  const fields = normalizeFields(rawFields)
  await query(`DELETE FROM leadgen_form_fields WHERE form_id = ?`, [formId]).catch(() => {})
  for (const f of fields) {
    await query(
      `INSERT INTO leadgen_form_fields
        (form_id, field_key, label, type, placeholder, help_text, required, options, maps_to, sort_order)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [
        formId,
        f.field_key,
        f.label,
        f.type,
        f.placeholder,
        f.help_text,
        f.required,
        f.options ? JSON.stringify(f.options) : null,
        f.maps_to,
        f.sort_order,
      ],
    ).catch((e) => console.error("[leadgen-db] setFormFields insert failed", e))
  }
}

export async function setFormStatus(id: number, status: FormStatus, actorId: number): Promise<void> {
  const form = await getFormById(id)
  if (!form) throw new FormNotFoundError()
  const archivedAt = status === "Archived" ? new Date() : null
  await query(
    `UPDATE leadgen_forms SET status = ?, archived_at = ?, row_version = row_version + 1 WHERE id = ?`,
    [status, archivedAt, id],
  )
  await recordAudit(null, {
    entityType: "leadgen_form",
    entityId: form.form_code,
    action: status.toLowerCase(),
    summary: `Lead form "${form.name}" ${status.toLowerCase()}`,
    actorId,
  })
}

export async function duplicateForm(id: number, actorId: number): Promise<{ id: number; form_code: string }> {
  const form = await getFormById(id)
  if (!form) throw new FormNotFoundError()
  const created = await createForm(
    {
      name: `${form.name} (copy)`,
      description: form.description,
      type: form.type,
      submit_label: form.submit_label,
      success_message: form.success_message,
      redirect_url: form.redirect_url,
      theme_color: form.theme_color,
      campaign: form.campaign,
      lead_source: form.lead_source,
      default_owner_id: form.default_owner_id,
      notify_user_id: form.notify_user_id,
      auto_create_lead: form.auto_create_lead,
      fields: form.fields,
    },
    actorId,
  )
  return created
}

// ---------------------------------------------------------------------------
// Public: views + submissions
// ---------------------------------------------------------------------------

export async function recordFormView(formId: number): Promise<void> {
  await query(`UPDATE leadgen_forms SET view_count = view_count + 1 WHERE id = ?`, [formId]).catch(() => {})
  await query(`INSERT INTO leadgen_form_events (form_id, type) VALUES (?, 'view')`, [formId]).catch(() => {})
}

// Simple per-process sliding-window rate limit for the public endpoint.
const rateBuckets = new Map<string, number[]>()
const RATE_LIMIT = 5
const RATE_WINDOW_MS = 60_000

function rateLimited(key: string): boolean {
  const now = Date.now()
  const hits = (rateBuckets.get(key) || []).filter((t) => now - t < RATE_WINDOW_MS)
  hits.push(now)
  rateBuckets.set(key, hits)
  return hits.length > RATE_LIMIT
}

export function validateSubmission(fields: any[], data: Record<string, any>): Record<string, string> {
  const errors: Record<string, string> = {}
  for (const f of fields) {
    if (f.type === "hidden") continue
    const value = data[f.field_key]
    const empty = value == null || String(value).trim() === "" || (f.type === "checkbox" && !value)
    if (f.required && empty) {
      errors[f.field_key] = `${f.label} is required`
      continue
    }
    if (!empty && f.type === "email" && !isValidEmail(String(value))) {
      errors[f.field_key] = "Enter a valid email address"
    }
  }
  return errors
}

/** Collapse the raw submission into the canonical master fields via maps_to. */
function mapSubmission(fields: any[], data: Record<string, any>) {
  const mapped: Record<string, any> = {}
  for (const f of fields) {
    if (f.maps_to === "none") continue
    const value = data[f.field_key]
    if (value == null || String(value).trim() === "") continue
    mapped[f.maps_to] = typeof value === "string" ? value.trim() : value
  }
  // Derive names both ways so downstream masters always have something.
  if (!mapped.full_name && (mapped.first_name || mapped.last_name)) {
    mapped.full_name = fullNameOf(mapped.first_name, mapped.last_name)
  }
  if (mapped.full_name && !mapped.first_name && !mapped.last_name) {
    const { first, last } = splitName(mapped.full_name)
    mapped.first_name = first
    mapped.last_name = last
  }
  return mapped
}

/**
 * Upsert the canonical marketing contact from a form submission. Matches by
 * email then phone so a returning visitor is linked, never duplicated. Returns
 * the contact id (or null when there is nothing identifiable to store).
 */
async function upsertContactFromSubmission(input: {
  mapped: Record<string, any>
  source: string
  ownerId: number | null
  consent: boolean
  actorId: number | null
}): Promise<number | null> {
  const email = normalizeEmail(input.mapped.email)
  const phone = normalizePhone(input.mapped.phone)
  if (!email && !phone) return null

  const clauses: string[] = []
  const args: any[] = []
  if (email) {
    clauses.push("email_normalized = ?")
    args.push(email)
  }
  if (phone) {
    clauses.push("phone_normalized = ?")
    args.push(phone)
  }
  const found = await query<any[]>(
    `SELECT id, contact_code FROM marketing_contacts
      WHERE archived_at IS NULL AND (${clauses.join(" OR ")}) LIMIT 1`,
    args,
  ).catch(() => [] as any[])

  const first = input.mapped.first_name ?? null
  const last = input.mapped.last_name ?? null
  const fullName = input.mapped.full_name || fullNameOf(first, last) || email || phone || "Unnamed"

  if (found.length) {
    const id = found[0].id
    await query(
      `UPDATE marketing_contacts
          SET company_name = COALESCE(NULLIF(company_name,''), ?),
              job_title = COALESCE(NULLIF(job_title,''), ?),
              phone = COALESCE(phone, ?),
              phone_normalized = COALESCE(phone_normalized, ?),
              email = COALESCE(email, ?),
              email_normalized = COALESCE(email_normalized, ?),
              owner_id = COALESCE(owner_id, ?),
              last_activity_at = NOW(),
              row_version = row_version + 1
        WHERE id = ?`,
      [
        input.mapped.company_name ?? null,
        input.mapped.job_title ?? null,
        phone,
        phone,
        email,
        email,
        input.ownerId,
        id,
      ],
    ).catch(() => {})
    await recordContactActivity({
      contactId: id,
      contactCode: found[0].contact_code,
      type: "form",
      summary: `Submitted ${input.source}`,
      actorId: input.actorId,
    })
    return id
  }

  const code = await nextRecordId("MKC", { allowCustom: true, digits: 6 })
  const res = await query<any>(
    `INSERT INTO marketing_contacts
       (contact_code, first_name, last_name, full_name, email, email_normalized, phone, phone_normalized,
        company_name, job_title, source, lifecycle_stage, owner_id, country, city, state,
        consent, consent_source, consent_at, email_subscription, last_activity_at, created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NOW(),?)`,
    [
      code,
      first,
      last,
      fullName,
      email,
      email,
      phone,
      phone,
      input.mapped.company_name ?? null,
      input.mapped.job_title ?? null,
      "Website",
      "Lead",
      input.ownerId,
      input.mapped.country ?? null,
      input.mapped.city ?? null,
      input.mapped.state ?? null,
      input.consent ? 1 : 0,
      input.consent ? "Lead capture form" : null,
      input.consent ? new Date() : null,
      input.consent ? "Subscribed" : "Pending",
      input.actorId,
    ],
  ).catch((e) => {
    console.error("[leadgen-db] contact insert failed", e)
    return null
  })
  if (!res) return null
  const id = Number(res.insertId)
  await recordContactActivity({
    contactId: id,
    contactCode: code,
    type: "form",
    summary: `Captured via ${input.source}`,
    meta: { source: "Website" },
    actorId: input.actorId,
  })
  return id
}

export type SubmissionMeta = {
  ip?: string | null
  userAgent?: string | null
  referrer?: string | null
  utm?: Record<string, any> | null
  honeypot?: string | null
}

/**
 * Process a public submission end-to-end. Throws SubmissionRejectedError for
 * anything the public caller should see (validation / rate limit); everything
 * else is best-effort so a downstream hiccup never loses the captured lead.
 */
export async function processSubmission(
  form: LeadGenForm & { fields: any[] },
  data: Record<string, any>,
  meta: SubmissionMeta = {},
): Promise<{ submission_code: string; status: SubmissionStatus; lead_code: string | null }> {
  await ensureContactSchema()
  await ensureLeadLifecycleSchema()

  // Honeypot: a real user never fills the hidden trap field.
  const isSpam = Boolean(meta.honeypot && String(meta.honeypot).trim())

  if (!isSpam) {
    const rlKey = `${form.id}:${meta.ip || "anon"}`
    if (rateLimited(rlKey)) {
      throw new SubmissionRejectedError("Too many submissions. Please try again in a minute.", 429)
    }
    const errors = validateSubmission(form.fields, data)
    if (Object.keys(errors).length) {
      throw new SubmissionRejectedError("Please correct the highlighted fields.", 400, errors)
    }
  }

  const mapped = mapSubmission(form.fields, data)
  const email = normalizeEmail(mapped.email)
  const phone = normalizePhone(mapped.phone)
  const consent = Boolean(mapped.consent)

  // Duplicate detection: same identity + same form within 24h is a dupe.
  let status: SubmissionStatus = isSpam ? "Spam" : "New"
  if (!isSpam && (email || phone)) {
    const dupeArgs: any[] = [form.id]
    let dupeClause = ""
    if (email) {
      dupeClause = "email_normalized = ?"
      dupeArgs.push(email)
    } else {
      dupeClause = "phone = ?"
      dupeArgs.push(phone)
    }
    const dupe = await query<any[]>(
      `SELECT id FROM leadgen_submissions
        WHERE form_id = ? AND ${dupeClause} AND created_at > (NOW() - INTERVAL 1 DAY) LIMIT 1`,
      dupeArgs,
    ).catch(() => [] as any[])
    if (dupe.length) status = "Duplicate"
  }

  const code = await nextRecordId("LGS", { allowCustom: true, digits: 6 })
  const fullName = mapped.full_name || fullNameOf(mapped.first_name, mapped.last_name) || null

  const res = await query<any>(
    `INSERT INTO leadgen_submissions
       (submission_code, form_id, form_code, data, full_name, email, email_normalized, phone,
        company_name, status, is_spam, ip, user_agent, referrer, utm)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      code,
      form.id,
      form.form_code,
      JSON.stringify(data ?? {}),
      fullName,
      mapped.email ?? null,
      email,
      phone,
      mapped.company_name ?? null,
      status,
      isSpam ? 1 : 0,
      meta.ip ?? null,
      meta.userAgent ? String(meta.userAgent).slice(0, 255) : null,
      meta.referrer ? String(meta.referrer).slice(0, 500) : null,
      meta.utm ? JSON.stringify(meta.utm) : null,
    ],
  )
  const submissionId = Number(res.insertId)

  await query(`UPDATE leadgen_forms SET submission_count = submission_count + 1 WHERE id = ?`, [form.id]).catch(() => {})
  await query(`INSERT INTO leadgen_form_events (form_id, type) VALUES (?, 'submit')`, [form.id]).catch(() => {})

  // Spam / duplicate submissions are stored for review but do NOT touch the
  // canonical masters or the sales pipeline.
  if (status === "Spam" || status === "Duplicate") {
    return { submission_code: code, status, lead_code: null }
  }

  const ownerId = form.default_owner_id ?? null

  // 1) Canonical marketing contact (upsert, never duplicate).
  const contactId = await upsertContactFromSubmission({
    mapped,
    source: `${form.name} (${form.form_code})`,
    ownerId,
    consent,
    actorId: null,
  })

  // 2) Hand the lead to the Sales lifecycle when the form is configured to.
  let leadId: number | null = null
  let leadCode: string | null = null
  if (form.auto_create_lead) {
    try {
      const created = await createLead(
        {
          contact_person: fullName || mapped.company_name || mapped.email || "Website lead",
          company_name: mapped.company_name || fullName || "Unknown",
          email: mapped.email ?? null,
          contact_number: phone ?? null,
          designation: mapped.job_title ?? null,
          country: mapped.country ?? null,
          website: mapped.website ?? null,
          lead_source: form.lead_source || "Lead Form",
          source_url: form.type === "Hosted" ? `/f/${form.public_token}` : null,
          campaign: form.campaign ?? null,
          assigned_to: ownerId,
          estimated_value: parseBudget(mapped.budget),
          remarks: mapped.message ? String(mapped.message).slice(0, 2000) : null,
        },
        ownerId,
      )
      leadId = created.id
      leadCode = created.lead_code
    } catch (e) {
      console.error("[leadgen-db] createLead from submission failed", e)
    }
  }

  // 3) Backfill links + mark converted.
  await query(
    `UPDATE leadgen_submissions SET contact_id = ?, lead_id = ?, lead_code = ?, status = 'Converted', processed_at = NOW() WHERE id = ?`,
    [contactId, leadId, leadCode, submissionId],
  ).catch(() => {})
  if (contactId && leadId) {
    await query(`UPDATE marketing_contacts SET lead_id = COALESCE(lead_id, ?) WHERE id = ?`, [leadId, contactId]).catch(
      () => {},
    )
  }

  // 4) Audit + notify the owner.
  await recordAudit(null, {
    entityType: "leadgen_submission",
    entityId: code,
    action: "captured",
    summary: `New lead captured via "${form.name}"`,
    meta: { form_code: form.form_code, lead_code: leadCode, contact_id: contactId },
    actorId: null,
  })
  const notifyUser = form.notify_user_id ?? ownerId
  if (notifyUser) {
    await notify(null, {
      userId: notifyUser,
      type: "lead",
      title: "New lead captured",
      body: `${fullName || mapped.email || "A visitor"} submitted "${form.name}"`,
      link: leadId ? `/modules/sales/leads/${leadId}` : `/modules/marketing/lead-generation`,
      entityType: "leadgen_submission",
      entityId: code,
    })
  }

  return { submission_code: code, status: "Converted", lead_code: leadCode }
}

function parseBudget(value: any): number | null {
  if (value == null) return null
  const n = Number(String(value).replace(/[^0-9.]/g, ""))
  return Number.isFinite(n) && n > 0 ? n : null
}

// ---------------------------------------------------------------------------
// Submissions inbox
// ---------------------------------------------------------------------------

export async function listSubmissions(opts: {
  formId?: number | null
  status?: string
  search?: string
  page?: number
  pageSize?: number
} = {}): Promise<{ submissions: any[]; total: number }> {
  const where: string[] = []
  const args: any[] = []
  if (opts.formId) {
    where.push("s.form_id = ?")
    args.push(opts.formId)
  }
  if (opts.status && (SUBMISSION_STATUSES as readonly string[]).includes(opts.status)) {
    where.push("s.status = ?")
    args.push(opts.status)
  }
  if (opts.search) {
    where.push("(s.full_name LIKE ? OR s.email LIKE ? OR s.phone LIKE ? OR s.company_name LIKE ? OR s.submission_code LIKE ?)")
    const like = `%${opts.search}%`
    args.push(like, like, like, like, like)
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : ""
  const page = Math.max(1, opts.page || 1)
  const pageSize = Math.min(200, Math.max(1, opts.pageSize || 50))
  const offset = (page - 1) * pageSize

  const totalRows = await query<any[]>(`SELECT COUNT(*) AS n FROM leadgen_submissions s ${whereSql}`, args)
  const total = Number(totalRows?.[0]?.n ?? 0)

  const rows = await query<any[]>(
    `SELECT s.*, f.name AS form_name, c.contact_code
       FROM leadgen_submissions s
       LEFT JOIN leadgen_forms f ON f.id = s.form_id
       LEFT JOIN marketing_contacts c ON c.id = s.contact_id
       ${whereSql}
       ORDER BY s.created_at DESC, s.id DESC
       LIMIT ? OFFSET ?`,
    [...args, pageSize, offset],
  )
  return {
    submissions: rows.map((r) => ({ ...r, data: parseJson(r.data), utm: parseJson(r.utm) })),
    total,
  }
}

export async function getSubmissionById(id: number): Promise<any | null> {
  const rows = await query<any[]>(
    `SELECT s.*, f.name AS form_name, f.public_token, f.type AS form_type,
            f.default_owner_id, f.lead_source, f.campaign, f.notify_user_id,
            c.contact_code
       FROM leadgen_submissions s
       LEFT JOIN leadgen_forms f ON f.id = s.form_id
       LEFT JOIN marketing_contacts c ON c.id = s.contact_id
      WHERE s.id = ? LIMIT 1`,
    [id],
  )
  if (!rows.length) return null
  const r = rows[0]
  return { ...r, data: parseJson(r.data), utm: parseJson(r.utm) }
}

export async function setSubmissionStatus(id: number, status: SubmissionStatus, actorId: number): Promise<void> {
  if (!(SUBMISSION_STATUSES as readonly string[]).includes(status)) {
    throw new SubmissionRejectedError("Invalid submission status", 400)
  }
  const sub = await getSubmissionById(id)
  if (!sub) throw new FormNotFoundError("Submission not found")
  await query(`UPDATE leadgen_submissions SET status = ?, is_spam = ? WHERE id = ?`, [
    status,
    status === "Spam" ? 1 : 0,
    id,
  ])
  await recordAudit(null, {
    entityType: "leadgen_submission",
    entityId: sub.submission_code,
    action: status.toLowerCase(),
    summary: `Submission ${sub.submission_code} marked ${status}`,
    actorId,
  })
}

/**
 * Manually convert a stored submission into the canonical Contact + Sales lead.
 * Idempotent: a submission already linked to a lead is returned unchanged.
 */
export async function convertSubmissionToLead(
  id: number,
  actorId: number,
): Promise<{ lead_code: string | null; lead_id: number | null; contact_id: number | null; already: boolean }> {
  await ensureContactSchema()
  await ensureLeadLifecycleSchema()
  const sub = await getSubmissionById(id)
  if (!sub) throw new FormNotFoundError("Submission not found")
  if (sub.lead_id) {
    return { lead_code: sub.lead_code, lead_id: sub.lead_id, contact_id: sub.contact_id, already: true }
  }

  const fields = await getFormFields(sub.form_id)
  const mapped = mapSubmission(fields, sub.data || {})
  const email = mapped.email || sub.email || null
  const phone = normalizePhone(mapped.phone || sub.phone)
  const companyName = mapped.company_name || sub.company_name || null
  const consent = Boolean(mapped.consent)
  const ownerId = sub.default_owner_id ?? null
  const fullName = mapped.full_name || sub.full_name || fullNameOf(mapped.first_name, mapped.last_name) || null

  const contactId =
    sub.contact_id ||
    (await upsertContactFromSubmission({
      mapped: { ...mapped, email, company_name: companyName },
      source: `${sub.form_name} (${sub.form_code})`,
      ownerId,
      consent,
      actorId,
    }))

  let leadId: number | null = null
  let leadCode: string | null = null
  try {
    const created = await createLead(
      {
        contact_person: fullName || companyName || email || "Website lead",
        company_name: companyName || fullName || "Unknown",
        email: email,
        contact_number: phone ?? null,
        designation: mapped.job_title ?? null,
        country: mapped.country ?? null,
        website: mapped.website ?? null,
        lead_source: sub.lead_source || "Lead Form",
        source_url: sub.form_type === "Hosted" ? `/f/${sub.public_token}` : null,
        campaign: sub.campaign ?? null,
        assigned_to: ownerId,
        estimated_value: parseBudget(mapped.budget),
        remarks: mapped.message ? String(mapped.message).slice(0, 2000) : null,
      },
      ownerId,
    )
    leadId = created.id
    leadCode = created.lead_code
  } catch (e) {
    console.error("[leadgen-db] convertSubmissionToLead createLead failed", e)
    throw new SubmissionRejectedError("Unable to create a lead from this submission", 500)
  }

  await query(
    `UPDATE leadgen_submissions SET contact_id = ?, lead_id = ?, lead_code = ?, status = 'Converted', processed_at = NOW() WHERE id = ?`,
    [contactId, leadId, leadCode, id],
  ).catch(() => {})
  if (contactId && leadId) {
    await query(`UPDATE marketing_contacts SET lead_id = COALESCE(lead_id, ?) WHERE id = ?`, [leadId, contactId]).catch(
      () => {},
    )
  }

  await recordAudit(null, {
    entityType: "leadgen_submission",
    entityId: sub.submission_code,
    action: "converted",
    summary: `Submission ${sub.submission_code} converted to lead ${leadCode ?? ""}`.trim(),
    actorId,
  })

  return { lead_code: leadCode, lead_id: leadId, contact_id: contactId, already: false }
}

// ---------------------------------------------------------------------------
// Dashboard analytics
// ---------------------------------------------------------------------------

export async function getDashboard(days = 30): Promise<Record<string, any>> {
  const period = Math.min(365, Math.max(1, days))

  // Headline totals for the stat cards. `forms`/`active_forms` come from the
  // form master; `submissions`/`leads_created` from the submissions table so
  // the conversion rate reflects real captured-to-lead performance.
  const [formTotals] = await query<any[]>(
    `SELECT
        COUNT(*) AS forms,
        COALESCE(SUM(status = 'Published'), 0) AS active_forms
       FROM leadgen_forms WHERE archived_at IS NULL`,
  )
  const [subTotals] = await query<any[]>(
    `SELECT
        COUNT(*) AS submissions,
        COALESCE(SUM(lead_id IS NOT NULL), 0) AS leads_created
       FROM leadgen_submissions`,
  )

  const submissions = Number(subTotals?.submissions ?? 0)
  const leadsCreated = Number(subTotals?.leads_created ?? 0)

  // Submissions per day over the trailing window for the area chart.
  const trend = await query<any[]>(
    `SELECT DATE(created_at) AS date, COUNT(*) AS submissions
       FROM leadgen_submissions
      WHERE created_at > (NOW() - INTERVAL ? DAY)
      GROUP BY DATE(created_at) ORDER BY date ASC`,
    [period],
  )

  // Per-form leaderboard by submission volume.
  const topForms = await query<any[]>(
    `SELECT f.id, f.name, f.form_code, f.submission_count AS submissions,
            (SELECT COUNT(*) FROM leadgen_submissions s WHERE s.form_id = f.id AND s.lead_id IS NOT NULL) AS leads_created
       FROM leadgen_forms f
      WHERE f.archived_at IS NULL
      ORDER BY f.submission_count DESC, f.view_count DESC
      LIMIT 8`,
  )

  const bySource = await query<any[]>(
    `SELECT COALESCE(NULLIF(f.lead_source,''),'Unspecified') AS lead_source, COUNT(s.id) AS submissions
       FROM leadgen_submissions s
       JOIN leadgen_forms f ON f.id = s.form_id
      WHERE s.created_at > (NOW() - INTERVAL ? DAY)
      GROUP BY lead_source ORDER BY submissions DESC LIMIT 8`,
    [period],
  )

  const recent = await query<any[]>(
    `SELECT s.id, s.submission_code, f.name AS form_name, s.full_name, s.email, s.status, s.created_at
       FROM leadgen_submissions s
       LEFT JOIN leadgen_forms f ON f.id = s.form_id
      ORDER BY s.created_at DESC LIMIT 8`,
  )

  return {
    totals: {
      forms: Number(formTotals?.forms ?? 0),
      active_forms: Number(formTotals?.active_forms ?? 0),
      submissions,
      leads_created: leadsCreated,
      conversion_rate: submissions > 0 ? Math.round((leadsCreated / submissions) * 1000) / 10 : 0,
    },
    trend: trend.map((t) => ({
      date: t.date,
      submissions: Number(t.submissions ?? 0),
    })),
    topForms: topForms.map((f) => ({
      id: f.id,
      name: f.name,
      form_code: f.form_code,
      submissions: Number(f.submissions ?? 0),
      leads_created: Number(f.leads_created ?? 0),
    })),
    bySource: bySource.map((s) => ({ lead_source: s.lead_source, submissions: Number(s.submissions ?? 0) })),
    recent,
  }
}
