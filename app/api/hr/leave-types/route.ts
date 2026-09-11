import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { getSession } from "@/lib/auth"
import {
  ensureLeaveSchema,
  getLeaveTypeByBusinessId,
  recordLeaveTypeAudit,
  type LeaveType,
} from "@/lib/hr-leave"
import { nextRecordId } from "@/lib/record-ids"

// Columns a client may write. `leave_type_id` is intentionally excluded — it is
// always server-generated (LT-0001…) so the master key can never be spoofed.
const fields = [
  "leave_code", "leave_type", "annual_quota", "carry_forward", "max_consecutive_days",
  "requires_document", "paid", "status", "description",
  "allow_half_day", "min_days_per_request", "max_days_per_request", "advance_notice_days",
  "allow_backdated", "backdated_limit_days", "applicable_gender", "applicable_employment_type",
  "count_weekends", "count_holidays", "max_requests_per_year",
  "accrual_method", "prorate_on_join", "allow_negative", "low_balance_threshold",
  "effective_from", "effective_until",
] as const

const boolFields = new Set([
  "requires_document", "paid", "allow_half_day", "allow_backdated", "count_weekends", "count_holidays",
  "prorate_on_join", "allow_negative",
])

const numberFields = new Set([
  "annual_quota", "carry_forward", "max_consecutive_days", "min_days_per_request", "max_days_per_request",
  "advance_notice_days", "backdated_limit_days", "max_requests_per_year", "low_balance_threshold",
])

const FIELD_LABELS: Record<string, string> = {
  leave_code: "Leave Code",
  leave_type: "Leave Type",
  annual_quota: "Annual Quota",
  carry_forward: "Carry Forward",
  max_consecutive_days: "Max Consecutive Days",
  requires_document: "Requires Document",
  paid: "Paid",
  status: "Status",
  description: "Description",
  allow_half_day: "Allow Half Day",
  min_days_per_request: "Min Days / Request",
  max_days_per_request: "Max Days / Request",
  advance_notice_days: "Advance Notice",
  allow_backdated: "Allow Backdated",
  backdated_limit_days: "Backdated Limit",
  applicable_gender: "Applicable Gender",
  applicable_employment_type: "Employment Type",
  count_weekends: "Count Weekends",
  count_holidays: "Count Holidays",
  max_requests_per_year: "Max Requests / Year",
  accrual_method: "Accrual Method",
  prorate_on_join: "Prorate On Join",
  allow_negative: "Allow Negative",
  low_balance_threshold: "Low Balance Threshold",
  effective_from: "Effective From",
  effective_until: "Effective Until",
}

function normalize(field: string, value: any) {
  if (boolFields.has(field)) return value ? 1 : 0
  if (numberFields.has(field)) {
    if (value === "" || value === null || value === undefined) return 0
    const n = Number(value)
    return Number.isFinite(n) ? n : 0
  }
  if (value === "" || value === undefined) return null
  return value ?? null
}

/**
 * Cross-field policy validation shared by create and update. `existing` is the
 * merged effective row (current values overlaid with the incoming patch), so a
 * partial PATCH is still validated against the full resulting policy.
 */
function validatePolicy(row: Record<string, any>): string[] {
  const errors: string[] = []
  const name = String(row.leave_type ?? "").trim()
  if (!name) errors.push("Leave Type name is required")

  const min = Number(row.min_days_per_request ?? 0)
  const max = Number(row.max_days_per_request ?? 0)
  if (min < 0) errors.push("Minimum days per request cannot be negative")
  if (max > 0 && min > 0 && min > max) errors.push("Minimum days per request cannot exceed the maximum")

  const maxConsecutive = Number(row.max_consecutive_days ?? 0)
  if (maxConsecutive > 0 && max > 0 && max > maxConsecutive) {
    errors.push("Max days per request cannot exceed the max consecutive days")
  }

  const quota = Number(row.annual_quota ?? 0)
  const carry = Number(row.carry_forward ?? 0)
  if (quota < 0) errors.push("Annual quota cannot be negative")
  if (carry < 0) errors.push("Carry forward cannot be negative")
  if (quota > 0 && carry > quota) errors.push("Carry forward cannot exceed the annual quota")

  if (row.allow_half_day && min > 0 && min < 0.5) {
    errors.push("Minimum days per request must be at least 0.5 when half-days are allowed")
  }

  if (row.effective_from && row.effective_until && row.effective_from > row.effective_until) {
    errors.push("Effective From date must be on or before Effective Until")
  }

  const accrual = String(row.accrual_method ?? "Annual")
  if (!["Annual", "Monthly", "Quarterly"].includes(accrual)) {
    errors.push("Accrual method must be Annual, Monthly, or Quarterly")
  }

  return errors
}

async function codeConflict(code: string | null, excludeId?: number): Promise<boolean> {
  if (!code) return false
  const rows = await query<any[]>(
    `SELECT id FROM hr_leave_types WHERE leave_code = ? ${excludeId ? "AND id <> ?" : ""} LIMIT 1`,
    excludeId ? [code, excludeId] : [code],
  )
  return rows.length > 0
}

