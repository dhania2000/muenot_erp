import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { query } from "@/lib/db"
import { ensureKbSchema, canManage, CONTENT_TYPES, labelForType } from "@/lib/knowledge-base"

export const dynamic = "force-dynamic"

// GET /api/knowledge-base/meta — dropdown sources for the editor (manager only).
export async function GET() {
  const session = await getSession()
  if (!session || !(await canManage(session)))
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  await ensureKbSchema()

  const [categories, departments, designations, employees, authors, articles] = await Promise.all([
    query<any[]>("SELECT id, name, active, sort_order FROM kb_categories ORDER BY sort_order, name"),
    query<any[]>("SELECT DISTINCT department FROM hr_employees WHERE department IS NOT NULL AND department <> '' ORDER BY department"),
    query<any[]>("SELECT DISTINCT designation FROM hr_employees WHERE designation IS NOT NULL AND designation <> '' ORDER BY designation"),
    query<any[]>("SELECT id, employee_name, department, designation, employment_status FROM hr_employees ORDER BY employee_name"),
    query<any[]>("SELECT DISTINCT author_id, author_name FROM kb_articles WHERE author_id IS NOT NULL AND author_name IS NOT NULL ORDER BY author_name"),
    query<any[]>("SELECT id, article_code, heading, content_type FROM kb_articles WHERE status <> 'rejected' ORDER BY heading LIMIT 500"),
  ])

  return NextResponse.json({
    categories: categories.map((c) => ({ id: c.id, name: c.name, active: !!c.active, sort_order: c.sort_order })),
    departments: departments.map((d) => d.department),
    designations: designations.map((d) => d.designation),
    employees: employees.map((e) => ({
      id: e.id, name: e.employee_name, department: e.department, designation: e.designation,
      active: String(e.employment_status ?? "").trim().toLowerCase() === "active",
    })),
    authors: authors.map((a) => ({ id: a.author_id, name: a.author_name })),
    articles: articles.map((a) => ({ id: a.id, code: a.article_code, heading: a.heading, content_type: a.content_type })),
    contentTypes: CONTENT_TYPES.map((t) => ({ value: t, label: labelForType(t) })),
  })
}
