import { query } from "@/lib/db"

/**
 * Personal dashboard data layer.
 *
 * The dashboard aggregates several independent sources (personal to-dos,
 * operations issues/projects, sales meetings, and employee birthdays). Every
 * source is queried defensively — if a table or column is missing in a given
 * deployment, that section simply resolves to empty instead of failing the
 * whole dashboard.
 */

export type PersonalTodo = {
  id: number
  title: string
  priority: "low" | "medium" | "high"
  due_date: string | null
  done: boolean
  created_at: string
}

export type PendingWork = {
  id: number
  title: string
  kind: string
  priority: string | null
  status: string
  due_date: string | null
  project: string | null
}

export type AssignedProject = {
  id: number
  name: string
  client: string | null
  role: string
  status: string | null
  priority: string | null
  end_date: string | null
}

export type TodayMeeting = {
  id: number
  title: string
  time: string | null
  type: string | null
  contact: string | null
  status: string | null
}

export type Birthday = {
  id: number
  name: string
  department: string | null
  date: string
  day: number
  month: number
  isToday: boolean
  inDays: number
}

export type EmployeeContext = {
  employeeId: string | null
  name: string
  department: string | null
  designation: string | null
  officialEmail: string | null
}

export type PersonalDashboardData = {
  employee: EmployeeContext
  todos: PersonalTodo[]
  pendingWork: PendingWork[]
  projects: AssignedProject[]
  meetings: TodayMeeting[]
  birthdays: Birthday[]
  stats: {
    openTodos: number
    pendingWork: number
    activeProjects: number
    meetingsToday: number
  }
}

let ensured = false

