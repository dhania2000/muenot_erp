import { NextResponse } from "next/server"
import { requireFeature } from "@/lib/api-auth"
import { moveDealStage, DealNotFoundError, DealValidationError } from "@/lib/sales/deal-pipeline"

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireFeature("sales.manage_deals")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const { id } = await params
  try {
    const body = await request.json()
    const stageId = Number(body.stage_id)
    if (!Number.isInteger(stageId) || stageId <= 0) {
      return NextResponse.json({ error: "A target stage is required" }, { status: 400 })
    }
    const result = await moveDealStage(Number(id), stageId, session.userId)
    return NextResponse.json({ ok: true, ...result })
  } catch (error) {
    if (error instanceof DealNotFoundError) return NextResponse.json({ error: error.message }, { status: 404 })
    if (error instanceof DealValidationError) return NextResponse.json({ error: error.message }, { status: 400 })
    console.error("[deals] stage move failed", error)
    return NextResponse.json({ error: "Unable to move deal." }, { status: 500 })
  }
}
