import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { assignConversation, canManageInbox, getConversation } from "@/lib/whatsapp-store"
import { isWhatsAppTeam } from "@/lib/whatsapp-shared"

/**
 * Assigns / reassigns / unassigns a conversation in the shared inbox.
 *
 * RBAC:
 *  - Admins may route to any agent or team, or unassign.
 *  - Employees may only "claim" a conversation (assign it to themselves) or
 *    release one currently assigned to them. This keeps the number shared
 *    while preventing an agent from grabbing another agent's thread.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id } = await params
  const conversationId = Number(id)
  if (!Number.isInteger(conversationId) || conversationId <= 0) {
    return NextResponse.json({ error: "Invalid conversation id" }, { status: 400 })
  }

  const conversation = await getConversation(conversationId)
  if (!conversation) return NextResponse.json({ error: "Conversation not found" }, { status: 404 })

  const body = (await request.json().catch(() => ({}))) as {
    agentId?: number | null
    team?: string | null
    note?: string | null
  }

  const agentId = body.agentId === null || body.agentId === undefined ? null : Number(body.agentId)
  if (agentId !== null && (!Number.isInteger(agentId) || agentId <= 0)) {
    return NextResponse.json({ error: "Invalid agentId" }, { status: 400 })
  }
  const team = body.team ? String(body.team) : null
  if (team !== null && !isWhatsAppTeam(team)) {
    return NextResponse.json({ error: "Invalid team" }, { status: 400 })
  }

  const isManager = canManageInbox(session.role)
  if (!isManager) {
    // Employees can only claim for themselves, or release their own claim.
    const claimingSelf = agentId === session.userId && team === null
    const releasingOwn =
      agentId === null && team === null && conversation.assignedAgentId === session.userId
    if (!claimingSelf && !releasingOwn) {
      return NextResponse.json(
        { error: "You can only claim a conversation for yourself or release your own." },
        { status: 403 },
      )
    }
  }

  await assignConversation({
    conversationId,
    agentId,
    team,
    byUserId: session.userId,
    note: body.note ? String(body.note).slice(0, 255) : null,
  })

  const updated = await getConversation(conversationId)
  return NextResponse.json({ ok: true, conversation: updated })
}
