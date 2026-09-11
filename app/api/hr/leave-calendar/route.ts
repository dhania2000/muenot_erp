import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { getSession } from "@/lib/auth"
import { userHasFeature } from "@/lib/permissions"
import { ensureLeaveSchema, getEmployeeByEmail } from "@/lib/hr-leave"

/**
 * Calendar feed: approved + in-flight leave overlapping a month, plus holidays,
 * so the UI can render a team leave calendar.
 */
export async function GET(request: Request) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  await ensureLeaveSchema()

  const canManage = session.role === "admin" || (await userHasFeature(session.userId, session.role, "hr.view_leave_requests"))
  const self = await getEmployeeByEmail(session.email)

  const sp = new URL(request.url).searchParams
  const now = new Date()
  const month = Number(sp.get("month")) || now.getMonth() + 1
  const year = Number(sp.get("year")) || now.getFullYear()
  const start = `${year}-${String(month).padStart(2, "0")}-01`
  const endDate = new Date(year, month, 0)
  const end = `${year}-${String(month).padStart(2, "0")}-${String(endDate.getDate()).padStart(2, "0")}`

  const where: string[] = [
    "r.from_date <= ?",
    "r.to_date >= ?",
    "r.status IN ('Pending','Manager Approved','HR Approved')",
  ]
  const args: any[] = [end, start]
  if (!canManage && self) {
    where.push("r.employee_id = ?")
    args.push(self.id)
  }

  const requests = await query<any[]>(
    `SELECT r.request_id, r.employee_name, r.employee_id, r.from_date, r.to_date, r.status,
       r.is_half_day, e.department, lt.leave_type
     FROM hr_leave_requests r
     LEFT JOIN hr_employees e ON e.id = r.employee_id
     LEFT JOIN hr_leave_types lt ON lt.leave_type_id = r.leave_type_id OR CAST(lt.id AS CHAR) = r.leave_type_id
     WHERE ${where.join(" AND ")}
     ORDER BY r.from_date ASC`,
    args,
  )

  let holidays: any[] = []
  try {
    holidays = await query<any[]>(
      `SELECT holiday_date, holiday_name FROM hr_holidays
       WHERE holiday_date BETWEEN ? AND ? AND (status = 'Active' OR status IS NULL)`,
      [start, end],
    )
  } catch {
    holidays = []
  }

  return NextResponse.json({
    month,
    year,
    requests: requests.map((r) => ({
      ...r,
      from_date: String(r.from_date).slice(0, 10),
      to_date: String(r.to_date).slice(0, 10),
    })),
    holidays: holidays.map((h) => ({
      date: String(h.holiday_date).slice(0, 10),
      name: h.holiday_name,
    })),
  })
}
