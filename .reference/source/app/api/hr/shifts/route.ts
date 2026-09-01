import { NextRequest, NextResponse } from "next/server"
import { query } from "@/lib/db"
import { getSession } from "@/lib/auth"

const fields = ["shift_id","shift_name","start_time","end_time","break_minutes","overtime_enabled","status","description"] as const

function hours(start: string, end: string, breakMinutes: number) {
  const [sh, sm] = start.split(":").map(Number); const [eh, em] = end.split(":").map(Number)
  let minutes = eh * 60 + em - (sh * 60 + sm); if (minutes <= 0) minutes += 1440
  return Math.max(0, (minutes - breakMinutes) / 60)
}

export async function GET() {
  const session = await getSession(); if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  try { return NextResponse.json({ shifts: await query("SELECT * FROM hr_shifts ORDER BY shift_name ASC") }) }
  catch { return NextResponse.json({ error: "Unable to load shifts" }, { status: 500 }) }
}

export async function POST(request: NextRequest) {
  const session = await getSession(); if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  try {
    const body = await request.json(); const values = fields.map((key) => body[key] ?? null)
    if (!body.shift_id || !body.shift_name || !body.start_time || !body.end_time) return NextResponse.json({ error: "Shift ID, name, start time and end time are required" }, { status: 400 })
    const breakMinutes = Math.max(0, Number(body.break_minutes || 0)); const workingHours = hours(body.start_time, body.end_time, breakMinutes)
    await query("INSERT INTO hr_shifts (shift_id,shift_name,start_time,end_time,break_minutes,working_hours,overtime_enabled,status,description) VALUES (?,?,?,?,?,?,?,?,?)", [values[0],values[1],values[2],values[3],breakMinutes,workingHours,body.overtime_enabled ? 1 : 0,body.status || "Active",values[7]])
    return NextResponse.json({ ok: true }, { status: 201 })
  } catch (error: any) { return NextResponse.json({ error: error?.code === "ER_DUP_ENTRY" ? "Shift ID already exists" : "Unable to create shift" }, { status: 400 }) }
}

export async function PATCH(request: NextRequest) {
  const session = await getSession(); if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  try {
    const body = await request.json(); if (!body.id) return NextResponse.json({ error: "Shift ID is required" }, { status: 400 })
    const breakMinutes = Math.max(0, Number(body.break_minutes || 0)); const workingHours = hours(body.start_time, body.end_time, breakMinutes)
    await query("UPDATE hr_shifts SET shift_name=?,start_time=?,end_time=?,break_minutes=?,working_hours=?,overtime_enabled=?,status=?,description=? WHERE id=?", [body.shift_name,body.start_time,body.end_time,breakMinutes,workingHours,body.overtime_enabled ? 1 : 0,body.status || "Active",body.description || null,body.id])
    return NextResponse.json({ ok: true })
  } catch { return NextResponse.json({ error: "Unable to update shift" }, { status: 400 }) }
}
