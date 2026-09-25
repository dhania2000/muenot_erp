import { NextResponse, type NextRequest } from "next/server"
import { uploadFile } from "@/lib/storage"
import { requireDocIntel, isResponse, serviceError } from "@/lib/ai/document-intelligence/request"
import { intakeExtraction } from "@/lib/ai/document-intelligence/service"
import { normalizeDocType } from "@/lib/ai/document-intelligence/model"

export const dynamic = "force-dynamic"

/**
 * POST (multipart) — upload a document into tenant storage (which enqueues a
 * malware scan) and immediately create an extraction intake row for it. The
 * actual AI processing stays gated on the scan verdict + tenant authorization
 * and must be triggered separately via the process endpoint.
 */
export async function POST(req: NextRequest) {
  const ctx = await requireDocIntel()
  if (isResponse(ctx)) return ctx

  const form = await req.formData()
  const file = form.get("file")
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "File is required" }, { status: 400 })
  }
  const docTypeHint = normalizeDocType(form.get("docType"))

  const up = await uploadFile(`ai-document-intelligence/${crypto.randomUUID()}-${file.name}`, file, {
    metadata: {
      module: "ai",
      entityType: "document_extraction",
      ownerId: ctx.actor.userId,
      classification: "confidential",
    },
  })
  if (!up.ok) return NextResponse.json({ error: up.error }, { status: 400 })

  const fileId = up.result.file?.id
  if (!fileId) {
    return NextResponse.json({ error: "Upload did not return a file id" }, { status: 500 })
  }

  const intake = await intakeExtraction({
    fileId,
    tenantId: ctx.tenantId,
    docTypeHint: docTypeHint === "unknown" ? null : docTypeHint,
    createdBy: ctx.actor.userId,
  })
  if (!intake.ok) return serviceError(intake)

  return NextResponse.json(
    { extraction: intake.extraction, deduped: intake.deduped },
    { status: intake.deduped ? 200 : 201 },
  )
}
