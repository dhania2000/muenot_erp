import { NextResponse } from "next/server"
import { authenticatePortalUser } from "@/lib/portal/store"
import { createPortalSessionToken, setPortalSessionCookie } from "@/lib/portal/auth"

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
      return NextResponse.json(
        { error: "The portal is not connected to a database. Please contact your provider." },
        { status: 503 },
      )
    }

    const result = await authenticatePortalUser(String(email), String(password))
    if (!result.ok) {
      if (result.reason === "locked") {
        return NextResponse.json(
          { error: "Too many failed attempts. Try again in a few minutes.", code: "ACCOUNT_LOCKED" },
          { status: 423 },
        )
      }
      return NextResponse.json({ error: "Invalid email or password" }, { status: 401 })
    }

    const { user } = result
    const token = await createPortalSessionToken({
      portalUserId: user.id,
      tenantId: user.tenant_id,
      clientId: user.client_id,
      email: user.email,
      name: user.name,
    })
    await setPortalSessionCookie(token)

    return NextResponse.json({
      user: { id: user.id, name: user.name, email: user.email },
    })
  } catch (error) {
    console.error("[v0] portal login error:", error)
    return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 })
  }
}
