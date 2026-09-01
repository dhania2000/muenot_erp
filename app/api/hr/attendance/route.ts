import { NextRequest, NextResponse } from "next/server"
import { query } from "@/lib/db"
import { getSession } from "@/lib/auth"

const fields = ["attendance_id","employee_id","employee_name","work_date","clock_in","clock_out","break_minutes","status","late_minutes","early_leaving_minutes","overtime_hours","location","latitude","longitude","source","regularisation_required","remarks"] as const

function hours(clockIn: string | null, clockOut: string | null, breakMinutes: number) {
  if (!clockIn || !clockOut) return 0
  const value = (new Date(clockOut).getTime() - new Date(clockIn).getTime()) / 3600000 - breakMinutes / 60
  return Math.max(0, Number(value.toFixed(2)))
}

export async function GET(request: NextRequest) {
  try {
    const session = await getSession(); if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    const rows = await query<any[]>("SELECT * FROM hr_attendance ORDER BY work_date DESC, id DESC")
    return NextResponse.json({ attendance: rows })
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to load attendance" }, { status: 500 }) }
}

export async function POST(request: NextRequest) {
  try {
    const session = await getSession(); if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    const body = await request.json()
    const values = fields.map((field) => body[field] ?? null)
    values[7] = body.status || "Present"; values[14] = body.source || "Manual"; values[15] = body.regularisation_required ? 1 : 0
    values[8] = Number(body.late_minutes || 0); values[9] = Number(body.early_leaving_minutes || 0); values[10] = Number(body.overtime_hours || 0)
    const breakMinutes = Number(body.break_minutes || 0)
    const workingHours = hours(body.clock_in, body.clock_out, breakMinutes)
    const sql = `INSERT INTO hr_attendance (${fields.join(",")}, working_hours) VALUES (${fields.map(() => "?").join(",")}, ?)`
    await query(sql, [...values, workingHours])
    return NextResponse.json({ ok: true }, { status: 201 })
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to save attendance" }, { status: 500 }) }
}
