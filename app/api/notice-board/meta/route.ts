import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { query } from "@/lib/db"
import { ensureNoticeSchema, canManage } from "@/lib/notice-board"

export const dynamic = "force-dynamic"

// GET /api/notice-board/meta — dropdown sources for the compose form (manager only).
export async function GET() {
  const session = await getSession()
  if (!session || !(await canManage(session)))
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  await ensureNoticeSchema()

  const [categories, departments, designations, locations, employmentTypes, employees] = await Promise.all([
    query<any[]>("SELECT name FROM notice_categories WHERE active = 1 ORDER BY sort_order, name"),
    query<any[]>("SELECT DISTINCT department FROM hr_employees WHERE department IS NOT NULL AND department <> '' ORDER BY department"),
    query<any[]>("SELECT DISTINCT designation FROM hr_employees WHERE designation IS NOT NULL AND designation <> '' ORDER BY designation"),
    query<any[]>("SELECT DISTINCT work_location FROM hr_employees WHERE work_location IS NOT NULL AND work_location <> '' ORDER BY work_location"),
    query<any[]>("SELECT DISTINCT employment_type FROM hr_employees WHERE employment_type IS NOT NULL AND employment_type <> '' ORDER BY employment_type"),
    query<any[]>(
      `SELECT id, employee_name, department, designation, employment_status
       FROM hr_employees ORDER BY employee_name`,
    ),
  ])

  return NextResponse.json({
    categories: categories.map((c) => c.name),
    departments: departments.map((d) => d.department),
    designations: designations.map((d) => d.designation),
    locations: locations.map((l) => l.work_location),
    employmentTypes: employmentTypes.map((e) => e.employment_type),
    employees: employees.map((e) => ({
      id: e.id,
      name: e.employee_name,
      department: e.department,
      designation: e.designation,
      active: String(e.employment_status ?? "").trim().toLowerCase() === "active",
    })),
  })
}
