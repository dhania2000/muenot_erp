import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { uploadFile } from "@/lib/storage"

export async function POST(request: Request) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const form = await request.formData()
  const file = form.get("file")
  if (!(file instanceof File)) return NextResponse.json({ error: "A file is required" }, { status: 400 })
  const up = await uploadFile(
    `hr/regularisation/${session.userId}/${Date.now()}-${file.name.replace(/[^a-zA-Z0-9._-]/g, "-")}`,
    file,
  )
  if (!up.ok) return NextResponse.json({ error: up.error }, { status: 400 })
  return NextResponse.json({ pathname: up.result.url })
}