/** Idempotently create the per-user to-do table. */
export async function ensurePersonalTodos(): Promise<void> {
  if (ensured) return
  await query(
    `CREATE TABLE IF NOT EXISTS personal_todos (
       id INT UNSIGNED NOT NULL AUTO_INCREMENT,
       user_id INT UNSIGNED NOT NULL,
       title VARCHAR(300) NOT NULL,
       priority ENUM('low','medium','high') NOT NULL DEFAULT 'medium',
       due_date DATE NULL,
       done TINYINT(1) NOT NULL DEFAULT 0,
       created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
       updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
       PRIMARY KEY (id),
       KEY idx_personal_todos_user (user_id, done, due_date)
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  )
  ensured = true
}

async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    console.log("[v0] personal-dashboard section failed:", (err as Error)?.message)
    return fallback
  }
}

/** Resolve the employee record linked to the signed-in user account. */
async function loadEmployeeContext(userId: number, fallbackName: string): Promise<EmployeeContext> {
  return safe<EmployeeContext>(async () => {
    const rows = await query<any[]>(
      `SELECT employee_id, employee_name, department, designation, official_email
       FROM hr_employees WHERE user_id = ? LIMIT 1`,
      [userId],
    )
    const r = rows[0]
    if (!r) return { employeeId: null, name: fallbackName, department: null, designation: null, officialEmail: null }
    return {
      employeeId: r.employee_id != null ? String(r.employee_id) : null,
      name: r.employee_name || fallbackName,
      department: r.department ?? null,
      designation: r.designation ?? null,
      officialEmail: r.official_email ?? null,
    }
  }, { employeeId: null, name: fallbackName, department: null, designation: null, officialEmail: null })
}

async function loadTodos(userId: number): Promise<PersonalTodo[]> {
  return safe<PersonalTodo[]>(async () => {
    const rows = await query<any[]>(
      `SELECT id, title, priority, due_date, done, created_at
       FROM personal_todos WHERE user_id = ?
       ORDER BY done ASC,
         CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
         (due_date IS NULL), due_date ASC, id DESC
       LIMIT 50`,
      [userId],
    )
    return rows.map((r) => ({
      id: Number(r.id),
      title: r.title,
      priority: r.priority,
      due_date: r.due_date ? String(r.due_date).slice(0, 10) : null,
      done: Boolean(r.done),
      created_at: String(r.created_at),
    }))
  }, [])
}

async function loadPendingWork(ctx: EmployeeContext): Promise<PendingWork[]> {
  if (!ctx.name && !ctx.employeeId) return []
  return safe<PendingWork[]>(async () => {
    const rows = await query<any[]>(
      `SELECT id, title, issue_type, priority, status, due_date, client_name, project_id
       FROM operations_issues
       WHERE status IN ('Open','In Progress')
         AND (assigned_to = ? OR assigned_to = ?)
       ORDER BY (due_date IS NULL), due_date ASC, id DESC
       LIMIT 25`,
      [ctx.name, ctx.employeeId ?? "\u0000"],
    )
    return rows.map((r) => ({
      id: Number(r.id),
      title: r.title || "Untitled issue",
      kind: r.issue_type || "Issue",
      priority: r.priority ?? null,
      status: r.status,
      due_date: r.due_date ? String(r.due_date).slice(0, 10) : null,
      project: r.client_name ?? null,
    }))
  }, [])
}

async function loadProjects(ctx: EmployeeContext): Promise<AssignedProject[]> {
  if (!ctx.name && !ctx.officialEmail && !ctx.employeeId) return []
  const byManager = await safe<AssignedProject[]>(async () => {
    const rows = await query<any[]>(
      `SELECT id, project_name, client_name, project_manager, operations_manager, manager_name, status, priority, end_date
       FROM operations_projects
       WHERE status <> 'Closed'
         AND (project_manager = ? OR operations_manager = ? OR manager_name = ?)
       ORDER BY (end_date IS NULL), end_date ASC, id DESC
       LIMIT 25`,
      [ctx.name, ctx.name, ctx.name],
    )
    return rows.map((r) => ({
      id: Number(r.id),
      name: r.project_name || "Untitled project",
      client: r.client_name ?? null,
      role:
        r.project_manager === ctx.name
          ? "Project Manager"
          : r.operations_manager === ctx.name
            ? "Operations Manager"
            : "Manager",
      status: r.status ?? null,
      priority: r.priority ?? null,
      end_date: r.end_date ? String(r.end_date).slice(0, 10) : null,
    }))
  }, [])

  const byAllocation = await safe<AssignedProject[]>(async () => {
    const rows = await query<any[]>(
      `SELECT p.id, p.project_name, p.client_name, p.status, p.priority, p.end_date, a.role
       FROM operations_resources r
       JOIN operations_allocations a ON a.resource_id = r.resource_id
       JOIN operations_projects p ON p.id = a.project_id
       WHERE (r.official_email = ? OR r.employee_id = ?)
         AND a.status = 'Active' AND p.status <> 'Closed'
       ORDER BY (p.end_date IS NULL), p.end_date ASC, p.id DESC
       LIMIT 25`,
      [ctx.officialEmail ?? "\u0000", ctx.employeeId ?? "\u0000"],
    )
    return rows.map((r) => ({
      id: Number(r.id),
      name: r.project_name || "Untitled project",
      client: r.client_name ?? null,
      role: r.role || "Contributor",
      status: r.status ?? null,
      priority: r.priority ?? null,
      end_date: r.end_date ? String(r.end_date).slice(0, 10) : null,
    }))
  }, [])

  const merged = new Map<number, AssignedProject>()
  for (const p of [...byManager, ...byAllocation]) if (!merged.has(p.id)) merged.set(p.id, p)
  return Array.from(merged.values())
}

async function loadTodayMeetings(userId: number): Promise<TodayMeeting[]> {
  return safe<TodayMeeting[]>(async () => {
    const rows = await query<any[]>(
      `SELECT id, meeting_time, meeting_type, contact_person, agenda, status
       FROM sales_meetings
       WHERE owner_id = ? AND meeting_date = CURDATE()
         AND (status IS NULL OR status NOT IN ('Cancelled'))
       ORDER BY (meeting_time IS NULL), meeting_time ASC, id ASC
       LIMIT 25`,
      [userId],
    )
    return rows.map((r) => ({
      id: Number(r.id),
      title: r.agenda || r.meeting_type || "Meeting",
      time: r.meeting_time ? String(r.meeting_time).slice(0, 5) : null,
      type: r.meeting_type ?? null,
      contact: r.contact_person ?? null,
      status: r.status ?? null,
    }))
  }, [])
}

async function loadBirthdays(selfUserId: number): Promise<Birthday[]> {
  return safe<Birthday[]>(async () => {
    const rows = await query<any[]>(
      `SELECT id, employee_name, department, dob
       FROM hr_employees
       WHERE dob IS NOT NULL
         AND (status IS NULL OR status <> 'Inactive')
         AND (user_id IS NULL OR user_id <> ?)`,
      [selfUserId],
    )
    const now = new Date()
    const todayY = now.getFullYear()
    const startOfToday = new Date(todayY, now.getMonth(), now.getDate())
    const result: Birthday[] = []
    for (const r of rows) {
      const dob = new Date(String(r.dob))
      if (Number.isNaN(dob.getTime())) continue
      const month = dob.getMonth()
      const day = dob.getDate()
      let next = new Date(todayY, month, day)
      if (next < startOfToday) next = new Date(todayY + 1, month, day)
      const inDays = Math.round((next.getTime() - startOfToday.getTime()) / 86400000)
      if (inDays > 45) continue
      result.push({
        id: Number(r.id),
        name: r.employee_name || "Teammate",
        department: r.department ?? null,
        date: `${next.getFullYear()}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
        day,
        month: month + 1,
        isToday: inDays === 0,
        inDays,
      })
    }
    result.sort((a, b) => a.inDays - b.inDays)
    return result.slice(0, 12)
  }, [])
}

