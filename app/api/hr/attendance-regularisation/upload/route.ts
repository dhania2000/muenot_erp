import { put } from "@vercel/blob"
import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"

export async function POST(request: Request) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const form = await request.formData()
  const file = form.get("file")
  if (!(file instanceof File) || file.size > 10 * 1024 * 1024) return NextResponse.json({ error: "Valid file up to 10MB is required" }, { status: 400 })
  const blob = await put(`hr/regularisation/${session.userId}/${Date.now()}-${file.name.replace(/[^a-zA-Z0-9._-]/g, "-")}`, file, { access: "public" })
  return NextResponse.json({ pathname: blob.url })
}
