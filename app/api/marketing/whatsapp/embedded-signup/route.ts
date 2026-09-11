import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import {
  exchangeEmbeddedSignupCode,
  verifyWhatsAppCredentials,
  getWabaName,
  upsertWhatsAppIntegration,
  subscribeWabaWebhook,
  getWhatsAppIntegration,
  toPublicIntegration,
} from "@/lib/whatsapp"

/**
 * Completes Meta WhatsApp Embedded Signup for a coexistence (WhatsApp Business
 * App + Cloud API) number.
 *
 * The client launches Meta's Embedded Signup popup with
 * `featureType: "whatsapp_business_app_onboarding"`, where the user selects the
 * existing WhatsApp Business Account + phone number and completes the QR scan.
 * The popup hands back:
 *   - `code`           — a short-lived token-exchange code (via FB.login)
 *   - `wabaId`         — from the WA_EMBEDDED_SIGNUP session-info message
 *   - `phoneNumberId`  — from the WA_EMBEDDED_SIGNUP session-info message
 *
 * We exchange the code for a business access token server-side (never in the
 * browser), verify the resulting phone number (reading `platform_type` /
 * `is_on_biz_app` to confirm coexistence), subscribe the WABA to webhooks, and
 * persist the credentials.
 *
 * We deliberately do NOT call `/{phone-number-id}/register` and never
 * deregister — coexistence is preserved end to end.
 */
export async function POST(request: Request) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const body = (await request.json().catch(() => ({}))) as {
    code?: string
    wabaId?: string
    phoneNumberId?: string
    businessName?: string
  }

  const code = body.code?.trim()
  const wabaId = body.wabaId?.trim()
  const phoneNumberId = body.phoneNumberId?.trim()
  const businessNameInput = body.businessName?.trim() || null

  if (!code) {
    return NextResponse.json(
      { error: "The onboarding did not return an authorization code. Please try connecting again." },
      { status: 400 },
    )
  }
  if (!wabaId || !phoneNumberId) {
    return NextResponse.json(
      {
        error:
          "The onboarding did not return a WhatsApp Business Account and phone number. Make sure you selected a number and completed the QR step, then try again.",
      },
      { status: 400 },
    )
  }

  // 1) Exchange the code for a business access token.
  const exchange = await exchangeEmbeddedSignupCode(code)
  if (!exchange.ok || !exchange.accessToken) {
    return NextResponse.json(
      { error: exchange.error || "Could not complete WhatsApp onboarding." },
      { status: 502 },
    )
  }
  const accessToken = exchange.accessToken

  // 2) Verify the phone number and read coexistence signals.
  let profile
  try {
    profile = await verifyWhatsAppCredentials({ phoneNumberId, accessToken })
  } catch (err) {
    return NextResponse.json(
      { error: `Meta could not verify the selected number: ${(err as Error).message}` },
      { status: 422 },
    )
  }

  // 3) Best-effort friendly business name from the WABA.
  const businessName = businessNameInput || (await getWabaName({ wabaId, accessToken }))

  // 4) Persist the integration (token encrypted at rest).
  await upsertWhatsAppIntegration({
    wabaId,
    phoneNumberId,
    displayPhoneNumber: profile.displayPhoneNumber,
    verifiedName: profile.verifiedName,
    businessName,
    qualityRating: profile.qualityRating,
    platformType: profile.platformType,
    isOnBizApp: profile.isOnBizApp,
    accessToken,
    connectedByUserId: session.userId,
  })

  const row = await getWhatsAppIntegration()

  // 5) Subscribe the WABA to webhooks so inbound messages, statuses and
  //    coexistence echoes start flowing. Best-effort: a failure here should not
  //    fail onboarding — the "Webhook setup" panel can retry it.
  let webhookSubscribed = true
  let webhookError: string | undefined
  if (row) {
    const sub = await subscribeWabaWebhook(row)
    webhookSubscribed = sub.ok
    webhookError = sub.error
  }

  return NextResponse.json({
    connected: true,
    integration: row ? toPublicIntegration(row) : null,
    webhookSubscribed,
    webhookError,
  })
}
