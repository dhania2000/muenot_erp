import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { ensureOperationsSchema } from "@/lib/operations-ensure"
import { addAttachment, removeAttachment, type Actor } from "@/lib/operations-meeting-detail"

function actorFrom(session: any): Actor {
  return { id: session.userId ?? null, name: session.name ?? null }
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  await ensureOperationsSchema()
  const { id } = await params
  const body = await request.json().catch(() => ({}))
  if (!body.file_url) return NextResponse.json({ error: "file_url is required." }, { status: 400 })
  const meeting = await addAttachment(id, body, actorFrom(session))
  return NextResponse.json({ meeting })
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  await ensureOperationsSchema()
  const { id } = await params
  const url = new URL(request.url)
  const attachmentId = url.searchParams.get("attachment_id")
  if (!attachmentId) return NextResponse.json({ error: "attachment_id is required." }, { status: 400 })
  const meeting = await removeAttachment(id, attachmentId, actorFrom(session))
  return NextResponse.json({ meeting })
}
