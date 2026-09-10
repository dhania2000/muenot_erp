import { NextRequest, NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { userHasFeature } from "@/lib/permissions"
import { validateUpload } from "@/lib/settings/uploads"
import { query } from "@/lib/db"

async function ensureImagesTable() {
  await query(
    `CREATE TABLE IF NOT EXISTS careers_images (
      id VARCHAR(64) NOT NULL PRIMARY KEY,
      mime VARCHAR(128) NOT NULL,
      data LONGBLOB NOT NULL,
      created_by BIGINT UNSIGNED DEFAULT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
  )
}

export async function POST(request: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const canManage =
    session.role === "admin" || (await userHasFeature(session.userId, session.role, "recruitment.view_jobs"))
  if (!canManage) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const form = await request.formData()
  const file = form.get("file")
  if (!(file instanceof File)) return NextResponse.json({ error: "File is required" }, { status: 400 })
  if (!file.type.startsWith("image/")) return NextResponse.json({ error: "Image files only" }, { status: 400 })
  const uploadError = await validateUpload(file)
  if (uploadError) return NextResponse.json({ error: uploadError }, { status: 400 })

  const buffer = Buffer.from(await file.arrayBuffer())
  const id = crypto.randomUUID()

  await ensureImagesTable()
  await query("INSERT INTO careers_images (id, mime, data, created_by) VALUES (?,?,?,?)", [
    id,
    file.type,
    buffer,
    session.userId,
  ])

  return NextResponse.json({ url: `/api/recruit/careers-settings/image/${id}` })
}
