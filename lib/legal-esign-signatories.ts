import "server-only"
import { query } from "@/lib/db"
import { nextRecordId } from "@/lib/record-ids"
import { ensureEsignTables, storeEsignFile } from "@/lib/legal-esign"
import type { EsignSignatory, SignatoryStatus } from "@/lib/legal-esign-shared"

// ---------------------------------------------------------------------------
// Legal E-sign — authorized signatory master (server-only).
//
// Muenot's authorized signatories are DERIVED from the existing Employee master
// (Phase 7) — this table only marks who may sign on the company's behalf and
// holds their securely-stored signature image. Signature changes are versioned
// (Phases 13-14); revoked/inactive signatories can't be used on new documents
// (Phase 16).
// ---------------------------------------------------------------------------

function mapRow(r: any): EsignSignatory {
  return {
    id: Number(r.id),
    signatory_uid: r.signatory_uid,
    employee_id: r.employee_id != null ? Number(r.employee_id) : null,
    name: r.name,
    designation: r.designation ?? null,
    department: r.department ?? null,
    email: r.email ?? null,
    signature_file_id: r.signature_file_id ?? null,
    signature_status: r.signature_status === "Uploaded" ? "Uploaded" : "None",
    status: (r.status as SignatoryStatus) || "Active",
    is_default: Number(r.is_default || 0),
    default_scope: r.default_scope ?? null,
    created_by: r.created_by != null ? Number(r.created_by) : null,
    created_at: r.created_at ? new Date(r.created_at).toISOString() : null,
    updated_at: r.updated_at ? new Date(r.updated_at).toISOString() : null,
    employee_name: r.employee_name ?? null,
  }
}

export async function listSignatories(opts: { includeInactive?: boolean; activeOnly?: boolean } = {}): Promise<
  EsignSignatory[]
> {
  await ensureEsignTables()
  const where = opts.activeOnly ? `WHERE s.status = 'Active'` : ""
  const rows = await query<any[]>(
    `SELECT s.*, e.name AS employee_name FROM legal_esign_signatories s
       LEFT JOIN employees e ON e.id = s.employee_id
       ${where}
      ORDER BY s.is_default DESC, s.status = 'Active' DESC, s.name ASC`,
  ).catch(() =>
    query<any[]>(`SELECT s.* FROM legal_esign_signatories s ${where} ORDER BY s.is_default DESC, s.name ASC`),
  )
  return rows.map(mapRow)
}

export async function getSignatory(id: number): Promise<EsignSignatory | null> {
  await ensureEsignTables()
  const rows = await query<any[]>(
    `SELECT s.*, e.name AS employee_name FROM legal_esign_signatories s
       LEFT JOIN employees e ON e.id = s.employee_id WHERE s.id = ? LIMIT 1`,
    [id],
  ).catch(() => query<any[]>(`SELECT s.* FROM legal_esign_signatories s WHERE s.id = ? LIMIT 1`, [id]))
  return rows[0] ? mapRow(rows[0]) : null
}

export type CreateSignatoryInput = {
  employeeId?: number | null
  name: string
  designation?: string | null
  department?: string | null
  email?: string | null
  isDefault?: boolean
  defaultScope?: string | null
  createdBy?: number | null
}

