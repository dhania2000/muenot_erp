import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { verifyPassword } from "@/lib/password"
import { createSessionToken, setSessionCookie } from "@/lib/auth"
import { getNum } from "@/lib/settings/server"

type UserRow = {
  id: number
  name: string
  email: string
  password_hash: string
  role: "admin" | "employee"
  status: "active" | "inactive"
  must_change_password: number
}

function isDbConfigured() {
  return Boolean(process.env.DB_HOST && process.env.DB_USER && process.env.DB_NAME)
}

export async function POST(request: Request) {
  try {
    const { email, password } = await request.json()

    if (!email || !password) {
      return NextResponse.json({ error: "Email and password are required" }, { status: 400 })
    }

    if (!isDbConfigured()) {
      console.error(
        "[v0] login error: database is not configured. Missing one of DB_HOST/DB_USER/DB_NAME env vars in this deployment.",
      )
      return NextResponse.json(
        { error: "The server is not connected to a database. Please contact your administrator." },
        { status: 503 },
      )
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

    // Session lifetime is configurable in Settings → Security (minutes).
    const timeoutMinutes = await getNum("security.session_timeout", 480)
    const durationSeconds = Math.max(60, Math.round(timeoutMinutes * 60))
    const token = await createSessionToken(
      {
        userId: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
      },
      durationSeconds,
    )
    await setSessionCookie(token, durationSeconds)

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
    const code = (error as { code?: string })?.code
    console.error("[v0] login error:", { code, error })

    // Surface actionable diagnostics for the most common infrastructure
    // failures instead of a blanket "Something went wrong."
    switch (code) {
      case "ECONNREFUSED":
      case "ETIMEDOUT":
      case "ENOTFOUND":
      case "EHOSTUNREACH":
      case "PROTOCOL_CONNECTION_LOST":
        return NextResponse.json(
          { error: "Unable to reach the database. Please contact your administrator." },
          { status: 503 },
        )
      case "ER_ACCESS_DENIED_ERROR":
        return NextResponse.json(
          { error: "Database credentials are invalid. Please contact your administrator." },
          { status: 503 },
        )
      case "ER_NO_SUCH_TABLE":
      case "ER_BAD_DB_ERROR":
        return NextResponse.json(
          { error: "The database is not set up correctly. Please contact your administrator." },
          { status: 503 },
        )
      default:
        return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 })
    }
  }
}
