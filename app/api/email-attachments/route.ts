import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { query } from "@/lib/db"
import { validateUpload } from "@/lib/settings/uploads"

let ensured = false
async function ensureTable() {
  if (ensured) return
  await query(
    `CREATE TABLE IF NOT EXISTS email_attachments (
      id CHAR(36) NOT NULL PRIMARY KEY,
      filename VARCHAR(255) NOT NULL,
      content_type VARCHAR(150) NOT NULL,
      size INT NOT NULL,
      data LONGBLOB NOT NULL,
      created_by INT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  )
  ensured = true
}

export async function POST(request: Request) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const form = await request.formData()
  const file = form.get("file")
  if (!(file instanceof File)) return NextResponse.json({ error: "File is required" }, { status: 400 })
  const uploadError = await validateUpload(file)
  if (uploadError) return NextResponse.json({ error: uploadError }, { status: 400 })

  await ensureTable()
  const id = crypto.randomUUID()
  const buffer = Buffer.from(await file.arrayBuffer())
  await query(
    `INSERT INTO email_attachments (id, filename, content_type, size, data, created_by) VALUES (?, ?, ?, ?, ?, ?)`,
    [id, file.name, file.type, file.size, buffer, (session as any).userId ?? null],
  )

  return NextResponse.json({
    pathname: `/api/email-attachments/${id}`,
    filename: file.name,
    contentType: file.type,
    size: file.size,
  })
}
