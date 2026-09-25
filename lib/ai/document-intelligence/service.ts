import "server-only"
/**
 * SPEC 19 (req #74) — orchestration for AI Document Intelligence.
 * ---------------------------------------------------------------------------
 * Wires the pure model/policy layer to the existing subsystems and NEVER
 * re-implements their behavior:
 *   - raw bytes            → lib/storage (file_objects) + enqueued malware scan
 *   - malware verdict      → lib/storage/file-scanning (getScanForFile, canDownload)
 *   - central registration → lib/dms (registerModuleDocument) on post
 *   - model selection/redaction → lib/ai (models-core, safety-core)
 *
 * The two security gates (queue-after-clean-scan-and-authorization, and
 * post-only-after-review) are enforced here via the pure functions in model.ts.
 */

import { getFileById } from "@/lib/storage/file-metadata"
import { downloadFile } from "@/lib/storage"
import { getScanForFile } from "@/lib/storage/file-scanning"
import { registerModuleDocument } from "@/lib/dms/integration"
import { redactText } from "@/lib/ai/safety-core"
import {
  canQueueForProcessing,
  canPost,
  canTransition,
  validateExtraction,
  mergeCorrections,
  diffCorrections,
  deriveContentHash,
  derivePostIdempotencyKey,
  normalizeDocType,
  computeOverallConfidence,
  type ClassifiedDocType,
  type ExtractedField,
  type FieldCorrection,
  type ExtractionStatus,
} from "./model"
import { getDocExtractionProvider } from "./extractor"
import {
  createExtraction,
  getExtraction,
  updateExtraction,
  snapshotVersion,
  logExtractionAudit,
  findByPostKey,
  type Extraction,
} from "./store"

export type Actor = { userId: number; role: "admin" | "employee"; isAdmin: boolean }

export type ServiceError = { ok: false; error: string; status: number }
export type ServiceOk<T> = { ok: true } & T
export type ServiceResult<T> = ServiceOk<T> | ServiceError

const MODULE = "ai"
const ENTITY_TYPE = "document_extraction"

// ---------------------------------------------------------------------------
// 1. Intake — store row from an already-uploaded file, enqueue scan happens in
//    the storage layer (uploadFile → enqueueScan). Idempotent on content hash.
// ---------------------------------------------------------------------------

export async function intakeExtraction(input: {
  fileId: number
  tenantId: number
  docTypeHint?: ClassifiedDocType | null
  createdBy: number | null
}): Promise<ServiceResult<{ extraction: Extraction; deduped: boolean }>> {
  const file = await getFileById(input.fileId)
  if (!file) return { ok: false, error: "File not found", status: 404 }
  // getFileById is tenant-scoped by the storage layer; double-check the binding.
  if (Number((file as any).tenantId ?? input.tenantId) !== input.tenantId) {
    return { ok: false, error: "File not found", status: 404 }
  }

  const contentHash = deriveContentHash({
    tenantId: input.tenantId,
    checksum: (file as any).checksum ?? null,
    size: file.size,
  })

  const { extraction, deduped } = await createExtraction({
    fileId: file.id,
    fileRef: file.fileRef,
    docType: normalizeDocType(input.docTypeHint),
    contentHash,
    createdBy: input.createdBy,
  })

  if (!deduped) {
    await logExtractionAudit({
      extractionId: extraction.id,
      action: "intake",
      detail: `file ${file.fileRef}`,
      userId: input.createdBy,
    })
  }
  return { ok: true, extraction, deduped }
}

// ---------------------------------------------------------------------------
// 2. Queue + process — gated on a clean malware verdict AND tenant authorization.
// ---------------------------------------------------------------------------

