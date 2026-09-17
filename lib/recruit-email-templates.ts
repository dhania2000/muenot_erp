import { query } from "@/lib/db"
import { nextRecordId } from "@/lib/record-ids"
import {
  RECRUIT_TEMPLATE_STATUSES,
  RECRUIT_TEMPLATE_AUDIENCES,
  type RecruitTemplateStatus,
  type RecruitTemplateAudience,
  type RecruitEmailTemplate,
} from "@/lib/recruit-email-template-shared"

// Re-export the client-safe constants/types for server-side importers.
export {
  RECRUIT_TEMPLATE_STATUSES,
  RECRUIT_TEMPLATE_AUDIENCES,
  type RecruitTemplateStatus,
  type RecruitTemplateAudience,
  type RecruitEmailTemplate,
}

/**
 * Recruitment Email Template Management service — mirrors the HR template
 * manager (stable Template ID RCET-0001, machine key, category/audience,
 * plain-text alternative, Draft/Active/Inactive/Archived lifecycle, versioning
 * and usage analytics), scoped to the recruit_email_templates table so the
 * existing candidate email send pipeline keeps reading the same rows.
 */

let schemaEnsured = false

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

async function ensureIndex(table: string, indexName: string, definition: string) {
  const rows = await query<any[]>(
    `SELECT 1 FROM information_schema.statistics
     WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ? LIMIT 1`,
    [table, indexName],
  )
  if (rows.length === 0) {
    await query(`ALTER TABLE \`${table}\` ADD ${definition}`)
  }
}

