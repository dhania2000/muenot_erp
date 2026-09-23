import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { getSession } from "@/lib/auth"
import { generateTempPassword, hashPassword } from "@/lib/password"
import { assertAndHashNewPassword, recordPasswordChange, validatePasswordAgainstPolicy, getPasswordPolicy } from "@/lib/password-policy"
import { revokeAllSessionsForUser } from "@/lib/session-store"

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

  let passwordHash: string
  if (custom) {
    const policy = await getPasswordPolicy()
    const errors = validatePasswordAgainstPolicy(custom, policy)
    if (errors.length) {
      return NextResponse.json({ error: errors[0] }, { status: 400 })
    }
    try {
      passwordHash = await assertAndHashNewPassword(target.id, custom)
    } catch (error) {
      return NextResponse.json({ error: (error as Error).message }, { status: 400 })
    }
    newPassword = custom
  } else {
    // A generated temp password always satisfies the policy's length/case/
    // number requirements (see lib/password.ts), so it never needs the
    // reuse-history check that would otherwise be wasted DB work here.
    newPassword = generateTempPassword()
    passwordHash = await hashPassword(newPassword)
    generated = true
  }

  await query("UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?", [passwordHash, id])
  await recordPasswordChange(target.id, passwordHash, null)

  // an admin-forced reset evicts the target from every device: all
  // of their standing sessions are revoked so the old password (and any live
  // session an attacker may hold) can no longer be used.
  try {
    await revokeAllSessionsForUser(target.id, { reason: "admin_password_reset" })
  } catch (err) {
    console.error("[v0] admin reset-password: session revocation failed (reset still succeeds):", err)
  }

  return NextResponse.json({
    ok: true,
    employee: { id: target.id, name: target.name, email: target.email },
    // Only surface the value when we generated it; a custom one is already known to the admin.
    tempPassword: generated ? newPassword : null,
  })
}
