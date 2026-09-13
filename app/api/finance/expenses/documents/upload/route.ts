import { put } from "@vercel/blob"
import { NextRequest, NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { validateUpload } from "@/lib/settings/uploads"

/**
 * Document upload for the Expense form (Phase 22) — receipts, vendor invoices
 * and supporting files. Mirrors the existing ERP blob-upload routes: the API
 * token stays server-side, the file is validated, and the stored blob URL is
 * returned for the form to persist onto the expense row.
 */
export async function POST(request: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const form = await request.formData()
  const file = form.get("file")
  if (!(file instanceof File)) return NextResponse.json({ error: "File is required" }, { status: 400 })

  const uploadError = await validateUpload(file)
  if (uploadError) return NextResponse.json({ error: uploadError }, { status: 400 })

  const blob = await put(`finance-expenses/${crypto.randomUUID()}-${file.name}`, file, {
    access: "public",
    addRandomSuffix: false,
  })
  return NextResponse.json({ url: blob.url, pathname: blob.url })
}
