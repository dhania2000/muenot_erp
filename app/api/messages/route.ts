import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { query } from "@/lib/db"
import { userHasFeature } from "@/lib/permissions"
import { ensureMessagesSchema } from "@/lib/messages-ensure"
import {
  audit,
  canMessageUser,
  directKey,
  getMyDepartment,
  notifyParticipants,
  rateLimit,
  sanitizeBody,
} from "@/lib/messages-core"

/**
 * GET /api/messages
 * Lists the caller's conversations (direct, group, department, management) with
 * last message, unread count and per-user pin/mute/archive state. Supports
 * ?filter=unread|direct|group|department|management|important|attachments,
 * ?archived=1 and ?q=<search>. All access is scoped to the caller server-side.
 */
export async function GET(request: Request) {
  const session = await getSession()
  if (!session || !(await userHasFeature(session.userId, session.role, "messages.view")))
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  await ensureMessagesSchema()

  const url = new URL(request.url)
  const filter = url.searchParams.get("filter") || "all"
  const archived = url.searchParams.get("archived") === "1"
  const q = (url.searchParams.get("q") || "").trim()

  const where: string[] = ["p.user_id = ?", "p.left_at IS NULL"]
  const args: any[] = [session.userId]
  where.push(archived ? "p.is_archived = 1" : "p.is_archived = 0")

  if (filter === "direct" || filter === "group" || filter === "department" || filter === "management")
    { where.push("c.type = ?"); args.push(filter) }

  const rows = await query<any[]>(
    `SELECT c.id, c.type, c.subject, c.name, c.description, c.photo_url, c.department,
            c.status, c.created_by, c.updated_at, c.last_message_at,
            p.role AS my_role, p.is_pinned, p.is_muted, p.is_archived, p.last_read_at,
            lm.body AS last_message, lm.created_at AS last_message_time,
            lm.message_type AS last_message_type, lm.deleted_at AS last_deleted,
            lm.importance AS last_importance, lu.name AS last_sender,
            (SELECT COUNT(*) FROM messages mx
               WHERE mx.conversation_id = c.id AND mx.sender_id <> ? AND mx.deleted_at IS NULL
                 AND (p.last_read_at IS NULL OR mx.created_at > p.last_read_at)) AS unread,
            (SELECT u2.name FROM conversation_participants p2
               JOIN users u2 ON u2.id = p2.user_id
              WHERE p2.conversation_id = c.id AND p2.user_id <> ? AND p2.left_at IS NULL
              LIMIT 1) AS peer_name,
            (SELECT p2.user_id FROM conversation_participants p2
              WHERE p2.conversation_id = c.id AND p2.user_id <> ? AND p2.left_at IS NULL
              LIMIT 1) AS peer_id
       FROM conversations c
       JOIN conversation_participants p ON p.conversation_id = c.id
       LEFT JOIN messages lm ON lm.id = (SELECT MAX(id) FROM messages WHERE conversation_id = c.id)
       LEFT JOIN users lu ON lu.id = lm.sender_id
      WHERE ${where.join(" AND ")}
      ORDER BY p.is_pinned DESC, COALESCE(c.last_message_at, c.updated_at) DESC`,
    [session.userId, session.userId, session.userId, ...args],
  )

  let list = rows.map((r) => ({
    ...r,
    title: r.type === "direct" ? r.peer_name || r.subject || "Conversation" : r.name || r.subject || "Group",
    unread: Number(r.unread) || 0,
  }))

  if (filter === "unread") list = list.filter((r) => r.unread > 0)
  if (filter === "important") list = list.filter((r) => r.last_importance && r.last_importance !== "normal")
  if (filter === "attachments") {
    const ids = list.map((r) => r.id)
    if (ids.length) {
      const withAtt = await query<any[]>(
        `SELECT DISTINCT conversation_id FROM message_attachments WHERE conversation_id IN (${ids.map(() => "?").join(",")})`,
        ids,
      )
      const set = new Set(withAtt.map((a) => a.conversation_id))
      list = list.filter((r) => set.has(r.id))
    } else list = []
  }
  if (q) {
    const needle = q.toLowerCase()
    list = list.filter(
      (r) =>
        (r.title || "").toLowerCase().includes(needle) ||
        (r.last_message || "").toLowerCase().includes(needle),
    )
  }

  return NextResponse.json({ conversations: list })
}

