import "server-only"
import { SignJWT, jwtVerify } from "jose"
import { query } from "@/lib/db"
import type { SessionPayload } from "@/lib/auth"
import { userHasFeature } from "@/lib/permissions"
import { ensureMessagesSchema } from "@/lib/messages-ensure"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export type CallType = "audio" | "video"

/** Full call lifecycle (Phase 8). */
export const CALL_STATUSES = [
  "calling",
  "ringing",
  "accepted",
  "connecting",
  "connected",
  "rejected",
  "busy",
  "missed",
  "ended",
  "failed",
  "cancelled",
] as const
export type CallStatus = (typeof CALL_STATUSES)[number]

/** Statuses that count as an in-flight / occupying call (Phase 13/43/69). */
export const ACTIVE_STATUSES: CallStatus[] = ["calling", "ringing", "accepted", "connecting", "connected"]

/** A ringing call is auto-marked missed after this window (Phase 44). */
export const RING_TIMEOUT_MS = 45_000
/** A session with no heartbeat / progress after this is considered stale (Phase 76/77). */
export const STALE_MS = 90_000
/** Online if the presence heartbeat is newer than this (Phase 78/79). */
export const PRESENCE_ONLINE_MS = 35_000

// RBAC feature slugs — reuse the existing matrix engine (Phase 62). Unmapped
// slugs fall back to HR-group visibility in userHasFeature; admins always pass.
export const FEATURE_AUDIO = "hr.internal_audio_call"
export const FEATURE_VIDEO = "hr.internal_video_call"
export const FEATURE_HISTORY = "hr.view_call_history"

// ---------------------------------------------------------------------------
// Identity resolution — HR Employee Master is the source of truth (Phase 6/41)
// ---------------------------------------------------------------------------

export type CallableEmployee = {
  employeeId: number
  userId: number | null
  name: string
  employeeCode: string | null
  designation: string | null
  department: string | null
  photoUrl: string | null
  employmentStatus: string | null
  loginStatus: string | null
  active: boolean
}

/**
 * Resolve an hr_employees row into a callable target, joining its login user.
 * NEVER trust a client-supplied user id — always resolve from the employee id
 * server-side (Phase 38/39). `active` reflects both the employment status and
 * the login account status.
 */
export async function resolveEmployeeTarget(employeeId: number): Promise<CallableEmployee | null> {
  const rows = await query<any[]>(
    `SELECT e.id, e.user_id, e.employee_name, e.employee_id AS employee_code,
            e.designation, e.department, e.photo_url, e.employment_status, e.archived_at,
            u.status AS login_status
       FROM hr_employees e
       LEFT JOIN users u ON u.id = e.user_id
      WHERE e.id = ? LIMIT 1`,
    [employeeId],
  )
  const r = rows[0]
  if (!r) return null
  const inactiveEmployment = ["Resigned", "Terminated", "Ex-Employee", "Suspended"]
  const employmentActive = !r.archived_at && !inactiveEmployment.includes(String(r.employment_status || ""))
  const loginActive = !r.login_status || String(r.login_status).toLowerCase() === "active"
  return {
    employeeId: Number(r.id),
    userId: r.user_id ? Number(r.user_id) : null,
    name: r.employee_name,
    employeeCode: r.employee_code || null,
    designation: r.designation || null,
    department: r.department || null,
    photoUrl: r.photo_url || null,
    employmentStatus: r.employment_status || null,
    loginStatus: r.login_status || null,
    active: employmentActive && loginActive,
  }
}

/** The HR Employee Master profile for a login user id (for caller/receiver cards). */
export async function employeeForUser(userId: number): Promise<CallableEmployee | null> {
  const rows = await query<any[]>(
    `SELECT e.id, e.user_id, e.employee_name, e.employee_id AS employee_code,
            e.designation, e.department, e.photo_url, e.employment_status, e.archived_at,
            u.status AS login_status, u.name AS user_name
       FROM users u
       LEFT JOIN hr_employees e ON e.user_id = u.id
      WHERE u.id = ? LIMIT 1`,
    [userId],
  )
  const r = rows[0]
  if (!r) return null
  return {
    employeeId: r.id ? Number(r.id) : 0,
    userId,
    name: r.employee_name || r.user_name || "Employee",
    employeeCode: r.employee_code || null,
    designation: r.designation || null,
    department: r.department || null,
    photoUrl: r.photo_url || null,
    employmentStatus: r.employment_status || null,
    loginStatus: r.login_status || null,
    active: true,
  }
}

