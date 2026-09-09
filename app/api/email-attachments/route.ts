import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { query } from "@/lib/db"

const allowed = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
])
const maxBytes = 10 * 1024 * 1024

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
  if (!allowed.has(file.type) || file.size > maxBytes) {
    return NextResponse.json({ error: "Only PDF, image, Word, and Excel files up to 10MB are allowed" }, { status: 400 })
  }

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
