import { NextResponse } from "next/server"
import { requireDocIntel, isResponse, serviceError } from "@/lib/ai/document-intelligence/request"
import { reviewExtraction } from "@/lib/ai/document-intelligence/service"
import type { FieldCorrection } from "@/lib/ai/document-intelligence/model"

export const dynamic = "force-dynamic"

/**
 * POST — apply reviewer corrections and approve/reject. Corrections are recorded
 * in the audit trail and produce a new immutable extraction version.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireDocIntel()
  if (isResponse(ctx)) return ctx

  const { id } = await params
  const extractionId = Number(id)
  if (!Number.isInteger(extractionId) || extractionId <= 0) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 })
  }

  let body: any
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const decision = body?.decision === "reject" ? "reject" : "approve"
  const rawCorrections = Array.isArray(body?.corrections) ? body.corrections : []
  const corrections: FieldCorrection[] = rawCorrections
    .filter((c: any) => c && typeof c.key === "string")
    .map((c: any) => ({ key: c.key, value: c.value == null ? null : String(c.value) }))

  const result = await reviewExtraction({ extractionId, actor: ctx.actor, corrections, decision })
  if (!result.ok) return serviceError(result)
  return NextResponse.json({ extraction: result.extraction })
}
