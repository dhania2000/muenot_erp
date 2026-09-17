import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { query } from "@/lib/db"
import { userHasFeature } from "@/lib/permissions"
import { ensureMessagesSchema } from "@/lib/messages-ensure"

/**
 * GET /api/messages/search?q=&conversationId=
 * Full-text-ish search across the caller's conversations. When conversationId
 * is provided the search is scoped to that thread. Only conversations the
 * caller actively participates in are ever searched (Phase 32/33).
 */
export async function GET(request: Request) {
  const session = await getSession()
  if (!session || !(await userHasFeature(session.userId, session.role, "messages.view")))
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  await ensureMessagesSchema()

  const url = new URL(request.url)
  const q = (url.searchParams.get("q") || "").trim()
  const conversationId = Number(url.searchParams.get("conversationId")) || 0
  if (q.length < 2) return NextResponse.json({ results: [] })
  const like = `%${q}%`

  const args: any[] = [session.userId, like]
  let scope = ""
  if (conversationId) { scope = "AND m.conversation_id = ?"; args.push(conversationId) }

  const results = await query<any[]>(
    `SELECT m.id, m.conversation_id, m.body, m.created_at, u.name AS sender_name,
            c.type, c.name AS group_name, c.subject
       FROM messages m
       JOIN conversation_participants p ON p.conversation_id = m.conversation_id AND p.user_id = ? AND p.left_at IS NULL
       JOIN users u ON u.id = m.sender_id
       JOIN conversations c ON c.id = m.conversation_id
      WHERE m.deleted_at IS NULL AND m.body LIKE ? ${scope}
      ORDER BY m.created_at DESC LIMIT 50`,
    args,
  )
  return NextResponse.json({ results })
}
