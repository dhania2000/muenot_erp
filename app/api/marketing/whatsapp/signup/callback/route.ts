import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { handleWhatsAppSignupCallback } from "@/lib/whatsapp-signup"

/**
 * Completes WhatsApp Embedded Signup. The client posts the authorization
 * `code` (from Meta's popup) plus the `state` we minted on start and the WABA /
 * phone-number ids Meta returned in its session-info message. The tenant is
 * resolved from the trusted `state`, cross-checked against the acting session,
 * and the account is connected + auto-configured inside that tenant's context.
 */
export async function POST(request: Request) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (session.role !== "admin") {
    return NextResponse.json({ error: "Only an administrator can connect WhatsApp." }, { status: 403 })
  }

  const body = (await request.json().catch(() => ({}))) as {
    state?: string
    code?: string
    wabaId?: string
    phoneNumberId?: string
    businessId?: string
  }

  const state = body.state?.trim()
  const code = body.code?.trim()
  const wabaId = body.wabaId?.trim()
  const phoneNumberId = body.phoneNumberId?.trim()

  if (!state || !code || !wabaId || !phoneNumberId) {
    return NextResponse.json(
      { error: "Missing signup details. Please restart the WhatsApp connection." },
      { status: 400 },
    )
  }

  try {
    const result = await handleWhatsAppSignupCallback({
      state,
      code,
      wabaId,
      phoneNumberId,
      businessId: body.businessId?.trim() || null,
      expectedTenantId: session.tenantId ?? null,
    })
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: 422 })
    }
    return NextResponse.json({ connected: true, integration: result.integration, autoConfig: result.autoConfig })
  } catch (err) {
    console.error("[v0] whatsapp signup callback error:", err)
    return NextResponse.json({ error: "Could not complete WhatsApp connection. Please try again." }, { status: 500 })
  }
}
