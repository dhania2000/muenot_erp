import { type NextRequest, NextResponse } from "next/server"
import { resolveSignerByToken, getEsignFile } from "@/lib/legal-esign"
import { getSignatory } from "@/lib/legal-esign-signatories"

export const runtime = "nodejs"

/**
 * PUBLIC, token-scoped preview of the saved authorized signature that will be
 * applied for an internal signatory. The token IS the credential — only the
 * signature bound to THIS signer is ever returned.
 */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const resolved = await resolveSignerByToken(token)
  if (!resolved.ok) return NextResponse.json({ error: "Invalid link" }, { status: 404 })
  const signatoryId = resolved.signer.signatory_id
  if (!signatoryId) return NextResponse.json({ error: "No saved signature" }, { status: 404 })
  const signatory = await getSignatory(Number(signatoryId))
  if (!signatory?.signature_file_id) return NextResponse.json({ error: "No saved signature" }, { status: 404 })
  const file = await getEsignFile(signatory.signature_file_id)
  if (!file) return NextResponse.json({ error: "No saved signature" }, { status: 404 })
  return new NextResponse(new Uint8Array(file.data), {
    headers: {
      "Content-Type": file.content_type || "image/png",
      "Cache-Control": "no-store, max-age=0",
    },
  })
}
