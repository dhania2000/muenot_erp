import { put } from "@vercel/blob"
import { NextRequest, NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { validateUpload } from "@/lib/settings/uploads"

export async function POST(request: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const form = await request.formData()
  const file = form.get("file")
  if (!(file instanceof File)) return NextResponse.json({ error: "File is required" }, { status: 400 })
  const uploadError = await validateUpload(file)
  if (uploadError) return NextResponse.json({ error: uploadError }, { status: 400 })
  const blob = await put(`hr-support/${crypto.randomUUID()}-${file.name}`, file, { access: "public", addRandomSuffix: false })
  return NextResponse.json({ pathname: blob.url })
}