export async function createSignatory(input: CreateSignatoryInput): Promise<EsignSignatory> {
  await ensureEsignTables()
  const uid = await nextRecordId("ESG", { allowCustom: true })
  if (input.isDefault && input.defaultScope) {
    await query(`UPDATE legal_esign_signatories SET is_default = 0 WHERE default_scope = ?`, [input.defaultScope])
  }
  const result = await query<any>(
    `INSERT INTO legal_esign_signatories
       (signatory_uid, employee_id, name, designation, department, email, is_default, default_scope, created_by)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [
      uid,
      input.employeeId ?? null,
      input.name,
      input.designation ?? null,
      input.department ?? null,
      input.email ?? null,
      input.isDefault ? 1 : 0,
      input.defaultScope ?? null,
      input.createdBy ?? null,
    ],
  )
  const id = Number((result as any).insertId)
  return (await getSignatory(id)) as EsignSignatory
}

export type UpdateSignatoryInput = {
  name?: string
  designation?: string | null
  department?: string | null
  email?: string | null
  status?: SignatoryStatus
  isDefault?: boolean
  defaultScope?: string | null
}

export async function updateSignatory(id: number, input: UpdateSignatoryInput): Promise<EsignSignatory | null> {
  await ensureEsignTables()
  const sets: string[] = []
  const params: any[] = []
  const push = (col: string, val: any) => {
    sets.push(`${col} = ?`)
    params.push(val)
  }
  if (input.name !== undefined) push("name", input.name)
  if (input.designation !== undefined) push("designation", input.designation)
  if (input.department !== undefined) push("department", input.department)
  if (input.email !== undefined) push("email", input.email)
  if (input.status !== undefined) push("status", input.status)
  if (input.defaultScope !== undefined) push("default_scope", input.defaultScope)
  if (input.isDefault !== undefined) {
    if (input.isDefault) {
      const scope = input.defaultScope ?? (await getSignatory(id))?.default_scope ?? null
      if (scope) await query(`UPDATE legal_esign_signatories SET is_default = 0 WHERE default_scope = ?`, [scope])
    }
    push("is_default", input.isDefault ? 1 : 0)
  }
  if (sets.length) {
    params.push(id)
    await query(`UPDATE legal_esign_signatories SET ${sets.join(", ")} WHERE id = ?`, params)
  }
  return getSignatory(id)
}

/**
 * Store a new signature image for a signatory. The previous signature (if any)
 * is preserved as a version row (Phases 13-14) so historical documents never
 * lose the mark that was in force when they were signed (Phase 80).
 */
export async function setSignatorySignature(input: {
  signatoryId: number
  data: Buffer
  contentType: string
  filename?: string | null
  changedBy?: number | null
}): Promise<EsignSignatory | null> {
  await ensureEsignTables()
  const current = await getSignatory(input.signatoryId)
  if (!current) return null

  const fileId = await storeEsignFile({
    kind: "signature",
    data: input.data,
    contentType: input.contentType,
    filename: input.filename ?? `signature-${current.signatory_uid}.png`,
    createdBy: input.changedBy ?? null,
  })

  // Archive the outgoing signature as a version before replacing it.
  if (current.signature_file_id) {
    await query(
      `INSERT INTO legal_esign_signatory_versions (signatory_id, signature_file_id, note, changed_by)
       VALUES (?,?,?,?)`,
      [input.signatoryId, current.signature_file_id, "Replaced", input.changedBy ?? null],
    )
  }

  await query(
    `UPDATE legal_esign_signatories SET signature_file_id = ?, signature_status = 'Uploaded' WHERE id = ?`,
    [fileId, input.signatoryId],
  )
  return getSignatory(input.signatoryId)
}

/** Remove the current signature (kept in history) — Phase 11 "Remove where permitted". */
export async function removeSignatorySignature(
  signatoryId: number,
  changedBy?: number | null,
): Promise<EsignSignatory | null> {
  await ensureEsignTables()
  const current = await getSignatory(signatoryId)
  if (!current) return null
  if (current.signature_file_id) {
    await query(
      `INSERT INTO legal_esign_signatory_versions (signatory_id, signature_file_id, note, changed_by) VALUES (?,?,?,?)`,
      [signatoryId, current.signature_file_id, "Removed", changedBy ?? null],
    )
  }
  await query(
    `UPDATE legal_esign_signatories SET signature_file_id = NULL, signature_status = 'None' WHERE id = ?`,
    [signatoryId],
  )
  return getSignatory(signatoryId)
}

export async function getSignatureHistory(signatoryId: number): Promise<
  { id: number; signature_file_id: string | null; note: string | null; changed_by: number | null; changed_at: string | null }[]
> {
  await ensureEsignTables()
  const rows = await query<any[]>(
    `SELECT * FROM legal_esign_signatory_versions WHERE signatory_id = ? ORDER BY changed_at DESC, id DESC`,
    [signatoryId],
  )
  return rows.map((r) => ({
    id: Number(r.id),
    signature_file_id: r.signature_file_id ?? null,
    note: r.note ?? null,
    changed_by: r.changed_by != null ? Number(r.changed_by) : null,
    changed_at: r.changed_at ? new Date(r.changed_at).toISOString() : null,
  }))
}

/** Default signatory for a scope (e.g. "legal", "hr") — Phase 17. */
export async function getDefaultSignatory(scope?: string | null): Promise<EsignSignatory | null> {
  await ensureEsignTables()
  const rows = scope
    ? await query<any[]>(
        `SELECT * FROM legal_esign_signatories WHERE status='Active' AND is_default=1 AND default_scope=? LIMIT 1`,
        [scope],
      )
    : await query<any[]>(`SELECT * FROM legal_esign_signatories WHERE status='Active' AND is_default=1 LIMIT 1`)
  return rows[0] ? mapRow(rows[0]) : null
}
