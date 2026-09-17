import { NextResponse } from "next/server"
import { requireFeature } from "@/lib/api-auth"
import { listActivity } from "@/lib/marketing/planner-db"

export const runtime = "nodejs"

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireFeature("marketing.planner.view")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const { id } = await params
  const activity = await listActivity(Number(id))
  return NextResponse.json({ activity })
}
