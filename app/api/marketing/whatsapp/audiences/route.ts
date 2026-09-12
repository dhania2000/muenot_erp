import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { createAudience, listAudiences } from "@/lib/whatsapp-audiences"
import { resolveWhatsAppCaps } from "@/lib/whatsapp-platform"

/** Lists saved audience segments. */
export async function GET() {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const audiences = await listAudiences()
  return NextResponse.json({ audiences })
}

/** Creates an audience segment (requires campaign capability). */
export async function POST(request: Request) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const caps = await resolveWhatsAppCaps(session)
  if (!caps.canCreateCampaigns) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const body = (await request.json().catch(() => ({}))) as {
    name?: string
    description?: string | null
    filter?: unknown
  }
  if (!body.name?.trim()) return NextResponse.json({ error: "Name is required" }, { status: 400 })

  const id = await createAudience({
    name: body.name,
    description: body.description ?? null,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    filter: (body.filter ?? { match: "all", conditions: [] }) as any,
    createdBy: session.userId,
  })
  const audiences = await listAudiences()
  return NextResponse.json({ ok: true, id, audiences }, { status: 201 })
}
