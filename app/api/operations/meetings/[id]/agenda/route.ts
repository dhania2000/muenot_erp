import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { ensureOperationsSchema } from "@/lib/operations-ensure"
import { addAgendaItem, updateAgendaItem, removeAgendaItem, type Actor } from "@/lib/operations-meeting-detail"

function actorFrom(session: any): Actor {
  return { id: session.userId ?? null, name: session.name ?? null }
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  await ensureOperationsSchema()
  const { id } = await params
  const body = await request.json().catch(() => ({}))
  if (!body.topic) return NextResponse.json({ error: "Topic is required." }, { status: 400 })
  const meeting = await addAgendaItem(id, body, actorFrom(session))
  return NextResponse.json({ meeting })
}

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  await ensureOperationsSchema()
  const { id } = await params
  const body = await request.json().catch(() => ({}))
  if (!body.item_id) return NextResponse.json({ error: "item_id is required." }, { status: 400 })
  const meeting = await updateAgendaItem(id, body.item_id, body, actorFrom(session))
  return NextResponse.json({ meeting })
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  await ensureOperationsSchema()
  const { id } = await params
  const url = new URL(request.url)
  const itemId = url.searchParams.get("item_id")
  if (!itemId) return NextResponse.json({ error: "item_id is required." }, { status: 400 })
  const meeting = await removeAgendaItem(id, itemId, actorFrom(session))
  return NextResponse.json({ meeting })
}
