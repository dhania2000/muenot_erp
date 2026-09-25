import "server-only"
/**
 * SPEC 19 (req #74) — tenant-scoped persistence for document extractions.
 * Every read/write goes through the tenant-scope helpers so a forged id can
 * never touch another tenant's extraction. Audit + version snapshots are written
 * here so the trail can never drift from the data.
 */

import { query } from "@/lib/db"
import {
  currentTenantId,
  tenantInsert,
  tenantUpdate,
  tenantFindById,
  tenantSelect,
} from "@/lib/tenant-scope"
import { ensureDocIntelligenceSchema } from "./schema"
import {
  normalizeStatus,
  normalizeDocType,
  type ExtractedField,
  type ExtractionStatus,
  type ClassifiedDocType,
  type SourceHighlight,
} from "./model"

export type ExtractionRow = {
  id: number
  tenant_id: number
  file_id: number
  file_ref: string | null
  dms_document_id: number | null
  doc_type: string
  status: string
  extraction_version: number
  provider: string | null
  model_id: string | null
  language: string | null
  overall_confidence: string | number
  fields_json: string | null
  highlights_json: string | null
  warnings_json: string | null
  content_hash: string
  post_idempotency_key: string | null
  posted_entity_type: string | null
  posted_entity_id: string | null
  reviewed_by: number | null
  reviewed_at: string | null
  posted_by: number | null
  posted_at: string | null
  error: string | null
  created_by: number | null
  created_at: string | null
  updated_at: string | null
}

export type Extraction = {
  id: number
  tenantId: number
  fileId: number
  fileRef: string | null
  dmsDocumentId: number | null
  docType: ClassifiedDocType
  status: ExtractionStatus
  version: number
  provider: string | null
  modelId: string | null
  language: string | null
  overallConfidence: number
  fields: ExtractedField[]
  highlights: SourceHighlight[]
  warnings: string[]
  contentHash: string
  postIdempotencyKey: string | null
  postedEntityType: string | null
  postedEntityId: string | null
  reviewedBy: number | null
  reviewedAt: string | null
  postedBy: number | null
  postedAt: string | null
  error: string | null
  createdBy: number | null
  createdAt: string | null
  updatedAt: string | null
}

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

