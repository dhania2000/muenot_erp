import { NextResponse } from "next/server"
import { requireFeature } from "@/lib/api-auth"
import {
  deleteOnboarding,
  getOnboardingDetail,
  onboardingErrorStatus,
  updateOnboarding,
} from "@/lib/sales/onboarding-service"

/** GET /api/sales/onboarding/[id] — full detail (relations, sub-items, timeline, health). */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireFeature("sales.view_onboarding")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const { id } = await params
  const detail = await getOnboardingDetail(Number(id))
  if (!detail) return NextResponse.json({ error: "Onboarding record not found" }, { status: 404 })
  return NextResponse.json({ onboarding: detail })
}

/** PATCH /api/sales/onboarding/[id] — edit details (optimistic concurrency). */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireFeature("sales.manage_onboarding")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const { id } = await params
  const body = await request.json().catch(() => ({}))
  try {
    const record = await updateOnboarding(Number(id), body, session.userId)
    return NextResponse.json({ success: true, record })
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error)?.message || "Failed to update onboarding", details: (err as any)?.details },
      { status: onboardingErrorStatus(err) },
    )
  }
}

/**
 * DELETE /api/sales/onboarding/[id] — guarded. Default soft-archives; pass
 * ?force=1 to permanently delete an already-archived record (cascades sub-items).
 */
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireFeature("sales.manage_onboarding")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const { id } = await params
  const force = new URL(request.url).searchParams.get("force") === "1"
  try {
    await deleteOnboarding(Number(id), session.userId, { force })
    return NextResponse.json({ success: true, archived: !force })
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error)?.message || "Failed to delete onboarding" },
      { status: onboardingErrorStatus(err) },
    )
  }
}
