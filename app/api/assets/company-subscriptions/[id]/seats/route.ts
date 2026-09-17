import { NextRequest, NextResponse } from "next/server"
import { requireModuleAction } from "@/lib/api-auth"
import { assignSeat, revokeSeat, SubscriptionError } from "@/lib/company-subscriptions"

export const runtime = "nodejs"

type Ctx = { params: Promise<{ id: string }> }

export async function POST(req: NextRequest, ctx: Ctx) {
  const session = await requireModuleAction("assets.company_subscriptions", "assign_seat")
  if (!session) return NextResponse.json({ error: "You do not have permission to assign seats." }, { status: 403 })
  const { id } = await ctx.params
  try {
    const body = await req.json().catch(() => ({}))
    const detail = await assignSeat(id, body, session)
    return NextResponse.json(detail, { status: 201 })
  } catch (error) {
    if (error instanceof SubscriptionError) return NextResponse.json({ error: error.message }, { status: error.status })
    console.log("[v0] assign seat failed", (error as Error).message)
    return NextResponse.json({ error: "Failed to assign seat." }, { status: 500 })
  }
}

export async function PATCH(req: NextRequest, ctx: Ctx) {
  const session = await requireModuleAction("assets.company_subscriptions", "revoke_seat")
  if (!session) return NextResponse.json({ error: "You do not have permission to revoke seats." }, { status: 403 })
  const { id } = await ctx.params
  try {
    const body = await req.json().catch(() => ({}))
    const seatId = String(body.seat_id || "")
    if (!seatId) return NextResponse.json({ error: "seat_id is required." }, { status: 400 })
    const detail = await revokeSeat(id, seatId, body, session)
    return NextResponse.json(detail)
  } catch (error) {
    if (error instanceof SubscriptionError) return NextResponse.json({ error: error.message }, { status: error.status })
    console.log("[v0] revoke seat failed", (error as Error).message)
    return NextResponse.json({ error: "Failed to revoke seat." }, { status: 500 })
  }
}
