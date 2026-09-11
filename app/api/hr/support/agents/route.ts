import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { getSession } from "@/lib/auth"
import { ensureSupportSchema, canManageSupport } from "@/lib/hr-support"

// GET /api/hr/support/agents — assignable HR agents (managers/admins). Only
// visible to users who can manage support, since it drives the assignment UI.
export async function GET() {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  await ensureSupportSchema()

  if (!(await canManageSupport(session))) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  // Admins plus anyone granted the manage-support feature via the matrix or
  // legacy grants. We surface all active admins and feature-granted employees.
  const agents = await query<any[]>(
    `SELECT DISTINCT u.id, u.name, u.email, u.role
       FROM users u
       LEFT JOIN user_permissions up ON up.user_id = u.id
       LEFT JOIN features f ON f.id = up.feature_id
      WHERE u.status = 'active'
        AND (u.role = 'admin' OR f.slug = 'hr.manage_support')
      ORDER BY u.name ASC`,
  )
  return NextResponse.json({ agents })
}
