import "server-only"
import { query } from "@/lib/db"
import { nextRecordId } from "@/lib/record-ids"
import { ensureLetterTables } from "@/lib/hr-letters-db"
import { extractVariables, canTransitionTemplate, type LetterTemplate, type LetterTemplateVersion } from "@/lib/hr-letters-shared"

// ---------------------------------------------------------------------------
// HR Letters — template service (server-only). CRUD + lifecycle + versioning.
// Routes stay thin by delegating persistence and version-snapshot logic here.
// ---------------------------------------------------------------------------

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

function hydrate(row: any): LetterTemplate {
  return { ...row, required_variables: parseJsonArray(row.required_variables) } as LetterTemplate
}

export async function listTemplates(filters: {
  status?: string
  category?: string
  event_key?: string
  audience?: string
  q?: string
} = {}): Promise<LetterTemplate[]> {
  await ensureLetterTables()
  const where: string[] = []
  const args: any[] = []
  if (filters.status) {
    where.push("status = ?")
    args.push(filters.status)
  }
  if (filters.category) {
    where.push("category = ?")
    args.push(filters.category)
  }
  if (filters.event_key) {
    where.push("event_key = ?")
    args.push(filters.event_key)
  }
  if (filters.audience) {
    where.push("audience = ?")
    args.push(filters.audience)
  }
  if (filters.q) {
    where.push("(name LIKE ? OR subject LIKE ? OR template_uid LIKE ?)")
    const like = `%${filters.q}%`
    args.push(like, like, like)
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : ""
  const rows = await query<any[]>(
    `SELECT * FROM hr_letter_templates ${whereSql} ORDER BY updated_at DESC, id DESC`,
    args,
  )
  return rows.map(hydrate)
}

export async function getTemplate(id: number): Promise<LetterTemplate | null> {
  await ensureLetterTables()
  const rows = await query<any[]>("SELECT * FROM hr_letter_templates WHERE id = ? LIMIT 1", [id])
  return rows[0] ? hydrate(rows[0]) : null
}

export type TemplateWriteInput = {
  name?: string
  description?: string | null
  category?: string
  letter_type?: string
  audience?: string
  event_key?: string
  subject?: string
  body?: string
  status?: string
  required_variables?: string[] | null
}

async function snapshotVersion(template: LetterTemplate, changeNote: string | null, userId: number | null) {
  await query(
    `INSERT INTO hr_letter_template_versions
      (template_id, version, name, subject, body, category, letter_type, audience, event_key, status, change_note, changed_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      template.id,
      template.version,
      template.name,
      template.subject,
      template.body,
      template.category,
      template.letter_type,
      template.audience,
      template.event_key,
      template.status,
      changeNote,
      userId,
    ],
  ).catch(() => {})
}

export async function createTemplate(input: TemplateWriteInput, userId: number | null): Promise<LetterTemplate> {
  await ensureLetterTables()
  const name = (input.name || "").trim()
  const subject = (input.subject || "").trim()
  const body = input.body || ""
  if (!name || !subject || !body.trim()) throw new Error("Name, subject and body are required")

  const uid = await nextRecordId("LT").catch(() => null)
  const required = input.required_variables ?? extractVariables(subject, body)

  const result = await query<any>(
    `INSERT INTO hr_letter_templates
      (template_uid, name, description, category, letter_type, audience, event_key, subject, body, status,
       version, required_variables, created_by, updated_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,1,?,?,?)`,
    [
      uid,
      name,
      input.description ?? null,
      input.category || "General",
      input.letter_type || "Other",
      input.audience || "Employee",
      input.event_key || "manual",
      subject,
      body,
      input.status || "Draft",
      JSON.stringify(required),
      userId,
      userId,
    ],
  )
  const created = await getTemplate(Number(result.insertId))
  if (!created) throw new Error("Failed to load created template")
  await snapshotVersion(created, "Created", userId)
  return created
}

export async function updateTemplate(
  id: number,
  input: TemplateWriteInput,
  userId: number | null,
  changeNote?: string | null,
): Promise<LetterTemplate | null> {
  await ensureLetterTables()
  const current = await getTemplate(id)
  if (!current) return null

  const editable: (keyof TemplateWriteInput)[] = [
    "name",
    "description",
    "category",
    "letter_type",
    "audience",
    "event_key",
    "subject",
    "body",
    "status",
  ]
  const sets: string[] = []
  const args: any[] = []
  for (const field of editable) {
    if (Object.prototype.hasOwnProperty.call(input, field)) {
      sets.push(`${field} = ?`)
      args.push((input as any)[field])
    }
  }

  // A content change bumps the version and snapshots the PREVIOUS state.
  const contentChanged =
    (input.subject !== undefined && input.subject !== current.subject) ||
    (input.body !== undefined && input.body !== current.body)

  if (contentChanged) {
    await snapshotVersion(current, changeNote ?? "Edited", userId)
    sets.push("version = version + 1")
    const subject = input.subject ?? current.subject
    const body = input.body ?? current.body
    const required = input.required_variables ?? extractVariables(subject, body)
    sets.push("required_variables = ?")
    args.push(JSON.stringify(required))
  } else if (input.required_variables !== undefined) {
    sets.push("required_variables = ?")
    args.push(JSON.stringify(input.required_variables))
  }

  sets.push("updated_by = ?")
  args.push(userId)

  if (!sets.length) return current
  args.push(id)
  await query(`UPDATE hr_letter_templates SET ${sets.join(", ")} WHERE id = ?`, args)
  return getTemplate(id)
}

export async function transitionTemplate(
  id: number,
  to: string,
  userId: number | null,
): Promise<{ ok: true; template: LetterTemplate } | { ok: false; error: string; code: number }> {
  const current = await getTemplate(id)
  if (!current) return { ok: false, error: "Template not found", code: 404 }
  if (current.status === to) return { ok: true, template: current }
  if (!canTransitionTemplate(current.status, to)) {
    return { ok: false, error: `Cannot move a ${current.status} template to ${to}`, code: 422 }
  }
  await query("UPDATE hr_letter_templates SET status = ?, updated_by = ? WHERE id = ?", [to, userId, id])
  await snapshotVersion({ ...current, status: to }, `Status → ${to}`, userId)
  const template = await getTemplate(id)
  return { ok: true, template: template! }
}

export async function deleteTemplate(id: number): Promise<void> {
  await ensureLetterTables()
  await query("DELETE FROM hr_letter_templates WHERE id = ?", [id])
}

export async function listVersions(templateId: number): Promise<LetterTemplateVersion[]> {
  await ensureLetterTables()
  const rows = await query<any[]>(
    `SELECT v.*, u.name AS changed_by_name
       FROM hr_letter_template_versions v
       LEFT JOIN users u ON u.id = v.changed_by
      WHERE v.template_id = ? ORDER BY v.version DESC, v.id DESC`,
    [templateId],
  )
  return rows as LetterTemplateVersion[]
}
