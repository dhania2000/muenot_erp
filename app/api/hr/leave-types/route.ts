import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { getSession } from "@/lib/auth"
import { ensureLeaveSchema } from "@/lib/hr-leave"

const fields = [
  "leave_type_id", "leave_type", "annual_quota", "carry_forward", "max_consecutive_days",
  "requires_document", "paid", "status", "description",
  // Extended policy fields.
  "allow_half_day", "min_days_per_request", "max_days_per_request", "advance_notice_days",
  "allow_backdated", "backdated_limit_days", "applicable_gender", "applicable_employment_type",
  "count_weekends", "count_holidays", "max_requests_per_year",
] as const

const boolFields = new Set(["requires_document", "paid", "allow_half_day", "allow_backdated", "count_weekends", "count_holidays"])

function normalize(field: string, value: any) {
  if (boolFields.has(field)) return value ? 1 : 0
  return value ?? null
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
  await ensureLeaveSchema()
  const body = await request.json()
  if (!body.leave_type_id || !body.leave_type) return NextResponse.json({ error: "Leave Type ID and Leave Type are required" }, { status: 400 })
  const values = fields.map((field) => normalize(field, body[field]))
  await query("INSERT INTO hr_leave_types (" + fields.join(",") + ") VALUES (" + fields.map(() => "?").join(",") + ")", values)
  return NextResponse.json({ ok: true }, { status: 201 })
}

export async function PATCH(request: Request) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  await ensureLeaveSchema()
  const body = await request.json()
  if (!body.id) return NextResponse.json({ error: "ID is required" }, { status: 400 })
  const allowed = fields.filter((field) => body[field] !== undefined)
  if (!allowed.length) return NextResponse.json({ error: "No changes supplied" }, { status: 400 })
  const values = allowed.map((field) => normalize(field, body[field]))
  await query("UPDATE hr_leave_types SET " + allowed.map((field) => `${field} = ?`).join(", ") + " WHERE id = ?", [...values, body.id])
  return NextResponse.json({ ok: true })
}
