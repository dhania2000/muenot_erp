import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { getSession } from "@/lib/auth"
import { hashPassword, verifyPassword } from "@/lib/password"

export async function POST(request: Request) {
  const session = await getSession()
  if (!session) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 })
  }

  const { currentPassword, newPassword } = await request.json()
  if (!currentPassword || !newPassword) {
    return NextResponse.json({ error: "Current and new password are required" }, { status: 400 })
  }
  if (String(newPassword).length < 8) {
    return NextResponse.json({ error: "New password must be at least 8 characters" }, { status: 400 })
  }

  const rows = await query<{ id: number; password_hash: string }[]>(
    "SELECT id, password_hash FROM users WHERE id = ? LIMIT 1",
    [session.userId],
  )
  const user = rows[0]
  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 })
  }

  const valid = await verifyPassword(currentPassword, user.password_hash)
  if (!valid) {
    return NextResponse.json({ error: "Current password is incorrect" }, { status: 401 })
  }

  const newHash = await hashPassword(newPassword)
  await query("UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?", [
    newHash,
    session.userId,
  ])

  return NextResponse.json({ ok: true })
}
