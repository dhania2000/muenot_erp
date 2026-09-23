import { NextResponse } from "next/server"
import { listRetryableDeliveries } from "@/lib/webhooks-store"
import { retryDelivery } from "@/lib/webhooks/dispatcher"

/**
 * scheduled sweep for failed webhook deliveries whose backoff
 * window has elapsed (see BACKOFF_MINUTES in lib/webhooks/dispatcher.ts).
 * Register on a short interval (e.g. every 5 minutes) in vercel.json cron.
 */
export async function GET() {
  const deliveries = await listRetryableDeliveries(100)
  let retried = 0
  for (const delivery of deliveries) {
    await retryDelivery(delivery)
    retried++
  }
  return NextResponse.json({ ok: true, retried })
}
