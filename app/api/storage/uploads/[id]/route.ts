import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { abortLargeUpload } from "@/lib/storage"
import { getSessionStatus } from "@/lib/storage/multipart-store"

export const runtime = "nodejs"

/**
 * SPEC 30 — A single upload session.
 * GET    → current status incl. which part numbers already landed (resume).
 * DELETE → cancel the upload (aborts the provider multipart upload).
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const { id } = await params
  const status = await getSessionStatus(Number(id))
  if (!status) return NextResponse.json({ error: "Upload session not found" }, { status: 404 })
  return NextResponse.json({ session: status })
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const { id } = await params
  const result = await abortLargeUpload(Number(id))
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status ?? 400 })
  return NextResponse.json({ ok: true })
}