export function mapExtraction(row: ExtractionRow): Extraction {
  return {
    id: Number(row.id),
    tenantId: Number(row.tenant_id),
    fileId: Number(row.file_id),
    fileRef: row.file_ref,
    dmsDocumentId: row.dms_document_id != null ? Number(row.dms_document_id) : null,
    docType: normalizeDocType(row.doc_type),
    status: normalizeStatus(row.status),
    version: Number(row.extraction_version),
    provider: row.provider,
    modelId: row.model_id,
    language: row.language,
    overallConfidence: Number(row.overall_confidence),
    fields: parseJson<ExtractedField[]>(row.fields_json, []),
    highlights: parseJson<SourceHighlight[]>(row.highlights_json, []),
    warnings: parseJson<string[]>(row.warnings_json, []),
    contentHash: row.content_hash,
    postIdempotencyKey: row.post_idempotency_key,
    postedEntityType: row.posted_entity_type,
    postedEntityId: row.posted_entity_id,
    reviewedBy: row.reviewed_by != null ? Number(row.reviewed_by) : null,
    reviewedAt: row.reviewed_at,
    postedBy: row.posted_by != null ? Number(row.posted_by) : null,
    postedAt: row.posted_at,
    error: row.error,
    createdBy: row.created_by != null ? Number(row.created_by) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export type CreateExtractionInput = {
  fileId: number
  fileRef: string | null
  docType: ClassifiedDocType
  contentHash: string
  dmsDocumentId?: number | null
  createdBy: number | null
}

/**
 * Insert a new extraction, or return the existing one with the same content hash
 * (idempotent for repeated uploads of identical bytes within a tenant).
 */
export async function createExtraction(
  input: CreateExtractionInput,
): Promise<{ extraction: Extraction; deduped: boolean }> {
  await ensureDocIntelligenceSchema()
  const existing = await findByContentHash(input.contentHash)
  if (existing) return { extraction: existing, deduped: true }

  const { insertId } = await tenantInsert("ai_document_extractions", {
    file_id: input.fileId,
    file_ref: input.fileRef,
    dms_document_id: input.dmsDocumentId ?? null,
    doc_type: input.docType,
    status: "uploaded",
    extraction_version: 0,
    overall_confidence: 0,
    content_hash: input.contentHash,
    created_by: input.createdBy,
  })
  const created = await getExtraction(insertId)
  if (!created) throw new Error("Failed to load created extraction")
  return { extraction: created, deduped: false }
}

export async function findByContentHash(contentHash: string): Promise<Extraction | null> {
  await ensureDocIntelligenceSchema()
  const rows = await tenantSelect<ExtractionRow[]>("ai_document_extractions", {
    where: "content_hash = ?",
    params: [contentHash],
    tail: "LIMIT 1",
  })
  return rows[0] ? mapExtraction(rows[0]) : null
}

export async function getExtraction(id: number): Promise<Extraction | null> {
  await ensureDocIntelligenceSchema()
  const row = await tenantFindById<ExtractionRow>("ai_document_extractions", id)
  return row ? mapExtraction(row) : null
}

export type ExtractionFilter = {
  status?: ExtractionStatus
  docType?: ClassifiedDocType
  limit?: number
}

export async function listExtractions(filter: ExtractionFilter = {}): Promise<Extraction[]> {
  await ensureDocIntelligenceSchema()
  const clauses: string[] = []
  const params: any[] = []
  if (filter.status) {
    clauses.push("status = ?")
    params.push(filter.status)
  }
  if (filter.docType) {
    clauses.push("doc_type = ?")
    params.push(filter.docType)
  }
  const limit = Math.min(Math.max(filter.limit ?? 100, 1), 500)
  const rows = await tenantSelect<ExtractionRow[]>("ai_document_extractions", {
    where: clauses.join(" AND "),
    params,
    tail: `ORDER BY id DESC LIMIT ${limit}`,
  })
  return rows.map(mapExtraction)
}

export type UpdateExtractionInput = Partial<{
  status: ExtractionStatus
  docType: ClassifiedDocType
  version: number
  provider: string | null
  modelId: string | null
  language: string | null
  overallConfidence: number
  fields: ExtractedField[]
  highlights: SourceHighlight[]
  warnings: string[]
  dmsDocumentId: number | null
  postIdempotencyKey: string | null
  postedEntityType: string | null
  postedEntityId: string | null
  reviewedBy: number | null
  reviewedAt: Date | null
  postedBy: number | null
  postedAt: Date | null
  error: string | null
}>

export async function updateExtraction(id: number, patch: UpdateExtractionInput): Promise<number> {
  await ensureDocIntelligenceSchema()
  const set: Record<string, any> = {}
  if (patch.status !== undefined) set.status = patch.status
  if (patch.docType !== undefined) set.doc_type = patch.docType
  if (patch.version !== undefined) set.extraction_version = patch.version
  if (patch.provider !== undefined) set.provider = patch.provider
  if (patch.modelId !== undefined) set.model_id = patch.modelId
  if (patch.language !== undefined) set.language = patch.language
  if (patch.overallConfidence !== undefined) set.overall_confidence = patch.overallConfidence
  if (patch.fields !== undefined) set.fields_json = JSON.stringify(patch.fields)
  if (patch.highlights !== undefined) set.highlights_json = JSON.stringify(patch.highlights)
  if (patch.warnings !== undefined) set.warnings_json = JSON.stringify(patch.warnings)
  if (patch.dmsDocumentId !== undefined) set.dms_document_id = patch.dmsDocumentId
  if (patch.postIdempotencyKey !== undefined) set.post_idempotency_key = patch.postIdempotencyKey
  if (patch.postedEntityType !== undefined) set.posted_entity_type = patch.postedEntityType
  if (patch.postedEntityId !== undefined) set.posted_entity_id = patch.postedEntityId
  if (patch.reviewedBy !== undefined) set.reviewed_by = patch.reviewedBy
  if (patch.reviewedAt !== undefined) set.reviewed_at = patch.reviewedAt
  if (patch.postedBy !== undefined) set.posted_by = patch.postedBy
  if (patch.postedAt !== undefined) set.posted_at = patch.postedAt
  if (patch.error !== undefined) set.error = patch.error?.slice(0, 1000) ?? null
  if (Object.keys(set).length === 0) return 0
  return tenantUpdate("ai_document_extractions", set, "id = ?", [id])
}

/** Persist an immutable snapshot of an extraction version (audit of extraction). */
export async function snapshotVersion(input: {
  extractionId: number
  version: number
  docType: ClassifiedDocType
  provider: string | null
  modelId: string | null
  overallConfidence: number
  fields: ExtractedField[]
  createdBy: number | null
}): Promise<void> {
  await ensureDocIntelligenceSchema()
  try {
    await tenantInsert("ai_document_extraction_versions", {
      extraction_id: input.extractionId,
      version: input.version,
      doc_type: input.docType,
      provider: input.provider,
      model_id: input.modelId,
      overall_confidence: input.overallConfidence,
      fields_json: JSON.stringify(input.fields),
      created_by: input.createdBy,
    })
  } catch (err) {
    // A duplicate version snapshot (retry) is harmless; log everything else.
    console.error("[v0] doc-intelligence version snapshot failed:", err)
  }
}

export async function listVersions(extractionId: number): Promise<
  { version: number; docType: string; overallConfidence: number; fields: ExtractedField[]; createdBy: number | null; createdAt: string | null }[]
> {
  await ensureDocIntelligenceSchema()
  const rows = await tenantSelect<any[]>("ai_document_extraction_versions", {
    where: "extraction_id = ?",
    params: [extractionId],
    tail: "ORDER BY version ASC",
  })
  return rows.map((r) => ({
    version: Number(r.version),
    docType: String(r.doc_type),
    overallConfidence: Number(r.overall_confidence),
    fields: parseJson<ExtractedField[]>(r.fields_json, []),
    createdBy: r.created_by != null ? Number(r.created_by) : null,
    createdAt: r.created_at,
  }))
}

export async function logExtractionAudit(input: {
  extractionId: number
  action: string
  detail?: string | null
  fromVersion?: number | null
  toVersion?: number | null
  userId?: number | null
}): Promise<void> {
  await ensureDocIntelligenceSchema()
  try {
    await tenantInsert("ai_document_extraction_audit", {
      extraction_id: input.extractionId,
      action: input.action.slice(0, 40),
      detail: input.detail?.slice(0, 1000) ?? null,
      from_version: input.fromVersion ?? null,
      to_version: input.toVersion ?? null,
      user_id: input.userId ?? null,
    })
  } catch (err) {
    // Audit must never break the primary operation.
    console.error("[v0] doc-intelligence audit log failed:", err)
  }
}

export type AuditEntry = {
  id: number
  action: string
  detail: string | null
  fromVersion: number | null
  toVersion: number | null
  userId: number | null
  createdAt: string | null
}

export async function listExtractionAudit(extractionId: number, limit = 200): Promise<AuditEntry[]> {
  await ensureDocIntelligenceSchema()
  const cap = Math.min(Math.max(limit, 1), 500)
  const rows = await tenantSelect<any[]>("ai_document_extraction_audit", {
    where: "extraction_id = ?",
    params: [extractionId],
    tail: `ORDER BY id DESC LIMIT ${cap}`,
  })
  return rows.map((r) => ({
    id: Number(r.id),
    action: String(r.action),
    detail: r.detail,
    fromVersion: r.from_version != null ? Number(r.from_version) : null,
    toVersion: r.to_version != null ? Number(r.to_version) : null,
    userId: r.user_id != null ? Number(r.user_id) : null,
    createdAt: r.created_at,
  }))
}

/** Guard: the acting tenant, for tests/debug. */
export function activeTenantId(): number {
  return currentTenantId()
}

/** Idempotent post marker: has this idempotency key already produced a post? */
export async function findByPostKey(key: string): Promise<Extraction | null> {
  await ensureDocIntelligenceSchema()
  const rows = await query<ExtractionRow[]>(
    "SELECT * FROM ai_document_extractions WHERE tenant_id = ? AND post_idempotency_key = ? LIMIT 1",
    [currentTenantId(), key],
  )
  return rows[0] ? mapExtraction(rows[0]) : null
}
