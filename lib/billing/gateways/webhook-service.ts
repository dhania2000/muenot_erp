import "server-only"
import { query } from "@/lib/db"
import type { SessionPayload } from "@/lib/auth"
import { runForTenant, tenantSelect, tenantInsert, tenantUpdate } from "@/lib/tenant-scope"
import {
  getInvoice,
  recordPayment,
  refundInvoice,
  ingestReconciliation,
  recomputeInvoice,
} from "@/lib/billing/billing-engine"
import type { GatewayEvent } from "./types"

/**
 * SPEC 21 — Gateway → billing bridge (Phase 3).
 * ---------------------------------------------------------------------------
 * The ONE place where a normalized, provider-neutral webhook event becomes a
 * billing effect (payment settled, payment failed, refund recorded). Because
 * it only ever sees a `GatewayEvent`, the billing engine never learns which
 * provider fired — Razorpay, Stripe and any future adapter funnel through here.
 *
 * Webhooks arrive with no user session, so the tenant is resolved from event
 * metadata (stamped at checkout) and the work runs inside `runForTenant` so all
 * reads/writes stay tenant-scoped. Every event is deduped through the
 * `billing_gateway_events` ledger, making redelivery/retry safe (at-least-once
 * delivery → exactly-once effect).
 */

export type ApplyResult = {
  status: "processed" | "duplicate" | "ignored"
  effect?: "payment_settled" | "payment_recorded" | "payment_failed" | "refund_recorded" | "none"
  reason?: string
  invoiceId?: number
  paymentId?: number
}

let ensured = false

