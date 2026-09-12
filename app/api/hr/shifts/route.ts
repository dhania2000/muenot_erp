import { NextRequest, NextResponse } from "next/server"
import { query } from "@/lib/db"
import { getSession } from "@/lib/auth"
import {
  ensureShiftSchema,
  nextShiftId,
  getAssignmentCounts,
  diffShift,
  logShiftEvent,
} from "@/lib/hr-shifts"
import {
  computeShiftHours,
  validateShiftInput,
  parseDayList,
  serializeDayList,
  weeklyOffsFromWorkingDays,
} from "@/lib/shift-ui"

// Columns a client may write. `shift_id` is intentionally excluded — it is
// always server-generated (SHIFT-0001…) so the master key can never be spoofed.
// `working_hours` is derived from the times/break and never trusted from input.
const boolFields = new Set([
  "is_overnight",
  "late_enabled",
  "early_checkout_enabled",
  "overtime_enabled",
  "overtime_eligible",
])

const numberFields = new Set([
  "break_minutes",
  "grace_minutes",
  "early_grace_minutes",
  "overtime_threshold_minutes",
  "overtime_rounding_minutes",
])

const textFields = ["shift_code", "shift_name", "start_time", "end_time", "status", "description"] as const

/**
 * Build the normalized, writable policy record from a request body. Days are
 * coerced to canonical comma strings, working_hours is derived, and weekly_offs
 * defaults to the complement of the working days when not supplied explicitly.
 */
function buildPolicyRecord(body: Record<string, any>) {
  const record: Record<string, any> = {}

  for (const field of textFields) {
    if (body[field] === undefined) continue
    const value = field === "shift_code" && body[field] ? String(body[field]).trim().toUpperCase() : body[field]
    record[field] = value === "" || value === undefined ? null : value
  }
  for (const field of boolFields) if (body[field] !== undefined) record[field] = body[field] ? 1 : 0
  for (const field of numberFields) {
    if (body[field] === undefined) continue
    const n = Number(body[field])
    record[field] = Number.isFinite(n) && n >= 0 ? Math.round(n) : 0
  }

  // Working days / weekly offs — accept either an array or a comma string.
  const workingDays =
    body.working_days !== undefined
      ? Array.isArray(body.working_days)
        ? parseDayList(body.working_days.join(","))
        : parseDayList(body.working_days)
      : null
  if (workingDays) record.working_days = serializeDayList(workingDays)

  if (body.weekly_offs !== undefined) {
    const offs = Array.isArray(body.weekly_offs) ? parseDayList(body.weekly_offs.join(",")) : parseDayList(body.weekly_offs)
    record.weekly_offs = serializeDayList(offs)
  } else if (workingDays && workingDays.length) {
    record.weekly_offs = serializeDayList(weeklyOffsFromWorkingDays(workingDays))
  }

  for (const field of ["effective_from", "effective_until"] as const) {
    if (body[field] === undefined) continue
    record[field] = body[field] ? String(body[field]).slice(0, 10) : null
  }

  return record
}

/** Effective boolean/number/string view used by the shared validator. */
function validationView(row: Record<string, any>) {
  return {
    shift_name: row.shift_name,
    start_time: row.start_time,
    end_time: row.end_time,
    is_overnight: Boolean(Number(row.is_overnight)),
    break_minutes: Number(row.break_minutes || 0),
    grace_minutes: Number(row.grace_minutes || 0),
    early_grace_minutes: Number(row.early_grace_minutes || 0),
    overtime_enabled: Boolean(Number(row.overtime_enabled)),
    overtime_threshold_minutes: Number(row.overtime_threshold_minutes || 0),
    overtime_rounding_minutes: Number(row.overtime_rounding_minutes || 0),
    effective_from: row.effective_from ?? null,
    effective_until: row.effective_until ?? null,
  }
}

async function nameConflict(name: string, excludeId?: number): Promise<boolean> {
  const rows = await query<any[]>(
    `SELECT id FROM hr_shifts WHERE shift_name = ? ${excludeId ? "AND id <> ?" : ""} LIMIT 1`,
    excludeId ? [name, excludeId] : [name],
  )
  return rows.length > 0
}

async function codeConflict(code: string | null, excludeId?: number): Promise<boolean> {
  if (!code) return false
  const rows = await query<any[]>(
    `SELECT id FROM hr_shifts WHERE shift_code = ? ${excludeId ? "AND id <> ?" : ""} LIMIT 1`,
    excludeId ? [code, excludeId] : [code],
  )
  return rows.length > 0
}

