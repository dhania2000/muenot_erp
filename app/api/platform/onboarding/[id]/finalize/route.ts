import { type NextRequest, NextResponse } from "next/server"
import { requirePlatformSuperAdmin } from "@/lib/platform-guard"
import {
  finalizeOnboarding,
  OnboardingStateError,
  OnboardingValidationError,
} from "@/lib/tenant-onboarding"

/**
 * Finalize (provision) an onboarding session. Super-admin only,
 * because it creates a live tenant and its first owner user. The orchestrator
 * is idempotent: a failed run records its partial progress, so re-POSTing here
 * resumes provisioning instead of duplicating anything.
 */
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requirePlatformSuperAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })

  const id = Number((await params).id)
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "Invalid onboarding id" }, { status: 400 })
  }

  try {
    const result = await finalizeOnboarding(id, {
      userId: guard.ctx.userId,
      email: guard.session.email,
    })
    return NextResponse.json({
      session: result.record,
      tenantId: result.tenantId,
      adminUserId: result.adminUserId,
      adminTempPassword: result.adminTempPassword,
    })
  } catch (err: any) {
    if (err instanceof OnboardingValidationError) {
      return NextResponse.json({ error: err.message, fieldErrors: err.fieldErrors }, { status: 400 })
    }
    const status = err instanceof OnboardingStateError ? err.status : 500
    return NextResponse.json({ error: err?.message ?? "Failed to finalize onboarding" }, { status })
  }
}
