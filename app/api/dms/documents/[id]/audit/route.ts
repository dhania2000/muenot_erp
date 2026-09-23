import { NextRequest, NextResponse } from "next/server"
import { requireDms, isResponse, effectiveAccess } from "@/lib/dms/request"
import { getDocument, listAudit } from "@/lib/dms"

export const runtime = "nodejs"

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireDms()
  if (isResponse(ctx)) return ctx
  const { id } = await params
  const docId = Number(id)

  const doc = await getDocument(docId)
  if (!doc) return NextResponse.json({ error: "Not found" }, { status: 404 })
  const access = await effectiveAccess(ctx.session, doc)
  if (!access) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  return NextResponse.json({ audit: await listAudit(docId, 200) })
}