// ---------------------------------------------------------------------------
// Permissions (Phase 4/62/63/64)
// ---------------------------------------------------------------------------

export async function canPlaceCall(session: SessionPayload, type: CallType): Promise<boolean> {
  return userHasFeature(session.userId, session.role, type === "video" ? FEATURE_VIDEO : FEATURE_AUDIO)
}

export async function callPermissions(session: SessionPayload) {
  const [audio, video, history] = await Promise.all([
    userHasFeature(session.userId, session.role, FEATURE_AUDIO),
    userHasFeature(session.userId, session.role, FEATURE_VIDEO),
    userHasFeature(session.userId, session.role, FEATURE_HISTORY),
  ])
  return { audio, video, history }
}

// ---------------------------------------------------------------------------
// Session helpers
// ---------------------------------------------------------------------------

export type CallSessionRow = {
  id: number
  caller_user_id: number
  receiver_user_id: number
  caller_employee_id: number | null
  receiver_employee_id: number | null
  call_type: CallType
  status: CallStatus
  end_reason: string | null
  project_id: number | null
  project_name: string | null
  task_id: number | null
  task_name: string | null
  origin: string | null
  started_at: string | null
  answered_at: string | null
  ended_at: string | null
  duration_seconds: number
}

export async function getSessionRow(id: number | string): Promise<CallSessionRow | null> {
  const rows = await query<CallSessionRow[]>(`SELECT * FROM internal_call_sessions WHERE id = ? LIMIT 1`, [id])
  return rows[0] || null
}

/** True when the user is the caller or receiver of the session (Phase 73). */
export function isParticipant(row: CallSessionRow, userId: number): boolean {
  return row.caller_user_id === userId || row.receiver_user_id === userId
}

export function peerOf(row: CallSessionRow, userId: number): number {
  return row.caller_user_id === userId ? row.receiver_user_id : row.caller_user_id
}

/** The user's current live call, if any (Phase 13/43). */
export async function activeSessionForUser(userId: number): Promise<CallSessionRow | null> {
  const rows = await query<CallSessionRow[]>(
    `SELECT * FROM internal_call_sessions
      WHERE (caller_user_id = ? OR receiver_user_id = ?)
        AND status IN (${ACTIVE_STATUSES.map(() => "?").join(",")})
      ORDER BY id DESC LIMIT 1`,
    [userId, userId, ...ACTIVE_STATUSES],
  )
  return rows[0] || null
}

/** Record an audit / lifecycle event (Phase 65). Best-effort. */
export async function logCallEvent(
  sessionId: number,
  event: string,
  actorUserId: number | null,
  detail?: string,
): Promise<void> {
  try {
    await query(
      `INSERT INTO internal_call_events (session_id, actor_user_id, event, detail) VALUES (?,?,?,?)`,
      [sessionId, actorUserId, event, detail ? detail.slice(0, 255) : null],
    )
  } catch (e) {
    console.log("[v0] logCallEvent failed:", (e as Error).message)
  }
}

/**
 * Transition a session to a terminal state and compute duration. Idempotent —
 * only moves out of an active status once. Returns the updated row.
 */
export async function endSession(
  sessionId: number,
  status: Extract<CallStatus, "ended" | "rejected" | "missed" | "failed" | "cancelled" | "busy">,
  endReason: string,
  actorUserId: number | null,
): Promise<CallSessionRow | null> {
  const row = await getSessionRow(sessionId)
  if (!row) return null
  if (!ACTIVE_STATUSES.includes(row.status)) return row // already terminal
  const answered = row.answered_at ? new Date(row.answered_at).getTime() : null
  const duration = answered ? Math.max(0, Math.round((Date.now() - answered) / 1000)) : 0
  await query(
    `UPDATE internal_call_sessions
        SET status = ?, end_reason = ?, ended_at = NOW(), duration_seconds = ?
      WHERE id = ? AND status IN (${ACTIVE_STATUSES.map(() => "?").join(",")})`,
    [status, endReason.slice(0, 48), duration, sessionId, ...ACTIVE_STATUSES],
  )
  await logCallEvent(sessionId, status, actorUserId, endReason)
  return getSessionRow(sessionId)
}

