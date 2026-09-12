import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { query } from "@/lib/db"
import { userHasFeature } from "@/lib/permissions"
import { ensureShiftRotationSchema, todayStr } from "@/lib/hr-shift-rotations"
import {
  type CycleType,
  type PatternStep,
  buildPreview,
  totalCycleSpan,
  unitLabel,
  validatePattern,
} from "@/lib/rotation-ui"

/**
 * Read-only, domain-specific view of Shift Rotation Sequences.
 *
 * The authoritative Sequence *editor* is the Rotation Builder (effective-dated
 * versions + audit in lib/hr-shift-rotations.ts). This endpoint never mutates —
 * it exposes the sequences that make up each rotation's CURRENT effective
 * version, joined to Shift Master, with cycle maths and validation derived from
 * the single shared engine (lib/rotation-ui.ts) so what HR sees here is exactly
 * what the attendance resolver applies. No arbitrary CRUD, no duplicated formula.
 */

type ShiftRow = {
  shift_id: number | null
  shift_code: string | null
  shift_name: string | null
  start_time: string | null
  end_time: string | null
  is_overnight: number | null
  break_minutes: number | null
  working_hours: number | null
  overtime_enabled: number | null
  shift_status: string | null
}

type SequenceRow = ShiftRow & {
  id: number
  sequence_id: string
  sequence_no: number
  unit_span: number
  duration_days: number
  is_weekly_off: number
  label: string | null
}

async function canView(session: { userId: number; role: "admin" | "employee" }): Promise<boolean> {
  if (session.role === "admin") return true
  return (
    (await userHasFeature(session.userId, session.role, "hr.view_rotation_sequences")) ||
    (await userHasFeature(session.userId, session.role, "hr.view_shift_rotations")) ||
    (await userHasFeature(session.userId, session.role, "hr.manage_shift_rotations"))
  )
}

/** Load the sequence rows (with Shift Master join) for a specific version. */
async function loadVersionSequences(versionPk: number): Promise<SequenceRow[]> {
  return query<SequenceRow[]>(
    `SELECT s.id, s.sequence_id, s.sequence_no, s.unit_span, s.duration_days, s.is_weekly_off, s.label,
            sh.id AS shift_id, sh.shift_code, sh.shift_name, sh.start_time, sh.end_time,
            sh.is_overnight, sh.break_minutes, sh.working_hours, sh.overtime_enabled, sh.status AS shift_status
     FROM hr_shift_rotation_sequences s
     LEFT JOIN hr_shifts sh ON sh.id = s.shift_id
     WHERE s.version_id = ?
     ORDER BY s.sequence_no ASC`,
    [versionPk],
  )
}

/** The version effective on `onDate` (latest whose effective_from <= date), else the earliest. */
async function pickEffectiveVersion(rotationPk: number, onDate: string) {
  const eff = await query<any[]>(
    `SELECT id, version_id, version_no, effective_from, cycle_type, cycle_length
     FROM hr_shift_rotation_versions WHERE rotation_id = ? AND effective_from <= ?
     ORDER BY effective_from DESC, version_no DESC LIMIT 1`,
    [rotationPk, onDate],
  )
  if (eff[0]) return eff[0]
  const earliest = await query<any[]>(
    `SELECT id, version_id, version_no, effective_from, cycle_type, cycle_length
     FROM hr_shift_rotation_versions WHERE rotation_id = ? ORDER BY version_no ASC LIMIT 1`,
    [rotationPk],
  )
  return earliest[0] || null
}

function toSteps(rows: SequenceRow[]): PatternStep[] {
  return rows.map((r) => ({
    shift_id: Number(r.shift_id || 0),
    unit_span: Math.max(1, Number(r.unit_span || r.duration_days || 1)),
    is_weekly_off: Boolean(Number(r.is_weekly_off)),
    shift_name: r.shift_name,
    label: r.label,
  }))
}

/** Derive advisory + blocking validation for one version's sequence set. */
function deriveWarnings(cycleType: CycleType, cycleLength: number, rows: SequenceRow[]): string[] {
  const warnings: string[] = []
  const steps = toSteps(rows)

  const patternError = validatePattern(cycleType, cycleLength, steps)
  if (patternError) warnings.push(patternError)

  for (const r of rows) {
    if (Number(r.is_weekly_off)) continue
    if (!r.shift_id) warnings.push(`Sequence ${r.sequence_no} references a missing or deleted shift.`)
    else if ((r.shift_status || "").toLowerCase() === "inactive") {
      warnings.push(`Sequence ${r.sequence_no} references an inactive shift (${r.shift_name || "—"}).`)
    }
  }

  const seen = new Set<number>()
  for (const r of rows) {
    if (seen.has(r.sequence_no)) warnings.push(`Duplicate sequence number ${r.sequence_no}.`)
    seen.add(r.sequence_no)
  }
  return warnings
}

