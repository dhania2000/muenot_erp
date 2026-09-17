import "server-only"
import { query } from "@/lib/db"
import type { SessionPayload } from "@/lib/auth"

export const MAX_MESSAGE_LEN = 5000
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024 // 25 MB

export const ALLOWED_ATTACHMENT_EXT = [
  "pdf", "doc", "docx", "xls", "xlsx", "csv", "ppt", "pptx",
  "png", "jpg", "jpeg", "gif", "webp", "zip", "txt",
]

export type ParticipantState = {
  conversation_id: number
  user_id: number
  role: "member" | "admin"
  is_pinned: number
  is_muted: number
  is_archived: number
  notif_setting: string
  last_read_at: string | null
  left_at: string | null
}

/**
 * Server-side authorization gate (Phase 53/54). Returns the caller's active
 * participant row for a conversation, or null when they are not an active
 * member. Never trust conversationIds from the client without this.
 */
export async function getParticipant(
  conversationId: number | string,
  userId: number,
): Promise<ParticipantState | null> {
  const rows = await query<ParticipantState[]>(
    `SELECT * FROM conversation_participants
       WHERE conversation_id = ? AND user_id = ? AND left_at IS NULL LIMIT 1`,
    [conversationId, userId],
  )
  return rows[0] || null
}

/** True when the caller can moderate the conversation (group admin or ERP admin). */
export async function isConversationAdmin(
  conversationId: number | string,
  session: SessionPayload,
): Promise<boolean> {
  if (session.role === "admin") return true
  const p = await getParticipant(conversationId, session.userId)
  return !!p && p.role === "admin"
}

/** Stable dedupe key for a direct conversation between two users. */
export function directKey(a: number, b: number): string {
  const [lo, hi] = a < b ? [a, b] : [b, a]
  return `${lo}-${hi}`
}

/** Write an audit record (Phase 55). Best-effort; never blocks the caller. */
export async function audit(
  action: string,
  session: SessionPayload,
  opts: { conversationId?: number | null; messageId?: number | null; detail?: string } = {},
): Promise<void> {
  try {
    await query(
      `INSERT INTO message_audit (action, conversation_id, message_id, actor_id, actor_name, detail)
       VALUES (?,?,?,?,?,?)`,
      [
        action,
        opts.conversationId ?? null,
        opts.messageId ?? null,
        session.userId,
        session.name || null,
        opts.detail ? opts.detail.slice(0, 500) : null,
      ],
    )
  } catch (e) {
    console.log("[v0] audit failed:", (e as Error).message)
  }
}

/**
 * Fan-out in-app notifications (Phase 29). Skips the actor and any recipient who
 * muted the conversation (Phase 27) or set mentions-only when this is not a
 * mention. Best-effort.
 */
export async function notifyParticipants(opts: {
  conversationId: number
  messageId?: number | null
  actorId: number
  type: "message" | "mention" | "reply" | "group_added" | "group_removed" | "announcement"
  title: string
  body: string
  onlyUserIds?: number[]
}): Promise<void> {
  try {
    let recipients: { user_id: number; notif_setting: string; is_muted: number }[]
    if (opts.onlyUserIds && opts.onlyUserIds.length) {
      recipients = await query<any[]>(
        `SELECT user_id, notif_setting, is_muted FROM conversation_participants
           WHERE conversation_id = ? AND user_id IN (${opts.onlyUserIds.map(() => "?").join(",")}) AND left_at IS NULL`,
        [opts.conversationId, ...opts.onlyUserIds],
      )
    } else {
      recipients = await query<any[]>(
        `SELECT user_id, notif_setting, is_muted FROM conversation_participants
           WHERE conversation_id = ? AND left_at IS NULL`,
        [opts.conversationId],
      )
    }
    const isMention = opts.type === "mention" || opts.type === "announcement"
    const rows = recipients.filter((r) => {
      if (r.user_id === opts.actorId) return false
      if (r.notif_setting === "none") return false
      if (r.is_muted && !isMention) return false
      if (r.notif_setting === "mentions" && !isMention) return false
      return true
    })
    if (!rows.length) return
    const values = rows.map((r) => [r.user_id, opts.conversationId, opts.messageId ?? null, opts.type, opts.title.slice(0, 200), opts.body.slice(0, 500)])
    await query(
      `INSERT INTO message_notifications (user_id, conversation_id, message_id, type, title, body)
       VALUES ${values.map(() => "(?,?,?,?,?,?)").join(",")}`,
      values.flat(),
    )
  } catch (e) {
    console.log("[v0] notifyParticipants failed:", (e as Error).message)
  }
}

// ---------------------------------------------------------------------------
// Rate limiting (Phase 59/60) — lightweight per-process sliding window.
// ---------------------------------------------------------------------------
declare global {
  // eslint-disable-next-line no-var
  var __msgRate: Map<string, number[]> | undefined
}
const rateStore = globalThis.__msgRate ?? new Map<string, number[]>()
globalThis.__msgRate = rateStore

/** Returns true when the action is allowed, false when the limit is exceeded. */
export function rateLimit(key: string, max: number, windowMs: number): boolean {
  const now = Date.now()
  const hits = (rateStore.get(key) || []).filter((t) => now - t < windowMs)
  if (hits.length >= max) {
    rateStore.set(key, hits)
    return false
  }
  hits.push(now)
  rateStore.set(key, hits)
  return true
}

/**
 * Enrich users with their HR Employee Master record (Phase 42). We reuse the
 * existing hr_employees table instead of duplicating any employee data, matching
 * on official/personal email. Returns a map keyed by user id.
 */
export async function getEmployeeProfiles(
  userIds: number[],
): Promise<Map<number, { department: string | null; designation: string | null; employee_id: string | null }>> {
  const map = new Map<number, { department: string | null; designation: string | null; employee_id: string | null }>()
  if (!userIds.length) return map
  const rows = await query<any[]>(
    `SELECT u.id AS user_id, e.department, e.designation, e.employee_id
       FROM users u
       LEFT JOIN hr_employees e
         ON (e.official_email = u.email OR e.personal_email = u.email)
      WHERE u.id IN (${userIds.map(() => "?").join(",")})`,
    userIds,
  )
  for (const r of rows) {
    if (!map.has(Number(r.user_id))) {
      map.set(Number(r.user_id), { department: r.department, designation: r.designation, employee_id: r.employee_id })
    }
  }
  return map
}

/** Resolve the caller's department from the HR Employee Master. */
export async function getMyDepartment(session: SessionPayload): Promise<string | null> {
  const rows = await query<any[]>(
    `SELECT e.department FROM users u
       LEFT JOIN hr_employees e ON (e.official_email = u.email OR e.personal_email = u.email)
      WHERE u.id = ? LIMIT 1`,
    [session.userId],
  )
  return rows[0]?.department || null
}

/** Whether the caller may send to a target user, honouring message_permissions. */
export async function canMessageUser(session: SessionPayload, targetRole: string): Promise<boolean> {
  if (session.role === "admin") return true
  const permission =
    (await query<any[]>("SELECT * FROM message_permissions WHERE employee_id=? LIMIT 1", [session.userId]))[0] ||
    { can_message_employees: true, can_message_admins: true, can_message_management: true }
  if (targetRole === "employee" && !permission.can_message_employees) return false
  if (targetRole === "admin" && !permission.can_message_admins) return false
  return true
}

/** Basic XSS-safe normalisation. We store raw text and escape at render time,
 *  but strip control chars and cap length here defensively (Phase 58). */
export function sanitizeBody(input: unknown): string {
  return String(input ?? "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .trim()
    .slice(0, MAX_MESSAGE_LEN)
}
