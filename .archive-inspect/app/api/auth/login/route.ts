import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { verifyPassword } from "@/lib/password"
import { createSessionToken, setSessionCookie } from "@/lib/auth"

type UserRow = {
  id: number
  name: string
  email: string
  password_hash: string
  role: "admin" | "employee"
  status: "active" | "inactive"
  must_change_password: number
}

export async function POST(request: Request) {
  try {
    const { email, password } = await request.json()

    if (!email || !password) {
      return NextResponse.json({ error: "Email and password are required" }, { status: 400 })
    }

    const rows = await query<UserRow[]>("SELECT * FROM users WHERE email = ? LIMIT 1", [
      String(email).toLowerCase().trim(),
    ])
    const user = rows[0]

    if (!user) {
      return NextResponse.json({ error: "Invalid email or password" }, { status: 401 })
    }

    if (user.status !== "active") {
      return NextResponse.json({ error: "This account has been deactivated" }, { status: 403 })
    }

    const valid = await verifyPassword(password, user.password_hash)
    if (!valid) {
      return NextResponse.json({ error: "Invalid email or password" }, { status: 401 })
    }

    const token = await createSessionToken({
      userId: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
    })
    await setSessionCookie(token)

    return NextResponse.json({
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        mustChangePassword: Boolean(user.must_change_password),
      },
    })
  } catch (error) {
    console.error("[v0] login error:", error)
    return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 })
  }
}