export async function processExtraction(input: {
  extractionId: number
  actor: Actor
  tenantAuthorized: boolean
  forcedType?: ClassifiedDocType | null
}): Promise<ServiceResult<{ extraction: Extraction }>> {
  const extraction = await getExtraction(input.extractionId)
  if (!extraction) return { ok: false, error: "Extraction not found", status: 404 }

  // --- Malware + authorization gate (fail-closed) --------------------------
  const scan = await getScanForFile(extraction.fileId).catch(() => null)
  const gate = canQueueForProcessing({
    scanStatus: (scan?.scanStatus as any) ?? null,
    approved: Boolean(scan?.approved),
    tenantAuthorized: input.tenantAuthorized,
  })
  if (!gate.allowed) {
    await logExtractionAudit({ extractionId: extraction.id, action: "queue_denied", detail: gate.reason, userId: input.actor.userId })
    return { ok: false, error: gate.reason, status: 409 }
  }

  if (!canTransition(extraction.status, "processing") && extraction.status !== "queued") {
    // allow uploaded→queued→processing; reject e.g. posted→processing
    if (!["uploaded", "queued", "extracted", "failed"].includes(extraction.status)) {
      return { ok: false, error: `Cannot process an extraction in status "${extraction.status}"`, status: 409 }
    }
  }

  await updateExtraction(extraction.id, { status: "processing", error: null })
  await logExtractionAudit({ extractionId: extraction.id, action: "queued", userId: input.actor.userId })

  try {
    const rawText = await readDocumentText(extraction.fileId)
    // Data minimization: redact obvious secrets/PII from the text we process.
    const safeText = redactText(rawText).text

    const provider = getDocExtractionProvider()
    const result = await provider.extract({
      text: safeText,
      filename: extraction.fileRef,
      mimeType: null,
      forcedType: input.forcedType ?? (extraction.docType !== "unknown" ? extraction.docType : null),
    })

    const highlights = result.fields.map((f) => f.source).filter((s): s is NonNullable<typeof s> => s != null)
    const nextVersion = extraction.version + 1

    await updateExtraction(extraction.id, {
      status: "extracted",
      docType: result.docType,
      version: nextVersion,
      provider: result.provider,
      modelId: result.model,
      language: result.language,
      overallConfidence: result.overallConfidence,
      fields: result.fields,
      highlights,
      warnings: result.warnings,
      error: null,
    })
    await snapshotVersion({
      extractionId: extraction.id,
      version: nextVersion,
      docType: result.docType,
      provider: result.provider,
      modelId: result.model,
      overallConfidence: result.overallConfidence,
      fields: result.fields,
      createdBy: input.actor.userId,
    })
    await logExtractionAudit({
      extractionId: extraction.id,
      action: "extracted",
      detail: `${result.docType} conf=${result.overallConfidence} lang=${result.language}`,
      toVersion: nextVersion,
      userId: input.actor.userId,
    })

    const updated = await getExtraction(extraction.id)
    return { ok: true, extraction: updated! }
  } catch (err) {
    console.error("[v0] doc-intelligence extraction failed:", err)
    await updateExtraction(extraction.id, { status: "failed", error: (err as Error).message })
    await logExtractionAudit({ extractionId: extraction.id, action: "failed", detail: (err as Error).message, userId: input.actor.userId })
    return { ok: false, error: "Extraction failed while processing the document", status: 500 }
  }
}

// ---------------------------------------------------------------------------
// 3. Review — apply reviewer corrections; record them in the audit trail.
// ---------------------------------------------------------------------------

export async function reviewExtraction(input: {
  extractionId: number
  actor: Actor
  corrections: FieldCorrection[]
  decision: "approve" | "reject"
}): Promise<ServiceResult<{ extraction: Extraction }>> {
  const extraction = await getExtraction(input.extractionId)
  if (!extraction) return { ok: false, error: "Extraction not found", status: 404 }

  if (input.decision === "reject") {
    if (!canTransition(extraction.status, "rejected")) {
      return { ok: false, error: `Cannot reject an extraction in status "${extraction.status}"`, status: 409 }
    }
    await updateExtraction(extraction.id, { status: "rejected", reviewedBy: input.actor.userId, reviewedAt: new Date() })
    await logExtractionAudit({ extractionId: extraction.id, action: "rejected", userId: input.actor.userId })
    return { ok: true, extraction: (await getExtraction(extraction.id))! }
  }

  if (extraction.status !== "extracted" && extraction.status !== "reviewed") {
    return { ok: false, error: "Only an extracted document can be reviewed", status: 409 }
  }

  const merged = mergeCorrections(extraction.fields, input.corrections)
  const changes = diffCorrections(extraction.fields, merged)
  const overall = computeOverallConfidence(merged)
  const nextVersion = extraction.version + (changes.length > 0 ? 1 : 0)

  await updateExtraction(extraction.id, {
    status: "reviewed",
    fields: merged,
    overallConfidence: overall,
    version: nextVersion,
    reviewedBy: input.actor.userId,
    reviewedAt: new Date(),
  })
  if (changes.length > 0) {
    await snapshotVersion({
      extractionId: extraction.id,
      version: nextVersion,
      docType: extraction.docType,
      provider: extraction.provider,
      modelId: extraction.modelId,
      overallConfidence: overall,
      fields: merged,
      createdBy: input.actor.userId,
    })
  }
  await logExtractionAudit({
    extractionId: extraction.id,
    action: "reviewed",
    detail: changes.length ? `corrected: ${changes.map((c) => c.key).join(", ")}` : "approved without changes",
    fromVersion: extraction.version,
    toVersion: nextVersion,
    userId: input.actor.userId,
  })
  return { ok: true, extraction: (await getExtraction(extraction.id))! }
}

