import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { completeLargeUpload } from "@/lib/storage"

export const runtime = "nodejs"

/**
 * SPEC 30 — Finalize a multipart upload once every chunk has landed. Returns
 * the tenant-scoped storage key + result so the caller can persist a reference.
 */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const { id } = await params
  const result = await completeLargeUpload(Number(id))
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status ?? 400 })
  return NextResponse.json({ ok: true, key: result.key, result: result.result })
}
