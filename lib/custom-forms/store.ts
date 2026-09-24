import "server-only"
/**
 * SPEC 95 — Custom Forms: definition store (Phase 2).
 * ---------------------------------------------------------------------------
 * Reads and writes the per-tenant form DEFINITIONS. Submissions live in
 * service.ts; this file owns only the form/schema side.
 *
 * Every statement is tenant-scoped: the acting tenant comes from the request
 * context (never caller input), so one tenant can never read or mutate another
 * tenant's forms.
 */
import { query } from "@/lib/db"
import { requireCurrentTenantId } from "@/lib/tenant-context"
import { ensureCustomFormSchema } from "@/lib/custom-forms/schema"
import {
  type FormDefInput,
  type FormDefinition,
  type FormSection,
  type FormStatus,
  normalizeSlug,
  validateFormDefinition,
} from "@/lib/custom-forms/model"
import { toTenantRole } from "@/lib/role-model"

type FormRow = {
  id: number
  slug: string
  title: string
  description: string
  status: string
  submit_label: string
  approval_enabled: number
  approver_min_role: string
  sections_json: string | null
  version: number
}

function parseJson<T>(raw: string | null, fallback: T): T {
  if (raw == null) return fallback
  if (typeof raw === "object") return raw as T
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

function rowToForm(row: FormRow): FormDefinition {
  return {
    id: Number(row.id),
    slug: row.slug,
    title: row.title,
    description: row.description ?? "",
    status: (["draft", "published", "archived"].includes(row.status) ? row.status : "draft") as FormStatus,
    submitLabel: row.submit_label || "Submit",
    approval: {
      enabled: Number(row.approval_enabled) === 1,
      approverMinRole: toTenantRole(row.approver_min_role),
    },
    sections: parseJson<FormSection[]>(row.sections_json, []),
    version: Number(row.version) || 1,
  }
}

const COLUMNS = `id, slug, title, description, status, submit_label, approval_enabled, approver_min_role, sections_json, version`

/** Every form definition for the tenant, newest first. */
export async function listForms(): Promise<FormDefinition[]> {
  await ensureCustomFormSchema()
  const tenantId = requireCurrentTenantId()
  const rows = (await query(
    `SELECT ${COLUMNS} FROM custom_forms WHERE tenant_id = ? ORDER BY updated_at DESC, id DESC`,
    [tenantId],
  )) as FormRow[]
  return rows.map(rowToForm)
}

/** One form by id, scoped to the tenant. */
export async function getFormById(id: number): Promise<FormDefinition | null> {
  await ensureCustomFormSchema()
  const tenantId = requireCurrentTenantId()
  const rows = (await query(`SELECT ${COLUMNS} FROM custom_forms WHERE tenant_id = ? AND id = ? LIMIT 1`, [
    tenantId,
    id,
  ])) as FormRow[]
  return rows[0] ? rowToForm(rows[0]) : null
}

/** One form by slug, scoped to the tenant (used by the public renderer). */
export async function getFormBySlug(slug: string): Promise<FormDefinition | null> {
  await ensureCustomFormSchema()
  const tenantId = requireCurrentTenantId()
  const rows = (await query(`SELECT ${COLUMNS} FROM custom_forms WHERE tenant_id = ? AND slug = ? LIMIT 1`, [
    tenantId,
    normalizeSlug(slug),
  ])) as FormRow[]
  return rows[0] ? rowToForm(rows[0]) : null
}

/**
 * Validate and persist a form definition. Creates when `id` is absent, updates
 * in place otherwise, bumping the version on every save so submissions can pin
 * the schema they were captured against. The slug is made unique per tenant.
 */
export async function saveForm(
  input: FormDefInput,
  actor: number | null,
): Promise<{ ok: true; form: FormDefinition } | { ok: false; errors: string[] }> {
  const parsed = validateFormDefinition(input)
  if (!parsed.ok) return parsed

  await ensureCustomFormSchema()
  const tenantId = requireCurrentTenantId()
  const def = parsed.def
  const slug = await uniqueSlug(tenantId, def.slug, input.id ?? null)
  def.slug = slug

  if (input.id) {
    const existing = await getFormById(input.id)
    if (!existing) return { ok: false, errors: ["Form not found."] }
    const version = existing.version + 1
    def.version = version
    await query(
      `UPDATE custom_forms
          SET slug = ?, title = ?, description = ?, status = ?, submit_label = ?,
              approval_enabled = ?, approver_min_role = ?, sections_json = ?, version = ?
        WHERE tenant_id = ? AND id = ?`,
      [
        slug,
        def.title,
        def.description,
        def.status,
        def.submitLabel,
        def.approval.enabled ? 1 : 0,
        def.approval.approverMinRole,
        JSON.stringify(def.sections),
        version,
        tenantId,
        input.id,
      ],
    )
    def.id = input.id
    return { ok: true, form: def }
  }

  def.version = 1
  const result = (await query(
    `INSERT INTO custom_forms
       (tenant_id, slug, title, description, status, submit_label, approval_enabled,
        approver_min_role, sections_json, version, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      tenantId,
      slug,
      def.title,
      def.description,
      def.status,
      def.submitLabel,
      def.approval.enabled ? 1 : 0,
      def.approval.approverMinRole,
      JSON.stringify(def.sections),
      1,
      actor,
    ],
  )) as { insertId?: number }
  def.id = result.insertId ?? null
  return { ok: true, form: def }
}

/** Change only a form's lifecycle status (draft / published / archived). */
export async function setFormStatus(
  id: number,
  status: FormStatus,
): Promise<{ ok: true } | { ok: false; error: string }> {
  await ensureCustomFormSchema()
  const tenantId = requireCurrentTenantId()
  const res = (await query(`UPDATE custom_forms SET status = ? WHERE tenant_id = ? AND id = ?`, [
    status,
    tenantId,
    id,
  ])) as { affectedRows?: number }
  if (!res.affectedRows) return { ok: false, error: "Form not found." }
  return { ok: true }
}

/** Delete a form and all of its submissions. */
export async function deleteForm(id: number): Promise<{ ok: true } | { ok: false; error: string }> {
  await ensureCustomFormSchema()
  const tenantId = requireCurrentTenantId()
  await query(`DELETE FROM custom_form_submissions WHERE tenant_id = ? AND form_id = ?`, [tenantId, id])
  const res = (await query(`DELETE FROM custom_forms WHERE tenant_id = ? AND id = ?`, [tenantId, id])) as {
    affectedRows?: number
  }
  if (!res.affectedRows) return { ok: false, error: "Form not found." }
  return { ok: true }
}

/** Make a slug unique within the tenant, ignoring the row being updated. */
async function uniqueSlug(tenantId: number, base: string, ignoreId: number | null): Promise<string> {
  const rows = (await query(`SELECT id, slug FROM custom_forms WHERE tenant_id = ?`, [tenantId])) as {
    id: number
    slug: string
  }[]
  const taken = new Set(rows.filter((r) => r.id !== ignoreId).map((r) => r.slug))
  if (!taken.has(base)) return base
  let n = 2
  while (taken.has(`${base}-${n}`)) n++
  return `${base}-${n}`
}
