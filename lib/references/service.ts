import "server-only"
/**
 * SPEC 93 — Reference Number Management: capture + duplicate detection (Phase 3 & 4).
 * ---------------------------------------------------------------------------
 * The side-effecting core that attaches reference values to documents and
 * enforces the configured duplicate policy. Everything about WHAT a reference
 * is lives in the pure model (model.ts); everything about the CONFIG lives in
 * the store (store.ts); this file owns the reference values themselves and the
 * duplicate check that runs against them.
 *
 * Duplicate detection (Phase 4): a candidate value is normalized to a
 * comparison key (model.duplicateKey) and matched against existing references
 * for the SAME (tenant, document type, reference type) via the
 * (tenant, doc type, ref type, normalized) index. The configured policy decides
 * the outcome:
 *   off   → never checked.
 *   warn  → matches are returned but the value is still saved.
 *   block → a match rejects the save inside the transaction, so two documents
 *           can never end up sharing a blocked reference even under a race
 *           (the UNIQUE key + FOR UPDATE serialize concurrent writers).
 */
import { pool, query } from "@/lib/db"
import { requireCurrentTenantId } from "@/lib/tenant-context"
import { ensureReferenceSchema } from "@/lib/references/schema"
import { effectiveConfig } from "@/lib/references/store"
import {
  type ReferenceType,
  cleanRefValue,
  duplicateKey,
  validateRefValue,
} from "@/lib/references/model"

export type DocumentReference = {
  docType: string
  documentId: string
  refType: ReferenceType
  value: string
}

export type DuplicateMatch = {
  documentId: string
  value: string
}

function normDoc(docType: string): string {
  return String(docType ?? "").toUpperCase().replace(/[^A-Z0-9_]/g, "")
}

/**
 * Find existing documents that already carry the same reference value for a
 * (document type, reference type), ignoring casing/punctuation. Optionally
 * excludes one document (the one being edited). Returns [] for a blank value or
 * when the config disables duplicate checking.
 */
export async function findDuplicates(
  docType: string,
  refType: ReferenceType,
  rawValue: string,
  opts: { excludeDocumentId?: string } = {},
): Promise<DuplicateMatch[]> {
  const value = cleanRefValue(rawValue)
  if (!value) return []
  const config = await effectiveConfig(docType, refType)
  if (config.duplicate === "off") return []

  await ensureReferenceSchema()
  const tenantId = requireCurrentTenantId()
  const key = duplicateKey(value)
  const params: any[] = [tenantId, normDoc(docType), refType, key]
  let sql = `SELECT document_id, ref_value FROM document_references
              WHERE tenant_id = ? AND document_type = ? AND ref_type = ? AND normalized = ?`
  if (opts.excludeDocumentId) {
    sql += ` AND document_id <> ?`
    params.push(String(opts.excludeDocumentId))
  }
  const rows = (await query(sql, params)) as { document_id: string; ref_value: string }[]
  return rows.map((r) => ({ documentId: String(r.document_id), value: String(r.ref_value) }))
}

export type SetReferenceResult =
  | { ok: true; value: string; duplicates: DuplicateMatch[] }
  | { ok: false; error: string; duplicates?: DuplicateMatch[] }

/**
 * Attach (or update, or clear) one reference value on a document, enforcing the
 * configured presence, shape and duplicate rules. A blank value clears the
 * reference. Runs in a transaction so a `block` policy is race-safe: the
 * duplicate check and the write are serialized against concurrent writers.
 */
