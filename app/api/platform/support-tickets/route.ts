import { NextRequest, NextResponse } from "next/server"
import { requirePlatformStaff } from "@/lib/platform-guard"
import { toTicketStatus } from "@/lib/support-sla/model"
import { listAllTickets } from "@/lib/support-sla/store"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/** Spec28 (#127) — Cross-tenant support queue with SLA state. Platform staff only. */
export async function GET(req: NextRequest) {
  const guard = await requirePlatformStaff()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const sp = req.nextUrl.searchParams
  const tenantRaw = sp.get("tenantId")
  const tenantId = tenantRaw ? Number(tenantRaw) : null
  if (tenantId != null && (!Number.isSafeInteger(tenantId) || tenantId <= 0)) {
    return NextResponse.json({ error: "Invalid tenantId" }, { status: 400 })
  }
  try {
    const tickets = await listAllTickets({
      status: toTicketStatus(sp.get("status")),
      tenantId,
      breached: sp.get("breached") === "1",
    })
    return NextResponse.json({ tickets })
  } catch (error) {
    console.error("[support-sla] platform list failed", error)
    return NextResponse.json({ error: "Unable to load tickets" }, { status: 500 })
  }
}
