import { NextRequest, NextResponse } from "next/server"
import { requirePlatformStaff, requirePlatformSuperAdmin } from "@/lib/platform-guard"
import { SUPPORT_LEVELS, toPriority, validateSlaTarget, type SupportLevel } from "@/lib/support-sla/model"
import { getSlaPolicies, updateSlaPolicy } from "@/lib/support-sla/store"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/** Spec28 (#127) — Response/resolution targets per plan support level × priority. */
export async function GET() {
  const guard = await requirePlatformStaff()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  try {
    return NextResponse.json({ policies: await getSlaPolicies() })
  } catch (error) {
    console.error("[support-sla] policy read failed", error)
    return NextResponse.json({ error: "Unable to load SLA policies" }, { status: 500 })
  }
}

/** Update one target. Super admin only; audited. Applies to tickets opened afterwards. */
export async function PUT(req: NextRequest) {
  const guard = await requirePlatformSuperAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const body = await req.json().catch(() => null)
  const level = body?.supportLevel as SupportLevel
  if (!(SUPPORT_LEVELS as readonly string[]).includes(level)) {
    return NextResponse.json({ error: "Invalid supportLevel" }, { status: 400 })
  }
  const priority = toPriority(body?.priority)
  if (!priority) return NextResponse.json({ error: "Invalid priority" }, { status: 400 })
  const target = validateSlaTarget(body ?? {})
  if (!target.ok) return NextResponse.json({ error: target.error }, { status: 400 })
  try {
    await updateSlaPolicy(level, priority, target.value, { userId: guard.session.userId })
    return NextResponse.json({ ok: true, policies: await getSlaPolicies() })
  } catch (error) {
    console.error("[support-sla] policy update failed", error)
    return NextResponse.json({ error: "Unable to update SLA policy" }, { status: 500 })
  }
}