async function nameConflict(name: string, excludeId?: number): Promise<boolean> {
  const rows = await query<any[]>(
    `SELECT id FROM hr_leave_types WHERE leave_type = ? ${excludeId ? "AND id <> ?" : ""} LIMIT 1`,
    excludeId ? [name, excludeId] : [name],
  )
  return rows.length > 0
}

export async function GET() {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  await ensureLeaveSchema()
  const rows = await query<any[]>("SELECT * FROM hr_leave_types ORDER BY status = 'Active' DESC, leave_type ASC")
  return NextResponse.json({ leaveTypes: rows })
}

export async function POST(request: Request) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (session.role !== "admin") {
    return NextResponse.json({ error: "You do not have permission to manage leave types" }, { status: 403 })
  }
  await ensureLeaveSchema()
  const body = await request.json()

  const code = body.leave_code ? String(body.leave_code).trim().toUpperCase() : null
  const merged = { ...body, leave_code: code }

  const errors = validatePolicy(merged)
  if (errors.length) return NextResponse.json({ error: errors[0], errors }, { status: 400 })

  if (await nameConflict(String(body.leave_type).trim())) {
    return NextResponse.json({ error: "A leave type with this name already exists" }, { status: 409 })
  }
  if (await codeConflict(code)) {
    return NextResponse.json({ error: `Leave code "${code}" is already in use` }, { status: 409 })
  }

  const leaveTypeId = await nextRecordId("LT")
  const insertFields = ["leave_type_id", ...fields] as const
  const values = [
    leaveTypeId,
    ...fields.map((field) => normalize(field, field === "leave_code" ? code : merged[field])),
  ]
  await query(
    "INSERT INTO hr_leave_types (" + insertFields.join(",") + ") VALUES (" + insertFields.map(() => "?").join(",") + ")",
    values,
  )

  await recordLeaveTypeAudit(
    leaveTypeId,
    [{ action: "created", newValue: `${body.leave_type}${code ? ` (${code})` : ""}` }],
    { id: session.userId, name: session.name },
  )

  return NextResponse.json({ ok: true, leave_type_id: leaveTypeId }, { status: 201 })
}

export async function PATCH(request: Request) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (session.role !== "admin") {
    return NextResponse.json({ error: "You do not have permission to manage leave types" }, { status: 403 })
  }
  await ensureLeaveSchema()
  const body = await request.json()
  if (!body.id) return NextResponse.json({ error: "ID is required" }, { status: 400 })

  const currentRows = await query<any[]>("SELECT * FROM hr_leave_types WHERE id = ? LIMIT 1", [body.id])
  const current = currentRows[0]
  if (!current) return NextResponse.json({ error: "Leave type not found" }, { status: 404 })

  const allowed = fields.filter((field) => body[field] !== undefined)
  if (!allowed.length) return NextResponse.json({ error: "No changes supplied" }, { status: 400 })

  // Build the effective post-update row for validation.
  const patch: Record<string, any> = {}
  for (const field of allowed) {
    patch[field] = field === "leave_code" && body[field] ? String(body[field]).trim().toUpperCase() : body[field]
  }
  const merged = { ...current, ...patch }

  const errors = validatePolicy(merged)
  if (errors.length) return NextResponse.json({ error: errors[0], errors }, { status: 400 })

  if (patch.leave_type !== undefined && (await nameConflict(String(merged.leave_type).trim(), body.id))) {
    return NextResponse.json({ error: "A leave type with this name already exists" }, { status: 409 })
  }
  const newCode = merged.leave_code ? String(merged.leave_code).trim().toUpperCase() : null
  if (patch.leave_code !== undefined && (await codeConflict(newCode, body.id))) {
    return NextResponse.json({ error: `Leave code "${newCode}" is already in use` }, { status: 409 })
  }

  const values = allowed.map((field) =>
    normalize(field, field === "leave_code" ? newCode : patch[field]),
  )
  await query(
    "UPDATE hr_leave_types SET " + allowed.map((field) => `${field} = ?`).join(", ") + " WHERE id = ?",
    [...values, body.id],
  )

  // Diff for the audit trail.
  const auditEntries = allowed
    .map((field) => {
      const before = current[field]
      const after = normalize(field, field === "leave_code" ? newCode : patch[field])
      if (String(before ?? "") === String(after ?? "")) return null
      return {
        action: field === "status" ? (after === "Active" ? "activated" : "deactivated") : "updated",
        field: FIELD_LABELS[field] ?? field,
        oldValue: before,
        newValue: after,
        reason: body.reason ?? null,
      }
    })
    .filter(Boolean) as Parameters<typeof recordLeaveTypeAudit>[1]

  await recordLeaveTypeAudit(current.leave_type_id, auditEntries, { id: session.userId, name: session.name })

  return NextResponse.json({ ok: true })
}

// Intentionally no DELETE handler: leave types are never hard-deleted because
// balances and historical requests reference them. Deactivate via PATCH status.
export type { LeaveType }
export { getLeaveTypeByBusinessId }
