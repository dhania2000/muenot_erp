import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { requireFeature } from "@/lib/api-auth"
import { getScope, scopeWhere } from "@/lib/permission-store"
import { query } from "@/lib/db"
import {
  ensureMonitoringSchema,
  getSessionById,
  postSignal,
  pollSignals,
  MONITORING_MODULE_KEY,
  type SignalKind,
} from "@/lib/screen-monitoring"

export const dynamic = "force-dynamic"

// ---------------------------------------------------------------------------
// WebRTC signaling relay for the "View Live" feature.
//
// The employee's browser (broadcaster) already holds the live screen-share
// MediaStream; an HR viewer negotiates a direct peer connection with it. This
// route only brokers the offer/answer/ICE handshake — no video is stored or
// proxied. Broadcaster access is limited to the session's own employee; viewer
// access requires the monitoring view permission AND the session being inside
// the caller's data scope.
// ---------------------------------------------------------------------------

const KINDS: SignalKind[] = ["offer", "answer", "ice", "bye"]

/** Ensure the caller may act as a broadcaster for (own) or viewer of a session. */
async function authorize(
  role: "viewer" | "broadcaster",
  sessionPk: number,
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  await ensureMonitoringSchema()
  const target = await getSessionById(sessionPk)
  if (!target) return { ok: false, status: 404, error: "Session not found" }

  if (role === "broadcaster") {
    const session = await getSession()
    if (!session) return { ok: false, status: 401, error: "Unauthorized" }
    if (session.role !== "admin" && target.user_id !== session.userId) {
      return { ok: false, status: 403, error: "Forbidden" }
    }
    return { ok: true }
  }

  // Viewer — must hold the monitoring view feature and have the session in scope.
  const session = await requireFeature("hr.view_screen_monitoring")
  if (!session) return { ok: false, status: 403, error: "Forbidden" }
  const scope = await getScope(session.userId, session.role, MONITORING_MODULE_KEY, "view")
  const sc = scopeWhere(scope, MONITORING_MODULE_KEY, session.userId, "s")
  const rows = await query<{ id: number }[]>(
    `SELECT s.id FROM screen_monitoring_sessions s WHERE ${sc.sql} AND s.id = ? LIMIT 1`,
    [...sc.params, sessionPk],
  )
  if (!rows.length) return { ok: false, status: 403, error: "Forbidden" }
  return { ok: true }
}

function parseRole(v: unknown): "viewer" | "broadcaster" | null {
  return v === "viewer" || v === "broadcaster" ? v : null
}

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as {
      sessionId?: number
      viewerId?: string
      role?: string
      kind?: string
      payload?: unknown
    }
    const sessionPk = Number(body.sessionId)
    const role = parseRole(body.role)
    const viewerId = String(body.viewerId ?? "").trim()
    const kind = body.kind as SignalKind
    if (!sessionPk || !role || !viewerId || !KINDS.includes(kind)) {
      return NextResponse.json({ error: "Invalid signal" }, { status: 400 })
    }

    const auth = await authorize(role, sessionPk)
    if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status })

    const payload = body.payload == null ? null : JSON.stringify(body.payload)
    await postSignal({ sessionPk, viewerId, sender: role, kind, payload })
    return NextResponse.json({ ok: true })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Signal failed" }, { status: 500 })
  }
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const sessionPk = Number(searchParams.get("sessionId"))
    const role = parseRole(searchParams.get("role"))
    const viewerId = String(searchParams.get("viewerId") ?? "").trim()
    if (!sessionPk || !role || !viewerId) {
      return NextResponse.json({ error: "Invalid request" }, { status: 400 })
    }

    const auth = await authorize(role, sessionPk)
    if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status })

    const messages = await pollSignals({ sessionPk, reader: role, viewerId })
    return NextResponse.json({
      messages: messages.map((m) => ({
        id: m.id,
        viewerId: m.viewer_id,
        kind: m.kind,
        payload: m.payload ? JSON.parse(m.payload) : null,
      })),
    })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Poll failed" }, { status: 500 })
  }
}
