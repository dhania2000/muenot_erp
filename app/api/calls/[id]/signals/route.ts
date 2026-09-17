import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { query } from "@/lib/db"
import { ensureCallsSchema } from "@/lib/calls-ensure"
import { getSessionRow, isParticipant, peerOf, verifyCallToken } from "@/lib/calls-core"

export const dynamic = "force-dynamic"

const ALLOWED_KINDS = new Set(["offer", "answer", "ice", "bye"])
const MAX_PAYLOAD = 64 * 1024 // 64 KB per signal — SDP/ICE only, never media.

/**
 * Signalling exchange for a single call session. This is the ONLY thing that
 * transits the ERP server for a call — SDP offers/answers and ICE candidates.
 * The actual audio/video media flows peer-to-peer over WebRTC (Phase 6/36).
 *
 * Authorization (Phase 72/73): the request must carry both a valid ERP session
 * AND a short-lived signed call token bound to this session + user. Only the
 * two participants can read or write signals for a session.
 */
async function authorize(request: Request, sessionId: number, userId: number) {
  const token = request.headers.get("x-call-token") || ""
  const claims = await verifyCallToken(token)
  if (!claims || claims.sid !== sessionId || claims.uid !== userId) return false
  return true
}

// GET /api/calls/:id/signals?after=<lastId> — fetch signals addressed to me.
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  await ensureCallsSchema()

  const { id } = await params
  const sessionId = Number(id)
  if (!(await authorize(request, sessionId, session.userId))) {
    return NextResponse.json({ error: "Invalid call token." }, { status: 403 })
  }
  const row = await getSessionRow(sessionId)
  if (!row || !isParticipant(row, session.userId)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  const after = Number(new URL(request.url).searchParams.get("after") || 0)
  const rows = await query<any[]>(
    `SELECT id, from_user_id, kind, payload FROM internal_call_signals
      WHERE session_id = ? AND to_user_id = ? AND id > ?
      ORDER BY id ASC LIMIT 100`,
    [sessionId, session.userId, after],
  )
  const signals = rows.map((r) => ({
    id: Number(r.id),
    from: Number(r.from_user_id),
    kind: r.kind as string,
    payload: safeParse(r.payload),
  }))
  return NextResponse.json({ signals, status: row.status })
}

// POST /api/calls/:id/signals — publish a signal to the peer.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  await ensureCallsSchema()

  const { id } = await params
  const sessionId = Number(id)
  if (!(await authorize(request, sessionId, session.userId))) {
    return NextResponse.json({ error: "Invalid call token." }, { status: 403 })
  }
  const row = await getSessionRow(sessionId)
  if (!row || !isParticipant(row, session.userId)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  const body = await request.json().catch(() => ({}))
  const kind = String(body.kind || "")
  if (!ALLOWED_KINDS.has(kind)) return NextResponse.json({ error: "Bad signal kind." }, { status: 400 })
  const payload = JSON.stringify(body.payload ?? null)
  if (payload.length > MAX_PAYLOAD) return NextResponse.json({ error: "Signal too large." }, { status: 413 })

  const to = peerOf(row, session.userId)
  const result = await query<any>(
    `INSERT INTO internal_call_signals (session_id, from_user_id, to_user_id, kind, payload)
     VALUES (?,?,?,?,?)`,
    [sessionId, session.userId, to, kind, payload],
  )
  return NextResponse.json({ id: result.insertId })
}

function safeParse(s: string) {
  try {
    return JSON.parse(s)
  } catch {
    return null
  }
}
