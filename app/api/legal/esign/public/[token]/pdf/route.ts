import { type NextRequest, NextResponse } from "next/server"
import { resolveSignerByToken, getRequestSigners } from "@/lib/legal-esign"
import { ensureBasePdf } from "@/lib/legal-esign-pdf"

export const runtime = "nodejs"

/**
 * PUBLIC document view for a signer — serves ONLY the base (unsigned) document,
 * gated behind a valid single-use token. The signed/executed PDF is never
 * reachable without a session (Phases 12, 64).
 */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const resolved = await resolveSignerByToken(token)
  if (!resolved.ok) return NextResponse.json({ error: "Link is not valid" }, { status: 403 })
  const signers = await getRequestSigners(resolved.request.id)
  const data = await ensureBasePdf({ ...resolved.request, signers })
  return new NextResponse(new Uint8Array(data), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${resolved.request.request_uid}.pdf"`,
      "Cache-Control": "no-store, max-age=0",
    },
  })
}
