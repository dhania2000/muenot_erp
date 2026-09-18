import { NextRequest, NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { uploadFile } from "@/lib/storage"

/**
 * Document upload for the Expense form (Phase 22) — receipts, vendor invoices
 * and supporting files. Uses the SPEC 26 storage facade so uploads land in the
 * tenant's connected storage (their own S3-compatible bucket, or the platform
 * default) under a tenant-scoped key. The returned reference is persisted onto
 * the expense row and resolves back through the download proxy.
 */
export async function POST(request: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const form = await request.formData()
  const file = form.get("file")
  if (!(file instanceof File)) return NextResponse.json({ error: "File is required" }, { status: 400 })

  const up = await uploadFile(`finance-expenses/${crypto.randomUUID()}-${file.name}`, file)
  if (!up.ok) return NextResponse.json({ error: up.error }, { status: 400 })

  return NextResponse.json({ url: up.result.url, pathname: up.result.url })
}
