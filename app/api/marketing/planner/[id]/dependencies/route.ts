import { NextResponse } from "next/server"
import { requireFeature } from "@/lib/api-auth"
import { addDependency, removeDependency } from "@/lib/marketing/planner-db"

export const runtime = "nodejs"

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireFeature("marketing.planner.manage")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const { id } = await params
  const body = await request.json().catch(() => ({}))
  const dependsOnId = Number(body.dependsOnId)
  if (!dependsOnId) return NextResponse.json({ error: "dependsOnId is required" }, { status: 400 })
  try {
    const item = await addDependency(Number(id), dependsOnId, session.userId)
    return NextResponse.json({ item })
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 })
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireFeature("marketing.planner.manage")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const { id } = await params
  const url = new URL(request.url)
  const dependsOnId = Number(url.searchParams.get("dependsOnId"))
  if (!dependsOnId) return NextResponse.json({ error: "dependsOnId is required" }, { status: 400 })
  const item = await removeDependency(Number(id), dependsOnId, session.userId)
  return NextResponse.json({ item })
}
