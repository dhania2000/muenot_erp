import { type NextRequest, NextResponse } from "next/server"
import { requirePlatformStaff, requirePlatformSuperAdmin } from "@/lib/platform-guard"
import {
  deleteOnboarding,
  getOnboarding,
  OnboardingStateError,
  saveOnboardingStep,
} from "@/lib/tenant-onboarding"

function parseId(raw: string): number | null {
  const id = Number(raw)
  return Number.isInteger(id) && id > 0 ? id : null
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requirePlatformStaff()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const id = parseId((await params).id)
  if (id == null) return NextResponse.json({ error: "Invalid onboarding id" }, { status: 400 })
  const session = await getOnboarding(id)
  if (!session) return NextResponse.json({ error: "Onboarding session not found" }, { status: 404 })
  return NextResponse.json({ session })
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requirePlatformSuperAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const id = parseId((await params).id)
  if (id == null) return NextResponse.json({ error: "Invalid onboarding id" }, { status: 400 })

  let body: any
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const step = Number(body?.step)
  if (!Number.isInteger(step) || step < 0) {
    return NextResponse.json({ error: "A valid step index is required" }, { status: 400 })
  }
  const data = body?.data && typeof body.data === "object" ? body.data : {}

  try {
    const session = await saveOnboardingStep(id, step, data)
    return NextResponse.json({ session })
  } catch (err: any) {
    const status = err instanceof OnboardingStateError ? err.status : 400
    return NextResponse.json({ error: err?.message ?? "Failed to save onboarding" }, { status })
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requirePlatformSuperAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const id = parseId((await params).id)
  if (id == null) return NextResponse.json({ error: "Invalid onboarding id" }, { status: 400 })

  try {
    await deleteOnboarding(id)
    return NextResponse.json({ ok: true })
  } catch (err: any) {
    const status = err instanceof OnboardingStateError ? err.status : 400
    return NextResponse.json({ error: err?.message ?? "Failed to delete onboarding" }, { status })
  }
}
