import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { uploadLargePart } from "@/lib/storage"

export const runtime = "nodejs"
// Chunks stream in as raw bytes; do not let the platform cache these writes.
export const dynamic = "force-dynamic"

/**
 * SPEC 30 — Upload a single chunk. The raw request body IS the chunk bytes.
 * Idempotent per (session, part): a retried chunk simply overwrites, so a
 * failed chunk can be re-sent without restarting the whole upload.
 */
export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string; part: string }> },
) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id, part } = await params
  const partNumber = Number(part)
  if (!Number.isInteger(partNumber) || partNumber < 1) {
    return NextResponse.json({ error: "Invalid part number" }, { status: 400 })
  }

  const buf = Buffer.from(await request.arrayBuffer())
  if (buf.length === 0) return NextResponse.json({ error: "Empty chunk" }, { status: 400 })

  const result = await uploadLargePart(Number(id), partNumber, buf)
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status ?? 400 })
  return NextResponse.json({ ok: true, uploadedParts: result.uploadedParts })
}
