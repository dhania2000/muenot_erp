import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { ensureOperationsSchema } from "@/lib/operations-ensure"
import { addNote, updateNote, removeNote, type Actor } from "@/lib/operations-meeting-detail"

function actorFrom(session: any): Actor {
  return { id: session.userId ?? null, name: session.name ?? null }
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  await ensureOperationsSchema()
  const { id } = await params
  const body = await request.json().catch(() => ({}))
  if (!body.body || !String(body.body).trim()) return NextResponse.json({ error: "Note body is required." }, { status: 400 })
  const meeting = await addNote(id, body.body, actorFrom(session))
  return NextResponse.json({ meeting })
}

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  await ensureOperationsSchema()
  const { id } = await params
  const body = await request.json().catch(() => ({}))
  if (!body.note_id) return NextResponse.json({ error: "note_id is required." }, { status: 400 })
  const meeting = await updateNote(id, body.note_id, body.body ?? "", actorFrom(session))
  return NextResponse.json({ meeting })
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  await ensureOperationsSchema()
  const { id } = await params
  const url = new URL(request.url)
  const noteId = url.searchParams.get("note_id")
  if (!noteId) return NextResponse.json({ error: "note_id is required." }, { status: 400 })
  const meeting = await removeNote(id, noteId, actorFrom(session))
  return NextResponse.json({ meeting })
}
