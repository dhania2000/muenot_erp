import { put } from "@vercel/blob"
import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"

const allowed = new Set(["application/pdf", "image/png", "image/jpeg", "image/webp", "image/gif", "application/msword", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/vnd.ms-excel", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"])
const maxBytes = 10 * 1024 * 1024

export async function POST(request: Request) {
  if (!(await getSession())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const form = await request.formData()
  const file = form.get("file")
  if (!(file instanceof File)) return NextResponse.json({ error: "File is required" }, { status: 400 })
  if (!allowed.has(file.type) || file.size > maxBytes) return NextResponse.json({ error: "Only PDF, image, Word, and Excel files up to 10MB are allowed" }, { status: 400 })
  const blob = await put(`email-attachments/${crypto.randomUUID()}-${file.name.replace(/[^a-zA-Z0-9._-]/g, "_")}`, file, { access: "private", addRandomSuffix: false })
  return NextResponse.json({ pathname: blob.pathname, filename: file.name, contentType: file.type, size: file.size })
}
