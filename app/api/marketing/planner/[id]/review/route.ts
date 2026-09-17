import { NextResponse } from "next/server"
import { requireFeature } from "@/lib/api-auth"
import { reviewAction } from "@/lib/marketing/planner-db"

export const runtime = "nodejs"

const ACTIONS = ["submit", "approve", "reject", "request_changes"] as const

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const body = await request.json().catch(() => ({}))
  const action = body?.action as (typeof ACTIONS)[number]
  if (!ACTIONS.includes(action)) return NextResponse.json({ error: "Invalid action" }, { status: 400 })

  // Submitting only needs edit rights; approving/rejecting needs the approve feature.
  const feature = action === "submit" ? "marketing.planner.manage" : "marketing.planner.approve"
  const session = await requireFeature(feature).then((s) =>
    s ?? (action === "submit" ? null : requireFeature("marketing.planner.manage")),
  )
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  try {
    const item = await reviewAction(Number(id), action, session.userId, body?.note)
    return NextResponse.json({ item })
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || "Review failed" }, { status: 400 })
  }
}
