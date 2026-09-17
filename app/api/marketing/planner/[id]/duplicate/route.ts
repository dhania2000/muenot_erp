import { NextResponse } from "next/server"
import { requireFeature } from "@/lib/api-auth"
import { duplicateItem } from "@/lib/marketing/planner-db"

export const runtime = "nodejs"

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireFeature("marketing.planner.manage")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const { id } = await params
  try {
    const item = await duplicateItem(Number(id), session.userId)
    return NextResponse.json({ item })
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 })
  }
}
