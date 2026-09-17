import { NextResponse } from "next/server"
import { requireFeature } from "@/lib/api-auth"
import {
  ensureCampaignSchema,
  getCampaign,
  previewAudience,
  audienceOf,
  type AudienceDefinition,
} from "@/lib/marketing/campaigns-db"

export const runtime = "nodejs"

/**
 * Live "who will receive this" preview. Accepts an optional draft audience
 * definition in the body so the builder can preview un-saved changes; falls
 * back to the campaign's stored audience.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  await ensureCampaignSchema()
  const session = await requireFeature("marketing.campaigns.view")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const { id: idStr } = await params
  const campaign = await getCampaign(Number(idStr))
  if (!campaign || campaign.archived_at) return NextResponse.json({ error: "Not found" }, { status: 404 })

  const body = await request.json().catch(() => ({}))
  let def: AudienceDefinition
  if (body && body.mode) {
    def = {
      mode: body.mode,
      segmentIds: Array.isArray(body.segmentIds) ? body.segmentIds.map(Number) : [],
      tags: Array.isArray(body.tags) ? body.tags.map(String) : [],
      contactIds: Array.isArray(body.contactIds) ? body.contactIds.map(Number) : [],
      excludeUnsubscribed: body.excludeUnsubscribed !== false,
    }
  } else {
    def = audienceOf(campaign)
  }

  const preview = await previewAudience(def)
  return NextResponse.json(preview)
}
