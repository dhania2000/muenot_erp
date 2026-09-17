import { NextResponse } from "next/server"
import { requireFeature } from "@/lib/api-auth"
import { resolveBaseUrl } from "@/lib/email"
import { isValidEmail } from "@/lib/clients-db"
import {
  ensureCampaignSchema,
  getCampaign,
  sendTestEmail,
  recordCampaignAudit,
  CampaignStateError,
} from "@/lib/marketing/campaigns-db"

export const runtime = "nodejs"

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  await ensureCampaignSchema()
  const session = await requireFeature("marketing.campaigns.manage")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const { id: idStr } = await params
  const campaign = await getCampaign(Number(idStr))
  if (!campaign || campaign.archived_at) return NextResponse.json({ error: "Not found" }, { status: 404 })

  const body = await request.json().catch(() => ({}))
  const to = String(body.email || session.email || "").trim()
  if (!isValidEmail(to)) return NextResponse.json({ error: "Enter a valid email address" }, { status: 400 })

  try {
    await sendTestEmail(campaign, to, resolveBaseUrl(request), session.userId)
    await recordCampaignAudit({ campaignId: campaign.id, action: "test", summary: `Test email sent to ${to}`, actorId: session.userId })
    return NextResponse.json({ ok: true })
  } catch (err: any) {
    if (err instanceof CampaignStateError) return NextResponse.json({ error: err.message }, { status: 400 })
    console.error("[campaigns] test send failed", err)
    return NextResponse.json({ error: err?.message || "Could not send the test email" }, { status: 500 })
  }
}
