import { NextResponse } from "next/server"
import { requireFeature } from "@/lib/api-auth"
import { publishItem } from "@/lib/marketing/planner-db"

export const runtime = "nodejs"

// Manual publish confirmation (Phase 88): Published only ever set by an explicit
// action, never by a date passing. Delivery itself is handed off to the
// existing Email / WhatsApp / campaign systems.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireFeature("marketing.planner.publish").then(
    (s) => s ?? requireFeature("marketing.planner.manage"),
  )
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const { id } = await params
  try {
    const body = await request.json().catch(() => ({}))
    const item = await publishItem(Number(id), session.userId, body?.note)
    return NextResponse.json({ item })
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || "Publish failed" }, { status: 400 })
  }
}
