import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { ensureOperationsSchema } from "@/lib/operations-ensure"
import { addParticipant, updateParticipant, removeParticipant, type Actor } from "@/lib/operations-meeting-detail"

function actorFrom(session: any): Actor {
  return { id: session.userId ?? null, name: session.name ?? null }
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  await ensureOperationsSchema()
  const { id } = await params
  const body = await request.json().catch(() => ({}))
  if (!body.name && !body.email) return NextResponse.json({ error: "Name or email is required." }, { status: 400 })
  const meeting = await addParticipant(id, body, actorFrom(session))
  return NextResponse.json({ meeting })
}

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  await ensureOperationsSchema()
  const { id } = await params
  const body = await request.json().catch(() => ({}))
  if (!body.participant_id) return NextResponse.json({ error: "participant_id is required." }, { status: 400 })
  const meeting = await updateParticipant(id, body.participant_id, body, actorFrom(session))
  return NextResponse.json({ meeting })
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  await ensureOperationsSchema()
  const { id } = await params
  const url = new URL(request.url)
  const participantId = url.searchParams.get("participant_id")
  if (!participantId) return NextResponse.json({ error: "participant_id is required." }, { status: 400 })
  const meeting = await removeParticipant(id, participantId, actorFrom(session))
  return NextResponse.json({ meeting })
}
