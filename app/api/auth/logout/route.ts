import { NextResponse } from "next/server"
import { clearSessionCookie, getSession } from "@/lib/auth"
import { revokeSession } from "@/lib/session-store"

export async function POST() {
  // SPEC 61 — revoke the server-side session record (not just the cookie) so
  // it disappears from Session management and the sid can never be replayed
  // even if the JWT cookie were somehow retained.
  try {
    const session = await getSession()
    if (session?.sid) await revokeSession(session.sid, "logout")
  } catch (err) {
    console.error("[v0] session revoke on logout failed:", err)
  }
  await clearSessionCookie()
  return NextResponse.json({ ok: true })
}
