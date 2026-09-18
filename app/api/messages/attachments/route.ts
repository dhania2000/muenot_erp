import { NextResponse } from "next/server"
import { uploadFile } from "@/lib/storage"
import { getSession } from "@/lib/auth"
import { query } from "@/lib/db"
import { userHasFeature } from "@/lib/permissions"
import { ensureMessagesSchema } from "@/lib/messages-ensure"
import { ALLOWED_ATTACHMENT_EXT, MAX_ATTACHMENT_BYTES, getParticipant, rateLimit } from "@/lib/messages-core"

/**
 * POST /api/messages/attachments  (multipart form: conversationId, file)
 * Uploads a file to Blob and records metadata. The message row is attached
 * later when the message is sent (attachmentIds). The raw Blob URL is never
 * returned to the client — downloads go through the authorized proxy route.
 */
export async function POST(request: Request) {
  const session = await getSession()
  if (!session || !(await userHasFeature(session.userId, session.role, "messages.send")))
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  await ensureMessagesSchema()

  if (!rateLimit(`upload:${session.userId}`, 30, 60_000))
    return NextResponse.json({ error: "Too many uploads. Please slow down." }, { status: 429 })

  const form = await request.formData()
  const conversationId = Number(form.get("conversationId"))
  const file = form.get("file") as File | null
  if (!conversationId || !file) return NextResponse.json({ error: "conversationId and file required" }, { status: 400 })
  if (!(await getParticipant(conversationId, session.userId)))
    return NextResponse.json({ error: "Not a participant" }, { status: 403 })

  if (file.size > MAX_ATTACHMENT_BYTES)
    return NextResponse.json({ error: "File exceeds 25 MB limit" }, { status: 400 })
  const ext = (file.name.split(".").pop() || "").toLowerCase()
  if (!ALLOWED_ATTACHMENT_EXT.includes(ext))
    return NextResponse.json({ error: `File type .${ext} is not allowed` }, { status: 400 })

  const up = await uploadFile(`messages/${conversationId}/${crypto.randomUUID()}-${file.name}`, file, {
    skipValidation: true,
  })
  if (!up.ok) return NextResponse.json({ error: up.error }, { status: 400 })

  await query(
    `INSERT INTO message_attachments (conversation_id, uploaded_by, file_name, file_type, file_size, storage_url)
     VALUES (?,?,?,?,?,?)`,
    [conversationId, session.userId, file.name.slice(0, 255), file.type || ext, file.size, up.result.key],
  )
  const row = (await query<any[]>("SELECT LAST_INSERT_ID() id"))[0]

  return NextResponse.json({
    id: row.id,
    file_name: file.name,
    file_type: file.type || ext,
    file_size: file.size,
    url: `/api/messages/attachments/${row.id}`,
  })
}
