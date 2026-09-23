import { NextResponse } from "next/server"
import { billingGuard } from "@/lib/billing-guard"
import { listCredits, createCredit, creditBalance, BillingError } from "@/lib/billing/billing-engine"

export const runtime = "nodejs"

/** Credit & adjustment ledger (tenant-scoped) plus running balance. */
export async function GET() {
  const session = await billingGuard().catch(() => null)
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  try {
    const [entries, balance] = await Promise.all([listCredits(), creditBalance()])
    return NextResponse.json({ entries, balance })
  } catch (err) {
    console.error("[v0] GET /api/billing/credits failed:", err)
    return NextResponse.json({ error: "Failed to load credits" }, { status: 500 })
  }
}

export async function POST(request: Request) {
  const session = await billingGuard().catch(() => null)
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  try {
    const body = await request.json()
    const entry = await createCredit(body, session)
    return NextResponse.json({ ok: true, entry }, { status: 201 })
  } catch (err) {
    if (err instanceof BillingError) {
      return NextResponse.json({ error: err.message, fields: err.fields }, { status: err.status })
    }
    console.error("[v0] POST /api/billing/credits failed:", err)
    return NextResponse.json({ error: "Failed to add credit" }, { status: 500 })
  }
}
