import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { deleteAudience, listAudiences, updateAudience } from "@/lib/whatsapp-audiences"
import { resolveWhatsAppCaps } from "@/lib/whatsapp-platform"

function parseId(id: string): number | null {
  const n = Number(id)
  return Number.isInteger(n) && n > 0 ? n : null
}

/** Updates an audience segment (requires campaign capability). */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const caps = await resolveWhatsAppCaps(session)
  if (!caps.canCreateCampaigns) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const { id } = await params
  const audienceId = parseId(id)
  if (!audienceId) return NextResponse.json({ error: "Invalid id" }, { status: 400 })

  const body = (await request.json().catch(() => ({}))) as {
    name?: string
    description?: string | null
    filter?: unknown
  }
  await updateAudience(audienceId, {
    name: body.name,
    description: body.description,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    filter: body.filter as any,
  })
  const audiences = await listAudiences()
  return NextResponse.json({ ok: true, audiences })
}

/** Deletes an audience segment (requires campaign capability). */
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const caps = await resolveWhatsAppCaps(session)
  if (!caps.canCreateCampaigns) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const { id } = await params
  const audienceId = parseId(id)
  if (!audienceId) return NextResponse.json({ error: "Invalid id" }, { status: 400 })

  await deleteAudience(audienceId)
  const audiences = await listAudiences()
  return NextResponse.json({ ok: true, audiences })
}
