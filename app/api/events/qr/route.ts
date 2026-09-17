import { NextRequest, NextResponse } from "next/server"
import QRCode from "qrcode"
import { getSession } from "@/lib/auth"
import { userHasFeature } from "@/lib/permissions"

/** Canonical production origin — used when nothing else yields a public URL. */
const PRODUCTION_ORIGIN = "https://erp.muenot.co.in"

/** A host that a phone on another network could never reach. */
function isLocalHost(host: string): boolean {
  const h = host.toLowerCase().split(":")[0]
  return (
    h === "localhost" ||
    h === "0.0.0.0" ||
    h === "127.0.0.1" ||
    h === "::1" ||
    h.endsWith(".local") ||
    h.startsWith("192.168.") ||
    h.startsWith("10.") ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h)
  )
}

/**
 * Resolves the PUBLIC base URL the QR should point at.
 *
 * A QR is scanned from a phone that is NOT on the dev machine, so it can never
 * use the request origin when that is a loopback/LAN address (e.g.
 * http://0.0.0.0:3000) — that is exactly what caused "site can't be reached".
 *
 * Priority:
 *   1. APP_URL / NEXT_PUBLIC_APP_URL (explicit, trailing slash trimmed)
 *   2. x-forwarded-host / host from the request, only if it is publicly routable
 *   3. The request origin, only if it is publicly routable
 *   4. The canonical production origin
 */
function resolvePublicBaseUrl(request: NextRequest): string {
  const configured = (process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL)?.replace(/\/+$/, "")
  if (configured) return configured

  const forwardedProto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim()
  const forwardedHost = request.headers.get("x-forwarded-host") || request.headers.get("host")
  if (forwardedHost && !isLocalHost(forwardedHost)) {
    const proto = forwardedProto || "https"
    return `${proto}://${forwardedHost}`
  }

  const originHost = request.nextUrl.host
  if (originHost && !isLocalHost(originHost)) return request.nextUrl.origin

  return PRODUCTION_ORIGIN
}

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

  const base = resolvePublicBaseUrl(request)
  const url = `${base}/event-access/scan/${encodeURIComponent(token)}`

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
