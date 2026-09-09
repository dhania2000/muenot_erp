import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { hashPassword } from "@/lib/password"
import { consumeResetToken, verifyResetToken } from "@/lib/password-reset"

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const token = searchParams.get("token") || ""
  const result = await verifyResetToken(token)
  return NextResponse.json({ valid: Boolean(result) })
}

export async function POST(request: Request) {
  try {
    const { token, newPassword } = await request.json()

    if (!token || !newPassword) {
      return NextResponse.json({ error: "Token and new password are required" }, { status: 400 })
    }
    if (String(newPassword).length < 8) {
      return NextResponse.json({ error: "New password must be at least 8 characters" }, { status: 400 })
    }

    const result = await verifyResetToken(token)
    if (!result) {
      return NextResponse.json({ error: "This reset link is invalid or has expired" }, { status: 400 })
    }

    const newHash = await hashPassword(newPassword)
    await query("UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?", [
      newHash,
      result.userId,
    ])
    await consumeResetToken(result.tokenId)

    return NextResponse.json({ ok: true })
  } catch (error) {
    console.error("[v0] reset-password error:", error)
    return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 })
  }
}
