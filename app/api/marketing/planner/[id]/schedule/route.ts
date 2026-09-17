import { NextResponse } from "next/server"
import { requireFeature } from "@/lib/api-auth"
import { scheduleItem } from "@/lib/marketing/planner-db"

export const runtime = "nodejs"

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireFeature("marketing.planner.manage")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const { id } = await params
  try {
    const body = await request.json()
    if (!body.publish_at) return NextResponse.json({ error: "publish_at required" }, { status: 400 })
    const item = await scheduleItem(Number(id), body.publish_at, session.userId)
    return NextResponse.json({ item })
  } catch (err: any) {
    const status = err?.code === "VALIDATION" ? 422 : err?.message === "Not found" ? 404 : 400
    return NextResponse.json({ error: err?.message || "Schedule failed", code: err?.code }, { status })
  }
}
