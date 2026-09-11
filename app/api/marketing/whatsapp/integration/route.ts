import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
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

  await upsertWhatsAppIntegration({
    wabaId,
    phoneNumberId,
    displayPhoneNumber: profile.displayPhoneNumber,
    verifiedName: profile.verifiedName,
    businessName,
    qualityRating: profile.qualityRating,
    accessToken,
    connectedByUserId: session.userId,
  })

  const row = await getWhatsAppIntegration()
  return NextResponse.json({
    connected: true,
    integration: row ? toPublicIntegration(row) : null,
  })
}

/** Disconnects the current WhatsApp integration. */
export async function DELETE() {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const row = await getWhatsAppIntegration()
  if (row) await deleteWhatsAppIntegration(row.id)
  return NextResponse.json({ connected: false, integration: null })
}
