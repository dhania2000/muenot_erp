import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { userHasFeature } from "@/lib/permissions"
import { ensureShiftRotationSchema, addRotationVersion, type Actor } from "@/lib/hr-shift-rotations"
import type { CycleType, PatternStep } from "@/lib/rotation-ui"

async function canManage(s: { userId: number; role: "admin" | "employee" }) {
  return s.role === "admin" || userHasFeature(s.userId, s.role, "hr.manage_shift_rotations")
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  await ensureShiftRotationSchema()
  if (!(await canManage(session))) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const { id } = await params
  const body = await request.json()
  const steps: PatternStep[] = Array.isArray(body.steps)
    ? body.steps.map((s: any) => ({
        shift_id: Number(s.shift_id) || 0,
        unit_span: Math.max(1, Math.floor(Number(s.unit_span) || 1)),
        is_weekly_off: Boolean(s.is_weekly_off),
        label: s.label ? String(s.label).slice(0, 120) : null,
      }))
    : []

  const actor: Actor = { userId: session.userId, name: session.name, email: session.email, role: session.role }
  try {
    const result = await addRotationVersion(
      id,
      {
        effective_from: String(body.effective_from || "").slice(0, 10),
        cycle_type: (["Days", "Weeks", "Months"].includes(body.cycle_type) ? body.cycle_type : "Weeks") as CycleType,
        cycle_length: Math.max(1, Math.floor(Number(body.cycle_length) || 1)),
        steps,
        notes: body.notes ? String(body.notes).slice(0, 500) : null,
      },
      actor,
    )
    if (!result.ok) return NextResponse.json({ error: result.errors[0] || "Validation failed", errors: result.errors }, { status: 422 })
    return NextResponse.json({ version_no: result.versionNo }, { status: 201 })
  } catch (error) {
    console.log("[v0] rotation version add failed", (error as Error).message)
    return NextResponse.json({ error: "Could not add the version." }, { status: 500 })
  }
}
