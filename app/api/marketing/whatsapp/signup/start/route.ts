import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { createWhatsAppSignupSession } from "@/lib/whatsapp-signup"

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
    const result = await createWhatsAppSignupSession(session.userId)
    return NextResponse.json(result)
  } catch (err) {
    console.error("[v0] whatsapp signup start error:", err)
    return NextResponse.json({ error: "Could not start WhatsApp signup. Please try again." }, { status: 500 })
  }
}