/**
 * Client-facing projection of a session from one participant's perspective:
 * my role, the peer's HR card, context labels, and a fresh signalling token.
 */
export async function buildCallView(row: CallSessionRow, userId: number) {
  const role: "caller" | "receiver" = row.caller_user_id === userId ? "caller" : "receiver"
  const peerUserId = peerOf(row, userId)
  const peer = await employeeForUser(peerUserId)
  const token = await issueCallToken(row.id, userId)
  return {
    id: row.id,
    role,
    status: row.status,
    callType: row.call_type,
    endReason: row.end_reason,
    startedAt: row.started_at,
    answeredAt: row.answered_at,
    context: {
      origin: row.origin,
      projectId: row.project_id,
      projectName: row.project_name,
      taskId: row.task_id,
      taskName: row.task_name,
    },
    peer: peer
      ? {
          userId: peerUserId,
          employeeId: peer.employeeId,
          name: peer.name,
          designation: peer.designation,
          department: peer.department,
          photoUrl: peer.photoUrl,
        }
      : { userId: peerUserId, employeeId: 0, name: "Employee", designation: null, department: null, photoUrl: null },
    token,
    iceServers: iceServers(),
  }
}

// ---------------------------------------------------------------------------
// Presence (Phase 3/78/79)
// ---------------------------------------------------------------------------

export async function heartbeat(userId: number): Promise<void> {
  await query(
    `INSERT INTO internal_call_presence (user_id, last_seen_at) VALUES (?, NOW())
       ON DUPLICATE KEY UPDATE last_seen_at = NOW()`,
    [userId],
  )
}

export async function setDnd(userId: number, dnd: boolean): Promise<void> {
  await query(
    `INSERT INTO internal_call_presence (user_id, last_seen_at, dnd) VALUES (?, NOW(), ?)
       ON DUPLICATE KEY UPDATE dnd = VALUES(dnd)`,
    [userId, dnd ? 1 : 0],
  )
}

export type PresenceStatus = "online" | "offline" | "busy" | "dnd" | "in_call"

/**
 * Derive presence for a set of login user ids. online/offline from the
 * heartbeat, in_call/busy from active sessions, dnd from the opt-in flag.
 */
export async function presenceForUsers(userIds: number[]): Promise<Map<number, PresenceStatus>> {
  const map = new Map<number, PresenceStatus>()
  if (!userIds.length) return map
  const uniq = Array.from(new Set(userIds))
  for (const id of uniq) map.set(id, "offline")

  const presence = await query<any[]>(
    `SELECT user_id, last_seen_at, dnd FROM internal_call_presence
      WHERE user_id IN (${uniq.map(() => "?").join(",")})`,
    uniq,
  )
  const now = Date.now()
  for (const p of presence) {
    const online = now - new Date(p.last_seen_at).getTime() < PRESENCE_ONLINE_MS
    if (!online) continue
    map.set(Number(p.user_id), p.dnd ? "dnd" : "online")
  }

  const busy = await query<any[]>(
    `SELECT DISTINCT caller_user_id, receiver_user_id FROM internal_call_sessions
      WHERE status IN (${ACTIVE_STATUSES.map(() => "?").join(",")})
        AND (caller_user_id IN (${uniq.map(() => "?").join(",")})
             OR receiver_user_id IN (${uniq.map(() => "?").join(",")}))`,
    [...ACTIVE_STATUSES, ...uniq, ...uniq],
  )
  for (const b of busy) {
    for (const uid of [Number(b.caller_user_id), Number(b.receiver_user_id)]) {
      if (map.has(uid)) map.set(uid, "in_call")
    }
  }
  return map
}

