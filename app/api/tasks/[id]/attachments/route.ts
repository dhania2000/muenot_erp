import { NextRequest, NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { addAttachment, deleteAttachment, TaskError } from "@/lib/tasks/model"

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
    await addAttachment(id, {
      file_name: body.file_name,
      file_url: body.file_url,
      file_size: body.file_size,
      content_type: body.content_type,
    })
    return NextResponse.json({ ok: true }, { status: 201 })
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
    const attachmentId = parseId(req.nextUrl.searchParams.get("attachmentId") ?? "")
    if (!attachmentId) return NextResponse.json({ error: "Invalid attachment id" }, { status: 400 })
    await deleteAttachment(id, attachmentId)
    return NextResponse.json({ ok: true })
  } catch (err) {
    return handle(err)
  }
}
