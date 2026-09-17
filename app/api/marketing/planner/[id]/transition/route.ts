import { NextResponse } from "next/server"
import { requireFeature } from "@/lib/api-auth"
import { transitionItem } from "@/lib/marketing/planner-db"
import type { PlannerStatus } from "@/lib/marketing/planner-constants"

export const runtime = "nodejs"

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireFeature("marketing.planner.manage")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const { id } = await params
  try {
    const body = await request.json()
    if (!body.to) return NextResponse.json({ error: "Target status required" }, { status: 400 })
    const item = await transitionItem(Number(id), body.to as PlannerStatus, session.userId, {
      reason: body.reason,
      expectedVersion: body.row_version != null ? Number(body.row_version) : undefined,
    })
    return NextResponse.json({ item })
  } catch (err: any) {
    const status =
      err?.code === "CONFLICT"
        ? 409
        : ["INVALID_TRANSITION", "VALIDATION", "DEPENDENCY"].includes(err?.code)
          ? 422
          : err?.message === "Not found"
            ? 404
            : 400
    return NextResponse.json({ error: err?.message || "Transition failed", code: err?.code }, { status })
  }
}
