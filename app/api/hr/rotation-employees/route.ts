import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { userHasFeature } from "@/lib/permissions"
import {
  ensureShiftRotationSchema,
  addMembers,
  endMembership,
  setMembershipStatus,
  employeesInDepartment,
  listMemberships,
  membershipSummary,
  getMembership,
  getMembershipEvents,
  employeesWithoutRotation,
  listRotations,
  listAssignableEmployees,
  listDepartments,
  getEffectiveSteps,
  todayStr,
  type Actor,
  type MembershipRow,
} from "@/lib/hr-shift-rotations"
import { getEmployeeRotationState, getRotationSequenceForEmployee } from "@/lib/hr-attendance"
import { buildPreview } from "@/lib/rotation-ui"

/**
 * THE authoritative "Shift Rotation Employees" API. It replaces the old generic
 * shift-workflows CRUD for the `employees` kind: the client can NEVER set the
 * record_id, current_sequence, next_run or status directly. Every write is
 * validated and delegated to the rotation service (auto-IDs, eligibility,
 * conflict detection, audit). Every read derives the current sequence/shift
 * through the ONE central resolver (resolve-on-read, so nothing is ever
 * materialized or duplicated).
 */

type Sess = { userId: number; name: string; email: string; role: "admin" | "employee" }

async function canManage(s: Sess) {
  return s.role === "admin" || userHasFeature(s.userId, s.role, "hr.manage_shift_rotations")
}
async function canOverride(s: Sess) {
  return s.role === "admin" || userHasFeature(s.userId, s.role, "hr.override_shift_rotations")
}

/** The date at which "current sequence" is meaningful for a membership. */
function referenceDate(m: MembershipRow): string {
  const today = todayStr()
  if (today < m.start_date) return m.start_date
  if (m.end_date && today > m.end_date) return m.end_date
  return today
}

export async function GET(request: Request) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  await ensureShiftRotationSchema()
  if (!(await canManage(session))) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const url = new URL(request.url)
  const recordId = url.searchParams.get("recordId")
  const meta = url.searchParams.get("meta")

  // --- Form metadata (rotations + employees + departments) ------------------
  if (meta) {
    const [rotations, employees, departments] = await Promise.all([
      listRotations({ state: "running" }),
      listAssignableEmployees(),
      listDepartments(),
    ])
    return NextResponse.json({
      rotations: rotations.map((r) => ({
        rotation_id: r.rotation_id,
        rotation_name: r.rotation_name,
        cycle_type: r.cycle_type,
        cycle_length: r.cycle_length,
        effective_from: r.effective_from,
        effective_until: r.effective_until,
        active_members: r.active_members,
      })),
      employees,
      departments,
      canOverride: await canOverride(session),
    })
  }

  // --- Single membership detail --------------------------------------------
  if (recordId) {
    const membership = await getMembership(recordId)
    if (!membership) return NextResponse.json({ error: "Membership not found." }, { status: 404 })

    const refDate = referenceDate(membership)
    const [state, effective, events] = await Promise.all([
      getEmployeeRotationState(membership.employee_pk, refDate),
      getEffectiveSteps(membership.rotation_pk, refDate),
      getMembershipEvents(membership.rotation_code, recordId),
    ])

    // A 21-day schedule preview anchored at the membership start — this is the
    // exact math the resolver uses, so admins see what will actually apply.
    let preview: { date: string; sequence_no: number; is_weekly_off: boolean; shift_name: string | null }[] = []
    if (effective && effective.steps.length) {
      const from = refDate < membership.start_date ? membership.start_date : refDate
      preview = buildPreview(membership.start_date, effective.cycleType, effective.steps, from, 21)
        .filter((d) => !membership.end_date || d.date <= membership.end_date)
        .map((d) => ({
          date: d.date,
          sequence_no: d.index >= 0 ? d.index + 1 : 0,
          is_weekly_off: Boolean(d.step?.is_weekly_off),
          shift_name: d.step?.is_weekly_off ? null : d.step?.shift_name ?? null,
        }))
    }

    return NextResponse.json({
      membership,
      state,
      pattern: effective ? { cycleType: effective.cycleType, steps: effective.steps } : null,
      preview,
      events,
    })
  }

  // --- List + summary -------------------------------------------------------
  const view = url.searchParams.get("view") || "all"

  if (view === "no-rotation") {
    const [uncovered, summary] = await Promise.all([employeesWithoutRotation(), membershipSummary()])
    return NextResponse.json({ view, uncovered, summary })
  }

  const rows = await listMemberships({
    q: url.searchParams.get("q") || undefined,
    rotation: url.searchParams.get("rotation") || undefined,
    department: url.searchParams.get("department") || undefined,
    status: url.searchParams.get("status") || undefined,
    view,
  })
  const summary = await membershipSummary()
  const today = todayStr()

  // Enrich each row with the CURRENT sequence resolved centrally. Only rows
  // whose window covers today have a live "current" position; others show none.
  const enriched = await Promise.all(
    rows.map(async (m) => {
      const active = m.status === "Active" && m.start_date <= today && (!m.end_date || m.end_date >= today)
      const seq = active ? await getRotationSequenceForEmployee(m.employee_pk, today) : null
      return {
        ...m,
        window:
          m.status !== "Active"
            ? "inactive"
            : m.start_date > today
              ? "upcoming"
              : m.end_date && m.end_date < today
                ? "ended"
                : "current",
        current_sequence_no: seq?.sequenceNo ?? null,
        current_shift_name: seq ? (seq.isWeeklyOff ? "Weekly off" : seq.shiftName) : null,
        current_is_weekly_off: seq?.isWeeklyOff ?? null,
      }
    }),
  )

  return NextResponse.json({ view, memberships: enriched, summary })
}

