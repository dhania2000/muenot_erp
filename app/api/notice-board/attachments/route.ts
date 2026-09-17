import { NextResponse } from "next/server"
import { put } from "@vercel/blob"
import { getSession } from "@/lib/auth"
import { query } from "@/lib/db"
import { ensureNoticeSchema, canManage, ATTACHMENT_ALLOWED_EXT, ATTACHMENT_MAX_BYTES } from "@/lib/notice-board"

export const dynamic = "force-dynamic"

/**
 * POST /api/notice-board/attachments  (multipart: file, draftKey?)
 * Uploads to Blob and records metadata against a draft key. The row is linked
 * to a notice when the notice is saved. The raw Blob URL is never returned —
 * downloads go through the authorized proxy at /attachments/[id].
 */
export async function POST(request: Request) {
  const session = await getSession()
  if (!session || !(await canManage(session)))
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  await ensureNoticeSchema()

  const form = await request.formData()
  const file = form.get("file") as File | null
  const draftKey = String(form.get("draftKey") || "").slice(0, 64) || null
  if (!file) return NextResponse.json({ error: "file required" }, { status: 400 })
  if (file.size > ATTACHMENT_MAX_BYTES)
    return NextResponse.json({ error: "File exceeds 20 MB limit" }, { status: 400 })
  const ext = (file.name.split(".").pop() || "").toLowerCase()
  if (!ATTACHMENT_ALLOWED_EXT.includes(ext))
    return NextResponse.json({ error: `File type .${ext} is not allowed` }, { status: 400 })

  const blob = await put(`notice-board/${crypto.randomUUID()}-${file.name}`, file, {
    access: "public",
    addRandomSuffix: false,
  })

  const res: any = await query(
    `INSERT INTO notice_attachments (draft_key, file_name, file_type, file_size, storage_url, uploaded_by)
     VALUES (?,?,?,?,?,?)`,
    [draftKey, file.name.slice(0, 255), file.type || `application/${ext}`, file.size, blob.url, session.userId],
  )

  return NextResponse.json({
    id: res.insertId,
    file_name: file.name,
    file_type: file.type,
    file_size: file.size,
  }, { status: 201 })
}

// DELETE /api/notice-board/attachments?id=123 — remove an unattached draft file.
export async function DELETE(request: Request) {
  const session = await getSession()
  if (!session || !(await canManage(session)))
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  await ensureNoticeSchema()

  const id = Number(new URL(request.url).searchParams.get("id"))
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 })
  await query("DELETE FROM notice_attachments WHERE id = ? AND uploaded_by = ?", [id, session.userId])
  return NextResponse.json({ deleted: true })
}
