import { NextResponse } from "next/server"
import { requireDocIntel, isResponse, serviceError } from "@/lib/ai/document-intelligence/request"
import { postExtraction } from "@/lib/ai/document-intelligence/service"

export const dynamic = "force-dynamic"

/**
 * POST — create a record (DMS document) from a reviewed extraction. Idempotent:
 * re-posting returns the existing record without creating a duplicate. Never
 * posts an unreviewed or invalid extraction (enforced in the service).
 */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireDocIntel()
  if (isResponse(ctx)) return ctx

  const { id } = await params
  const extractionId = Number(id)
  if (!Number.isInteger(extractionId) || extractionId <= 0) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 })
  }

  const result = await postExtraction({ extractionId, actor: ctx.actor })
  if (!result.ok) return serviceError(result)
  return NextResponse.json({ extraction: result.extraction, deduped: result.deduped })
}
