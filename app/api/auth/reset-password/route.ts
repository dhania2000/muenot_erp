import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { consumeResetToken, verifyResetToken } from "@/lib/password-reset"
import { assertAndHashNewPassword, recordPasswordChange } from "@/lib/password-policy"
import { resolveTenantIdForUser } from "@/lib/tenant-service"
import { revokeAllSessionsForUser } from "@/lib/session-store"

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

    const result = await verifyResetToken(token)
    if (!result) {
      return NextResponse.json({ error: "This reset link is invalid or has expired" }, { status: 400 })
    }

    // SPEC 60 — full policy enforcement: strength rules + reuse history.
    let newHash: string
    try {
      newHash = await assertAndHashNewPassword(result.userId, newPassword)
    } catch (error) {
      return NextResponse.json({ error: (error as Error).message }, { status: 400 })
    }

    await query("UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?", [
      newHash,
      result.userId,
    ])
    const tenantId = await resolveTenantIdForUser(result.userId)
    await recordPasswordChange(result.userId, newHash, tenantId ?? null)
    await consumeResetToken(result.tokenId)

    // SPEC 60 — session invalidation after password reset. A forgotten-password
    // reset happens off-session (the actor holds no cookie), so every standing
    // session for this user is revoked: if the reset was triggered by an
    // attacker who had a live session, that session dies here.
    try {
      await revokeAllSessionsForUser(result.userId, { reason: "password_reset" })
    } catch (err) {
      console.error("[v0] reset-password: session revocation failed (reset still succeeds):", err)
    }

    return NextResponse.json({ ok: true })
  } catch (error) {
    console.error("[v0] reset-password error:", error)
    return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 })
  }
}
