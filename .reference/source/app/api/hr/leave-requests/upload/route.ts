import { put } from "@vercel/blob"
import { NextRequest, NextResponse } from "next/server"
import { getSession } from "@/lib/auth"

export async function POST(request: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const form = await request.formData()
  const file = form.get("file")
  if (!(file instanceof File)) return NextResponse.json({ error: "File required" }, { status: 400 })
  if (file.size > 10 * 1024 * 1024) return NextResponse.json({ error: "File too large" }, { status: 413 })
  const blob = await put(`hr/leave-attachments/${Date.now()}-${file.name}`, file, { access: "private" })
  return NextResponse.json({ pathname: blob.pathname })
}
