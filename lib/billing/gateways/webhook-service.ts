import "server-only"
import { query, tableColumns } from "@/lib/db"
import type { SessionPayload } from "@/lib/auth"
import { runForTenant, tenantSelect, tenantInsert, tenantUpdate, tenantFindById } from "@/lib/tenant-scope"
import {
  getInvoice,
  recordPayment,
  refundInvoice,
  ingestReconciliation,
  recomputeInvoice,
} from "@/lib/billing/billing-engine"
import type { GatewayEvent } from "./types"

/**
 * Payment webhook processing, storage, retry & monitoring.
 * ---------------------------------------------------------------------------
 * The ONE place where a verified, provider-neutral webhook event becomes a
 * billing effect (payment settled/failed, refund recorded). Built on the
 * gateway bridge, this layer adds the durable event ledger that makes
 * at-least-once delivery safe and observable:
 *
 *   - Event storage      : every verified event is persisted (raw + normalized)
 *                          in `billing_gateway_events` before any effect runs.
 *   - Idempotency        : the (tenant, gateway, event_id) unique key claims an
 *                          event exactly once.
 *   - Duplicate guard     : a redelivered event whose row is already in a
 *                          terminal state (processed/ignored) is a no-op.
 *   - Retry handling     : an event that FAILED processing (or crashed mid-flight
 *                          and is stale) is reclaimed on redelivery and retried,
 *                          with an attempt counter — so a transient error is not
 *                          permanently swallowed as a "duplicate".
 *   - Out-of-order safety: effects are written defensively (a late `failed`
 *                          never clobbers an already-settled payment, and a
 *                          replayed `succeeded` re-settles the same row).
 *   - Failed monitoring  : failures land in the ledger with `status='failed'`
 *                          and `last_error`, surfaced by `listWebhookEvents` /
 *                          `getWebhookEventStats` and replayable on demand.
 *
 * Webhooks arrive with no user session, so the tenant is resolved from event
 * metadata (stamped at checkout) and all work runs inside `runForTenant`.
 */

export type ApplyStatus = "processed" | "duplicate" | "ignored" | "failed"

export type ApplyResult = {
  status: ApplyStatus
  effect?: "payment_settled" | "payment_recorded" | "payment_failed" | "refund_recorded" | "none"
  reason?: string
  invoiceId?: number
  paymentId?: number
  attempts?: number
}

/** A stored webhook event row, shaped for monitoring surfaces. */
export type WebhookEventRow = {
  id: number
  gateway: string
  event_id: string
  event_type: string
  status: ApplyStatus | "processing"
  effect: string | null
  attempts: number
  signature_ok: boolean
  invoice_id: number | null
  payment_id: number | null
  last_error: string | null
  reason: string | null
  received_at: string | null
  updated_at: string | null
  created_at: string
}

export type WebhookEventStats = {
  total: number
  processed: number
  duplicate: number
  ignored: number
  failed: number
  processing: number
  retried: number
}

/** How long a row may sit in `processing` before we treat it as a crashed,
 *  reclaimable attempt rather than an in-flight duplicate. */
const STALE_PROCESSING_MS = 2 * 60 * 1000

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
      attempts     INT UNSIGNED NOT NULL DEFAULT 1,
      signature_ok TINYINT(1) NOT NULL DEFAULT 1,
      invoice_id   INT UNSIGNED DEFAULT NULL,
      payment_id   INT UNSIGNED DEFAULT NULL,
      last_error   VARCHAR(1000) DEFAULT NULL,
      reason       VARCHAR(255) DEFAULT NULL,
      raw          MEDIUMTEXT DEFAULT NULL,
      normalized   MEDIUMTEXT DEFAULT NULL,
      received_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_gw_event (tenant_id, gateway, event_id),
      KEY idx_gw_event_tenant (tenant_id),
      KEY idx_gw_event_status (tenant_id, status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  )

  // Bring installs (which lacked these columns) up to the model.
  const cols = await tableColumns("billing_gateway_events")
  const adds: string[] = []
  if (!cols.has("attempts")) adds.push("ADD COLUMN attempts INT UNSIGNED NOT NULL DEFAULT 1")
  if (!cols.has("signature_ok")) adds.push("ADD COLUMN signature_ok TINYINT(1) NOT NULL DEFAULT 1")
  if (!cols.has("last_error")) adds.push("ADD COLUMN last_error VARCHAR(1000) DEFAULT NULL")
  if (!cols.has("reason")) adds.push("ADD COLUMN reason VARCHAR(255) DEFAULT NULL")
  if (!cols.has("normalized")) adds.push("ADD COLUMN normalized MEDIUMTEXT DEFAULT NULL")
  if (!cols.has("received_at")) adds.push("ADD COLUMN received_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP")
  if (!cols.has("updated_at")) adds.push("ADD COLUMN updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP")
  if (adds.length) {
    await query(`ALTER TABLE billing_gateway_events ${adds.join(", ")}`)
  }
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

