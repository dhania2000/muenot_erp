import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import {
  getWhatsAppIntegration,
  getWebhookVerifyToken,
  getAppSecret,
  subscribeWabaWebhook,
} from "@/lib/whatsapp"

/** Masks a secret so the UI can show it is configured without revealing it. */
function mask(value: string | null): string | null {
  if (!value) return null
  if (value.length <= 4) return "••••"
  return `${"•".repeat(Math.max(4, value.length - 4))}${value.slice(-4)}`
}

/**
 * Returns everything the "Webhook Setup" panel needs. Secrets are only ever
 * returned masked — the real verify token and app secret stay server-side.
 */
export async function GET(request: Request) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const origin = new URL(request.url).origin
  const verifyToken = getWebhookVerifyToken()
  const appSecret = getAppSecret()

  return NextResponse.json({
    callbackUrl: `${origin}/api/marketing/whatsapp/webhook`,
    verifyTokenConfigured: Boolean(verifyToken),
    verifyTokenMasked: mask(verifyToken),
    appSecretConfigured: Boolean(appSecret),
    subscribeField: "messages",
  })
}

/**
 * Subscribes the connected app to the WABA's webhook fields. A successful GET
 * verification alone does NOT start message delivery — Meta requires this
 * explicit subscription.
 */
export async function POST() {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const integration = await getWhatsAppIntegration()
  if (!integration) {
    return NextResponse.json({ error: "No WhatsApp account is connected yet." }, { status: 400 })
  }

  const result = await subscribeWabaWebhook(integration)
  if (!result.ok) {
    return NextResponse.json(
      { error: result.error || "Failed to subscribe to WABA webhooks." },
      { status: 502 },
    )
  }

  return NextResponse.json({ ok: true })
}
