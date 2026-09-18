import { type NextRequest, NextResponse } from "next/server"
import { billingGuard } from "@/lib/billing-guard"
import { listWebhookEvents, getWebhookEventStats } from "@/lib/billing/gateways/webhook-service"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * SPEC 22 — Webhook monitoring feed (admin-only). Lists recent gateway webhook
 * events for the current tenant plus aggregate counts, powering the failed-event
 * monitoring console. Read-only; the receiving endpoint stays unauthenticated
 * (signature-verified) at /api/billing/webhooks/[provider].
 */
export async function GET(req: NextRequest) {
  const session = await billingGuard().catch(() => null)
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  try {
    const url = new URL(req.url)
    const status = url.searchParams.get("status") ?? undefined
    const limit = Number(url.searchParams.get("limit") ?? "100")
    const [events, stats] = await Promise.all([
      listWebhookEvents({ status: status || undefined, limit }),
      getWebhookEventStats(),
    ])
    return NextResponse.json({ events, stats })
  } catch (err) {
    console.error("[v0] GET /api/billing/webhooks/events failed:", err)
    return NextResponse.json({ error: "Failed to load webhook events" }, { status: 500 })
  }
}