type ClaimOutcome = { action: "process" | "duplicate"; attempts: number }

/**
 * Claim an event for processing. Returns `process` for a brand-new event, and
 * for a redelivered one either `duplicate` (already terminal, or genuinely
 * in-flight) or `process` (previously failed / crashed-stale → retry).
 *
 * This is the retry heart of : treated EVERY redelivery of a
 * known event id as a duplicate, so a transient failure left the event stuck
 * and never re-applied. We now only short-circuit on terminal rows.
 */
async function claimEvent(event: GatewayEvent): Promise<ClaimOutcome> {
  try {
    await tenantInsert("billing_gateway_events", {
      gateway: event.gateway,
      event_id: event.id,
      event_type: event.type,
      status: "processing",
      attempts: 1,
      signature_ok: 1,
      raw: safeJson(event.raw),
      normalized: safeJson(event),
    })
    return { action: "process", attempts: 1 }
  } catch (err) {
    if (!/Duplicate/i.test((err as Error).message)) throw err
  }

  // Row exists — decide whether it is a true duplicate or a retry candidate.
  const rows = (await tenantSelect("billing_gateway_events", {
    where: "gateway = ? AND event_id = ?",
    params: [event.gateway, event.id],
    tail: "LIMIT 1",
  })) as any[]
  const row = rows[0]
  if (!row) return { action: "duplicate", attempts: 0 }

  const status = String(row.status)
  const attempts = Number(row.attempts ?? 1)

  if (status === "processed" || status === "ignored") {
    return { action: "duplicate", attempts }
  }
  if (status === "processing") {
    const updatedMs = Date.parse(String(row.updated_at ?? row.received_at ?? row.created_at))
    const stale = Number.isFinite(updatedMs) && Date.now() - updatedMs > STALE_PROCESSING_MS
    if (!stale) return { action: "duplicate", attempts } // genuinely in-flight
  }

  // status === 'failed', or a stale 'processing' → reclaim & retry.
  const next = attempts + 1
  await tenantUpdate(
    "billing_gateway_events",
    { status: "processing", attempts: next, updated_at: nowSql() },
    "gateway = ? AND event_id = ?",
    [event.gateway, event.id],
  )
  return { action: "process", attempts: next }
}

/**
 * Apply one verified gateway event. Idempotent and retry-safe:
 *   - a repeated terminal event is a no-op ("duplicate"),
 *   - a previously failed/crashed event is retried,
 *   - a processing failure is recorded ("failed") and rethrown so the caller
 *     returns 5xx and the provider redelivers.
 *
 * Pass `{ replay: true }` to force reprocessing of an already-stored event
 * (manual replay from the monitoring console).
 */
export async function applyGatewayEvent(
  event: GatewayEvent,
  opts: { replay?: boolean } = {},
): Promise<ApplyResult> {
  const tenantId = tenantIdFromEvent(event)
  if (!tenantId) return { status: "ignored", reason: "missing tenant_id in event metadata" }

  return runForTenant({ tenantId }, async () => {
    await ensureGatewayEventsSchema()

    let attempts: number
    if (opts.replay) {
      attempts = await markReplaying(event)
    } else {
      const claim = await claimEvent(event)
      if (claim.action === "duplicate") return { status: "duplicate", attempts: claim.attempts }
      attempts = claim.attempts
    }

    try {
      const result = await processEvent(event, tenantId)
      return await finish(event, { ...result, attempts })
    } catch (err) {
      await markFailed(event, err)
      throw err
    }
  })
}

