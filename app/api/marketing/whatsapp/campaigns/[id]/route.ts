import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import {
  cancelCampaign,
  deleteCampaign,
  getCampaign,
  launchCampaign,
  listCampaigns,
  pauseCampaign,
  resumeCampaign,
  updateCampaign,
} from "@/lib/whatsapp-campaigns"
import { resolveWhatsAppCaps } from "@/lib/whatsapp-platform"

/** Single campaign with its live delivery counters. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id } = await params
  const campaignId = Number(id)
  if (!Number.isInteger(campaignId) || campaignId <= 0) {
    return NextResponse.json({ error: "Invalid campaign id" }, { status: 400 })
  }

  const campaign = await getCampaign(campaignId)
  if (!campaign) return NextResponse.json({ error: "Campaign not found" }, { status: 404 })
  return NextResponse.json({ campaign })
}

/**
 * Campaign lifecycle actions: launch / pause / resume / cancel, or a field
 * update. Launching enforces the campaign capability so bulk sends stay gated.
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const caps = await resolveWhatsAppCaps(session)
  if (!caps.canCreateCampaigns) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const { id } = await params
  const campaignId = Number(id)
  if (!Number.isInteger(campaignId) || campaignId <= 0) {
    return NextResponse.json({ error: "Invalid campaign id" }, { status: 400 })
  }

  const campaign = await getCampaign(campaignId)
  if (!campaign) return NextResponse.json({ error: "Campaign not found" }, { status: 404 })

  const body = (await request.json().catch(() => ({}))) as {
    action?: "launch" | "pause" | "resume" | "cancel"
    name?: string
    scheduledAt?: string | null
  }

  try {
    switch (body.action) {
      case "launch": {
        const result = await launchCampaign(campaignId, session.userId)
        const campaigns = await listCampaigns()
        return NextResponse.json({ ok: true, result, campaigns })
      }
      case "pause":
        await pauseCampaign(campaignId)
        break
      case "resume":
        await resumeCampaign(campaignId)
        break
      case "cancel":
        await cancelCampaign(campaignId)
        break
      default:
        await updateCampaign(campaignId, {
          name: body.name,
          scheduledAt: body.scheduledAt,
        })
    }
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 })
  }

  const campaigns = await listCampaigns()
  return NextResponse.json({ ok: true, campaigns })
}

/** Deletes a campaign (draft/cancelled cleanup). */
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const caps = await resolveWhatsAppCaps(session)
  if (!caps.canCreateCampaigns) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const { id } = await params
  const campaignId = Number(id)
  if (!Number.isInteger(campaignId) || campaignId <= 0) {
    return NextResponse.json({ error: "Invalid campaign id" }, { status: 400 })
  }

  await deleteCampaign(campaignId)
  const campaigns = await listCampaigns()
  return NextResponse.json({ ok: true, campaigns })
}
