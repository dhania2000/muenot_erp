import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { getSession } from "@/lib/auth"
import { generateTempPassword, hashPassword } from "@/lib/password"
import { assertAndHashNewPassword, recordPasswordChange, validatePasswordAgainstPolicy, getPasswordPolicy } from "@/lib/password-policy"

async function requireAdmin() {
  const session = await getSession()
  if (!session || session.role !== "admin") return null
  return session
}

/**
 * System-admin-only password reset addressed by employee id. Resolves the
 * employee's linked login account (hr_employees.user_id) and resets its
 * password — either to an admin-supplied value or a generated temporary one.
 * The employee is forced to set a new password on their next sign-in.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireAdmin()
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const { id } = await params

  const rows = await query<
    { id: number; employee_name: string; user_id: number | null; login_email: string | null }[]
  >(
    `SELECT e.id, e.employee_name, e.user_id, u.email AS login_email
     FROM hr_employees e
     LEFT JOIN users u ON u.id = e.user_id
     WHERE e.id = ? LIMIT 1`,
    [id],
  )
  const emp = rows[0]
  if (!emp) return NextResponse.json({ error: "Employee not found" }, { status: 404 })
  if (!emp.user_id) {
    return NextResponse.json(
      { error: "This employee has no login account to reset. Create a login account first." },
      { status: 400 },
    )
  }

  let newPassword: string
  let generated = false

  const body = await request.json().catch(() => ({}))
  const custom = typeof body?.password === "string" ? body.password.trim() : ""

  let passwordHash: string
  if (custom) {
    const policy = await getPasswordPolicy()
    const errors = validatePasswordAgainstPolicy(custom, policy)
    if (errors.length) {
      return NextResponse.json({ error: errors[0] }, { status: 400 })
    }
    try {
      passwordHash = await assertAndHashNewPassword(emp.user_id, custom)
    } catch (error) {
      return NextResponse.json({ error: (error as Error).message }, { status: 400 })
    }
    newPassword = custom
  } else {
    newPassword = generateTempPassword()
    passwordHash = await hashPassword(newPassword)
    generated = true
  }

  await query("UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?", [
    passwordHash,
    emp.user_id,
  ])
  await recordPasswordChange(emp.user_id, passwordHash, null)

  return NextResponse.json({
    ok: true,
    employee: { id: emp.id, name: emp.employee_name, email: emp.login_email },
    // Only surface the value when we generated it; a custom one is already known to the admin.
    tempPassword: generated ? newPassword : null,
  })
}