export async function setReference(
  docType: string,
  documentId: string,
  refType: ReferenceType,
  rawValue: string,
  opts: { createdBy?: number | null } = {},
): Promise<SetReferenceResult> {
  const doc = normDoc(docType)
  const id = String(documentId ?? "").trim()
  if (!doc) return { ok: false, error: "A document type is required." }
  if (!id) return { ok: false, error: "A document id is required." }

  const config = await effectiveConfig(doc, refType)
  const validated = validateRefValue(config, rawValue)
  if (!validated.ok) return { ok: false, error: validated.error }

  await ensureReferenceSchema()
  const tenantId = requireCurrentTenantId()

  // Blank + not required → clear any existing value for this reference.
  if (!validated.value) {
    await query(
      `DELETE FROM document_references
        WHERE tenant_id = ? AND document_type = ? AND document_id = ? AND ref_type = ?`,
      [tenantId, doc, id, refType],
    )
    return { ok: true, value: "", duplicates: [] }
  }

  const connection = await pool.getConnection()
  try {
    await connection.beginTransaction()

    let duplicates: DuplicateMatch[] = []
    if (config.duplicate !== "off") {
      const [rows] = await connection.query<any[]>(
        `SELECT document_id, ref_value FROM document_references
          WHERE tenant_id = ? AND document_type = ? AND ref_type = ? AND normalized = ?
            AND document_id <> ?
          FOR UPDATE`,
        [tenantId, doc, refType, validated.key, id],
      )
      duplicates = rows.map((r) => ({ documentId: String(r.document_id), value: String(r.ref_value) }))
      if (config.duplicate === "block" && duplicates.length > 0) {
        await connection.rollback().catch(() => {})
        return {
          ok: false,
          error: `Duplicate ${refType} reference — already used by ${duplicates
            .map((d) => d.documentId)
            .join(", ")}.`,
          duplicates,
        }
      }
    }

    await connection.query(
      `INSERT INTO document_references
         (tenant_id, document_type, document_id, ref_type, ref_value, normalized, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         ref_value = VALUES(ref_value),
         normalized = VALUES(normalized)`,
      [tenantId, doc, id, refType, validated.value, validated.key, opts.createdBy ?? null],
    )

    await connection.commit()
    return { ok: true, value: validated.value, duplicates }
  } catch (error) {
    await connection.rollback().catch(() => {})
    throw error
  } finally {
    connection.release()
  }
}

/** Every reference value attached to one document. */
export async function listReferences(
  docType: string,
  documentId: string,
): Promise<DocumentReference[]> {
  await ensureReferenceSchema()
  const tenantId = requireCurrentTenantId()
  const rows = (await query(
    `SELECT document_type, document_id, ref_type, ref_value
       FROM document_references
      WHERE tenant_id = ? AND document_type = ? AND document_id = ?
      ORDER BY ref_type`,
    [tenantId, normDoc(docType), String(documentId)],
  )) as { document_type: string; document_id: string; ref_type: string; ref_value: string }[]
  return rows.map((r) => ({
    docType: String(r.document_type),
    documentId: String(r.document_id),
    refType: r.ref_type as ReferenceType,
    value: String(r.ref_value),
  }))
}

/**
 * Resolve a raw reference value to the documents that carry it — the console's
 * cross-reference lookup. Searches every reference type unless one is given.
 */
export async function resolveReference(
  rawValue: string,
  opts: { docType?: string; refType?: ReferenceType } = {},
): Promise<Array<DocumentReference>> {
  const value = cleanRefValue(rawValue)
  if (!value) return []
  await ensureReferenceSchema()
  const tenantId = requireCurrentTenantId()
  const key = duplicateKey(value)
  const params: any[] = [tenantId, key]
  let sql = `SELECT document_type, document_id, ref_type, ref_value
               FROM document_references
              WHERE tenant_id = ? AND normalized = ?`
  if (opts.docType) {
    sql += ` AND document_type = ?`
    params.push(normDoc(opts.docType))
  }
  if (opts.refType) {
    sql += ` AND ref_type = ?`
    params.push(opts.refType)
  }
  sql += ` ORDER BY document_type, ref_type LIMIT 100`
  const rows = (await query(sql, params)) as {
    document_type: string
    document_id: string
    ref_type: string
    ref_value: string
  }[]
  return rows.map((r) => ({
    docType: String(r.document_type),
    documentId: String(r.document_id),
    refType: r.ref_type as ReferenceType,
    value: String(r.ref_value),
  }))
}
