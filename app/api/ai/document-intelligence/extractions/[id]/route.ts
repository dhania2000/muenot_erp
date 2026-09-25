import { NextResponse } from "next/server"
import { requireDocIntel, isResponse } from "@/lib/ai/document-intelligence/request"
import { getExtraction, listVersions, listExtractionAudit } from "@/lib/ai/document-intelligence/store"

export const dynamic = "force-dynamic"

/** GET — one extraction with its version snapshots and audit trail. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireDocIntel()
  if (isResponse(ctx)) return ctx

  const { id } = await params
  const extractionId = Number(id)
  if (!Number.isInteger(extractionId) || extractionId <= 0) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 })
  }

  // getExtraction is tenant-scoped; a wrong-tenant id resolves to null → 404.
  const extraction = await getExtraction(extractionId)
  if (!extraction) return NextResponse.json({ error: "Not found" }, { status: 404 })

  const [versions, audit] = await Promise.all([
    listVersions(extractionId),
    listExtractionAudit(extractionId),
  ])
  return NextResponse.json({ extraction, versions, audit })
}