export async function ensureRecruitEmailTemplateSchema() {
  if (schemaEnsured) return

  await query(
    `CREATE TABLE IF NOT EXISTS recruit_email_templates (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(150) NOT NULL,
      subject VARCHAR(255) NOT NULL,
      body LONGTEXT NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'Draft',
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  )

  await ensureColumn("recruit_email_templates", "template_uid", "VARCHAR(40) NULL")
  await ensureColumn("recruit_email_templates", "template_key", "VARCHAR(80) NULL")
  await ensureColumn("recruit_email_templates", "description", "VARCHAR(500) NULL")
  await ensureColumn("recruit_email_templates", "category", "VARCHAR(60) NOT NULL DEFAULT 'General'")
  await ensureColumn("recruit_email_templates", "audience", "VARCHAR(40) NOT NULL DEFAULT 'Candidate'")
  await ensureColumn("recruit_email_templates", "event_key", "VARCHAR(60) NULL")
  await ensureColumn("recruit_email_templates", "status", "VARCHAR(20) NOT NULL DEFAULT 'Draft'")
  await ensureColumn("recruit_email_templates", "body_text", "LONGTEXT NULL")
  await ensureColumn("recruit_email_templates", "version", "INT UNSIGNED NOT NULL DEFAULT 1")
  await ensureColumn("recruit_email_templates", "usage_count", "INT UNSIGNED NOT NULL DEFAULT 0")
  await ensureColumn("recruit_email_templates", "last_used_at", "DATETIME NULL")
  await ensureColumn("recruit_email_templates", "attachment_pathname", "VARCHAR(255) NULL")
  await ensureColumn("recruit_email_templates", "attachment_name", "VARCHAR(255) NULL")
  await ensureColumn("recruit_email_templates", "attachment_type", "VARCHAR(150) NULL")
  await ensureColumn("recruit_email_templates", "attachment_size", "INT UNSIGNED NULL")
  await ensureColumn("recruit_email_templates", "created_by", "BIGINT UNSIGNED NULL")
  await ensureColumn("recruit_email_templates", "updated_by", "BIGINT UNSIGNED NULL")
  await ensureColumn(
    "recruit_email_templates",
    "created_at",
    "TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP",
  )

  await query(
    `ALTER TABLE recruit_email_templates MODIFY COLUMN status
     ENUM('Draft','Active','Inactive','Archived') NOT NULL DEFAULT 'Draft'`,
  )

  await ensureIndex(
    "recruit_email_templates",
    "uq_recruit_email_templates_uid",
    "UNIQUE KEY uq_recruit_email_templates_uid (template_uid)",
  )
  await ensureIndex(
    "recruit_email_templates",
    "uq_recruit_email_templates_key",
    "UNIQUE KEY uq_recruit_email_templates_key (template_key)",
  )
  await ensureIndex(
    "recruit_email_templates",
    "idx_recruit_email_templates_status",
    "KEY idx_recruit_email_templates_status (status)",
  )

  await query(
    `CREATE TABLE IF NOT EXISTS recruit_email_template_versions (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      template_id BIGINT UNSIGNED NOT NULL,
      version INT UNSIGNED NOT NULL,
      name VARCHAR(150) NOT NULL,
      subject VARCHAR(255) NOT NULL,
      body LONGTEXT NOT NULL,
      body_text LONGTEXT NULL,
      category VARCHAR(60) NULL,
      audience VARCHAR(40) NULL,
      status VARCHAR(20) NULL,
      changed_by BIGINT UNSIGNED NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_recruit_email_template_versions_tpl (template_id, version)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  )

  const legacy = await query<any[]>(
    "SELECT id FROM recruit_email_templates WHERE template_uid IS NULL OR template_uid = ''",
  )
  for (const row of legacy) {
    await query("UPDATE recruit_email_templates SET template_uid = ? WHERE id = ?", [
      await generateTemplateUid(),
      row.id,
    ])
  }

  schemaEnsured = true
}

async function generateTemplateUid(): Promise<string> {
  return nextRecordId("RCET", { digits: 4, allowCustom: true }) // e.g. RCET-0001
}

export function normalizeTemplateKey(raw: string | null | undefined): string | null {
  const key = (raw || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
  return key || null
}

export function extractVariables(...texts: (string | null | undefined)[]): string[] {
  const found = new Set<string>()
  const re = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g
  for (const text of texts) {
    if (!text) continue
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null) found.add(m[1])
  }
  return Array.from(found)
}

export function htmlToPlainText(html: string): string {
  return html
    .replace(/<\s*br\s*\/?\s*>/gi, "\n")
    .replace(/<\/\s*(p|div|h[1-6]|li|tr)\s*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

const mapRow = (r: any): RecruitEmailTemplate => ({
  id: Number(r.id),
  template_uid: r.template_uid ?? null,
  template_key: r.template_key ?? null,
  name: r.name,
  description: r.description ?? null,
  category: r.category ?? "General",
  audience: r.audience ?? "Candidate",
  event_key: r.event_key ?? null,
  subject: r.subject,
  body: r.body,
  body_text: r.body_text ?? null,
  status: (r.status ?? "Draft") as RecruitTemplateStatus,
  version: Number(r.version ?? 1),
  usage_count: Number(r.usage_count ?? 0),
  last_used_at: r.last_used_at ?? null,
  attachment_pathname: r.attachment_pathname ?? null,
  attachment_name: r.attachment_name ?? null,
  attachment_type: r.attachment_type ?? null,
  attachment_size: r.attachment_size == null ? null : Number(r.attachment_size),
  created_by: r.created_by == null ? null : Number(r.created_by),
  updated_by: r.updated_by == null ? null : Number(r.updated_by),
  created_at: r.created_at ?? null,
  updated_at: r.updated_at ?? null,
})

export async function listTemplates(
  opts: { search?: string; status?: string; category?: string; includeArchived?: boolean } = {},
): Promise<RecruitEmailTemplate[]> {
  await ensureRecruitEmailTemplateSchema()
  const where: string[] = []
  const args: any[] = []

  if (opts.status && opts.status !== "all") {
    where.push("status = ?")
    args.push(opts.status)
  } else if (!opts.includeArchived) {
    where.push("status <> 'Archived'")
  }
  if (opts.category && opts.category !== "all") {
    where.push("category = ?")
    args.push(opts.category)
  }
  if (opts.search) {
    where.push("(name LIKE ? OR subject LIKE ? OR template_key LIKE ? OR template_uid LIKE ?)")
    const like = `%${opts.search}%`
    args.push(like, like, like, like)
  }

  const rows = await query<any[]>(
    `SELECT * FROM recruit_email_templates
     ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY updated_at DESC, id DESC`,
    args,
  )
  return rows.map(mapRow)
}

export async function getTemplate(id: number): Promise<RecruitEmailTemplate | null> {
  await ensureRecruitEmailTemplateSchema()
  const rows = await query<any[]>("SELECT * FROM recruit_email_templates WHERE id = ? LIMIT 1", [id])
  return rows[0] ? mapRow(rows[0]) : null
}

export type TemplateInput = {
  name: string
  template_key?: string | null
  description?: string | null
  category?: string
  audience?: string
  event_key?: string | null
  subject: string
  body: string
  body_text?: string | null
  status?: RecruitTemplateStatus
  attachment?: {
    pathname?: string | null
    filename?: string | null
    contentType?: string | null
    size?: number | null
  } | null
}

export type TemplateResult =
  | { ok: true; id: number; template_uid: string }
  | { ok: false; error: string; code: number }

function validate(input: TemplateInput): string | null {
  if (!input.name?.trim()) return "Template name is required"
  if (!input.subject?.trim()) return "Subject is required"
  if (!input.body?.trim()) return "Body is required"
  if (input.status && !RECRUIT_TEMPLATE_STATUSES.includes(input.status)) return "Invalid status"
  return null
}

async function keyTaken(key: string, exceptId?: number): Promise<boolean> {
  const rows = await query<any[]>(
    `SELECT id FROM recruit_email_templates WHERE template_key = ? ${exceptId ? "AND id <> ?" : ""} LIMIT 1`,
    exceptId ? [key, exceptId] : [key],
  )
  return rows.length > 0
}

export async function createTemplate(
  input: TemplateInput,
  actorId?: number | null,
): Promise<TemplateResult> {
  await ensureRecruitEmailTemplateSchema()
  const err = validate(input)
  if (err) return { ok: false, error: err, code: 400 }

  const key = normalizeTemplateKey(input.template_key)
  if (key && (await keyTaken(key))) {
    return { ok: false, error: `Template key "${key}" is already in use`, code: 409 }
  }

  const uid = await generateTemplateUid()
  const bodyText = input.body_text?.trim() || htmlToPlainText(input.body)
  const status = input.status ?? "Draft"

  const res = await query<any>(
    `INSERT INTO recruit_email_templates
       (template_uid, template_key, name, description, category, audience, event_key,
        subject, body, body_text, status, version, usage_count,
        attachment_pathname, attachment_name, attachment_type, attachment_size,
        created_by, updated_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,1,0,?,?,?,?,?,?)`,
    [
      uid,
      key,
      input.name.trim(),
      input.description?.trim() || null,
      (input.category || "General").trim() || "General",
      (input.audience || "Candidate").trim() || "Candidate",
      input.event_key || null,
      input.subject.trim(),
      input.body,
      bodyText,
      status,
      input.attachment?.pathname || null,
      input.attachment?.filename || null,
      input.attachment?.contentType || null,
      input.attachment?.size || null,
      actorId ?? null,
      actorId ?? null,
    ],
  )
  const id = Number(res.insertId)
  await snapshotVersion(id, 1, input.name.trim(), input.subject.trim(), input.body, bodyText, input.category, input.audience, status, actorId)
  return { ok: true, id, template_uid: uid }
}

export async function updateTemplate(
  id: number,
  input: TemplateInput,
  actorId?: number | null,
): Promise<TemplateResult> {
  await ensureRecruitEmailTemplateSchema()
  const existing = await getTemplate(id)
  if (!existing) return { ok: false, error: "Template not found", code: 404 }
  const err = validate(input)
  if (err) return { ok: false, error: err, code: 400 }

  const key = normalizeTemplateKey(input.template_key)
  if (key && (await keyTaken(key, id))) {
    return { ok: false, error: `Template key "${key}" is already in use`, code: 409 }
  }

  const bodyText = input.body_text?.trim() || htmlToPlainText(input.body)
  const status = input.status ?? existing.status
  const contentChanged =
    existing.name !== input.name.trim() ||
    existing.subject !== input.subject.trim() ||
    existing.body !== input.body ||
    (existing.body_text ?? "") !== bodyText
  const version = contentChanged ? existing.version + 1 : existing.version

  await query(
    `UPDATE recruit_email_templates SET
       template_key = ?, name = ?, description = ?, category = ?, audience = ?,
       event_key = ?, subject = ?, body = ?, body_text = ?, status = ?, version = ?,
       attachment_pathname = ?, attachment_name = ?, attachment_type = ?, attachment_size = ?,
       updated_by = ?
     WHERE id = ?`,
    [
      key,
      input.name.trim(),
      input.description?.trim() || null,
      (input.category || "General").trim() || "General",
      (input.audience || "Candidate").trim() || "Candidate",
      input.event_key || null,
      input.subject.trim(),
      input.body,
      bodyText,
      status,
      version,
      input.attachment?.pathname || null,
      input.attachment?.filename || null,
      input.attachment?.contentType || null,
      input.attachment?.size || null,
      actorId ?? null,
      id,
    ],
  )
  if (contentChanged) {
    await snapshotVersion(id, version, input.name.trim(), input.subject.trim(), input.body, bodyText, input.category, input.audience, status, actorId)
  }
  return { ok: true, id, template_uid: existing.template_uid || "" }
}

export async function deleteTemplate(id: number, opts: { hard?: boolean } = {}): Promise<TemplateResult> {
  await ensureRecruitEmailTemplateSchema()
  const existing = await getTemplate(id)
  if (!existing) return { ok: false, error: "Template not found", code: 404 }

  if (opts.hard && existing.usage_count === 0) {
    await query("DELETE FROM recruit_email_templates WHERE id = ?", [id])
  } else {
    await query("UPDATE recruit_email_templates SET status = 'Archived' WHERE id = ?", [id])
  }
  return { ok: true, id, template_uid: existing.template_uid || "" }
}

export async function duplicateTemplate(id: number, actorId?: number | null): Promise<TemplateResult> {
  const src = await getTemplate(id)
  if (!src) return { ok: false, error: "Template not found", code: 404 }
  return createTemplate(
    {
      name: `${src.name} (Copy)`,
      template_key: src.template_key ? `${src.template_key}_COPY` : null,
      description: src.description,
      category: src.category,
      audience: src.audience,
      event_key: null,
      subject: src.subject,
      body: src.body,
      body_text: src.body_text,
      status: "Draft",
      attachment: src.attachment_pathname
        ? {
            pathname: src.attachment_pathname,
            filename: src.attachment_name,
            contentType: src.attachment_type,
            size: src.attachment_size,
          }
        : null,
    },
    actorId,
  )
}

export async function recordTemplateUsage(id: number): Promise<void> {
  try {
    await query(
      "UPDATE recruit_email_templates SET usage_count = usage_count + 1, last_used_at = NOW() WHERE id = ?",
      [id],
    )
  } catch {
    // Usage analytics must never break a send.
  }
}

async function snapshotVersion(
  templateId: number,
  version: number,
  name: string,
  subject: string,
  body: string,
  bodyText: string | null,
  category: string | undefined,
  audience: string | undefined,
  status: string,
  actorId?: number | null,
) {
  try {
    await query(
      `INSERT INTO recruit_email_template_versions
        (template_id, version, name, subject, body, body_text, category, audience, status, changed_by)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [templateId, version, name, subject, body, bodyText, category ?? null, audience ?? null, status, actorId ?? null],
    )
  } catch {
    // Version history is best-effort.
  }
}

export async function listVersions(templateId: number) {
  await ensureRecruitEmailTemplateSchema()
  return query<any[]>(
    `SELECT id, version, name, subject, status, changed_by, created_at
     FROM recruit_email_template_versions WHERE template_id = ? ORDER BY version DESC`,
    [templateId],
  )
}
