import { NextResponse, type NextRequest } from "next/server"
import { requireDocIntel, isResponse, serviceError } from "@/lib/ai/document-intelligence/request"
import { intakeExtraction, processExtraction } from "@/lib/ai/document-intelligence/service"
import { listExtractions } from "@/lib/ai/document-intelligence/store"
import { normalizeDocType, normalizeStatus, DOC_TYPES } from "@/lib/ai/document-intelligence/model"

export const dynamic = "force-dynamic"

/** GET — list this tenant's extractions, optionally filtered by status/docType. */
export async function GET(req: NextRequest) {
  const ctx = await requireDocIntel()
  if (isResponse(ctx)) return ctx

  const url = new URL(req.url)
  const statusParam = url.searchParams.get("status")
  const typeParam = url.searchParams.get("docType")

  const rows = await listExtractions({
    status: statusParam ? normalizeStatus(statusParam) : undefined,
    docType: typeParam ? normalizeDocType(typeParam) : undefined,
  })
  return NextResponse.json({ extractions: rows })
}

/**
 * POST — intake an already-uploaded, scanned file as an extraction job.
 * Idempotent on document content: re-posting the same file returns the existing
 * job. When `autoProcess` is set, immediately runs extraction if the malware
 * verdict is clean and the tenant is authorized (fail-closed otherwise).
 */
export async function POST(req: NextRequest) {
  const ctx = await requireDocIntel()
  if (isResponse(ctx)) return ctx

  let body: any
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const fileId = Number(body?.fileId)
  if (!Number.isInteger(fileId) || fileId <= 0) {
    return NextResponse.json({ error: "fileId is required" }, { status: 400 })
  }
  const docTypeHint = body?.docType != null ? normalizeDocType(body.docType) : null
  if (body?.docType != null && docTypeHint === "unknown" && !DOC_TYPES.includes(body.docType)) {
    // Accept unknown as an explicit hint too; only reject non-strings.
    if (typeof body.docType !== "string") {
      return NextResponse.json({ error: "docType must be a string" }, { status: 400 })
    }
  }

  const intake = await intakeExtraction({
    fileId,
    tenantId: ctx.tenantId,
    docTypeHint,
    createdBy: ctx.actor.userId,
  })
  if (!intake.ok) return serviceError(intake)

  let extraction = intake.extraction
  if (body?.autoProcess === true && !intake.deduped) {
    const processed = await processExtraction({
      extractionId: extraction.id,
      actor: ctx.actor,
      tenantAuthorized: ctx.tenantAuthorized,
      forcedType: docTypeHint,
    })
    // A blocked gate (scan pending / not authorized) is not a hard error here —
    // the job stays queued and the client can retry processing later.
    if (processed.ok) extraction = processed.extraction
  }

  return NextResponse.json({ extraction, deduped: intake.deduped }, { status: intake.deduped ? 200 : 201 })
}
