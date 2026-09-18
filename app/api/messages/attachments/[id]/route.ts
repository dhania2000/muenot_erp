import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { query } from "@/lib/db"
import { ensureMessagesSchema } from "@/lib/messages-ensure"
import { getParticipant } from "@/lib/messages-core"
import { openStoredObject } from "@/lib/storage"

/**
 * GET /api/messages/attachments/[id]
 * Authorized download. The Blob URL is unguessable and never exposed to the
 * client directly; this proxy enforces conversation membership (Phase 22/54)
 * before streaming the file back, so links can't be shared outside the thread.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  await ensureMessagesSchema()

  const { id } = await params
  const att = (await query<any[]>("SELECT * FROM message_attachments WHERE id=? LIMIT 1", [id]))[0]
  if (!att) return NextResponse.json({ error: "Not found" }, { status: 404 })
  if (!(await getParticipant(att.conversation_id, session.userId)))
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  let obj
  try {
    obj = await openStoredObject(att.storage_url)
  } catch {
    return NextResponse.json({ error: "File unavailable" }, { status: 502 })
  }

  const headers = new Headers()
  headers.set("Content-Type", att.file_type || obj.contentType || "application/octet-stream")
  headers.set("Content-Disposition", `inline; filename="${encodeURIComponent(att.file_name)}"`)
  headers.set("Cache-Control", "private, max-age=0, no-store")
  headers.set("X-Content-Type-Options", "nosniff")
  const body = obj.body instanceof Buffer ? new Uint8Array(obj.body) : (obj.body as ReadableStream<Uint8Array>)
  return new NextResponse(body as any, { headers })
}
