import { NextResponse } from "next/server"
import { requireFeature } from "@/lib/api-auth"
import { assignItem } from "@/lib/marketing/planner-db"

export const runtime = "nodejs"

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireFeature("marketing.planner.assign").then(
    (s) => s ?? requireFeature("marketing.planner.manage"),
  )
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const { id } = await params
  try {
    const body = await request.json()
    const item = await assignItem(
      Number(id),
      {
        primary: body.primary != null ? Number(body.primary) : null,
        contributors: Array.isArray(body.contributors) ? body.contributors.map(Number) : [],
      },
      session.userId,
    )
    return NextResponse.json({ item })
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || "Assign failed" }, { status: 400 })
  }
}
