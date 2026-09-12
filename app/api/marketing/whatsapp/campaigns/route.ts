import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { createCampaign, listCampaigns } from "@/lib/whatsapp-campaigns"
import { resolveWhatsAppCaps } from "@/lib/whatsapp-platform"

/** Lists all campaigns with their delivery counters. */
export async function GET() {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const campaigns = await listCampaigns()
  return NextResponse.json({ campaigns })
}

/** Creates a campaign (draft, or scheduled when scheduledAt is set). */
export async function POST(request: Request) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const caps = await resolveWhatsAppCaps(session)
  if (!caps.canCreateCampaigns) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const body = (await request.json().catch(() => ({}))) as {
    name?: string
    type?: string
    departmentId?: number | null
    audienceId?: number | null
    templateName?: string
    templateLanguage?: string
    variables?: string[]
    mediaLink?: string | null
    headerMediaId?: string | null
    scheduledAt?: string | null
  }
  if (!body.name?.trim()) return NextResponse.json({ error: "Name is required" }, { status: 400 })
  if (!body.templateName?.trim()) return NextResponse.json({ error: "Template is required" }, { status: 400 })

  const id = await createCampaign({
    name: body.name,
    type: body.type,
    departmentId: body.departmentId ?? null,
    audienceId: body.audienceId ?? null,
    templateName: body.templateName,
    templateLanguage: body.templateLanguage,
    variables: Array.isArray(body.variables) ? body.variables : [],
    mediaLink: body.mediaLink ?? null,
    headerMediaId: body.headerMediaId ?? null,
    scheduledAt: body.scheduledAt ?? null,
    createdBy: session.userId,
  })
  const campaigns = await listCampaigns()
  return NextResponse.json({ ok: true, id, campaigns }, { status: 201 })
}
