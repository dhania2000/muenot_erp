import { type NextRequest, NextResponse } from "next/server"
import { requirePlatformStaff, requirePlatformSuperAdmin } from "@/lib/platform-guard"
import { InvoiceRefundError, markInvoicePaid, refundInvoice } from "@/lib/platform-console"
import { recordPlatformAudit } from "@/lib/platform-roles"
import { normalizeIdempotencyKey } from "@/lib/support-sla/model"
import { applyInvoiceClawback } from "@/lib/partners/store"

/**
 * Refund (part of) a paid invoice. Super admin; Idempotency-Key REQUIRED so a
 * retried request never refunds twice. Any settled partner commission on the
 * invoice is clawed back proportionally.
 */
export async function POST(req: NextRequest) {
  const guard = await requirePlatformSuperAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })

  const idempotencyKey = normalizeIdempotencyKey(req.headers.get("idempotency-key"))
  if (!idempotencyKey) return NextResponse.json({ error: "Idempotency-Key header is required" }, { status: 400 })

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
  const amount = Number(body?.amount)
  const amountCents = Math.round(amount * 100)
  if (!Number.isFinite(amount) || amountCents <= 0 || Math.abs(amount * 100 - amountCents) > 1e-6) {
    return NextResponse.json({ error: "amount must be a positive value with at most 2 decimals" }, { status: 400 })
  }
  const reason = body?.reason == null ? null : String(body.reason).slice(0, 300)

  try {
    const result = await refundInvoice({ invoiceId, amountCents, reason, idempotencyKey, actorUserId: guard.ctx.userId })
    const { clawbacks } = await applyInvoiceClawback(invoiceId, guard.ctx.userId)
    if (!result.replayed) {
      await recordPlatformAudit({
        actorUserId: guard.ctx.userId,
        actorEmail: guard.session.email,
        action: "invoice_refunded",
        targetTenantId: result.tenantId,
        detail: { invoiceId, amount: (amountCents / 100).toFixed(2), reason, clawbacks },
      })
    }
    return NextResponse.json({ ok: true, replayed: result.replayed, refundedAmount: result.refundedAmount, clawbacks })
  } catch (err: any) {
    if (err instanceof InvoiceRefundError) return NextResponse.json({ error: err.message }, { status: err.status })
    console.error("[platform-invoices] refund failed:", err)
    return NextResponse.json({ error: "Failed to refund invoice" }, { status: 500 })
  }
}

/**
 * Record a payment against an open invoice. Platform-staff surface;
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
