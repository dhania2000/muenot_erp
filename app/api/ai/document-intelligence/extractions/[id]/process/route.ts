import { NextResponse } from "next/server"
import { requireDocIntel, isResponse, serviceError } from "@/lib/ai/document-intelligence/request"
import { processExtraction } from "@/lib/ai/document-intelligence/service"
import { normalizeDocType } from "@/lib/ai/document-intelligence/model"

export const dynamic = "force-dynamic"

/**
 * POST — queue + run extraction. Gated (fail-closed) on a clean malware verdict
 * AND tenant AI authorization inside the service layer.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireDocIntel()
  if (isResponse(ctx)) return ctx

  const { id } = await params
  const extractionId = Number(id)
  if (!Number.isInteger(extractionId) || extractionId <= 0) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 })
  }

  let forcedType: ReturnType<typeof normalizeDocType> | null = null
  try {
    const body = await req.json()
    if (body?.docType != null) forcedType = normalizeDocType(body.docType)
  } catch {
    // No body is fine — force type stays null.
  }

  const result = await processExtraction({
    extractionId,
    actor: ctx.actor,
    tenantAuthorized: ctx.tenantAuthorized,
    forcedType,
  })
  if (!result.ok) return serviceError(result)
  return NextResponse.json({ extraction: result.extraction })
}
