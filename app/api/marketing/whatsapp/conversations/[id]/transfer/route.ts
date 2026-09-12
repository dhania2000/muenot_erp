import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { query } from "@/lib/db"
import { assignConversation, canManageInbox, getConversation } from "@/lib/whatsapp-store"
import { resolveWhatsAppCaps, listTransfers, recordTransfer } from "@/lib/whatsapp-platform"
import { setConversationDepartment } from "@/lib/whatsapp-routing"

/** Full transfer history for a conversation. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id } = await params
  const conversationId = Number(id)
  if (!Number.isInteger(conversationId) || conversationId <= 0) {
    return NextResponse.json({ error: "Invalid conversation id" }, { status: 400 })
  }

  const transfers = await listTransfers(conversationId)
  return NextResponse.json({ transfers })
}

/**
 * Transfers a conversation to another department and/or agent, keeping the
 * full history intact and recording an audit trail. Requires the reassign
 * capability (or admin).
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const caps = await resolveWhatsAppCaps(session)
  if (!caps.canReassign && !caps.canAssign && !canManageInbox(session.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  const { id } = await params
  const conversationId = Number(id)
  if (!Number.isInteger(conversationId) || conversationId <= 0) {
    return NextResponse.json({ error: "Invalid conversation id" }, { status: 400 })
  }

  const conversation = await getConversation(conversationId)
  if (!conversation) return NextResponse.json({ error: "Conversation not found" }, { status: 404 })

  const body = (await request.json().catch(() => ({}))) as {
    toDepartmentId?: number | null
    toAgentId?: number | null
    reason?: string | null
  }

  const rows = await query<{ department_id: number | null; assigned_agent_id: number | null }[]>(
    "SELECT department_id, assigned_agent_id FROM `marketing_whatsapp_conversations` WHERE id = ? LIMIT 1",
    [conversationId],
  )
  const fromDepartmentId = rows[0]?.department_id ?? null
  const fromAgentId = rows[0]?.assigned_agent_id ?? null

  const toDepartmentId =
    body.toDepartmentId === null || body.toDepartmentId === undefined ? null : Number(body.toDepartmentId)
  const toAgentId = body.toAgentId === null || body.toAgentId === undefined ? null : Number(body.toAgentId)

  // Apply the department move (validates the department exists).
  if (body.toDepartmentId !== undefined) {
    try {
      await setConversationDepartment(conversationId, toDepartmentId)
    } catch {
      return NextResponse.json({ error: "Department not found" }, { status: 400 })
    }
  }

  // Apply the agent (re)assignment when an agent was chosen.
  if (body.toAgentId !== undefined) {
    await assignConversation({
      conversationId,
      agentId: toAgentId,
      team: null,
      byUserId: session.userId,
      note: body.reason ? String(body.reason).slice(0, 255) : "Transferred",
    })
  }

  await recordTransfer({
    conversationId,
    fromDepartmentId,
    toDepartmentId: body.toDepartmentId !== undefined ? toDepartmentId : fromDepartmentId,
    fromAgentId,
    toAgentId: body.toAgentId !== undefined ? toAgentId : fromAgentId,
    transferredBy: session.userId,
    reason: body.reason ? String(body.reason).slice(0, 500) : null,
  })

  const [updated, transfers] = await Promise.all([
    getConversation(conversationId),
    listTransfers(conversationId),
  ])
  return NextResponse.json({ ok: true, conversation: updated, transfers })
}
