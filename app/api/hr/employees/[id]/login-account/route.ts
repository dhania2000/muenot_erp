import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { query } from "@/lib/db"
import { hashPassword, generateTempPassword } from "@/lib/password"
import { ensurePermissionSchema } from "@/lib/permission-store"

async function requireAdmin() {
  const session = await getSession()
  if (!session || session.role !== "admin") return null
  return session
}

/**
 * Creates a login account for an employee (or links an existing account with a
 * matching email) so a Worksuite-style permission matrix can be assigned.
 */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireAdmin()
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  await ensurePermissionSchema()
  const { id } = await params

  const rows = await query<
    { id: number; employee_name: string; official_email: string | null; personal_email: string | null; designation: string | null; user_id: number | null }[]
  >(
    `SELECT id, employee_name, official_email, personal_email, designation, user_id
     FROM hr_employees WHERE id = ? LIMIT 1`,
    [id],
  )
  const emp = rows[0]
  if (!emp) return NextResponse.json({ error: "Employee not found" }, { status: 404 })
  if (emp.user_id) return NextResponse.json({ error: "This employee already has a login account." }, { status: 409 })

  const email = (emp.official_email || emp.personal_email || "").toLowerCase().trim()
  if (!email) {
    return NextResponse.json(
      { error: "Add an official or personal email to this employee before creating a login account." },
      { status: 400 },
    )
  }

  // Reuse an existing user with this email, otherwise provision a new one.
  const existing = await query<{ id: number }[]>("SELECT id FROM users WHERE email = ? LIMIT 1", [email])
  let userId: number
  let tempPassword: string | null = null

  if (existing.length > 0) {
    userId = existing[0].id
  } else {
    tempPassword = generateTempPassword()
    const passwordHash = await hashPassword(tempPassword)
    const result = await query<any>(
      `INSERT INTO users (name, email, password_hash, role, designation, status, must_change_password)
       VALUES (?, ?, ?, 'employee', ?, 'active', 1)`,
      [emp.employee_name, email, passwordHash, emp.designation || null],
    )
    userId = result.insertId
  }

  await query("UPDATE hr_employees SET user_id = ? WHERE id = ?", [userId, emp.id])

  return NextResponse.json({
    ok: true,
    linkedUser: { id: userId, email },
    tempPassword,
  })
}
