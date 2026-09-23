import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { getMeter, recordUsage, checkUsageLimit } from "@/lib/billing/usage-metering"

export const runtime = "nodejs"

/**
 * Ingestion endpoint for metered usage events.
 *
 * Any authenticated part of the app (or a server-to-server caller with a valid
 * session) can post a counter event here; the tenant is taken from the session,
 * never from the request body, so events can never be attributed to another
 * tenant. Returns the post-record limit check so callers can react to quota
 * breaches.
 */
export async function POST(request: Request) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  let body: any
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 })
  }

  const meterKey = String(body?.meterKey ?? "")
  const meter = getMeter(meterKey)
  if (!meter) return NextResponse.json({ error: "Unknown meter" }, { status: 400 })
  if (meter.kind !== "counter") {
    return NextResponse.json({ error: "Meter is a live gauge and cannot be recorded" }, { status: 400 })
  }

  const quantity = body?.quantity == null ? 1 : Number(body.quantity)
  if (!Number.isFinite(quantity) || quantity <= 0) {
    return NextResponse.json({ error: "quantity must be a positive number" }, { status: 400 })
  }

  try {
    const recorded = await recordUsage({
      meterKey,
      quantity,
      source: typeof body?.source === "string" ? body.source.slice(0, 60) : "api",
      refId: typeof body?.refId === "string" ? body.refId.slice(0, 80) : null,
      metadata: body?.metadata && typeof body.metadata === "object" ? body.metadata : null,
    })
    if (!recorded) return NextResponse.json({ error: "Event rejected" }, { status: 400 })
    const check = await checkUsageLimit(meterKey, 0)
    return NextResponse.json({ success: true, check })
  } catch (err) {
    console.error("[v0] record usage event failed:", err)
    return NextResponse.json({ error: "Failed to record event" }, { status: 500 })
  }
}
