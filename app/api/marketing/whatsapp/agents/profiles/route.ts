import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { listAgentProfiles, upsertAgentSettings } from "@/lib/whatsapp-platform"

/** Full agent roster with per-agent capability flags (admins only). */
export async function GET() {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (session.role !== "admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const profiles = await listAgentProfiles()
  return NextResponse.json({ profiles })
}

/** Updates one agent's capability flags (admins only). */
export async function POST(request: Request) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (session.role !== "admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const body = (await request.json().catch(() => ({}))) as {
    userId?: number
    settings?: Record<string, boolean>
  }
  const userId = Number(body.userId)
  if (!Number.isInteger(userId) || userId <= 0) {
    return NextResponse.json({ error: "Invalid userId" }, { status: 400 })
  }

  await upsertAgentSettings(userId, body.settings ?? {})
  const profiles = await listAgentProfiles()
  return NextResponse.json({ ok: true, profiles })
}