export async function GET(request: Request) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  await ensureShiftRotationSchema()
  if (!(await canView(session))) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const sp = new URL(request.url).searchParams
  const today = todayStr()

  // ---- Detail: a single sequence + Shift Master timing + upcoming occurrences.
  const sequenceId = sp.get("sequenceId")
  if (sequenceId) {
    const seq = await query<any[]>(
      `SELECT s.id, s.sequence_id, s.sequence_no, s.unit_span, s.duration_days, s.is_weekly_off, s.label,
              s.version_id, s.rotation_id AS rotation_pk,
              sh.id AS shift_id, sh.shift_code, sh.shift_name, sh.start_time, sh.end_time,
              sh.is_overnight, sh.break_minutes, sh.working_hours, sh.overtime_enabled, sh.status AS shift_status,
              r.rotation_id, r.rotation_name, r.effective_from, r.time_zone,
              v.version_no, v.cycle_type, v.cycle_length, v.effective_from AS version_from
       FROM hr_shift_rotation_sequences s
       LEFT JOIN hr_shifts sh ON sh.id = s.shift_id
       JOIN hr_shift_rotations r ON r.id = s.rotation_id
       LEFT JOIN hr_shift_rotation_versions v ON v.id = s.version_id
       WHERE s.sequence_id = ? LIMIT 1`,
      [sequenceId],
    )
    if (!seq[0]) return NextResponse.json({ error: "Sequence not found." }, { status: 404 })
    const d = seq[0]

    const versionRows = d.version_id ? await loadVersionSequences(Number(d.version_id)) : []
    const steps = toSteps(versionRows)
    const cycleType = (d.cycle_type as CycleType) || "Weeks"
    const totalSpanDays = totalCycleSpan(cycleType, steps)

    // Upcoming occurrence ranges of THIS sequence, from the shared engine anchored
    // at the version's effective date (falls back to the rotation's effective_from).
    const anchor = String(d.version_from || d.effective_from || today).slice(0, 10)
    const start = today > anchor ? today : anchor
    const targetIndex = versionRows.findIndex((r) => r.sequence_id === sequenceId)
    const occurrences: { from: string; to: string }[] = []
    if (targetIndex >= 0 && steps.length) {
      const preview = buildPreview(anchor, cycleType, steps, start, 366)
      let open: { from: string; to: string } | null = null
      for (const day of preview) {
        if (day.index === targetIndex) {
          if (!open) open = { from: day.date, to: day.date }
          else open.to = day.date
        } else if (open) {
          occurrences.push(open)
          open = null
        }
      }
      if (open) occurrences.push(open)
    }

    return NextResponse.json({
      sequence: {
        sequence_id: d.sequence_id,
        sequence_no: d.sequence_no,
        unit_span: Number(d.unit_span || d.duration_days || 1),
        duration_days: Number(d.duration_days || 0),
        is_weekly_off: Boolean(Number(d.is_weekly_off)),
        label: d.label,
        rotation_id: d.rotation_id,
        rotation_name: d.rotation_name,
        version_no: d.version_no,
        cycle_type: cycleType,
        cycle_length: Number(d.cycle_length || 1),
        time_zone: d.time_zone,
        position_in_cycle: targetIndex >= 0 ? targetIndex + 1 : d.sequence_no,
        total_steps: versionRows.length,
        total_cycle_days: totalSpanDays,
        shift: {
          shift_id: d.shift_id,
          shift_code: d.shift_code,
          shift_name: d.shift_name,
          start_time: d.start_time,
          end_time: d.end_time,
          is_overnight: Boolean(Number(d.is_overnight)),
          break_minutes: d.break_minutes,
          working_hours: d.working_hours,
          overtime_enabled: Boolean(Number(d.overtime_enabled)),
          status: d.shift_status,
        },
      },
      occurrences: occurrences.slice(0, 8),
    })
  }

  // ---- List: sequences grouped by rotation (current effective version).
  const q = (sp.get("q") || "").trim().toLowerCase()
  const rotationFilter = sp.get("rotation") || "all"
  const cycleFilter = sp.get("cycleType") || "all"
  const stateFilter = sp.get("state") || "all" // all | active

  const rotWhere: string[] = []
  const rotArgs: any[] = []
  if (cycleFilter !== "all") { rotWhere.push("r.cycle_type = ?"); rotArgs.push(cycleFilter) }
  if (stateFilter === "active") rotWhere.push("r.status = 'Active'")
  if (rotationFilter !== "all") { rotWhere.push("r.rotation_id = ?"); rotArgs.push(rotationFilter) }
  const rotWhereSql = rotWhere.length ? `WHERE ${rotWhere.join(" AND ")}` : ""

  const rotations = await query<any[]>(
    `SELECT r.id, r.rotation_id, r.rotation_name, r.status, r.cycle_type, r.cycle_length,
            r.effective_from, r.effective_until, r.current_version_no,
            (SELECT COUNT(*) FROM hr_shift_rotation_employees re
              WHERE re.rotation_id = r.id AND re.status = 'Active'
                AND re.start_date <= ? AND (re.end_date IS NULL OR re.end_date >= ?)) AS active_members
     FROM hr_shift_rotations r ${rotWhereSql}
     ORDER BY (r.status = 'Active') DESC, r.rotation_name ASC, r.id ASC`,
    [today, today, ...rotArgs],
  )

  const groups: any[] = []
  const flat: any[] = []

  for (const r of rotations) {
    const version = await pickEffectiveVersion(Number(r.id), today)
    if (!version) {
      groups.push({
        rotation_id: r.rotation_id,
        rotation_name: r.rotation_name,
        status: r.status,
        cycle_type: r.cycle_type,
        cycle_length: r.cycle_length,
        effective_from: r.effective_from ? String(r.effective_from).slice(0, 10) : null,
        active_members: Number(r.active_members || 0),
        version_no: null,
        total_cycle_days: 0,
        declared_cycle_days: r.cycle_type === "Weeks" ? Number(r.cycle_length) * 7 : Number(r.cycle_length),
        consistent: false,
        shifts_used: [],
        warnings: ["Rotation must contain at least one valid sequence."],
        sequences: [],
      })
      continue
    }

    const rows = await loadVersionSequences(Number(version.id))
    const cycleType = (version.cycle_type as CycleType) || (r.cycle_type as CycleType)
    const cycleLength = Number(version.cycle_length || r.cycle_length || 1)
    const steps = toSteps(rows)
    const totalSpanDays = totalCycleSpan(cycleType, steps)
    const declared = cycleType === "Weeks" ? cycleLength * 7 : cycleLength
    const warnings = deriveWarnings(cycleType, cycleLength, rows)

    const shiftsUsed = Array.from(
      new Map(
        rows.filter((x) => !Number(x.is_weekly_off) && x.shift_id).map((x) => [x.shift_id, x.shift_name]),
      ).values(),
    ).filter(Boolean)

    const sequences = rows.map((s) => {
      const spanUnits = Math.max(1, Number(s.unit_span || s.duration_days || 1))
      const record = {
        sequence_id: s.sequence_id,
        sequence_no: s.sequence_no,
        order: s.sequence_no,
        unit_span: spanUnits,
        cycle_type: cycleType,
        span_label: `${spanUnits} ${unitLabel(cycleType, spanUnits)}`,
        is_weekly_off: Boolean(Number(s.is_weekly_off)),
        label: s.label,
        shift_id: s.shift_id,
        shift_code: s.shift_code,
        shift_name: Number(s.is_weekly_off) ? "Weekly Off" : s.shift_name || null,
        start_time: s.start_time,
        end_time: s.end_time,
        is_overnight: Boolean(Number(s.is_overnight)),
        shift_status: s.shift_status,
        invalid_shift: !Number(s.is_weekly_off) && !s.shift_id,
        inactive_shift: !Number(s.is_weekly_off) && (s.shift_status || "").toLowerCase() === "inactive",
      }
      flat.push({
        sequence_id: s.sequence_id,
        rotation_id: r.rotation_id,
        rotation_name: r.rotation_name,
        sequence_no: s.sequence_no,
        shift_name: record.shift_name,
        shift_code: s.shift_code,
        span: record.span_label,
        cycle_type: cycleType,
        cycle_length: cycleLength,
        status: r.status,
      })
      return record
    })

    const group = {
      rotation_id: r.rotation_id,
      rotation_name: r.rotation_name,
      status: r.status,
      cycle_type: cycleType,
      cycle_length: cycleLength,
      effective_from: r.effective_from ? String(r.effective_from).slice(0, 10) : null,
      active_members: Number(r.active_members || 0),
      version_no: version.version_no,
      total_cycle_days: totalSpanDays,
      declared_cycle_days: declared,
      consistent: totalSpanDays === declared,
      shifts_used: shiftsUsed,
      warnings,
      sequences,
    }

    // Free-text search across rotation + shift fields.
    if (q) {
      const hay = [
        r.rotation_id, r.rotation_name,
        ...sequences.map((s) => `${s.shift_name || ""} ${s.shift_code || ""} ${s.sequence_id}`),
      ].join(" ").toLowerCase()
      if (!hay.includes(q)) continue
    }
    groups.push(group)
  }

  const rotationOptions = rotations.map((r) => ({ rotation_id: r.rotation_id, rotation_name: r.rotation_name }))
  return NextResponse.json({ groups, flat, rotationOptions })
}
