import { NextRequest, NextResponse } from "next/server"
import { requireFeature } from "@/lib/api-auth"
import { query } from "@/lib/db"

/**
 * Slim employee list for the HR email composer's recipient picker. Only returns
 * active employees that have a usable email address. Gated by the same feature
 * that guards the emails page.
 */
export async function GET(request: NextRequest) {
  const session = await requireFeature("hr.view_emails")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const q = (request.nextUrl.searchParams.get("q") || "").trim()
  const where: string[] = [
    "archived_at IS NULL",
    "(official_email IS NOT NULL AND official_email <> '' OR personal_email IS NOT NULL AND personal_email <> '')",
  ]
  const args: any[] = []
  if (q) {
    const like = `%${q}%`
    where.push(
      "(employee_name LIKE ? OR employee_id LIKE ? OR official_email LIKE ? OR department LIKE ?)",
    )
    args.push(like, like, like, like)
  }

  const rows = await query<any[]>(
    `SELECT id, employee_id, employee_name,
            COALESCE(NULLIF(official_email,''), personal_email) AS email,
            department, designation
     FROM hr_employees
     WHERE ${where.join(" AND ")}
     ORDER BY employee_name ASC
     LIMIT 500`,
    args,
  )
  return NextResponse.json({ recipients: rows })
}
