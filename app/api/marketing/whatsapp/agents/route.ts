import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { listAgents } from "@/lib/whatsapp-store"
import { WHATSAPP_TEAMS } from "@/lib/whatsapp-shared"

/** Assignable agents + teams for the shared-inbox routing controls. */
export async function GET() {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const agents = await listAgents()
  return NextResponse.json({ agents, teams: WHATSAPP_TEAMS })
}
