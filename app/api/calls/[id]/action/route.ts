import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { query } from "@/lib/db"
import { ensureCallsSchema } from "@/lib/calls-ensure"
import {
  buildCallView,
  endSession,
  getSessionRow,
  isParticipant,
  logCallEvent,
  notifyUser,
  peerOf,
} from "@/lib/calls-core"

export const dynamic = "force-dynamic"

/**
 * POST /api/calls/:id/action — drive the call state machine.
 *
 * body.action ∈ accept | reject | cancel | end | connecting | connected | reconnecting
 *
 * Every action verifies the caller is an authenticated PARTICIPANT of the
 * session (Phase 38/73). Accept is receiver-only; cancel is caller-only; the
 * rest are allowed for either party. Terminal transitions compute duration and
 * notify the peer through the existing notification feed.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  await ensureCallsSchema()

  const { id } = await params
  const sessionId = Number(id)
  const body = await request.json().catch(() => ({}))
  const action = String(body.action || "")

  const row = await getSessionRow(sessionId)
  if (!row) return NextResponse.json({ error: "Call not found." }, { status: 404 })
  if (!isParticipant(row, session.userId)) {
    return NextResponse.json({ error: "You are not a participant of this call." }, { status: 403 })
  }
  const isCaller = row.caller_user_id === session.userId
  const isReceiver = row.receiver_user_id === session.userId

  switch (action) {
    case "accept": {
      if (!isReceiver) return NextResponse.json({ error: "Only the receiver can accept." }, { status: 403 })
      if (row.status !== "ringing" && row.status !== "calling") {
        return NextResponse.json({ error: "Call is no longer ringing." }, { status: 409 })
      }
      await query(
        `UPDATE internal_call_sessions SET status='accepted', answered_at=NOW()
          WHERE id=? AND status IN ('ringing','calling')`,
        [sessionId],
      )
      await logCallEvent(sessionId, "accepted", session.userId)
      break
    }
    case "reject": {
      if (!isReceiver) return NextResponse.json({ error: "Only the receiver can reject." }, { status: 403 })
      await endSession(sessionId, "rejected", "receiver_rejected", session.userId)
      await notifyUser(row.caller_user_id, "call_rejected", "Call rejected", "Your call was declined.")
      break
    }
    case "cancel": {
      if (!isCaller) return NextResponse.json({ error: "Only the caller can cancel." }, { status: 403 })
      await endSession(sessionId, "cancelled", "caller_cancelled", session.userId)
      // Cancelled before answer counts as a missed call for the receiver (Phase 14).
      if (!row.answered_at) {
        await notifyUser(row.receiver_user_id, "missed_call", "Missed call", `You missed a ${row.call_type} call.`)
      }
      break
    }
    case "end": {
      await endSession(sessionId, "ended", body.reason ? String(body.reason).slice(0, 48) : "hangup", session.userId)
      await notifyUser(peerOf(row, session.userId), "call_ended", "Call ended", "The call has ended.")
      break
    }
    case "connecting":
    case "connected":
    case "reconnecting": {
      // Progress transitions during an accepted call. Only move forward.
      if (["accepted", "connecting", "connected", "reconnecting"].includes(row.status)) {
        const next = action === "reconnecting" ? "connecting" : action
        await query(
          `UPDATE internal_call_sessions SET status=? WHERE id=? AND status NOT IN ('ended','failed','rejected','missed','cancelled','busy')`,
          [next, sessionId],
        )
        await logCallEvent(sessionId, action, session.userId)
      }
      break
    }
    default:
      return NextResponse.json({ error: "Unknown action." }, { status: 400 })
  }

  const updated = await getSessionRow(sessionId)
  const view = updated ? await buildCallView(updated, session.userId) : null
  return NextResponse.json({ session: view })
}
