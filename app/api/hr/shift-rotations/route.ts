import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { userHasFeature } from "@/lib/permissions"
import {
  ensureShiftRotationSchema,
  listRotations,
  getRotationSummary,
  createRotation,
  type Actor,
  type CreateRotationInput,
} from "@/lib/hr-shift-rotations"
import type { CycleType, PatternStep } from "@/lib/rotation-ui"

async function canManage(s: { userId: number; role: "admin" | "employee" }) {
  return s.role === "admin" || userHasFeature(s.userId, s.role, "hr.manage_shift_rotations")
}
async function canView(s: { userId: number; role: "admin" | "employee" }) {
  return s.role === "admin" || userHasFeature(s.userId, s.role, "hr.view_shift_rotations")
}
async function canOverride(s: { userId: number; role: "admin" | "employee" }) {
  return s.role === "admin" || userHasFeature(s.userId, s.role, "hr.override_shift_rotations")
}

export async function GET(request: Request) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  await ensureShiftRotationSchema()
  const manage = await canManage(session)
  if (!manage && !(await canView(session))) {
    return NextResponse.json({ error: "You do not have access to shift rotations." }, { status: 403 })
  }

  const sp = new URL(request.url).searchParams
  const rotations = await listRotations({
    q: (sp.get("q") || "").trim() || undefined,
    status: sp.get("status") || undefined,
    cycleType: sp.get("cycle_type") || undefined,
    state: sp.get("state") || undefined,
  })
  const summary = await getRotationSummary()

  return NextResponse.json({
    rotations,
    summary,
    canManage: manage,
    canOverride: await canOverride(session),
  })
}

export async function POST(request: Request) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  await ensureShiftRotationSchema()
  if (!(await canManage(session))) {
    return NextResponse.json({ error: "You do not have permission to create shift rotations." }, { status: 403 })
  }

  const body = await request.json()
  const steps: PatternStep[] = Array.isArray(body.steps)
    ? body.steps.map((s: any) => ({
        shift_id: Number(s.shift_id) || 0,
        unit_span: Math.max(1, Math.floor(Number(s.unit_span) || 1)),
        is_weekly_off: Boolean(s.is_weekly_off),
        label: s.label ? String(s.label).slice(0, 120) : null,
      }))
    : []

  const input: CreateRotationInput = {
    rotation_name: String(body.rotation_name || "").slice(0, 120),
    description: body.description ? String(body.description).slice(0, 500) : null,
    cycle_type: (["Days", "Weeks", "Months"].includes(body.cycle_type) ? body.cycle_type : "Weeks") as CycleType,
    cycle_length: Math.max(1, Math.floor(Number(body.cycle_length) || 1)),
    effective_from: String(body.effective_from || "").slice(0, 10),
    effective_until: body.effective_until ? String(body.effective_until).slice(0, 10) : null,
    time_zone: String(body.time_zone || "Asia/Kolkata").slice(0, 64),
    steps,
  }

  const actor: Actor = { userId: session.userId, name: session.name, email: session.email, role: session.role }
  try {
    const result = await createRotation(input, actor)
    if (!result.ok) {
      return NextResponse.json({ error: result.validation.errors[0] || "Validation failed", validation: result.validation }, { status: 422 })
    }
    return NextResponse.json({ rotation_id: result.rotationId }, { status: 201 })
  } catch (error) {
    console.log("[v0] shift-rotation create failed", (error as Error).message)
    return NextResponse.json({ error: "Could not create the rotation." }, { status: 500 })
  }
}
