import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { userHasFeature } from "@/lib/permissions"
import {
  ensureShiftRotationSchema,
  addMembers,
  endMembership,
  setMembershipStatus,
  employeesInDepartment,
  type Actor,
} from "@/lib/hr-shift-rotations"

async function canManage(s: { userId: number; role: "admin" | "employee" }) {
  return s.role === "admin" || userHasFeature(s.userId, s.role, "hr.manage_shift_rotations")
}
async function canOverride(s: { userId: number; role: "admin" | "employee" }) {
  return s.role === "admin" || userHasFeature(s.userId, s.role, "hr.override_shift_rotations")
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  await ensureShiftRotationSchema()
  if (!(await canManage(session))) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const { id } = await params
  const body = await request.json()
  const start_date = String(body.start_date || "").slice(0, 10)
  const end_date = body.end_date ? String(body.end_date).slice(0, 10) : null

  // Assemble the target employee set: explicit ids plus, when a department is
  // supplied, every currently-eligible employee in that department (§bulk).
  let employeeIds: number[] = Array.isArray(body.employee_ids) ? body.employee_ids.map(Number).filter(Boolean) : []
  if (body.department && typeof body.department === "string") {
    const deptEmployees = await employeesInDepartment(body.department, start_date || new Date().toISOString().slice(0, 10))
    employeeIds = [...employeeIds, ...deptEmployees.map((e) => e.id)]
  }

  const actor: Actor = { userId: session.userId, name: session.name, email: session.email, role: session.role }
  const override = Boolean(body.is_override) && (await canOverride(session))
  try {
    const result = await addMembers(id, { employeeIds, start_date, end_date }, actor, override)
    if (!result.ok) return NextResponse.json({ error: result.errors[0] || "Could not assign employees", ...result }, { status: 422 })
    return NextResponse.json(result, { status: 201 })
  } catch (error) {
    console.log("[v0] rotation add members failed", (error as Error).message)
    return NextResponse.json({ error: "Could not assign employees to the rotation." }, { status: 500 })
  }
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  await ensureShiftRotationSchema()
  if (!(await canManage(session))) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  await params // route is rotation-scoped; membership resolved by record_id
  const body = await request.json()
  const recordId = String(body.record_id || "")
  if (!recordId) return NextResponse.json({ error: "record_id is required." }, { status: 400 })
  const actor: Actor = { userId: session.userId, name: session.name, email: session.email, role: session.role }

  if (body.action === "end") {
    const endDate = String(body.end_date || new Date().toISOString().slice(0, 10)).slice(0, 10)
    const result = await endMembership(recordId, endDate, actor)
    if (!result.ok) return NextResponse.json({ error: result.errors?.[0] || "Could not end membership" }, { status: 422 })
    return NextResponse.json({ ok: true })
  }
  if (body.status === "Active" || body.status === "Inactive") {
    const ok = await setMembershipStatus(recordId, body.status, actor)
    if (!ok) return NextResponse.json({ error: "Membership not found." }, { status: 404 })
    return NextResponse.json({ ok: true })
  }
  return NextResponse.json({ error: "Unsupported membership action." }, { status: 400 })
}
