import { type NextRequest, NextResponse } from "next/server"
import { configureGatewaysFromEnv, hasGateway, getGateway } from "@/lib/billing/gateways/registry"
import { applyGatewayEvent } from "@/lib/billing/gateways/webhook-service"

/**
 * Provider-neutral webhook receiver (Phase 3).
 * ---------------------------------------------------------------------------
 * A single endpoint serves every provider: `/api/billing/webhooks/razorpay`,
 * `/api/billing/webhooks/stripe`, etc. It looks up the adapter by the path
 * param, verifies the raw-body signature (MUST read the raw text before JSON
 * parsing so the HMAC matches byte-for-byte), normalizes the event and hands it
 * to the billing bridge. The route knows nothing provider-specific.
 */

export const runtime = "nodejs"
// Webhooks are unauthenticated by session; auth is the signature check below.
export const dynamic = "force-dynamic"

function lowerHeaders(req: NextRequest): Record<string, string> {
  const out: Record<string, string> = {}
  req.headers.forEach((value, key) => {
    out[key.toLowerCase()] = value
  })
  return out
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ provider: string }> }) {
  const { provider } = await ctx.params
  configureGatewaysFromEnv()

  if (!hasGateway(provider)) {
    return NextResponse.json({ error: `Unknown or unconfigured gateway "${provider}".` }, { status: 404 })
  }

  const gateway = getGateway(provider)
  const rawBody = await req.text()

  if (!gateway.verifyWebhook({ rawBody, headers: lowerHeaders(req) })) {
    // 400, not 401: the provider should NOT retry a signature it cannot fix.
    return NextResponse.json({ error: "Invalid webhook signature." }, { status: 400 })
  }

  let result
  try {
    const event = gateway.parseEvent(rawBody)
    result = await applyGatewayEvent(event)
  } catch (err) {
    // Real processing failure — return 500 so the provider retries later.
    console.error(`[v0] ${provider} webhook processing failed:`, (err as Error).message)
    return NextResponse.json({ error: "Webhook processing failed." }, { status: 500 })
  }

  // Duplicate/ignored still return 200 so the provider stops retrying.
  return NextResponse.json({ ok: true, ...result }, { status: 200 })
}
