import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { getSession } from "@/lib/auth"
import { hashPassword, generateTempPassword } from "@/lib/password"

async function requireAdmin() {
  const session = await getSession()
  if (!session || session.role !== "admin") return null
  return session
}

/**
 * Admin-only password reset. Lets a System Admin reset any employee's login
 * password — either to an admin-supplied value or to a generated temporary
 * one. The user is forced to set a new password on their next sign-in.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireAdmin()
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const { id } = await params

  const rows = await query<{ id: number; name: string; email: string; role: string }[]>(
    "SELECT id, name, email, role FROM users WHERE id = ? LIMIT 1",
    [id],
  )
  const target = rows[0]
  if (!target) return NextResponse.json({ error: "Employee not found" }, { status: 404 })

  let newPassword: string
  let generated = false

  const body = await request.json().catch(() => ({}))
  const custom = typeof body?.password === "string" ? body.password.trim() : ""

  if (custom) {
    if (custom.length < 8) {
      return NextResponse.json({ error: "Password must be at least 8 characters." }, { status: 400 })
    }
    newPassword = custom
  } else {
    newPassword = generateTempPassword()
    generated = true
  }

  const passwordHash = await hashPassword(newPassword)
  await query("UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?", [passwordHash, id])

  return NextResponse.json({
    ok: true,
    employee: { id: target.id, name: target.name, email: target.email },
    // Only surface the value when we generated it; a custom one is already known to the admin.
    tempPassword: generated ? newPassword : null,
  })
}
