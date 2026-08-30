import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { requireFeature } from "@/lib/api-auth"

export async function GET() {
  const session = await requireFeature("sales.view_meetings")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const meetings = await query(
    `SELECT m.*, u.name AS added_by_name
     FROM sales_meetings m
     LEFT JOIN users u ON u.id = m.added_by
     ORDER BY m.meeting_date DESC, m.meeting_time DESC`,
  )
  return NextResponse.json({ meetings })
}

export async function POST(request: Request) {
  const session = await requireFeature("sales.manage_meetings")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const body = await request.json()
  if (!body.company_name || !body.meeting_date) {
    return NextResponse.json({ error: "Company name and date are required" }, { status: 400 })
  }

  const [{ next }] = await query<{ next: number }[]>(
    "SELECT COALESCE(MAX(CAST(SUBSTRING(meeting_code, 4) AS UNSIGNED)), 0) + 1 AS next FROM sales_meetings",
  )
  const meetingCode = `MM-${String(next).padStart(3, "0")}`

  const result = await query<any>(
    `INSERT INTO sales_meetings
     (meeting_code, meeting_date, meeting_time, company_name, contact_person, meeting_type,
      agenda, outcome_notes, next_steps, added_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      meetingCode,
      body.meeting_date,
      body.meeting_time || null,
      body.company_name,
      body.contact_person || null,
      body.meeting_type || "Discovery",
      body.agenda || null,
      body.outcome_notes || null,
      body.next_steps || null,
      session.userId,
    ],
  )

  return NextResponse.json({ id: result.insertId, meeting_code: meetingCode })
}
