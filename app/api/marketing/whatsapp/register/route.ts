import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { getWhatsAppIntegration, registerWhatsAppNumber } from "@/lib/whatsapp"

/**
 * Registers the connected phone number with the WhatsApp Cloud API. This is the
 * one-time step Meta requires before a number can send messages — without it
 * every send fails with `(#133010) Account not registered`. The `pin` is the
 * number's 6-digit two-step verification PIN (set here for a brand-new number).
 */
export async function POST(request: Request) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const integration = await getWhatsAppIntegration()
  if (!integration) {
    return NextResponse.json({ error: "No WhatsApp account is connected yet." }, { status: 400 })
  }

  const body = (await request.json().catch(() => ({}))) as { pin?: string }
  const pin = body.pin?.trim().replace(/[^\d]/g, "")
  if (!pin || pin.length !== 6) {
    return NextResponse.json(
      { error: "A 6-digit PIN is required to register the number." },
      { status: 400 },
    )
  }

  const result = await registerWhatsAppNumber({ integration, pin })
  if (!result.ok) {
    return NextResponse.json({ error: result.error || "Failed to register number." }, { status: 502 })
  }

  return NextResponse.json({ ok: true })
}
