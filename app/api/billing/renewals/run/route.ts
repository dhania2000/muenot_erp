import { NextResponse } from "next/server"
import { billingGuard } from "@/lib/billing-guard"
import { runRenewalCycle } from "@/lib/billing/renewal-engine"

export const runtime = "nodejs"

/**
 * Run one renewal cycle for the current tenant: reconcile lifecycle,
 * queue + deliver due renewal reminders, process failed-payment retries (with
 * escalation to suspension when exhausted), and ensure renewal invoices exist.
 * Idempotent — safe to trigger repeatedly from the console or a scheduler.
 */
export async function POST(request: Request) {
  const session = await billingGuard().catch(() => null)
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  try {
    const body = await request.json().catch(() => ({}) as Record<string, unknown>)
    const taxRate = Number.isFinite(Number(body.taxRate)) ? Number(body.taxRate) : 0
    const sendReminders = body.sendReminders !== false
    const result = await runRenewalCycle(session, { taxRate, sendReminders })
    return NextResponse.json({ ok: true, result })
  } catch (err) {
    console.error("[v0] POST /api/billing/renewals/run failed:", err)
    return NextResponse.json({ error: "Renewal cycle failed" }, { status: 500 })
  }
}
