import "server-only"
/**
 * — Webhook delivery: signing, sending, retry with backoff.
 * ---------------------------------------------------------------------------
 * `emitWebhookEvent` is the single fan-out point business code calls when
 * something webhook-worthy happens (see lib/webhooks-store.ts WEBHOOK_EVENTS
 * for the event catalog). It is fire-and-forget from the caller's point of
 * view — a slow or failing subscriber endpoint never blocks or fails the
 * request that triggered the event.
 *
 * Every delivery is signed the standard way: `X-Webhook-Signature` is an
 * HMAC-SHA256 of `${timestamp}.${body}` using the endpoint's own secret, plus
 * `X-Webhook-Timestamp`, so a receiver can verify authenticity and reject
 * replays. On failure the delivery is left in `failed` with an exponential
 * backoff `next_retry_at` (1m, 5m, 30m, 2h, 6h) for up to 5 attempts total;
 * app/api/cron/webhooks-retry sweeps those on a schedule, and the admin UI
 * also exposes a manual "Retry" action per delivery.
 */
import crypto from "crypto"
import {
  createDelivery,
  getDeliveryEndpoint,
  listActiveEndpointsForEvent,
  recordDeliveryOutcome,
  resolveEndpointHeaders,
  resolveEndpointSecret,
  updateDeliveryResult,
  type WebhookDeliveryRow,
} from "@/lib/webhooks-store"

const BACKOFF_MINUTES = [1, 5, 30, 120, 360]
const DELIVERY_TIMEOUT_MS = 8000

function sign(secret: string, timestamp: string, body: string): string {
  return crypto.createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")
}

async function sendDelivery(delivery: WebhookDeliveryRow): Promise<void> {
  const endpoint = await getDeliveryEndpoint(delivery.endpoint_id)
  if (!endpoint || endpoint.status !== "active") {
    await updateDeliveryResult(delivery.id, { status: "failed", attempts: delivery.attempts, responseBody: "Endpoint disabled or missing" })
    return
  }
  const secret = resolveEndpointSecret(endpoint) ?? ""
  const timestamp = String(Math.floor(Date.now() / 1000))
  const signature = sign(secret, timestamp, delivery.payload)
  const attempts = delivery.attempts + 1

  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS)
    // Subscriber-configured headers go on first; the signed headers below are
    // set last so a custom header can never override the signature chain.
    const res = await fetch(endpoint.url, {
      method: "POST",
      headers: {
        ...resolveEndpointHeaders(endpoint),
        "Content-Type": "application/json",
        "X-Webhook-Signature": signature,
        "X-Webhook-Timestamp": timestamp,
        "X-Webhook-Event": delivery.event_type,
        // Idempotency: this id is stable for the lifetime of the delivery and
        // is re-sent unchanged on every retry (manual or cron sweep), so a
        // receiver can dedupe replays by storing the id and ignoring repeats.
        // `X-Webhook-Attempt` is advisory only and increments per send.
        "X-Webhook-Id": String(delivery.id),
        "X-Webhook-Attempt": String(attempts),
      },
      body: delivery.payload,
      signal: controller.signal,
    }).finally(() => clearTimeout(timeout))

    const bodyText = await res.text().catch(() => "")
    const ok = res.status >= 200 && res.status < 300
    await updateDeliveryResult(delivery.id, {
      status: ok ? "success" : "failed",
      attempts,
      responseCode: res.status,
      responseBody: bodyText,
      nextRetryAt: ok ? null : nextRetryAt(attempts),
    })
    await recordDeliveryOutcome(endpoint.id, ok)
  } catch (err) {
    await updateDeliveryResult(delivery.id, {
      status: "failed",
      attempts,
      responseBody: err instanceof Error ? err.message : "Delivery failed",
      nextRetryAt: nextRetryAt(attempts),
    })
    await recordDeliveryOutcome(endpoint.id, false)
  }
}

function nextRetryAt(attempts: number): Date | null {
  if (attempts >= BACKOFF_MINUTES.length) return null // attempt cap reached — no further automatic retry
  const minutes = BACKOFF_MINUTES[attempts - 1] ?? BACKOFF_MINUTES[BACKOFF_MINUTES.length - 1]
  return new Date(Date.now() + minutes * 60_000)
}

/**
 * Fan an event out to every active tenant endpoint subscribed to it. Never
 * throws — a webhook subsystem problem must never fail the business
 * operation that triggered it.
 */
export async function emitWebhookEvent(tenantId: number, eventType: string, data: Record<string, unknown>): Promise<void> {
  try {
    const endpoints = await listActiveEndpointsForEvent(tenantId, eventType)
    if (endpoints.length === 0) return
    const payload = JSON.stringify({ event: eventType, data, emittedAt: new Date().toISOString() })

    await Promise.all(
      endpoints.map(async (endpoint) => {
        const deliveryId = await createDelivery({ endpointId: endpoint.id, tenantId, eventType, payload })
        const rows = await import("@/lib/webhooks-store").then((m) => m.listDeliveries(tenantId, endpoint.id, 1))
        const delivery = rows.find((d) => d.id === deliveryId)
        if (delivery) await sendDelivery(delivery)
      }),
    )
  } catch (err) {
    console.error("[v0] webhook emission failed", err)
  }
}

/** Re-attempts one delivery immediately — used by manual "Retry" in the admin UI and the retry cron sweep. */
export async function retryDelivery(delivery: WebhookDeliveryRow): Promise<void> {
  await sendDelivery(delivery)
}
