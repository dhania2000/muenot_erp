import { NextResponse } from "next/server"
import { requirePlatformSuperAdmin } from "@/lib/platform-guard"
import { inspectWhatsAppPhoneOwnership, releaseWhatsAppPhoneOwnership, OwnershipReleaseError } from "@/lib/whatsapp-phone-ownership"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
const headers = { "Cache-Control": "private, no-store" }

export async function GET(request: Request) {
  const guard = await requirePlatformSuperAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status, headers })
  try {
    const phoneNumberId = new URL(request.url).searchParams.get("phoneNumberId") ?? ""
    return NextResponse.json({ ownership: await inspectWhatsAppPhoneOwnership(phoneNumberId),
      legacyEnvironmentConfigured: process.env.WHATSAPP_PHONE_NUMBER_ID?.trim() === phoneNumberId }, { headers })
  } catch (error) {
    return NextResponse.json({ error: error instanceof OwnershipReleaseError ? error.message : "Unable to inspect phone ownership." },
      { status: error instanceof OwnershipReleaseError ? error.status : 500, headers })
  }
}

export async function POST(request: Request) {
  const guard = await requirePlatformSuperAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status, headers })
  try {
    const body = await request.json() as Record<string, unknown>
    const integrationId = Number(body.integrationId)
    const phoneNumberId = typeof body.phoneNumberId === "string" ? body.phoneNumberId : ""
    const ownerTenantId = body.ownerTenantId === null ? null : Number(body.ownerTenantId)
    if (body.confirmation !== "RELEASE" || !Number.isSafeInteger(integrationId) || integrationId <= 0 ||
      !/^\d{1,191}$/.test(phoneNumberId) || (ownerTenantId !== null && (!Number.isSafeInteger(ownerTenantId) || ownerTenantId <= 0)))
      return NextResponse.json({ error: "Inspect ownership, then confirm the exact integration and owner." }, { status: 400, headers })
    const result = await releaseWhatsAppPhoneOwnership(integrationId, guard.ctx,
      typeof body.reason === "string" ? body.reason : "", { phoneNumberId, ownerTenantId })
    return NextResponse.json(result, { headers })
  } catch (error) {
    return NextResponse.json({ error: error instanceof OwnershipReleaseError ? error.message : "Unable to release phone ownership." },
      { status: error instanceof OwnershipReleaseError ? error.status : error instanceof SyntaxError ? 400 : 500, headers })
  }
}
