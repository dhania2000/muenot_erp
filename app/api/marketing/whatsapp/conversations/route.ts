import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { canManageInbox, inboxScopeFor, listConversations } from "@/lib/whatsapp-store"
import {
  isWhatsAppPriority,
  isWhatsAppStatus,
  isWhatsAppTeam,
  type WhatsAppInboxView,
} from "@/lib/whatsapp-shared"

/** Lists WhatsApp conversations for the shared inbox, newest activity first. */
export async function GET(request: Request) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const url = new URL(request.url)
  const params = url.searchParams

  const search = params.get("search")?.trim() || undefined
  const unreadOnly = params.get("filter") === "unread"

  const viewParam = params.get("view")
  const view: WhatsAppInboxView | undefined =
    viewParam === "mine" || viewParam === "unassigned" || viewParam === "all" ? viewParam : undefined

  const statusParam = params.get("status")
  const status = isWhatsAppStatus(statusParam) ? statusParam : undefined

  const priorityParam = params.get("priority")
  const priority = isWhatsAppPriority(priorityParam) ? priorityParam : undefined

  const teamParam = params.get("team")
  const team = isWhatsAppTeam(teamParam) ? teamParam : undefined

  const agentIdParam = Number(params.get("agentId"))
  const agentId = Number.isInteger(agentIdParam) && agentIdParam > 0 ? agentIdParam : undefined

  const since = params.get("since")?.trim() || undefined

  const scope = inboxScopeFor(session.role, session.userId)
  const conversations = await listConversations(
    { search, unreadOnly, view, status, priority, team, agentId, since },
    scope,
  )

  return NextResponse.json({ conversations, canManage: canManageInbox(session.role), viewerId: session.userId })
}
