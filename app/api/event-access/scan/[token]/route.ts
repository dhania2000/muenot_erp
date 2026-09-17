import { NextRequest, NextResponse } from "next/server"
import { rateLimitScan } from "@/lib/events-access"
import { verifyParticipantToken } from "@/lib/events-scan"

/**
 * Public QR scan/verify endpoint (no ERP session required — this is what a
 * gate scanner or the employee's own device hits). Protected by an in-memory
 * rate limiter keyed on client IP + token, and by the fully server-side
 * verification in verifyParticipantToken.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const token = (await params).token
  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "unknown"

  if (!rateLimitScan(`${ip}:${token}`.slice(0, 80))) {
    return NextResponse.json(
      { result: "RATE_LIMITED", approved: false, title: "Too Many Attempts", message: "Too many attempts. Please wait a moment and try again." },
      { status: 429 },
    )
  }

  let body: any = {}
  try {
    body = await request.json()
  } catch {
    /* empty body is fine */
  }
  const action = body.action === "checkin" || body.action === "checkout" ? body.action : "verify"

  const verification = await verifyParticipantToken(token, action, {
    scannerName: body.scanner_name ? String(body.scanner_name).slice(0, 150) : null,
    venue: body.venue ? String(body.venue).slice(0, 255) : null,
    deviceInfo: request.headers.get("user-agent")?.slice(0, 255) ?? null,
  })

  return NextResponse.json(verification)
}
