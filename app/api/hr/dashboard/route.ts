import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { requireFeature } from "@/lib/api-auth"

// Any individual metric group is wrapped so a single missing column / table
// can never blank out the entire dashboard.
async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn()
  } catch {
    return fallback
  }
}

const num = (v: unknown) => Number(v ?? 0)

export async function GET() {
  const session = await requireFeature("hr.view_dashboard")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  // Headcount KPIs from the employee master.
  const headcount = await safe(async () => {
    const [row] = (await query(
      `SELECT
         COUNT(*) AS total,
         SUM(employment_status = 'Active') AS active,
         SUM(employment_status = 'Probation') AS probation,
         SUM(onboarding_status IS NOT NULL AND onboarding_status NOT IN ('Completed','Complete','Done')) AS onboarding,
         SUM(MONTH(joining_date) = MONTH(CURDATE()) AND YEAR(joining_date) = YEAR(CURDATE())) AS joined_this_month
       FROM hr_employees`,
    )) as any[]
    return row ?? {}
  }, {} as any)

  // Today's attendance snapshot.
  const attToday = await safe(async () => {
    const [row] = (await query(
      `SELECT
         SUM(status = 'Present') AS present,
         SUM(status = 'Absent') AS absent,
         SUM(status IN ('Leave','On Leave','Half Day')) AS leave,
         SUM(late_minutes > 0) AS late,
         COUNT(*) AS marked
       FROM hr_attendance WHERE work_date = CURDATE()`,
    )) as any[]
    return row ?? {}
  }, {} as any)

  const onLeaveToday = await safe(async () => {
    const [row] = (await query(
      `SELECT COUNT(*) AS c FROM hr_leave_requests
        WHERE status LIKE '%Approved%' AND CURDATE() BETWEEN from_date AND to_date`,
    )) as any[]
    return num(row?.c)
  }, 0)

  const leave = await safe(async () => {
    const [row] = (await query(
      `SELECT
         COUNT(*) AS total,
         SUM(status NOT LIKE '%Rejected%' AND status <> 'HR Approved') AS pending
       FROM hr_leave_requests`,
    )) as any[]
    return row ?? {}
  }, {} as any)

  const tickets = await safe(async () => {
    const [row] = (await query(
      `SELECT
         COUNT(*) AS total,
         SUM(status IN ('Open','In Progress','Waiting')) AS open,
         SUM(status NOT IN ('Resolved','Closed') AND sla_due_date IS NOT NULL AND sla_due_date < NOW()) AS sla_breached
       FROM hr_support_tickets`,
    )) as any[]
    return row ?? {}
  }, {} as any)

  // Breakdowns for charts.
  const byDepartment = await safe(
    () =>
      query(
        `SELECT COALESCE(NULLIF(department,''),'Unassigned') AS department, COUNT(*) AS count
         FROM hr_employees GROUP BY department ORDER BY count DESC LIMIT 8`,
      ),
    [] as any[],
  )

  const byType = await safe(
    () =>
      query(
        `SELECT COALESCE(NULLIF(employment_type,''),'Other') AS type, COUNT(*) AS count
         FROM hr_employees GROUP BY employment_type ORDER BY count DESC`,
      ),
    [] as any[],
  )

  const leaveByStatus = await safe(
    () =>
      query(
        `SELECT COALESCE(NULLIF(status,''),'Pending') AS status, COUNT(*) AS count
         FROM hr_leave_requests GROUP BY status ORDER BY count DESC`,
      ),
    [] as any[],
  )

  const ticketsByPriority = await safe(
    () =>
      query(
        `SELECT COALESCE(NULLIF(priority,''),'Medium') AS priority, COUNT(*) AS count
         FROM hr_support_tickets GROUP BY priority`,
      ),
    [] as any[],
  )

  const attendanceTrend = await safe(
    () =>
      query(
        `SELECT work_date,
                SUM(status = 'Present') AS present,
                SUM(status = 'Absent') AS absent
         FROM hr_attendance
         WHERE work_date >= DATE_SUB(CURDATE(), INTERVAL 6 DAY)
         GROUP BY work_date ORDER BY work_date`,
      ),
    [] as any[],
  )

  const recentJoiners = await safe(
    () =>
      query(
        `SELECT employee_id, employee_name, department, designation, joining_date
         FROM hr_employees WHERE joining_date IS NOT NULL
         ORDER BY joining_date DESC LIMIT 6`,
      ),
    [] as any[],
  )

  const pendingLeaves = await safe(
    () =>
      query(
        `SELECT request_id, employee_name, from_date, to_date, days, status
         FROM hr_leave_requests
         WHERE status NOT LIKE '%Rejected%' AND status <> 'HR Approved'
         ORDER BY requested_at DESC LIMIT 6`,
      ),
    [] as any[],
  )

  return NextResponse.json({
    kpis: {
      totalEmployees: num(headcount.total),
      activeEmployees: num(headcount.active),
      probation: num(headcount.probation),
      onboarding: num(headcount.onboarding),
      joinedThisMonth: num(headcount.joined_this_month),
      presentToday: num(attToday.present),
      absentToday: num(attToday.absent),
      lateToday: num(attToday.late),
      markedToday: num(attToday.marked),
      onLeaveToday,
      pendingLeaves: num(leave.pending),
      totalLeaves: num(leave.total),
      openTickets: num(tickets.open),
      slaBreached: num(tickets.sla_breached),
    },
    byDepartment: (byDepartment as any[]).map((r) => ({ department: r.department, count: num(r.count) })),
    byType: (byType as any[]).map((r) => ({ type: r.type, count: num(r.count) })),
    leaveByStatus: (leaveByStatus as any[]).map((r) => ({ status: r.status, count: num(r.count) })),
    ticketsByPriority: (ticketsByPriority as any[]).map((r) => ({ priority: r.priority, count: num(r.count) })),
    attendanceTrend: (attendanceTrend as any[]).map((r) => ({
      date: r.work_date,
      present: num(r.present),
      absent: num(r.absent),
    })),
    recentJoiners,
    pendingLeaves,
  })
}