export async function getPersonalDashboard(userId: number, fallbackName: string): Promise<PersonalDashboardData> {
  await safe(() => ensurePersonalTodos(), undefined)
  const employee = await loadEmployeeContext(userId, fallbackName)
  const [todos, pendingWork, projects, meetings, birthdays] = await Promise.all([
    loadTodos(userId),
    loadPendingWork(employee),
    loadProjects(employee),
    loadTodayMeetings(userId),
    loadBirthdays(userId),
  ])
  return {
    employee,
    todos,
    pendingWork,
    projects,
    meetings,
    birthdays,
    stats: {
      openTodos: todos.filter((t) => !t.done).length,
      pendingWork: pendingWork.length,
      activeProjects: projects.length,
      meetingsToday: meetings.length,
    },
  }
}

export async function createTodo(
  userId: number,
  input: { title: string; priority?: string; due_date?: string | null },
): Promise<PersonalTodo> {
  await ensurePersonalTodos()
  const priority = ["low", "medium", "high"].includes(String(input.priority)) ? input.priority : "medium"
  const due = input.due_date ? String(input.due_date).slice(0, 10) : null
  const res = await query<any>(
    `INSERT INTO personal_todos (user_id, title, priority, due_date) VALUES (?, ?, ?, ?)`,
    [userId, input.title.slice(0, 300), priority, due],
  )
  return {
    id: Number(res.insertId),
    title: input.title.slice(0, 300),
    priority: priority as PersonalTodo["priority"],
    due_date: due,
    done: false,
    created_at: new Date().toISOString(),
  }
}

export async function updateTodo(
  userId: number,
  id: number,
  patch: { done?: boolean; title?: string; priority?: string; due_date?: string | null },
): Promise<boolean> {
  await ensurePersonalTodos()
  const sets: string[] = []
  const params: any[] = []
  if (patch.done !== undefined) {
    sets.push("done = ?")
    params.push(patch.done ? 1 : 0)
  }
  if (patch.title !== undefined) {
    sets.push("title = ?")
    params.push(String(patch.title).slice(0, 300))
  }
  if (patch.priority !== undefined && ["low", "medium", "high"].includes(String(patch.priority))) {
    sets.push("priority = ?")
    params.push(patch.priority)
  }
  if (patch.due_date !== undefined) {
    sets.push("due_date = ?")
    params.push(patch.due_date ? String(patch.due_date).slice(0, 10) : null)
  }
  if (!sets.length) return false
  params.push(userId, id)
  const res = await query<any>(
    `UPDATE personal_todos SET ${sets.join(", ")} WHERE user_id = ? AND id = ?`,
    params,
  )
  return Number(res.affectedRows) > 0
}

export async function deleteTodo(userId: number, id: number): Promise<boolean> {
  await ensurePersonalTodos()
  const res = await query<any>(`DELETE FROM personal_todos WHERE user_id = ? AND id = ?`, [userId, id])
  return Number(res.affectedRows) > 0
}
