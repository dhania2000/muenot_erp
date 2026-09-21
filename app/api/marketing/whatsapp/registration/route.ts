import { NextResponse } from "next/server"
import { requireTenantAdmin, effectiveTenantId } from "@/lib/platform-guard"
import { finalizeWhatsAppRegistration } from "@/lib/whatsapp-registration"
export const runtime = "nodejs"
export const maxDuration = 120

export async function POST(request: Request) {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const origin = request.headers.get("origin")
  if (origin && origin !== new URL(process.env.APP_URL || request.url).origin) return NextResponse.json({ error: "Invalid origin" }, { status: 403 })
  try {
    const raw = await request.text()
    if (raw.length > 2048) return NextResponse.json({ error: "Request too large" }, { status: 413 })
    const body = JSON.parse(raw)
    if (!Number.isSafeInteger(body.connectionId) || body.connectionId < 1 || (body.pin !== undefined && (typeof body.pin !== "string" || !/^\d{6}$/.test(body.pin)))) {
      return NextResponse.json({ error: "A connection ID and, if supplied, a six-digit PIN are required." }, { status: 400 })
    }
    const registration = await finalizeWhatsAppRegistration(effectiveTenantId(guard.ctx)!, body.connectionId, body.pin)
    return NextResponse.json({ registration }, { headers: { "Cache-Control": "no-store" } })
  } catch {
    return NextResponse.json({ error: "Unable to finalize this connection. Verify access and refresh status before retrying." }, { status: 409 })
  }
}
