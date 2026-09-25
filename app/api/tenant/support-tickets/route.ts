import { NextRequest, NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { normalizeIdempotencyKey, validateTicketInput } from "@/lib/support-sla/model"
import { SupportSlaError, createTicket, listMyTickets } from "@/lib/support-sla/store"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * Spec28 (#127) — The caller's tenant support tickets with live SLA state.
 * Deliberately NOT maintenance-gated: customers must be able to reach support
 * while their workspace is down.
 */
export async function GET() {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Not authenticated" }, { status: 401 })
  try {
    return NextResponse.json({ tickets: await listMyTickets() })
  } catch (error) {
    if (error instanceof SupportSlaError) return NextResponse.json({ error: error.message }, { status: error.status })
    console.error("[support-sla] list failed", error)
    return NextResponse.json({ error: "Unable to load tickets" }, { status: 500 })
  }
}

/** Open a ticket. The SLA tier comes from the tenant's plan server-side, never the body. */
export async function POST(req: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Not authenticated" }, { status: 401 })
  const body = await req.json().catch(() => null)
  if (!body || typeof body !== "object") return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  const parsed = validateTicketInput(body as Record<string, unknown>)
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 })
  try {
    const { ticket, replayed } = await createTicket(
      parsed.value,
      { userId: session.userId },
      normalizeIdempotencyKey(req.headers.get("idempotency-key")),
    )
    return NextResponse.json({ ok: true, ticket, replayed }, { status: replayed ? 200 : 201 })
  } catch (error) {
    if (error instanceof SupportSlaError) return NextResponse.json({ error: error.message, code: error.code }, { status: error.status })
    console.error("[support-sla] create failed", error)
    return NextResponse.json({ error: "Unable to open ticket" }, { status: 500 })
  }
}
