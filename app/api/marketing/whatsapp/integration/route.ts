import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { requireTenantAdmin } from "@/lib/platform-guard"
import { safeWhatsAppPersistenceError } from "@/lib/whatsapp-persistence-diagnostics"
import {
  getWhatsAppIntegration,
  toPublicIntegration,
  upsertWhatsAppIntegration,
  deleteWhatsAppIntegration,
  verifyWhatsAppCredentials,
} from "@/lib/whatsapp"

/** Returns the current WhatsApp integration status (never exposes the token). */
export async function GET() {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const row = await getWhatsAppIntegration()
  return NextResponse.json({
    connected: Boolean(row),
    integration: row ? toPublicIntegration(row) : null,
  })
}

/**
 * Connects a WhatsApp Business number. We verify the credentials against the
 * Graph API first so we never store a set that cannot actually send messages,
 * and surface Meta's own error message back to the user when it fails.
 */
export async function POST(request: Request) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const body = (await request.json().catch(() => ({}))) as {
    wabaId?: string
    phoneNumberId?: string
    accessToken?: string
    businessName?: string
  }

  const wabaId = body.wabaId?.trim()
  const phoneNumberId = body.phoneNumberId?.trim()
  const accessToken = body.accessToken?.trim()
  const businessName = body.businessName?.trim() || null

  if (!wabaId || !phoneNumberId || !accessToken) {
    return NextResponse.json(
      { error: "WhatsApp Business Account ID, Phone Number ID and Access Token are all required." },
      { status: 400 },
    )
  }

  let profile
  try {
    profile = await verifyWhatsAppCredentials({ phoneNumberId, accessToken })
  } catch (err) {
    return NextResponse.json(
      { error: `Meta rejected these credentials: ${(err as Error).message}` },
      { status: 422 },
    )
  }

  try { await upsertWhatsAppIntegration({
    wabaId,
    phoneNumberId,
    displayPhoneNumber: profile.displayPhoneNumber,
    verifiedName: profile.verifiedName,
    businessName,
    qualityRating: profile.qualityRating,
    platformType: profile.platformType,
    accessToken,
    connectedByUserId: session.userId,
  }) } catch (error) {
    if (safeWhatsAppPersistenceError(error).operation === "phone_ownership_conflict")
      return NextResponse.json({ code: "WHATSAPP_PHONE_ALREADY_ASSIGNED",
        error: "This WhatsApp number is already connected to another Muenot account. Disconnect it from the previous account or contact Muenot support." }, { status: 409 })
    return NextResponse.json({ error: "WhatsApp connection could not be saved." }, { status: 500 })
  }

  const row = await getWhatsAppIntegration()
  return NextResponse.json({
    connected: true,
    integration: row ? toPublicIntegration(row) : null,
  })
}

/** Disconnects the current WhatsApp integration. */
export async function DELETE() {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })

  const row = await getWhatsAppIntegration()
  if (row) await deleteWhatsAppIntegration(row.id, guard.ctx.userId)
  return NextResponse.json({ connected: false, integration: null })
}
