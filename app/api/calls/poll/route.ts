import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { query } from "@/lib/db"
import { ensureCallsSchema } from "@/lib/calls-ensure"
import {
  activeSessionForUser,
  buildCallView,
  heartbeat,
  sweepStaleSessions,
} from "@/lib/calls-core"

export const dynamic = "force-dynamic"

// Throttle the stale-session sweep so a busy poll loop doesn't hammer it.
declare global {
  // eslint-disable-next-line no-var
  var __callSweepAt: number | undefined
}

/**
 * GET /api/calls/poll — the presence + call-state heartbeat.
 *
 * Called on a light interval by every signed-in client (Phase 78/79). It:
 *  - refreshes the caller's presence heartbeat (drives online/offline),
 *  - opportunistically closes ring-timed-out / stale sessions (Phase 44/77),
 *  - returns the user's single active session (incoming or outgoing) as a
 *    client view, plus any just-terminated session so both ends learn the
 *    final state (rejected / busy / missed / ended).
 */
export async function GET() {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  await ensureCallsSchema()
  await heartbeat(session.userId)

  const now = Date.now()
  if (!globalThis.__callSweepAt || now - globalThis.__callSweepAt > 10_000) {
    globalThis.__callSweepAt = now
    await sweepStaleSessions().catch(() => {})
  }

  const active = await activeSessionForUser(session.userId)
  const view = active ? await buildCallView(active, session.userId) : null

  // A session that reached a terminal state in the last 25s so the peer's UI
  // can reflect rejected / missed / busy / ended even after the row left the
  // active set.
  const recent = await query<any[]>(
    `SELECT id, status, end_reason, call_type, caller_user_id, receiver_user_id
       FROM internal_call_sessions
      WHERE (caller_user_id = ? OR receiver_user_id = ?)
        AND status IN ('rejected','missed','busy','ended','failed','cancelled')
        AND ended_at IS NOT NULL
        AND ended_at > (NOW() - INTERVAL 25 SECOND)
      ORDER BY id DESC LIMIT 1`,
    [session.userId, session.userId],
  )
  const recentRow = recent[0]
    ? {
        id: Number(recent[0].id),
        status: recent[0].status,
        endReason: recent[0].end_reason,
        callType: recent[0].call_type,
        role: recent[0].caller_user_id === session.userId ? "caller" : "receiver",
      }
    : null

  return NextResponse.json({ session: view, recent: recentRow, serverTime: now })
}