async function ensureGatewayEventsSchema(): Promise<void> {
  if (ensured) return
  await query(
    `CREATE TABLE IF NOT EXISTS billing_gateway_events (
      id           INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      tenant_id    INT UNSIGNED NOT NULL,
      gateway      VARCHAR(40) NOT NULL,
      event_id     VARCHAR(191) NOT NULL,
      event_type   VARCHAR(60) NOT NULL,
      status       VARCHAR(20) NOT NULL DEFAULT 'processed',
      effect       VARCHAR(30) DEFAULT NULL,
      invoice_id   INT UNSIGNED DEFAULT NULL,
      payment_id   INT UNSIGNED DEFAULT NULL,
      raw          MEDIUMTEXT DEFAULT NULL,
      created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_gw_event (tenant_id, gateway, event_id),
      KEY idx_gw_event_tenant (tenant_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  )
  ensured = true
}

/** A non-interactive session for webhook-driven writes (created_by = 0). */
function systemSession(tenantId: number): SessionPayload {
  return { userId: 0, email: "system@billing", name: "Gateway Webhook", role: "admin", tenantId } as SessionPayload
}

function tenantIdFromEvent(event: GatewayEvent): number | null {
  const raw = event.metadata?.tenant_id ?? event.metadata?.tenantId
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 ? n : null
}

async function resolveInvoiceId(event: GatewayEvent): Promise<number | null> {
  const fromMeta = Number(event.metadata?.invoice_id ?? event.metadata?.invoiceId)
  if (Number.isInteger(fromMeta) && fromMeta > 0) return fromMeta

  // Fall back to matching the reference against a payment we opened, or an
  // invoice number, so events still land even if invoice_id was not stamped.
  if (event.reference) {
    const byRef = (await tenantSelect("billing_payments", {
      columns: "invoice_id",
      where: "(reference = ? OR payment_no = ?)",
      params: [event.reference, event.reference],
      tail: "ORDER BY created_at DESC LIMIT 1",
    })) as any[]
    if (byRef[0]) return Number(byRef[0].invoice_id)

    const byInv = (await tenantSelect("billing_invoices", {
      columns: "id",
      where: "invoice_no = ?",
      params: [event.reference],
      tail: "LIMIT 1",
    })) as any[]
    if (byInv[0]) return Number(byInv[0].id)
  }
  return null
}

/**
 * Find a payment we opened for this charge (pending or otherwise) so a
 * succeeded/failed webhook settles the SAME row instead of creating a
 * duplicate. Matches on the provider handles we stored at checkout.
 */
async function findOpenedPayment(invoiceId: number, event: GatewayEvent): Promise<any | null> {
  const refs = [event.providerOrderId, event.providerPaymentId, event.reference].filter(Boolean) as string[]
  if (refs.length) {
    const placeholders = refs.map(() => "?").join(",")
    const rows = (await tenantSelect("billing_payments", {
      where: `invoice_id = ? AND reference IN (${placeholders})`,
      params: [invoiceId, ...refs],
      tail: "ORDER BY created_at DESC LIMIT 1",
    })) as any[]
    if (rows[0]) return rows[0]
  }
  // Otherwise reuse a still-pending gateway payment on the invoice.
  const pending = (await tenantSelect("billing_payments", {
    where: "invoice_id = ? AND status = 'pending' AND gateway = ?",
    params: [invoiceId, event.gateway],
    tail: "ORDER BY created_at ASC LIMIT 1",
  })) as any[]
  return pending[0] ?? null
}

/**
 * Apply one verified gateway event. Idempotent: a repeated event id is a no-op
 * ("duplicate"). Unroutable events (no tenant/invoice, unknown type) are
 * recorded as "ignored" rather than throwing, so the provider gets a 200 and
 * stops retrying a message we will never act on.
 */
export async function applyGatewayEvent(event: GatewayEvent): Promise<ApplyResult> {
  const tenantId = tenantIdFromEvent(event)
  if (!tenantId) return { status: "ignored", reason: "missing tenant_id in event metadata" }

  return runForTenant({ tenantId }, async () => {
    await ensureGatewayEventsSchema()

    // Idempotency gate — claim the event id before doing any work.
    try {
      await tenantInsert("billing_gateway_events", {
        gateway: event.gateway,
        event_id: event.id,
        event_type: event.type,
        status: "processing",
        raw: safeJson(event.raw),
      })
    } catch (err) {
      if (/Duplicate/i.test((err as Error).message)) return { status: "duplicate" }
      throw err
    }

    const finish = (result: ApplyResult) =>
      tenantUpdate(
        "billing_gateway_events",
        {
          status: result.status === "ignored" ? "ignored" : "processed",
          effect: result.effect ?? null,
          invoice_id: result.invoiceId ?? null,
          payment_id: result.paymentId ?? null,
        },
        "gateway = ? AND event_id = ?",
        [event.gateway, event.id],
      ).then(() => result)

    if (event.type === "unknown") return finish({ status: "ignored", effect: "none", reason: "unhandled event type" })

    const invoiceId = await resolveInvoiceId(event)
    if (!invoiceId) return finish({ status: "ignored", effect: "none", reason: "no matching invoice" })

    const inv = await getInvoice(invoiceId)
    if (!inv) return finish({ status: "ignored", effect: "none", reason: "invoice not found", invoiceId })

    const session = systemSession(tenantId)

    switch (event.type) {
      case "payment.succeeded": {
        const opened = await findOpenedPayment(invoiceId, event)
        if (opened && String(opened.status) !== "succeeded") {
          await tenantUpdate(
            "billing_payments",
            {
              status: "succeeded",
              reconciled: 1,
              reconciled_at: nowSql(),
              paid_at: nowSql(),
              reference: event.providerPaymentId ?? opened.reference,
            },
            "id = ?",
            [opened.id],
          )
          await recomputeInvoice(invoiceId)
          await recordSettlement(event, invoiceId, inv.invoice_no, session)
          return finish({ status: "processed", effect: "payment_settled", invoiceId, paymentId: Number(opened.id) })
        }
        if (opened && String(opened.status) === "succeeded") {
          return finish({ status: "processed", effect: "none", invoiceId, paymentId: Number(opened.id) })
        }
        // No opened row (charge started outside our checkout) — record it fresh.
        const payment = await recordPayment(
          invoiceId,
          {
            amount: event.amount ?? undefined,
            method: "gateway",
            gateway: event.gateway,
            reference: event.providerPaymentId ?? event.reference ?? null,
            status: "succeeded",
            note: `Gateway webhook ${event.id}`,
          },
          session,
        )
        await tenantUpdate("billing_payments", { reconciled: 1, reconciled_at: nowSql() }, "id = ?", [payment.id])
        await recordSettlement(event, invoiceId, inv.invoice_no, session)
        return finish({ status: "processed", effect: "payment_recorded", invoiceId, paymentId: payment.id })
      }

      case "payment.failed": {
        const opened = await findOpenedPayment(invoiceId, event)
        if (opened && String(opened.status) === "pending") {
          await tenantUpdate("billing_payments", { status: "failed" }, "id = ?", [opened.id])
          await recomputeInvoice(invoiceId)
          return finish({ status: "processed", effect: "payment_failed", invoiceId, paymentId: Number(opened.id) })
        }
        if (!opened) {
          const payment = await recordPayment(
            invoiceId,
            {
              amount: event.amount ?? undefined,
              method: "gateway",
              gateway: event.gateway,
              reference: event.providerPaymentId ?? event.reference ?? null,
              status: "failed",
              note: `Gateway webhook ${event.id} (failed)`,
            },
            session,
          )
          return finish({ status: "processed", effect: "payment_failed", invoiceId, paymentId: payment.id })
        }
        return finish({ status: "processed", effect: "none", invoiceId })
      }

      case "refund.succeeded": {
        const refund = await refundInvoice(
          invoiceId,
          { amount: event.amount ?? undefined, reason: `Gateway refund ${event.providerRefundId ?? event.id}` },
          session,
        )
        return finish({ status: "processed", effect: "refund_recorded", invoiceId, paymentId: refund.id })
      }

      default:
        return finish({ status: "ignored", effect: "none", reason: "unhandled event type", invoiceId })
    }
  })
}

/** Mirror the settlement into the reconciliation ledger as a matched line. */
async function recordSettlement(
  event: GatewayEvent,
  invoiceId: number,
  invoiceNo: string,
  session: SessionPayload,
): Promise<void> {
  try {
    await ingestReconciliation(
      {
        statement_ref: `${event.gateway}:${event.id}`,
        gateway: event.gateway,
        payout_ref: event.providerPaymentId ?? undefined,
        amount: event.amount ?? undefined,
        currency: event.currency ?? undefined,
        payment_reference: event.providerPaymentId ?? event.reference ?? undefined,
      },
      session,
    )
  } catch (err) {
    // Reconciliation is a convenience mirror; never fail the settlement over it.
    console.error("[v0] gateway reconciliation mirror failed:", (err as Error).message)
  }
}

function nowSql(): string {
  return new Date().toISOString().slice(0, 19).replace("T", " ")
}

function safeJson(value: unknown): string | null {
  try {
    return JSON.stringify(value).slice(0, 60000)
  } catch {
    return null
  }
}
