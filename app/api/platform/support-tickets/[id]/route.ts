import { NextRequest, NextResponse } from "next/server"
import { requirePlatformStaff } from "@/lib/platform-guard"
import { toTicketStatus } from "@/lib/support-sla/model"
import { SupportSlaError, respondToTicket, setTicketStatus } from "@/lib/support-sla/store"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * Staff actions on a ticket.
 * Body: { action: "respond", message } (stops the response clock)
 *     | { action: "status", status }   (resolved/closed stops the resolution clock)
 */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requirePlatformStaff()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const id = Number((await params).id)
  if (!Number.isSafeInteger(id) || id <= 0) return NextResponse.json({ error: "Invalid ticket id" }, { status: 400 })
  const body = await req.json().catch(() => null)
  const actor = { userId: guard.session.userId }
  try {
    if (body?.action === "respond") {
      const message = typeof body.message === "string" ? body.message.trim() : ""
      if (message.length < 1 || message.length > 5000) {
        return NextResponse.json({ error: "message must be 1-5000 characters" }, { status: 400 })
      }
      return NextResponse.json({ ok: true, ticket: await respondToTicket(id, message, actor) })
    }
    if (body?.action === "status") {
      const status = toTicketStatus(body.status)
      if (!status) return NextResponse.json({ error: "Invalid status" }, { status: 400 })
      return NextResponse.json({ ok: true, ticket: await setTicketStatus(id, status, actor) })
    }
    return NextResponse.json({ error: "action must be respond or status" }, { status: 400 })
  } catch (error) {
    if (error instanceof SupportSlaError) return NextResponse.json({ error: error.message, code: error.code }, { status: error.status })
    console.error("[support-sla] ticket action failed", error)
    return NextResponse.json({ error: "Unable to update ticket" }, { status: 500 })
  }
}
