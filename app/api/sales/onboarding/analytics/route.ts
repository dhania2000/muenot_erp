import { NextResponse } from "next/server"
import { requireFeature } from "@/lib/api-auth"
import { getOnboardingAnalytics, onboardingErrorStatus } from "@/lib/sales/onboarding-service"

/** GET /api/sales/onboarding/analytics — portfolio counts + health/progress rollups. */
export async function GET() {
  const session = await requireFeature("sales.view_onboarding")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  try {
    const analytics = await getOnboardingAnalytics()
    return NextResponse.json({ analytics })
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error)?.message || "Failed to load analytics" },
      { status: onboardingErrorStatus(err) },
    )
  }
}