/**
 * POST /api/messages
 * Creates a conversation. body.type: direct | group | department | management.
 * Direct chats are de-duplicated per user pair (Phase 11/12). Group/department/
 * management creation is permission gated (Phase 7/44/52).
 */
export async function POST(request: Request) {
  const session = await getSession()
  if (!session || !(await userHasFeature(session.userId, session.role, "messages.send")))
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  await ensureMessagesSchema()

  if (!rateLimit(`create:${session.userId}`, 20, 60_000))
    return NextResponse.json({ error: "Too many new conversations. Please slow down." }, { status: 429 })

  const body = await request.json().catch(() => ({}))
  const type = String(body.type || "direct")

  // ---- DIRECT --------------------------------------------------------------
  if (type === "direct") {
    const recipientId = Number(body.recipientId)
    if (!recipientId || recipientId === session.userId)
      return NextResponse.json({ error: "Valid recipient required" }, { status: 400 })
    const recipient = (await query<any[]>("SELECT id, role, name FROM users WHERE id=? AND status='active' LIMIT 1", [recipientId]))[0]
    if (!recipient) return NextResponse.json({ error: "Recipient unavailable" }, { status: 404 })
    if (!(await canMessageUser(session, recipient.role)))
      return NextResponse.json({ error: "Messaging permission denied" }, { status: 403 })

    const key = directKey(session.userId, recipientId)
    const existing = (await query<any[]>("SELECT id FROM conversations WHERE direct_key=? LIMIT 1", [key]))[0]
    if (existing) {
      // Re-activate my participation if I had archived/left it.
      await query(
        "UPDATE conversation_participants SET is_archived=0, left_at=NULL WHERE conversation_id=? AND user_id=?",
        [existing.id, session.userId],
      )
      return NextResponse.json({ id: existing.id, reused: true }, { status: 200 })
    }

    await query(
      "INSERT INTO conversations (type, subject, created_by, direct_key, last_message_at) VALUES ('direct', ?, ?, ?, NOW())",
      [body.subject || null, session.userId, key],
    )
    const conv = (await query<any[]>("SELECT LAST_INSERT_ID() id"))[0]
    await query(
      "INSERT INTO conversation_participants (conversation_id, user_id, role) VALUES (?,?, 'member'), (?,?, 'member')",
      [conv.id, session.userId, conv.id, recipientId],
    )
    await audit("conversation_created", session, { conversationId: conv.id, detail: `direct with ${recipient.name}` })
    return NextResponse.json({ id: conv.id }, { status: 201 })
  }

  // ---- GROUP ---------------------------------------------------------------
  if (type === "group") {
    const name = String(body.name || "").trim()
    if (name.length < 2 || name.length > 200)
      return NextResponse.json({ error: "Group name required (2-200 chars)" }, { status: 400 })
    const memberIds = Array.from(new Set((body.memberIds || []).map((n: any) => Number(n)).filter(Boolean)))
    if (!memberIds.length) return NextResponse.json({ error: "Select at least one member" }, { status: 400 })
    const adminIds = new Set<number>((body.adminIds || []).map((n: any) => Number(n)))

    await query(
      "INSERT INTO conversations (type, name, description, photo_url, created_by, last_message_at) VALUES ('group', ?, ?, ?, ?, NOW())",
      [name, sanitizeBody(body.description) || null, body.photoUrl || null, session.userId],
    )
    const conv = (await query<any[]>("SELECT LAST_INSERT_ID() id"))[0]
    const all = new Set<number>([session.userId, ...memberIds])
    const values: any[] = []
    for (const uid of all) values.push(conv.id, uid, uid === session.userId || adminIds.has(uid) ? "admin" : "member")
    await query(
      `INSERT INTO conversation_participants (conversation_id, user_id, role) VALUES ${[...all].map(() => "(?,?,?)").join(",")}`,
      values,
    )
    await audit("conversation_created", session, { conversationId: conv.id, detail: `group "${name}"` })
    await notifyParticipants({
      conversationId: conv.id,
      actorId: session.userId,
      type: "group_added",
      title: `Added to ${name}`,
      body: `${session.name} added you to the group "${name}"`,
    })
    return NextResponse.json({ id: conv.id }, { status: 201 })
  }

  // ---- DEPARTMENT ----------------------------------------------------------
  if (type === "department") {
    // Admins may target any department; employees may only create their own.
    let dept = String(body.department || "").trim()
    if (session.role !== "admin") {
      const mine = await getMyDepartment(session)
      if (!mine) return NextResponse.json({ error: "No department on your HR record" }, { status: 400 })
      dept = mine
    }
    if (!dept) return NextResponse.json({ error: "Department required" }, { status: 400 })

    const existing = (await query<any[]>("SELECT id FROM conversations WHERE type='department' AND department=? LIMIT 1", [dept]))[0]
    let convId: number
    if (existing) convId = existing.id
    else {
      await query(
        "INSERT INTO conversations (type, name, department, created_by, last_message_at) VALUES ('department', ?, ?, ?, NOW())",
        [`${dept} Department`, dept, session.userId],
      )
      convId = (await query<any[]>("SELECT LAST_INSERT_ID() id"))[0].id
      await audit("conversation_created", session, { conversationId: convId, detail: `department "${dept}"` })
    }
    // Sync department members from HR Employee Master (reuse, never duplicate).
    const members = await query<any[]>(
      `SELECT DISTINCT u.id FROM users u
         JOIN hr_employees e ON (e.official_email = u.email OR e.personal_email = u.email)
        WHERE e.department = ? AND u.status = 'active'`,
      [dept],
    )
    const memberIds = new Set<number>([session.userId, ...members.map((m) => Number(m.id))])
    for (const uid of memberIds) {
      await query(
        `INSERT INTO conversation_participants (conversation_id, user_id, role)
         VALUES (?,?, ?) ON DUPLICATE KEY UPDATE left_at = NULL`,
        [convId, uid, uid === session.userId && session.role === "admin" ? "admin" : "member"],
      )
    }
    return NextResponse.json({ id: convId, reused: !!existing }, { status: existing ? 200 : 201 })
  }

  // ---- MANAGEMENT ----------------------------------------------------------
  if (type === "management") {
    if (session.role !== "admin")
      return NextResponse.json({ error: "Only management can create management conversations" }, { status: 403 })
    const name = String(body.name || "Management").trim()
    const extra = Array.from(new Set((body.memberIds || []).map((n: any) => Number(n)).filter(Boolean)))
    // Default audience = all admins (management), plus any explicitly selected users.
    const admins = await query<any[]>("SELECT id FROM users WHERE role='admin' AND status='active'")
    await query(
      "INSERT INTO conversations (type, name, created_by, last_message_at) VALUES ('management', ?, ?, NOW())",
      [name, session.userId],
    )
    const conv = (await query<any[]>("SELECT LAST_INSERT_ID() id"))[0]
    const all = new Set<number>([session.userId, ...admins.map((a) => Number(a.id)), ...extra])
    const values: any[] = []
    for (const uid of all) values.push(conv.id, uid, admins.some((a) => Number(a.id) === uid) ? "admin" : "member")
    await query(
      `INSERT INTO conversation_participants (conversation_id, user_id, role) VALUES ${[...all].map(() => "(?,?,?)").join(",")}`,
      values,
    )
    await audit("conversation_created", session, { conversationId: conv.id, detail: `management "${name}"` })
    return NextResponse.json({ id: conv.id }, { status: 201 })
  }

  return NextResponse.json({ error: "Unsupported conversation type" }, { status: 400 })
}
