import "server-only"
import { query } from "@/lib/db"
import { nextRecordId } from "@/lib/record-ids"
import { ensureContractTables } from "@/lib/legal-contracts-db"
import { validateTemplate } from "@/lib/legal-contracts-render"
import {
  type ContractTemplate,
  type ContractTemplateVersion,
  type TemplateStatus,
  canTransitionTemplate,
  extractVariables,
} from "@/lib/legal-contracts-shared"

// ---------------------------------------------------------------------------
// Legal Contracts — template master CRUD, lifecycle & version history.
//
// Editing a Published/Approved template's content bumps the version and files a
// snapshot into legal_contract_template_versions so generated contracts can
// always point at the exact template revision they were built from. Mirrors the
// hr-letter-templates module.
// ---------------------------------------------------------------------------

function parseRequired(value: any): string[] | null {
  if (!value) return null
  if (Array.isArray(value)) return value
  try {
    const parsed = JSON.parse(String(value))
    return Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

function mapTemplate(r: any): ContractTemplate {
  return { ...r, required_variables: parseRequired(r.required_variables) } as ContractTemplate
}

export async function listContractTemplates(filters: {
  search?: string
  status?: string
  contractType?: string
  category?: string
  source?: string
} = {}): Promise<ContractTemplate[]> {
  await ensureContractTables()
  const where: string[] = []
  const params: any[] = []
  if (filters.search) {
    where.push("(t.name LIKE ? OR t.contract_type LIKE ? OR t.description LIKE ?)")
    const like = `%${filters.search}%`
    params.push(like, like, like)
  }
  for (const [col, val] of [
    ["status", filters.status],
    ["contract_type", filters.contractType],
    ["category", filters.category],
    ["source", filters.source],
  ] as [string, string | undefined][]) {
    if (val && val !== "all") {
      where.push(`t.${col} = ?`)
      params.push(val)
    }
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : ""
  const rows = await query<any[]>(
    `SELECT t.*, o.name AS owner_name, cb.name AS created_by_name
       FROM legal_contract_templates t
       LEFT JOIN users o ON o.id = t.owner_id
       LEFT JOIN users cb ON cb.id = t.created_by
       ${whereSql}
      ORDER BY t.updated_at DESC, t.id DESC`,
    params,
  ).catch(() =>
    query<any[]>(`SELECT t.* FROM legal_contract_templates t ${whereSql} ORDER BY t.updated_at DESC, t.id DESC`, params),
  )
  return rows.map(mapTemplate)
}

export async function getContractTemplate(id: number): Promise<ContractTemplate | null> {
  await ensureContractTables()
  const rows = await query<any[]>(
    `SELECT t.*, o.name AS owner_name, cb.name AS created_by_name
       FROM legal_contract_templates t
       LEFT JOIN users o ON o.id = t.owner_id
       LEFT JOIN users cb ON cb.id = t.created_by
      WHERE t.id = ? LIMIT 1`,
    [id],
  ).catch(() => query<any[]>(`SELECT * FROM legal_contract_templates WHERE id = ? LIMIT 1`, [id]))
  return rows[0] ? mapTemplate(rows[0]) : null
}

export type TemplateInput = {
  name: string
  contractType: string
  category: string
  description?: string | null
  source: string
  content: string
  requiredVariables?: string[] | null
  reviewDate?: string | null
  expiryDate?: string | null
  ownerId?: number | null
  actorId?: number | null
}

export async function createContractTemplate(input: TemplateInput): Promise<{ ok: true; template: ContractTemplate } | { ok: false; error: string; details?: string[] }> {
  await ensureContractTables()
  if (!input.name?.trim()) return { ok: false, error: "Name is required" }
  const validation = validateTemplate({ content: input.content, source: input.source })
  if (!validation.valid) return { ok: false, error: validation.errors.join("; "), details: validation.errors }

  const templateUid = await nextRecordId("CONT", { digits: 4 }).then((v) => v.replace("CONT", "CTPL")).catch(() => null)
  const required = input.requiredVariables?.length ? input.requiredVariables : extractVariables(input.content)

  const result = await query<any>(
    `INSERT INTO legal_contract_templates
       (template_uid, name, contract_type, category, description, source, version, status, content,
        required_variables, owner_id, review_date, expiry_date, created_by, updated_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      templateUid,
      input.name.trim(),
      input.contractType || "Other",
      input.category || "Other",
      input.description ?? null,
      input.source || "manual",
      1,
      "Draft",
      input.content,
      JSON.stringify(required),
      input.ownerId ?? input.actorId ?? null,
      input.reviewDate || null,
      input.expiryDate || null,
      input.actorId ?? null,
      input.actorId ?? null,
    ],
  )
  const template = await getContractTemplate(Number((result as any).insertId))
  if (!template) return { ok: false, error: "Failed to load created template" }
  await snapshotVersion(template, "Template created", input.actorId ?? null)
  return { ok: true, template }
}

export async function updateContractTemplate(
  id: number,
  input: Partial<TemplateInput> & { changeNote?: string | null },
): Promise<{ ok: true; template: ContractTemplate } | { ok: false; error: string; details?: string[] }> {
  await ensureContractTables()
  const existing = await getContractTemplate(id)
  if (!existing) return { ok: false, error: "Template not found" }

  const nextContent = input.content ?? existing.content
  const nextSource = input.source ?? existing.source
  const validation = validateTemplate({ content: nextContent, source: nextSource })
  if (!validation.valid) return { ok: false, error: validation.errors.join("; "), details: validation.errors }

  const contentChanged = input.content != null && input.content !== existing.content
  const nextVersion = contentChanged ? existing.version + 1 : existing.version
  const required =
    input.requiredVariables?.length != null
      ? input.requiredVariables
      : contentChanged
        ? extractVariables(nextContent)
        : existing.required_variables

  await query(
    `UPDATE legal_contract_templates SET
        name = ?, contract_type = ?, category = ?, description = ?, source = ?,
        content = ?, required_variables = ?, version = ?, review_date = ?, expiry_date = ?,
        owner_id = ?, updated_by = ?
      WHERE id = ?`,
    [
      input.name?.trim() ?? existing.name,
      input.contractType ?? existing.contract_type,
      input.category ?? existing.category,
      input.description !== undefined ? input.description : existing.description,
      nextSource,
      nextContent,
      JSON.stringify(required ?? []),
      nextVersion,
      input.reviewDate !== undefined ? input.reviewDate || null : existing.review_date,
      input.expiryDate !== undefined ? input.expiryDate || null : existing.expiry_date,
      input.ownerId !== undefined ? input.ownerId : existing.owner_id,
      input.actorId ?? existing.updated_by ?? null,
      id,
    ],
  )
  const template = await getContractTemplate(id)
  if (!template) return { ok: false, error: "Failed to load template" }
  if (contentChanged) await snapshotVersion(template, input.changeNote || `Edited to v${nextVersion}`, input.actorId ?? null)
  return { ok: true, template }
}

export async function setTemplateStatus(
  id: number,
  to: TemplateStatus,
  actorId?: number | null,
): Promise<{ ok: true; template: ContractTemplate } | { ok: false; error: string }> {
  await ensureContractTables()
  const existing = await getContractTemplate(id)
  if (!existing) return { ok: false, error: "Template not found" }
  if (existing.status === to) return { ok: true, template: existing }
  if (!canTransitionTemplate(existing.status, to)) {
    return { ok: false, error: `Cannot move template from ${existing.status} to ${to}` }
  }
  await query("UPDATE legal_contract_templates SET status = ?, updated_by = ? WHERE id = ?", [
    to,
    actorId ?? null,
    id,
  ])
  const template = await getContractTemplate(id)
  if (!template) return { ok: false, error: "Failed to load template" }
  await snapshotVersion(template, `Status → ${to}`, actorId ?? null)
  return { ok: true, template }
}

export async function deleteContractTemplate(id: number): Promise<{ ok: boolean; error?: string }> {
  await ensureContractTables()
  const used = await query<any[]>(
    "SELECT id FROM legal_generated_contracts WHERE template_id = ? LIMIT 1",
    [id],
  ).catch(() => [] as any[])
  if (used[0]) {
    // Preserve history: archive instead of hard-delete when contracts exist.
    await query("UPDATE legal_contract_templates SET status = 'Archived' WHERE id = ?", [id])
    return { ok: true, error: "Template archived (generated contracts reference it)" }
  }
  await query("DELETE FROM legal_contract_templates WHERE id = ?", [id])
  return { ok: true }
}

export async function listTemplateVersions(templateId: number): Promise<ContractTemplateVersion[]> {
  await ensureContractTables()
  const rows = await query<any[]>(
    `SELECT v.*, u.name AS changed_by_name
       FROM legal_contract_template_versions v
       LEFT JOIN users u ON u.id = v.changed_by
      WHERE v.template_id = ?
      ORDER BY v.version DESC, v.id DESC`,
    [templateId],
  ).catch(() =>
    query<any[]>(
      `SELECT * FROM legal_contract_template_versions WHERE template_id = ? ORDER BY version DESC, id DESC`,
      [templateId],
    ),
  )
  return rows as ContractTemplateVersion[]
}

async function snapshotVersion(t: ContractTemplate, note: string, actorId: number | null) {
  await query(
    `INSERT INTO legal_contract_template_versions
       (template_id, version, name, contract_type, category, source, status, content, change_note, changed_by)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [t.id, t.version, t.name, t.contract_type, t.category, t.source, t.status, t.content, note, actorId],
  ).catch((err) => console.error("[legal-contracts-templates] snapshotVersion failed", err))
}
