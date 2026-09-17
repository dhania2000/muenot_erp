import { type NextRequest, NextResponse } from "next/server"
import { requirePlatformStaff } from "@/lib/platform-guard"
import { markInvoicePaid } from "@/lib/platform-console"
import { recordPlatformAudit } from "@/lib/platform-roles"

/**
 * SPEC 4 — Record a payment against an open invoice. Platform-staff surface;
 * audited. Only an `open` invoice can be marked paid (enforced in the query).
 */
export async function PATCH(req: NextRequest) {
  const guard = await requirePlatformStaff()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })

  let body: any
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const invoiceId = Number(body?.invoiceId)
  if (!Number.isInteger(invoiceId) || invoiceId <= 0) {
    return NextResponse.json({ error: "Invalid invoice id" }, { status: 400 })
  }

  try {
    await markInvoicePaid(invoiceId)
    await recordPlatformAudit({
      actorUserId: guard.ctx.userId,
      actorEmail: guard.session.email,
      action: "invoice_paid",
      detail: { invoiceId },
    })
    return NextResponse.json({ ok: true })
  } catch (err: any) {
    return NextResponse.json({ error: err?.message ?? "Failed to update invoice" }, { status: 400 })
  }
}