export async function GET() {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  try {
    await ensureShiftSchema()
    const [shifts, counts] = await Promise.all([
      query<any[]>("SELECT * FROM hr_shifts ORDER BY status = 'Active' DESC, shift_name ASC"),
      getAssignmentCounts(),
    ])
    const enriched = shifts.map((s) => {
      const usage = counts[Number(s.id)]
      return {
        ...s,
        active_assignments: usage?.activeAssignments ?? 0,
        total_assignments: usage?.totalAssignments ?? 0,
        assigned_employees: usage?.assignedEmployees ?? 0,
      }
    })
    return NextResponse.json({ shifts: enriched })
  } catch {
    return NextResponse.json({ error: "Unable to load shifts" }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (session.role !== "admin") {
    return NextResponse.json({ error: "You do not have permission to manage shifts" }, { status: 403 })
  }
  try {
    await ensureShiftSchema()
    const body = await request.json()
    const record = buildPolicyRecord(body)

    const invalid = validateShiftInput(validationView(record))
    if (invalid) return NextResponse.json({ error: invalid }, { status: 400 })

    if (await nameConflict(String(record.shift_name).trim())) {
      return NextResponse.json({ error: "A shift with this name already exists" }, { status: 409 })
    }
    if (await codeConflict(record.shift_code ?? null)) {
      return NextResponse.json({ error: `Shift code "${record.shift_code}" is already in use` }, { status: 409 })
    }

    record.working_hours = computeShiftHours(
      record.start_time,
      record.end_time,
      Number(record.break_minutes || 0),
      Boolean(Number(record.is_overnight)),
    )
    record.status = record.status || "Active"
    record.shift_id = await nextShiftId()
    record.created_by = session.userId

    const cols = Object.keys(record)
    const result: any = await query(
      `INSERT INTO hr_shifts (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`,
      cols.map((c) => record[c]),
    )

    await logShiftEvent({
      shiftId: Number(result?.insertId),
      shiftRef: record.shift_id,
      shiftName: record.shift_name,
      type: "created",
      summary: `Created shift ${record.shift_name} (${record.shift_id})`,
      actorId: session.userId,
      actorName: session.name,
    })

    return NextResponse.json({ ok: true, shift_id: record.shift_id }, { status: 201 })
  } catch (error: any) {
    const message =
      error?.code === "ER_DUP_ENTRY" ? "A shift with this code already exists" : "Unable to create shift"
    return NextResponse.json({ error: message }, { status: 400 })
  }
}

export async function PATCH(request: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (session.role !== "admin") {
    return NextResponse.json({ error: "You do not have permission to manage shifts" }, { status: 403 })
  }
  try {
    await ensureShiftSchema()
    const body = await request.json()
    if (!body.id) return NextResponse.json({ error: "Shift ID is required" }, { status: 400 })

    const currentRows = await query<any[]>("SELECT * FROM hr_shifts WHERE id = ? LIMIT 1", [body.id])
    const current = currentRows[0]
    if (!current) return NextResponse.json({ error: "Shift not found" }, { status: 404 })

    const patch = buildPolicyRecord(body)
    if (!Object.keys(patch).length) return NextResponse.json({ error: "No changes supplied" }, { status: 400 })

    // Validate against the full effective row so a partial patch is still checked.
    const merged = { ...current, ...patch }
    const invalid = validateShiftInput(validationView(merged))
    if (invalid) return NextResponse.json({ error: invalid }, { status: 400 })

    if (patch.shift_name !== undefined && (await nameConflict(String(merged.shift_name).trim(), body.id))) {
      return NextResponse.json({ error: "A shift with this name already exists" }, { status: 409 })
    }
    if (patch.shift_code !== undefined && (await codeConflict(patch.shift_code ?? null, body.id))) {
      return NextResponse.json({ error: `Shift code "${patch.shift_code}" is already in use` }, { status: 409 })
    }

    // Recompute derived hours whenever a driver of it changed.
    if (
      patch.start_time !== undefined ||
      patch.end_time !== undefined ||
      patch.break_minutes !== undefined ||
      patch.is_overnight !== undefined
    ) {
      patch.working_hours = computeShiftHours(
        merged.start_time,
        merged.end_time,
        Number(merged.break_minutes || 0),
        Boolean(Number(merged.is_overnight)),
      )
    }
    patch.updated_by = session.userId

    const changes = diffShift(current, patch).filter((c) => c.field !== "updated_by")

    const cols = Object.keys(patch)
    await query(
      `UPDATE hr_shifts SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE id = ?`,
      [...cols.map((c) => patch[c]), body.id],
    )

    if (changes.length) {
      const statusChange = changes.find((c) => c.field === "status")
      const type = statusChange ? (String(statusChange.to) === "Active" ? "activated" : "deactivated") : "updated"
      const summary = statusChange
        ? `Status changed to ${statusChange.to}`
        : `Updated ${changes.map((c) => c.label).join(", ")}`
      await logShiftEvent({
        shiftId: Number(body.id),
        shiftRef: current.shift_id,
        shiftName: merged.shift_name,
        type,
        summary,
        changes,
        reason: body.reason ?? null,
        actorId: session.userId,
        actorName: session.name,
      })
    }

    return NextResponse.json({ ok: true })
  } catch (error: any) {
    const message =
      error?.code === "ER_DUP_ENTRY" ? "A shift with this code already exists" : "Unable to update shift"
    return NextResponse.json({ error: message }, { status: 400 })
  }
}
