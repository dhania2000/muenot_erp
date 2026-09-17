import { NextResponse } from "next/server"
import { requireFeature } from "@/lib/api-auth"
import { deleteItem, getItem, updateItem } from "@/lib/marketing/planner-db"

export const runtime = "nodejs"

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireFeature("marketing.planner.view")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const { id } = await params
  const item = await getItem(Number(id))
  if (!item) return NextResponse.json({ error: "Not found" }, { status: 404 })
  return NextResponse.json({ item })
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireFeature("marketing.planner.manage")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const { id } = await params
  try {
    const body = await request.json()
    const expectedVersion = body.row_version != null ? Number(body.row_version) : undefined
    delete body.row_version
    const item = await updateItem(Number(id), body, session.userId, expectedVersion)
    return NextResponse.json({ item })
  } catch (err: any) {
    const status = err?.code === "CONFLICT" ? 409 : err?.message === "Not found" ? 404 : 400
    return NextResponse.json({ error: err?.message || "Update failed", code: err?.code }, { status })
  }
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireFeature("marketing.planner.manage")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const { id } = await params
  try {
    await deleteItem(Number(id), session.userId)
    return NextResponse.json({ success: true })
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || "Delete failed" }, { status: 400 })
  }
}
