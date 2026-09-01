import { NextRequest, NextResponse } from "next/server"
import { query } from "@/lib/db"
import { getSession } from "@/lib/auth"

const fields = ["employee_id","notice_date","last_working_date","exit_type","exit_reason","manager_clearance","hr_clearance","it_clearance","finance_clearance","asset_return","document_return","exit_interview","final_settlement","status","remarks"] as const

export async function GET() {
  const session = await getSession(); if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const rows = await query<any[]>(`SELECT o.*, e.employee_name FROM hr_offboarding o JOIN employees e ON e.id = o.employee_id ORDER BY o.created_at DESC`)
  return NextResponse.json({ offboarding: rows })
}

export async function POST(request: NextRequest) {
  const session = await getSession(); if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const body = await request.json(); if (!body.employee_id) return NextResponse.json({ error: "Employee is required" }, { status: 400 })
  const values = fields.map((field) => body[field] ?? null)
  const id = `OFF-${Date.now().toString(36).toUpperCase()}`
  await query(`INSERT INTO hr_offboarding (offboarding_id, ${fields.join(",")}) VALUES (?, ${fields.map(() => "?").join(",")})`, [id, ...values])
  return NextResponse.json({ offboarding_id: id }, { status: 201 })
}

export async function PATCH(request: NextRequest) {
  const session = await getSession(); if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const body = await request.json(); if (!body.id) return NextResponse.json({ error: "ID is required" }, { status: 400 })
  const updates = fields.filter((field) => Object.prototype.hasOwnProperty.call(body, field))
  if (!updates.length) return NextResponse.json({ error: "No changes provided" }, { status: 400 })
  await query(`UPDATE hr_offboarding SET ${updates.map((field) => `${field} = ?`).join(", ")} WHERE id = ?`, [...updates.map((field) => body[field]), body.id])
  return NextResponse.json({ ok: true })
}