export async function POST(request: Request) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  await ensureShiftRotationSchema()
  if (!(await canManage(session))) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const body = await request.json().catch(() => ({}))
  const rotationId = String(body.rotation_id || "").trim()
  if (!rotationId) return NextResponse.json({ error: "Choose a rotation to assign employees to." }, { status: 400 })

  const start_date = String(body.start_date || "").slice(0, 10)
  const end_date = body.end_date ? String(body.end_date).slice(0, 10) : null

  // Target set = explicit employees + (optional) everyone eligible in a dept.
  let employeeIds: number[] = Array.isArray(body.employee_ids) ? body.employee_ids.map(Number).filter(Boolean) : []
  if (body.department && typeof body.department === "string") {
    const dept = await employeesInDepartment(body.department, start_date || todayStr())
    employeeIds = [...employeeIds, ...dept.map((e) => e.id)]
  }

  const actor: Actor = { userId: session.userId, name: session.name, email: session.email, role: session.role }
  const override = Boolean(body.is_override) && (await canOverride(session))
  try {
    const result = await addMembers(rotationId, { employeeIds, start_date, end_date }, actor, override)
    if (!result.ok) {
      return NextResponse.json({ error: result.errors[0] || "Could not assign employees", ...result }, { status: 422 })
    }
    return NextResponse.json(result, { status: 201 })
  } catch (error) {
    console.log("[v0] rotation-employees add failed", (error as Error).message)
    return NextResponse.json({ error: "Could not assign employees to the rotation." }, { status: 500 })
  }
}

export async function PATCH(request: Request) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  await ensureShiftRotationSchema()
  if (!(await canManage(session))) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const body = await request.json().catch(() => ({}))
  const recordId = String(body.record_id || "")
  if (!recordId) return NextResponse.json({ error: "record_id is required." }, { status: 400 })
  const actor: Actor = { userId: session.userId, name: session.name, email: session.email, role: session.role }

  if (body.action === "end") {
    const endDate = String(body.end_date || todayStr()).slice(0, 10)
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