/** The provider-neutral billing effect for a claimed event. */
async function processEvent(event: GatewayEvent, tenantId: number): Promise<ApplyResult> {
  if (event.type === "unknown") return { status: "ignored", effect: "none", reason: "unhandled event type" }

  const invoiceId = await resolveInvoiceId(event)
  if (!invoiceId) return { status: "ignored", effect: "none", reason: "no matching invoice" }

  const inv = await getInvoice(invoiceId)
  if (!inv) return { status: "ignored", effect: "none", reason: "invoice not found", invoiceId }

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
        return { status: "processed", effect: "payment_settled", invoiceId, paymentId: Number(opened.id) }
      }
      if (opened && String(opened.status) === "succeeded") {
        // Out-of-order / replayed success on an already-settled payment.
        return { status: "processed", effect: "none", invoiceId, paymentId: Number(opened.id) }
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
      return { status: "processed", effect: "payment_recorded", invoiceId, paymentId: payment.id }
    }

    case "payment.failed": {
      const opened = await findOpenedPayment(invoiceId, event)
      // Out-of-order guard: never flip an already-succeeded payment to failed.
      if (opened && String(opened.status) === "succeeded") {
        return { status: "processed", effect: "none", invoiceId, paymentId: Number(opened.id) }
      }
      if (opened && String(opened.status) === "pending") {
        await tenantUpdate("billing_payments", { status: "failed" }, "id = ?", [opened.id])
        await recomputeInvoice(invoiceId)
        return { status: "processed", effect: "payment_failed", invoiceId, paymentId: Number(opened.id) }
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
        return { status: "processed", effect: "payment_failed", invoiceId, paymentId: payment.id }
      }
      return { status: "processed", effect: "none", invoiceId }
    }

    case "refund.succeeded": {
      const refund = await refundInvoice(
        invoiceId,
        { amount: event.amount ?? undefined, reason: `Gateway refund ${event.providerRefundId ?? event.id}` },
        session,
      )
      return { status: "processed", effect: "refund_recorded", invoiceId, paymentId: refund.id }
    }

    default:
      return { status: "ignored", effect: "none", reason: "unhandled event type", invoiceId }
  }
}

/** Persist a terminal outcome onto the ledger row. */
async function finish(event: GatewayEvent, result: ApplyResult): Promise<ApplyResult> {
  await tenantUpdate(
    "billing_gateway_events",
    {
      status: result.status === "ignored" ? "ignored" : "processed",
      effect: result.effect ?? null,
      invoice_id: result.invoiceId ?? null,
      payment_id: result.paymentId ?? null,
      reason: result.reason ?? null,
      last_error: null,
      updated_at: nowSql(),
    },
    "gateway = ? AND event_id = ?",
    [event.gateway, event.id],
  )
  return result
}

/** Record a processing failure so it is monitorable and retryable. */
async function markFailed(event: GatewayEvent, err: unknown): Promise<void> {
  try {
    await tenantUpdate(
      "billing_gateway_events",
      { status: "failed", last_error: String((err as Error)?.message ?? err).slice(0, 1000), updated_at: nowSql() },
      "gateway = ? AND event_id = ?",
      [event.gateway, event.id],
    )
  } catch (e) {
    console.error("[v0] failed to mark webhook event failed:", (e as Error).message)
  }
}

