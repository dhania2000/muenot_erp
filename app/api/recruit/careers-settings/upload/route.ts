import { put } from "@vercel/blob"
import { NextRequest, NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { userHasFeature } from "@/lib/permissions"
import { validateUpload } from "@/lib/settings/uploads"

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

  // When Vercel Blob storage is connected, store the file there and return its
  // public URL. This is the preferred path for larger images.
  if (process.env.BLOB_READ_WRITE_TOKEN) {
    const blob = await put(`careers/${crypto.randomUUID()}-${file.name}`, file, {
      access: "public",
      addRandomSuffix: false,
    })
    return NextResponse.json({ url: blob.url })
  }

  // Fallback with no external storage connected: inline the image as a base64
  // data URL saved directly in company_settings. Capped so it comfortably fits
  // the widened MEDIUMTEXT column (base64 inflates size by ~33%).
  const MAX_INLINE_BYTES = 1.5 * 1024 * 1024
  if (file.size > MAX_INLINE_BYTES) {
    return NextResponse.json(
      { error: "Without connected file storage, images must be 1.5MB or smaller. Please use a smaller image." },
      { status: 400 },
    )
  }
  const buffer = Buffer.from(await file.arrayBuffer())
  const dataUrl = `data:${file.type};base64,${buffer.toString("base64")}`
  return NextResponse.json({ url: dataUrl })
}
