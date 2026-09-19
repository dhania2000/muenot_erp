import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { setTenantOnboardingState } from "@/lib/tenant-registration"

/**
 * Mark a tenant's WhatsApp onboarding step as done (whether the admin connected
 * WhatsApp or chose to skip). The tenant id comes from the authenticated
 * session only — never from the request body — so one admin can never advance
 * another tenant's onboarding.
 */
export async function POST() {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Not authenticated" }, { status: 401 })
  if (session.role !== "admin") return NextResponse.json({ error: "Admins only" }, { status: 403 })
  if (!session.tenantId) return NextResponse.json({ error: "No tenant in session" }, { status: 400 })

  try {
    await setTenantOnboardingState(session.tenantId, "active")
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error("[v0] onboarding complete failed:", err)
    return NextResponse.json({ error: "Could not update onboarding status" }, { status: 500 })
  }
}