// ---------------------------------------------------------------------------
// 4. Post — create a record from the reviewed extraction. Idempotent; never
//    posts an unreviewed or invalid extraction.
// ---------------------------------------------------------------------------

export async function postExtraction(input: {
  extractionId: number
  actor: Actor
}): Promise<ServiceResult<{ extraction: Extraction; deduped: boolean }>> {
  const extraction = await getExtraction(input.extractionId)
  if (!extraction) return { ok: false, error: "Extraction not found", status: 404 }

  const validation = validateExtraction(extraction.docType, extraction.fields)
  const gate = canPost({ status: extraction.status, validation })
  if (!gate.allowed) {
    // Already-posted is not an error under idempotency: return the existing post.
    if (extraction.status === "posted") return { ok: true, extraction, deduped: true }
    return { ok: false, error: gate.reason, status: 409 }
  }

  const idemKey = derivePostIdempotencyKey({
    tenantId: extraction.tenantId,
    extractionId: extraction.id,
    version: extraction.version,
  })
  const already = await findByPostKey(idemKey)
  if (already && already.id === extraction.id && already.status === "posted") {
    return { ok: true, extraction: already, deduped: true }
  }

  // Register the reviewed document into the central DMS, linked back to this
  // extraction. This is the concrete, tenant-scoped, audited "record" created on
  // post. Domain-specific posting (e.g. an AP invoice row) can extend from here.
  const title = deriveTitle(extraction)
  const dmsDoc = await registerModuleDocument({
    module: MODULE,
    entityType: ENTITY_TYPE,
    entityId: extraction.id,
    title,
    description: `AI-extracted ${extraction.docType} (confidence ${extraction.overallConfidence})`,
    fileId: extraction.fileId,
    ownerId: input.actor.userId,
    createdBy: input.actor.userId,
  })

  await updateExtraction(extraction.id, {
    status: "posted",
    postIdempotencyKey: idemKey,
    postedBy: input.actor.userId,
    postedAt: new Date(),
    postedEntityType: "dms_document",
    postedEntityId: String(dmsDoc.id),
    dmsDocumentId: dmsDoc.id,
  })
  await logExtractionAudit({
    extractionId: extraction.id,
    action: "posted",
    detail: `dms_document:${dmsDoc.id}`,
    toVersion: extraction.version,
    userId: input.actor.userId,
  })
  return { ok: true, extraction: (await getExtraction(extraction.id))!, deduped: false }
}

function deriveTitle(extraction: Extraction): string {
  const byKey = new Map(extraction.fields.map((f) => [f.key, f.value]))
  const candidates = [
    byKey.get("invoice_number"),
    byKey.get("contract_title"),
    byKey.get("full_name"),
    byKey.get("merchant_name"),
    byKey.get("vendor_name"),
  ].filter(Boolean)
  const label = candidates[0] ?? extraction.fileRef ?? `extraction ${extraction.id}`
  return `${capitalize(extraction.docType)} — ${label}`.slice(0, 200)
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Read the raw document's text for extraction (text-like files only). */
async function readDocumentText(fileId: number): Promise<string> {
  const file = await getFileById(fileId)
  if (!file) throw new Error("File not found")
  const mime = file.mimeType ?? ""
  const isTextLike =
    mime.startsWith("text/") ||
    mime === "application/json" ||
    mime === "application/xml" ||
    mime === "application/csv" ||
    /\.(txt|csv|json|xml|md|eml)$/i.test(file.filename ?? "")
  if (!isTextLike) {
    // Non-text scans (PDF/image) require upstream OCR; return empty so the
    // extractor surfaces a "no readable text" warning instead of crashing.
    return ""
  }
  const src = await downloadFile(file.objectKey)
  const buf = await readStreamToBuffer(src.body)
  return buf.toString("utf8")
}

async function readStreamToBuffer(body: unknown): Promise<Buffer> {
  if (!body) return Buffer.alloc(0)
  if (Buffer.isBuffer(body)) return body
  if (body instanceof Uint8Array) return Buffer.from(body)
  // Web ReadableStream
  if (typeof (body as any).getReader === "function") {
    const reader = (body as ReadableStream<Uint8Array>).getReader()
    const chunks: Uint8Array[] = []
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) chunks.push(value)
    }
    return Buffer.concat(chunks.map((c) => Buffer.from(c)))
  }
  // Node Readable
  if (typeof (body as any)[Symbol.asyncIterator] === "function") {
    const chunks: Buffer[] = []
    for await (const chunk of body as AsyncIterable<Buffer | Uint8Array>) {
      chunks.push(Buffer.from(chunk))
    }
    return Buffer.concat(chunks)
  }
  return Buffer.alloc(0)
}

export type { Extraction, ExtractedField, ExtractionStatus }
