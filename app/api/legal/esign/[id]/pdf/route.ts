import { type NextRequest, NextResponse } from "next/server"
import { requireFeature } from "@/lib/api-auth"
import { getEsignRequest, getEsignFile, getRequestSigners, logEsignEvent } from "@/lib/legal-esign"
import { ensureBasePdf } from "@/lib/legal-esign-pdf"

export const runtime = "nodejs"

/**
 * Serve the base (unsigned) or signed PDF for a request. Auth-gated — the signed
 * document is never exposed through a public URL (Phases 12, 64, 92).
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireFeature("legal.view_esign")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const { id } = await params
  const req = await getEsignRequest(Number(id))
  if (!req) return NextResponse.json({ error: "Not found" }, { status: 404 })

  const sp = request.nextUrl.searchParams
  const version = sp.get("version") === "signed" ? "signed" : "base"
  const download = sp.get("download") === "1"

  let data: Buffer
  let filename: string
  if (version === "signed") {
    if (!req.signed_file_id) return NextResponse.json({ error: "No signed document yet" }, { status: 404 })
    const file = await getEsignFile(req.signed_file_id)
    if (!file) return NextResponse.json({ error: "Signed document unavailable" }, { status: 404 })
    data = file.data
    filename = file.filename || `${req.request_uid}-signed.pdf`
    if (download) {
      await logEsignEvent({
        requestId: req.id,
        type: "signed_pdf_downloaded",
        summary: `Signed PDF downloaded by ${session.name || "user"}`,
        actorId: session.userId,
        actorName: session.name ?? null,
      })
    }
  } else {
    // Freeze/serve the immutable base document.
    const signers = req.signers || (await getRequestSigners(req.id))
    data = await ensureBasePdf({ ...req, signers })
    filename = `${req.request_uid}-original.pdf`
  }

  return new NextResponse(new Uint8Array(data), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `${download ? "attachment" : "inline"}; filename="${filename}"`,
      "Cache-Control": "no-store, max-age=0",
    },
  })
}
