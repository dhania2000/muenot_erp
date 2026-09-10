import { NextRequest, NextResponse } from "next/server"
import { query } from "@/lib/db"

// Public route — accepts a candidate's resume (PDF or image) as part of a job
// application. Stores the file in the database so no external storage provider
// is required, mirroring the careers-image storage pattern.

const MAX_BYTES = 10 * 1024 * 1024 // 10MB
const ALLOWED_MIME = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
])

async function ensureResumesTable() {
  await query(
    `CREATE TABLE IF NOT EXISTS recruit_resumes (
      id VARCHAR(64) NOT NULL PRIMARY KEY,
      mime VARCHAR(128) NOT NULL,
      filename VARCHAR(255) DEFAULT NULL,
      data LONGBLOB NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
  )
}

export async function POST(request: NextRequest) {
  const form = await request.formData()
  const file = form.get("file")
  if (!(file instanceof File)) return NextResponse.json({ error: "File is required" }, { status: 400 })
  if (!ALLOWED_MIME.has(file.type)) {
    return NextResponse.json({ error: "Please upload a PDF or image file" }, { status: 400 })
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: "File must be 10MB or smaller" }, { status: 400 })
  }

  const buffer = Buffer.from(await file.arrayBuffer())
  const id = crypto.randomUUID()

  await ensureResumesTable()
  await query("INSERT INTO recruit_resumes (id, mime, filename, data) VALUES (?,?,?,?)", [
    id,
    file.type,
    file.name?.slice(0, 255) || null,
    buffer,
  ])

  return NextResponse.json({ url: `/api/recruit/public/resume/${id}`, filename: file.name })
}