export async function isDnd(userId: number): Promise<boolean> {
  const rows = await query<any[]>(`SELECT dnd FROM internal_call_presence WHERE user_id = ? LIMIT 1`, [userId])
  return !!rows[0]?.dnd
}

// ---------------------------------------------------------------------------
// Notifications — reuse the existing Messages notification feed (Phase 50/51)
// ---------------------------------------------------------------------------

export async function notifyUser(
  userId: number,
  type: string,
  title: string,
  body: string,
): Promise<void> {
  try {
    await ensureMessagesSchema()
    await query(
      `INSERT INTO message_notifications (user_id, conversation_id, message_id, type, title, body)
       VALUES (?, NULL, NULL, ?, ?, ?)`,
      [userId, type.slice(0, 32), title.slice(0, 200), body.slice(0, 500)],
    )
  } catch (e) {
    console.log("[v0] notifyUser failed:", (e as Error).message)
  }
}

// ---------------------------------------------------------------------------
// Short-lived signed call token (Phase 74) — bound to session + participant.
// ---------------------------------------------------------------------------

function callTokenKey() {
  const secret = process.env.SESSION_SECRET || "dev-only-insecure-secret-change-me"
  return new TextEncoder().encode(secret)
}

export async function issueCallToken(sessionId: number, userId: number): Promise<string> {
  return new SignJWT({ sid: sessionId, uid: userId, scope: "call-signal" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("2h")
    .sign(callTokenKey())
}

export async function verifyCallToken(
  token: string,
): Promise<{ sid: number; uid: number } | null> {
  try {
    const { payload } = await jwtVerify(token, callTokenKey())
    if (payload.scope !== "call-signal") return null
    return { sid: Number(payload.sid), uid: Number(payload.uid) }
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// STUN / TURN (Phase 36/37) — public STUN + optional env-configured TURN.
// No insecure open relay is ever created; TURN is only advertised when the
// operator has provided credentials.
// ---------------------------------------------------------------------------

export function iceServers(): RTCIceServerLike[] {
  const servers: RTCIceServerLike[] = [
    { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] },
  ]
  const turnUrl = process.env.TURN_URL
  if (turnUrl) {
    servers.push({
      urls: turnUrl.split(",").map((s) => s.trim()).filter(Boolean),
      username: process.env.TURN_USERNAME || undefined,
      credential: process.env.TURN_CREDENTIAL || undefined,
    })
  }
  return servers
}

export type RTCIceServerLike = { urls: string | string[]; username?: string; credential?: string }

/**
 * Auto-close ring-timed-out and stale sessions (Phase 44/76/77). Safe to call
 * opportunistically (from the poll endpoint) and from the cron sweep. Returns
 * the ids that were closed so callers can notify.
 */
export async function sweepStaleSessions(): Promise<{ missed: number[]; failed: number[] }> {
  const missed: number[] = []
  const failed: number[] = []

  // Ringing but never answered past the ring timeout -> missed.
  const ringTimedOut = await query<any[]>(
    `SELECT * FROM internal_call_sessions
      WHERE status IN ('calling','ringing')
        AND started_at < (NOW() - INTERVAL ? SECOND)`,
    [Math.round(RING_TIMEOUT_MS / 1000)],
  )
  for (const row of ringTimedOut as CallSessionRow[]) {
    const updated = await endSession(row.id, "missed", "ring_timeout", null)
    if (updated) {
      missed.push(row.id)
      await notifyUser(
        row.receiver_user_id,
        "missed_call",
        "Missed call",
        `You missed a ${row.call_type} call.`,
      )
    }
  }

  // Connected/accepted but no heartbeat progress for a long time -> failed/stale.
  const stale = await query<any[]>(
    `SELECT * FROM internal_call_sessions
      WHERE status IN ('accepted','connecting','connected')
        AND updated_at < (NOW() - INTERVAL ? SECOND)`,
    [Math.round(STALE_MS / 1000)],
  )
  for (const row of stale as CallSessionRow[]) {
    const updated = await endSession(row.id, "failed", "stale_session", null)
    if (updated) failed.push(row.id)
  }

  return { missed, failed }
}
