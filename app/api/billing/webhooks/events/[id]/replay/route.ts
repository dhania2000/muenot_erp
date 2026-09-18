import { NextResponse } from "next/server"
import { billingGuard } from "@/lib/billing-guard"
import { replayWebhookEvent, WebhookReplayError } from "@/lib/billing/gateways/webhook-service"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * SPEC 22 — Manual replay of a stored webhook event (admin-only). Used to
 * recover a failed event after fixing the underlying cause, without waiting for
 * the provider to redeliver. Replaying is idempotent: an already-settled event
 * is a safe no-op.
 */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await billingGuard().catch(() => null)
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const { id } = await ctx.params
  const eventId = Number(id)
  if (!Number.isInteger(eventId) || eventId <= 0) {
    return NextResponse.json({ error: "Invalid event id" }, { status: 400 })
  }

  try {
    const result = await replayWebhookEvent(eventId)
    return NextResponse.json({ ok: true, result })
  } catch (err) {
    if (err instanceof WebhookReplayError) {
      return NextResponse.json({ error: err.message }, { status: err.status })
    }
    console.error("[v0] POST /api/billing/webhooks/events/[id]/replay failed:", err)
    return NextResponse.json({ error: "Replay failed" }, { status: 500 })
  }
}
