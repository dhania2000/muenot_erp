import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { listConversations } from "@/lib/whatsapp-store"

/** Lists WhatsApp conversations for the inbox, newest activity first. */
export async function GET(request: Request) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const url = new URL(request.url)
  const search = url.searchParams.get("search")?.trim() || undefined
  const unreadOnly = url.searchParams.get("filter") === "unread"

  const conversations = await listConversations({ search, unreadOnly })
  return NextResponse.json({ conversations })
}
