import { NextResponse } from "next/server"
import { requirePlatformStaff, requirePlatformSuperAdmin } from "@/lib/platform-guard"
import { createOnboarding, listOnboarding } from "@/lib/tenant-onboarding"

/**
 * SPEC 5 — Tenant onboarding directory. PLATFORM-axis surface: only Muenot
 * platform staff can view onboarding sessions; creating (which culminates in
 * provisioning a real tenant) is restricted to super admins, matching the
 * tenant-create guard.
 */
export async function GET() {
  const guard = await requirePlatformStaff()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const sessions = await listOnboarding()
  return NextResponse.json({ sessions })
}

export async function POST() {
  const guard = await requirePlatformSuperAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const session = await createOnboarding(guard.ctx.userId)
  return NextResponse.json({ session }, { status: 201 })
}
