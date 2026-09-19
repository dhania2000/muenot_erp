import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { createWhatsAppSignupSessionForSystemAdmin, getSignupReadiness } from "@/lib/whatsapp-signup"

/** Read-only probe used by the client to disable the button when Meta config is missing. */
export async function GET() {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (session.role !== "admin") {
    return NextResponse.json({ error: "Only an administrator can connect WhatsApp." }, { status: 403 })
  }
  return NextResponse.json(getSignupReadiness())
}

/**
 * Starts a WhatsApp Embedded Signup for the acting tenant. Returns the CSRF
 * `state` plus the Meta app/config ids the client needs to launch the popup.
 * Admin-only: connecting a business number is a tenant-configuration action.
 */
export async function POST() {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (session.role !== "admin") {
    return NextResponse.json({ error: "Only an administrator can connect WhatsApp." }, { status: 403 })
  }

  try {
    // getSession() normally binds a tenant from the signed session / users
    // table. The original System Admin account may legitimately have no
    // tenant_id, so its Meta signup is bound to the single platform-owner
    // tenant by the service. No client-supplied tenant id is accepted.
    const result = await createWhatsAppSignupSessionForSystemAdmin(session.userId)
    return NextResponse.json(result)
  } catch (err) {
    console.error("[v0] whatsapp signup start error:", err)
    const message = err instanceof Error ? err.message : ""
    if (message.includes("platform-owner tenant")) {
      return NextResponse.json({ error: message }, { status: 409 })
    }
    return NextResponse.json({ error: "Could not start WhatsApp signup. Please try again." }, { status: 500 })
  }
}
