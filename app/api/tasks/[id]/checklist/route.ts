import { NextRequest, NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { addChecklistItem, toggleChecklistItem, deleteChecklistItem, TaskError } from "@/lib/tasks/model"

function parseId(raw: string): number {
  const id = Number(raw)
  return Number.isSafeInteger(id) && id > 0 ? id : 0
}

function handle(err: unknown) {
  const status = err instanceof TaskError ? err.status : 500
  return NextResponse.json({ error: (err as Error).message }, { status })
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const id = parseId((await params).id)
  if (!id) return NextResponse.json({ error: "Invalid id" }, { status: 400 })
  try {
    const body = await req.json()
    await addChecklistItem(id, body.item_text)
    return NextResponse.json({ ok: true }, { status: 201 })
  } catch (err) {
    return handle(err)
  }
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const id = parseId((await params).id)
  if (!id) return NextResponse.json({ error: "Invalid id" }, { status: 400 })
  try {
    const body = await req.json()
    const itemId = parseId(String(body.item_id))
    if (!itemId) return NextResponse.json({ error: "Invalid item id" }, { status: 400 })
    await toggleChecklistItem(id, itemId, !!body.is_done)
    return NextResponse.json({ ok: true })
  } catch (err) {
    return handle(err)
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const id = parseId((await params).id)
  if (!id) return NextResponse.json({ error: "Invalid id" }, { status: 400 })
  try {
    const itemId = parseId(req.nextUrl.searchParams.get("itemId") ?? "")
    if (!itemId) return NextResponse.json({ error: "Invalid item id" }, { status: 400 })
    await deleteChecklistItem(id, itemId)
    return NextResponse.json({ ok: true })
  } catch (err) {
    return handle(err)
  }
}
