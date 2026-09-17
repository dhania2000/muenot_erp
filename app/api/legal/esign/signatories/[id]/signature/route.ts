import { type NextRequest, NextResponse } from "next/server"
import { requireFeature } from "@/lib/api-auth"
import { getEsignFile } from "@/lib/legal-esign"
import {
  getSignatory,
  setSignatorySignature,
  removeSignatorySignature,
} from "@/lib/legal-esign-signatories"
import { SIGNATURE_IMAGE_TYPES, SIGNATURE_MAX_BYTES } from "@/lib/legal-esign-shared"

export const runtime = "nodejs"

/** Serve a signatory's current signature image (auth-gated, never a public URL). */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireFeature("legal.view_esign")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const { id } = await params
  const signatory = await getSignatory(Number(id))
  if (!signatory?.signature_file_id) return NextResponse.json({ error: "No signature" }, { status: 404 })
  const file = await getEsignFile(signatory.signature_file_id)
  if (!file) return NextResponse.json({ error: "No signature" }, { status: 404 })
  return new NextResponse(new Uint8Array(file.data), {
    headers: {
      "Content-Type": file.content_type || "image/png",
      "Cache-Control": "no-store, max-age=0",
    },
  })
}

/** Upload / replace a signatory's signature. Accepts a base64 data URL. */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireFeature("legal.manage_esign")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const { id } = await params
  const signatory = await getSignatory(Number(id))
  if (!signatory) return NextResponse.json({ error: "Not found" }, { status: 404 })
  const body = await request.json().catch(() => ({}))
  const dataUrl = String(body.imageData || "")
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/)
  if (!match) return NextResponse.json({ error: "A signature image is required" }, { status: 400 })
  const contentType = match[1]
  if (!SIGNATURE_IMAGE_TYPES.includes(contentType)) {
    return NextResponse.json({ error: "Only PNG or JPEG signature images are allowed" }, { status: 400 })
  }
  const data = Buffer.from(match[2], "base64")
  if (data.length > SIGNATURE_MAX_BYTES) {
    return NextResponse.json({ error: "Signature image is too large (max 3 MB)" }, { status: 400 })
  }
  const updated = await setSignatorySignature({
    signatoryId: Number(id),
    data,
    contentType,
    filename: body.filename ?? null,
    changedBy: session.userId,
  })
  return NextResponse.json({ signatory: updated })
}

/** Remove the current signature (kept in version history). */
export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireFeature("legal.manage_esign")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const { id } = await params
  const signatory = await getSignatory(Number(id))
  if (!signatory) return NextResponse.json({ error: "Not found" }, { status: 404 })
  const updated = await removeSignatorySignature(Number(id), session.userId)
  return NextResponse.json({ signatory: updated })
}
