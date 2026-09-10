import { NextRequest, NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { isCertificateKind, loadCertificate, renderCertificatePdf } from "@/lib/hr-certificate"

export const runtime = "nodejs"

// GET /api/hr/master-data/certificate?kind=awards|appreciations&id=123[&download=1]
export async function GET(req: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const kind = req.nextUrl.searchParams.get("kind") || ""
  const id = req.nextUrl.searchParams.get("id") || ""
  if (!isCertificateKind(kind)) return NextResponse.json({ error: "Invalid kind" }, { status: 400 })
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 })

  const cert = await loadCertificate(kind, id)
  if (!cert) return NextResponse.json({ error: "Record not found" }, { status: 404 })

  const pdf = renderCertificatePdf(cert.data)
  const disposition = req.nextUrl.searchParams.get("download") === "1" ? "attachment" : "inline"
  return new NextResponse(new Uint8Array(pdf), {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `${disposition}; filename="${cert.fileName}"`,
      "Cache-Control": "no-store",
    },
  })
}
