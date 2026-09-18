import { NextResponse } from "next/server"
import { billingGuard } from "@/lib/billing-guard"
import { listReconciliation, ingestReconciliation, BillingError } from "@/lib/billing/billing-engine"

export const runtime = "nodejs"

/**
 * SPEC 20 — Payment reconciliation. GET lists settlement lines; POST ingests a
 * gateway settlement and auto-matches it to a payment by reference or amount.
 */
export async function GET() {
  const session = await billingGuard().catch(() => null)
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  try {
    return NextResponse.json({ entries: await listReconciliation() })
  } catch (err) {
    console.error("[v0] GET /api/billing/reconciliation failed:", err)
    return NextResponse.json({ error: "Failed to load reconciliation" }, { status: 500 })
  }
}

export async function POST(request: Request) {
  const session = await billingGuard().catch(() => null)
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  try {
    const body = await request.json()
    const entry = await ingestReconciliation(body, session)
    return NextResponse.json({ ok: true, entry }, { status: 201 })
  } catch (err) {
    if (err instanceof BillingError) {
      return NextResponse.json({ error: err.message, fields: err.fields }, { status: err.status })
    }
    console.error("[v0] POST /api/billing/reconciliation failed:", err)
    return NextResponse.json({ error: "Failed to ingest settlement" }, { status: 500 })
  }
}
