import { NextRequest, NextResponse } from "next/server"
import QRCode from "qrcode"
import { getSession } from "@/lib/auth"
import { userHasFeature } from "@/lib/permissions"

/**
 * Renders a QR PNG for an event or participant access token.
 * The QR encodes ONLY the opaque public scan URL — never any personal data.
 * Requires an authenticated ERP user with events.view.
 */
export async function GET(request: NextRequest) {
  const session = await getSession()
  if (!session || !(await userHasFeature(session.userId, session.role, "events.view")))
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const token = request.nextUrl.searchParams.get("token")?.trim()
  if (!token) return NextResponse.json({ error: "token required" }, { status: 400 })

  const origin = request.nextUrl.origin
  const url = `${origin}/event-access/scan/${encodeURIComponent(token)}`

  try {
    const png = await QRCode.toBuffer(url, {
      type: "png",
      errorCorrectionLevel: "M",
      margin: 2,
      width: 512,
      color: { dark: "#0f172a", light: "#ffffff" },
    })
    return new NextResponse(new Uint8Array(png), {
      headers: {
        "Content-Type": "image/png",
        "Cache-Control": "private, max-age=300",
        "X-Content-Type-Options": "nosniff",
      },
    })
  } catch (error) {
    console.error("[v0] QR render failed:", (error as Error).message)
    return NextResponse.json({ error: "Failed to render QR" }, { status: 500 })
  }
}
