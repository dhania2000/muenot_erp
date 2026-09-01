import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { getSession } from "@/lib/auth"
import { hashPassword, generateTempPassword } from "@/lib/password"

async function requireAdmin() {
  const session = await getSession()
  if (!session || session.role !== "admin") return null
  return session
}

export async function GET() {
  const session = await requireAdmin()
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const employees = await query(
    `SELECT id, name, email, role, designation, status, must_change_password, created_at
     FROM users ORDER BY created_at DESC`,
  )
  return NextResponse.json({ employees })
}

export async function POST(request: Request) {
  const session = await requireAdmin()
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const { name, email, designation } = await request.json()
  if (!name || !email) {
    return NextResponse.json({ error: "Name and email are required" }, { status: 400 })
  }

  const normalizedEmail = String(email).toLowerCase().trim()
  const existing = await query<{ id: number }[]>("SELECT id FROM users WHERE email = ? LIMIT 1", [
    normalizedEmail,
  ])
  if (existing.length > 0) {
    return NextResponse.json({ error: "An account with this email already exists" }, { status: 409 })
  }

  const tempPassword = generateTempPassword()
  const passwordHash = await hashPassword(tempPassword)

  const result = await query<any>(
    `INSERT INTO users (name, email, password_hash, role, designation, status, must_change_password)
     VALUES (?, ?, ?, 'employee', ?, 'active', 1)`,
    [name, normalizedEmail, passwordHash, designation || null],
  )

  return NextResponse.json({
    employee: { id: result.insertId, name, email: normalizedEmail, designation },
    tempPassword,
  })
}
