import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { query } from "@/lib/db"
import { userHasFeature } from "@/lib/permissions"
import { ensureMessagesSchema } from "@/lib/messages-ensure"
import {
  audit,
  getEmployeeProfiles,
  getParticipant,
  isConversationAdmin,
  MAX_MESSAGE_LEN,
  notifyParticipants,
  rateLimit,
  sanitizeBody,
} from "@/lib/messages-core"

/**
 * GET /api/messages/[id]?before=<messageId>&limit=30
 * Returns conversation metadata, participants and a page of messages (newest
 * first, ascending in the response). Marks the conversation read for the caller.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session || !(await userHasFeature(session.userId, session.role, "messages.view")))
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  await ensureMessagesSchema()

  const { id } = await params
  const me = await getParticipant(id, session.userId)
  if (!me) return NextResponse.json({ error: "Not found" }, { status: 404 })

  const url = new URL(request.url)
  const before = Number(url.searchParams.get("before")) || 0
  const limit = Math.min(Number(url.searchParams.get("limit")) || 30, 60)

  const conv = (await query<any[]>("SELECT * FROM conversations WHERE id=? LIMIT 1", [id]))[0]

  const participants = await query<any[]>(
    `SELECT p.user_id, p.role, p.last_read_at, p.left_at, u.name, u.email, u.role AS user_role
       FROM conversation_participants p JOIN users u ON u.id = p.user_id
      WHERE p.conversation_id = ? ORDER BY p.role='admin' DESC, u.name ASC`,
    [id],
  )
  const profiles = await getEmployeeProfiles(participants.map((p) => Number(p.user_id)))
  const participantsOut = participants.map((p) => ({
    ...p,
    active: !p.left_at,
    department: profiles.get(Number(p.user_id))?.department || null,
    designation: profiles.get(Number(p.user_id))?.designation || null,
  }))

  const args: any[] = [id]
  let cursor = ""
  if (before) { cursor = "AND m.id < ?"; args.push(before) }
  const rowsDesc = await query<any[]>(
    `SELECT m.*, u.name AS sender_name, u.role AS sender_role,
            rm.body AS reply_body, rm.sender_id AS reply_sender_id, ru.name AS reply_sender_name,
            rm.deleted_at AS reply_deleted
       FROM messages m
       JOIN users u ON u.id = m.sender_id
       LEFT JOIN messages rm ON rm.id = m.reply_to_id
       LEFT JOIN users ru ON ru.id = rm.sender_id
      WHERE m.conversation_id = ? ${cursor}
      ORDER BY m.id DESC LIMIT ?`,
    [...args, limit],
  )
  const hasMore = rowsDesc.length === limit
  const messages = rowsDesc.reverse()

  // Attachments for this page.
  const msgIds = messages.map((m) => m.id)
  let attachments: any[] = []
  if (msgIds.length) {
    attachments = await query<any[]>(
      `SELECT id, message_id, file_name, file_type, file_size FROM message_attachments
         WHERE message_id IN (${msgIds.map(() => "?").join(",")})`,
      msgIds,
    )
  }
  const attByMsg = new Map<number, any[]>()
  for (const a of attachments) {
    const arr = attByMsg.get(a.message_id) || []
    arr.push({ ...a, url: `/api/messages/attachments/${a.id}` })
    attByMsg.set(a.message_id, arr)
  }

  const messagesOut = messages.map((m) => ({
    id: m.id,
    body: m.deleted_at ? null : m.body,
    deleted: !!m.deleted_at,
    sender_id: m.sender_id,
    sender_name: m.sender_name,
    sender_role: m.sender_role,
    created_at: m.created_at,
    edited_at: m.edited_at,
    message_type: m.message_type,
    importance: m.importance,
    source_module: m.source_module,
    source_record_id: m.source_record_id,
    source_label: m.source_label,
    reply_to_id: m.reply_to_id,
    reply: m.reply_to_id
      ? { id: m.reply_to_id, body: m.reply_deleted ? null : m.reply_body, sender_name: m.reply_sender_name }
      : null,
    attachments: attByMsg.get(m.id) || [],
    mine: m.sender_id === session.userId,
  }))

  // Mark read for the caller.
  await query("UPDATE conversation_participants SET last_read_at = NOW() WHERE conversation_id=? AND user_id=?", [
    id,
    session.userId,
  ])
  // Clear this conversation's notifications for the caller.
  await query("UPDATE message_notifications SET is_read=1 WHERE user_id=? AND conversation_id=?", [session.userId, id]).catch(
    () => {},
  )

  return NextResponse.json({
    conversation: {
      id: conv.id,
      type: conv.type || "direct",
      title:
        conv.type === "direct"
          ? participantsOut.find((p) => p.user_id !== session.userId)?.name || conv.subject || "Conversation"
          : conv.name || conv.subject || "Group",
      name: conv.name,
      description: conv.description,
      photo_url: conv.photo_url,
      department: conv.department,
      status: conv.status,
      created_by: conv.created_by,
    },
    myRole: me.role,
    isMuted: !!me.is_muted,
    isPinned: !!me.is_pinned,
    isArchived: !!me.is_archived,
    notifSetting: me.notif_setting,
    participants: participantsOut,
    messages: messagesOut,
    hasMore,
  })
}

/**
 * POST /api/messages/[id]
 * Sends a message. Supports reply_to_id, importance, attachmentIds (pre-uploaded),
 * mentionIds, message_type ('text' | 'announcement') and ERP source linking.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session || !(await userHasFeature(session.userId, session.role, "messages.send")))
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  await ensureMessagesSchema()

  const { id } = await params
  const me = await getParticipant(id, session.userId)
  if (!me) return NextResponse.json({ error: "Not found" }, { status: 404 })

  if (!rateLimit(`send:${session.userId}`, 30, 10_000))
    return NextResponse.json({ error: "You are sending messages too quickly." }, { status: 429 })

  const body = await request.json().catch(() => ({}))
  const text = sanitizeBody(body.body)
  const attachmentIds: number[] = Array.from(new Set((body.attachmentIds || []).map((n: any) => Number(n)).filter(Boolean)))
  if (!text && !attachmentIds.length)
    return NextResponse.json({ error: "Message is empty" }, { status: 400 })
  if (text.length > MAX_MESSAGE_LEN)
    return NextResponse.json({ error: "Message too long" }, { status: 400 })

  let messageType = body.message_type === "announcement" ? "announcement" : "text"
  if (messageType === "announcement" && !(await isConversationAdmin(id, session))) messageType = "text"
  const importance = ["normal", "important", "urgent"].includes(body.importance) ? body.importance : "normal"
  const replyToId = Number(body.reply_to_id) || null
  if (replyToId) {
    const ok = (await query<any[]>("SELECT id FROM messages WHERE id=? AND conversation_id=? LIMIT 1", [replyToId, id]))[0]
    if (!ok) return NextResponse.json({ error: "Invalid reply target" }, { status: 400 })
  }

  await query(
    `INSERT INTO messages (conversation_id, sender_id, body, message_type, importance, reply_to_id,
       source_module, source_record_id, source_label, has_attachment)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [
      id,
      session.userId,
      text,
      messageType,
      importance,
      replyToId,
      body.source_module ? String(body.source_module).slice(0, 48) : null,
      body.source_record_id ? String(body.source_record_id).slice(0, 64) : null,
      body.source_label ? String(body.source_label).slice(0, 200) : null,
      attachmentIds.length ? 1 : 0,
    ],
  )
  const msg = (await query<any[]>("SELECT LAST_INSERT_ID() id"))[0]

  if (attachmentIds.length) {
    await query(
      `UPDATE message_attachments SET message_id=? WHERE id IN (${attachmentIds.map(() => "?").join(",")})
         AND conversation_id=? AND uploaded_by=? AND message_id IS NULL`,
      [msg.id, ...attachmentIds, id, session.userId],
    )
  }

  await query("UPDATE conversations SET last_message_at = NOW() WHERE id=?", [id])
  await query("UPDATE conversation_participants SET last_read_at = NOW() WHERE conversation_id=? AND user_id=?", [
    id,
    session.userId,
  ])
  // Re-surface the thread for anyone who archived it.
  await query("UPDATE conversation_participants SET is_archived=0 WHERE conversation_id=? AND is_archived=1", [id]).catch(
    () => {},
  )

  const preview = text ? text.slice(0, 120) : "Sent an attachment"
  const mentionIds: number[] = Array.from(new Set((body.mentionIds || []).map((n: any) => Number(n)).filter(Boolean)))
  if (mentionIds.length) {
    await notifyParticipants({
      conversationId: Number(id),
      messageId: msg.id,
      actorId: session.userId,
      type: "mention",
      title: `${session.name} mentioned you`,
      body: preview,
      onlyUserIds: mentionIds,
    })
  }
  await notifyParticipants({
    conversationId: Number(id),
    messageId: msg.id,
    actorId: session.userId,
    type: messageType === "announcement" ? "announcement" : replyToId ? "reply" : "message",
    title: session.name,
    body: preview,
    onlyUserIds: mentionIds.length ? undefined : undefined,
  })

  return NextResponse.json({ id: msg.id }, { status: 201 })
}

/**
 * PATCH /api/messages/[id]
 * Conversation-level actions: pin, mute, archive, notif, rename, updateInfo,
 * leave, addMembers, removeMembers, setRole, archiveConversation (admin).
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  await ensureMessagesSchema()

  const { id } = await params
  const me = await getParticipant(id, session.userId)
  if (!me) return NextResponse.json({ error: "Not found" }, { status: 404 })

  const body = await request.json().catch(() => ({}))
  const action = String(body.action || "")

  // Per-user preferences — always allowed for the caller's own row.
  if (action === "pin" || action === "mute" || action === "archive") {
    const col = action === "pin" ? "is_pinned" : action === "mute" ? "is_muted" : "is_archived"
    await query(`UPDATE conversation_participants SET ${col}=? WHERE conversation_id=? AND user_id=?`, [
      body.value ? 1 : 0,
      id,
      session.userId,
    ])
    return NextResponse.json({ success: true })
  }
  if (action === "notif") {
    const setting = ["all", "mentions", "none"].includes(body.value) ? body.value : "all"
    await query("UPDATE conversation_participants SET notif_setting=? WHERE conversation_id=? AND user_id=?", [
      setting,
      id,
      session.userId,
    ])
    return NextResponse.json({ success: true })
  }
  if (action === "markUnread") {
    await query("UPDATE conversation_participants SET last_read_at=NULL WHERE conversation_id=? AND user_id=?", [
      id,
      session.userId,
    ])
    return NextResponse.json({ success: true })
  }
  if (action === "leave") {
    await query("UPDATE conversation_participants SET left_at=NOW() WHERE conversation_id=? AND user_id=?", [
      id,
      session.userId,
    ])
    await audit("member_left", session, { conversationId: Number(id) })
    return NextResponse.json({ success: true })
  }

  // Group-admin-only actions below.
  const canManage = await isConversationAdmin(id, session)
  if (!canManage) return NextResponse.json({ error: "Admin only" }, { status: 403 })

  if (action === "rename" || action === "updateInfo") {
    await query("UPDATE conversations SET name=COALESCE(?, name), description=COALESCE(?, description), photo_url=COALESCE(?, photo_url) WHERE id=?", [
      body.name ? String(body.name).slice(0, 200) : null,
      body.description !== undefined ? sanitizeBody(body.description) : null,
      body.photoUrl || null,
      id,
    ])
    await audit("conversation_updated", session, { conversationId: Number(id), detail: body.name || "info" })
    return NextResponse.json({ success: true })
  }
  if (action === "addMembers") {
    const ids = Array.from(new Set((body.memberIds || []).map((n: any) => Number(n)).filter(Boolean)))
    for (const uid of ids) {
      await query(
        `INSERT INTO conversation_participants (conversation_id, user_id, role) VALUES (?,?, 'member')
         ON DUPLICATE KEY UPDATE left_at=NULL`,
        [id, uid],
      )
    }
    await audit("members_added", session, { conversationId: Number(id), detail: `${ids.length} member(s)` })
    await notifyParticipants({
      conversationId: Number(id),
      actorId: session.userId,
      type: "group_added",
      title: "Added to group",
      body: `${session.name} added you to the group`,
      onlyUserIds: ids as number[],
    })
    return NextResponse.json({ success: true })
  }
  if (action === "removeMembers") {
    const ids = Array.from(new Set((body.memberIds || []).map((n: any) => Number(n)).filter(Boolean)))
    if (ids.length)
      await query(
        `UPDATE conversation_participants SET left_at=NOW() WHERE conversation_id=? AND user_id IN (${ids
          .map(() => "?")
          .join(",")})`,
        [id, ...ids],
      )
    await audit("members_removed", session, { conversationId: Number(id), detail: `${ids.length} member(s)` })
    return NextResponse.json({ success: true })
  }
  if (action === "setRole") {
    const target = Number(body.userId)
    const role = body.role === "admin" ? "admin" : "member"
    await query("UPDATE conversation_participants SET role=? WHERE conversation_id=? AND user_id=?", [role, id, target])
    await audit("role_changed", session, { conversationId: Number(id), detail: `user ${target} -> ${role}` })
    return NextResponse.json({ success: true })
  }
  if (action === "archiveConversation") {
    await query("UPDATE conversations SET status=? WHERE id=?", [body.value ? "archived" : "active", id])
    await audit("conversation_status", session, { conversationId: Number(id), detail: body.value ? "archived" : "active" })
    return NextResponse.json({ success: true })
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 })
}