/** Ensure a row exists and bump attempts for a manual replay. */
async function markReplaying(event: GatewayEvent): Promise<number> {
  const rows = (await tenantSelect("billing_gateway_events", {
    columns: "attempts",
    where: "gateway = ? AND event_id = ?",
    params: [event.gateway, event.id],
    tail: "LIMIT 1",
  })) as any[]
  if (!rows[0]) {
    await tenantInsert("billing_gateway_events", {
      gateway: event.gateway,
      event_id: event.id,
      event_type: event.type,
      status: "processing",
      attempts: 1,
      signature_ok: 1,
      raw: safeJson(event.raw),
      normalized: safeJson(event),
    })
    return 1
  }
  const next = Number(rows[0].attempts ?? 1) + 1
  await tenantUpdate(
    "billing_gateway_events",
    { status: "processing", attempts: next, updated_at: nowSql() },
    "gateway = ? AND event_id = ?",
    [event.gateway, event.id],
  )
  return next
}

// ── Monitoring surface ───────────────────────────────────────────────────────

/** Recent webhook events for the current tenant (newest first). */
export async function listWebhookEvents(opts: { limit?: number; status?: string } = {}): Promise<WebhookEventRow[]> {
  await ensureGatewayEventsSchema()
  const limit = Math.min(Math.max(Number(opts.limit) || 100, 1), 500)
  const where = opts.status ? "status = ?" : ""
  const params = opts.status ? [opts.status] : []
  const rows = (await tenantSelect("billing_gateway_events", {
    columns:
      "id, gateway, event_id, event_type, status, effect, attempts, signature_ok, invoice_id, payment_id, last_error, reason, received_at, updated_at, created_at",
    where,
    params,
    tail: `ORDER BY id DESC LIMIT ${limit}`,
  })) as any[]
  return rows.map(toEventRow)
}

/** Aggregate counts for the monitoring header cards. */
export async function getWebhookEventStats(): Promise<WebhookEventStats> {
  await ensureGatewayEventsSchema()
  const rows = (await tenantSelect("billing_gateway_events", {
    columns: "status, COUNT(*) AS n, SUM(CASE WHEN attempts > 1 THEN 1 ELSE 0 END) AS retried",
    tail: "GROUP BY status",
  })) as any[]
  const stats: WebhookEventStats = {
    total: 0,
    processed: 0,
    duplicate: 0,
    ignored: 0,
    failed: 0,
    processing: 0,
    retried: 0,
  }
  for (const r of rows) {
    const n = Number(r.n) || 0
    stats.total += n
    stats.retried += Number(r.retried) || 0
    const s = String(r.status) as keyof WebhookEventStats
    if (s in stats && s !== "total" && s !== "retried") (stats[s] as number) += n
  }
  return stats
}

/**
 * Manually replay a stored event by its ledger id (admin action). Reconstructs
 * the normalized event from storage and re-applies it. Effects are idempotent,
 * so replaying a settled payment is a safe no-op; replaying a failed one
 * re-attempts the billing effect.
 */
export async function replayWebhookEvent(id: number): Promise<ApplyResult> {
  await ensureGatewayEventsSchema()
  const row = await tenantFindById<any>("billing_gateway_events", id)
  if (!row) throw new WebhookReplayError("Event not found", 404)

  const normalized = row.normalized ? safeParse(row.normalized) : null
  if (!normalized) {
    throw new WebhookReplayError("Event cannot be replayed (no stored payload). Ask the provider to redeliver it.", 422)
  }
  return applyGatewayEvent(normalized as GatewayEvent, { replay: true })
}

export class WebhookReplayError extends Error {
  readonly status: number
  constructor(message: string, status = 400) {
    super(message)
    this.name = "WebhookReplayError"
    this.status = status
  }
}

function toEventRow(r: any): WebhookEventRow {
  return {
    id: Number(r.id),
    gateway: String(r.gateway),
    event_id: String(r.event_id),
    event_type: String(r.event_type),
    status: String(r.status) as WebhookEventRow["status"],
    effect: r.effect ?? null,
    attempts: Number(r.attempts ?? 1),
    signature_ok: Number(r.signature_ok ?? 1) === 1,
    invoice_id: r.invoice_id != null ? Number(r.invoice_id) : null,
    payment_id: r.payment_id != null ? Number(r.payment_id) : null,
    last_error: r.last_error ?? null,
    reason: r.reason ?? null,
    received_at: r.received_at ?? null,
    updated_at: r.updated_at ?? null,
    created_at: String(r.created_at),
  }
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

function safeParse(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}
