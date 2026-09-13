import { query } from "@/lib/db"

// ---------------------------------------------------------------------------
// Finance audit trail (server-only).
//
// Append-only record of every meaningful lifecycle action on a financial
// document (created / issued / sent / posted / payment recorded / cancelled /
// reversed). Mirrors the hr_letter_events pattern: logging is always best
// effort so an audit failure can never break the primary financial operation.
//
// The finance_audit_events table is created by the 2026-09-13 migration; this
// module never issues DDL (per the "migration file only" schema policy).
// ---------------------------------------------------------------------------

export type FinanceAuditEventType =
  | "created"
  | "updated"
  | "issued"
  | "sent"
  | "posted"
  | "payment_recorded"
  | "cancelled"
  | "reversed"
  | "deleted"

export type FinanceAuditEvent = {
  id: number
  entity_type: string
  entity_pk: number | null
  entity_ref: string | null
  event_type: FinanceAuditEventType
  summary: string
  detail: Record<string, unknown> | null
  amount: number | null
  voucher_no: string | null
  actor_id: number | null
  actor_name: string | null
  created_at: string | null
}

export async function logFinanceEvent(opts: {
  entityType: string
  entityPk?: number | null
  entityRef?: string | null
  type: FinanceAuditEventType
  summary: string
  detail?: Record<string, unknown> | null
  amount?: number | null
  voucherNo?: string | null
  actorId?: number | null
  actorName?: string | null
}): Promise<void> {
  try {
    await query(
      `INSERT INTO finance_audit_events
         (entity_type, entity_pk, entity_ref, event_type, summary, detail, amount, voucher_no, actor_id, actor_name)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [
        opts.entityType,
        opts.entityPk ?? null,
        opts.entityRef ?? null,
        opts.type,
        opts.summary,
        opts.detail && Object.keys(opts.detail).length ? JSON.stringify(opts.detail) : null,
        opts.amount ?? null,
        opts.voucherNo ?? null,
        opts.actorId ?? null,
        opts.actorName ?? null,
      ],
    )
  } catch (error) {
    // Never let audit logging break the primary operation.
    console.error("[v0] logFinanceEvent failed:", (error as Error).message)
  }
}

/** Full audit history for a document, newest first. */
export async function getFinanceEvents(entityType: string, entityPk: number): Promise<FinanceAuditEvent[]> {
  try {
    const rows = (await query(
      `SELECT e.*, u.name AS actor_display
         FROM finance_audit_events e
         LEFT JOIN users u ON u.id = e.actor_id
        WHERE e.entity_type = ? AND e.entity_pk = ?
        ORDER BY e.created_at DESC, e.id DESC`,
      [entityType, entityPk],
    )) as any[]
    return rows.map((r) => ({
      id: Number(r.id),
      entity_type: r.entity_type,
      entity_pk: r.entity_pk != null ? Number(r.entity_pk) : null,
      entity_ref: r.entity_ref ?? null,
      event_type: r.event_type,
      summary: r.summary,
      detail: parseDetail(r.detail),
      amount: r.amount != null ? Number(r.amount) : null,
      voucher_no: r.voucher_no ?? null,
      actor_id: r.actor_id != null ? Number(r.actor_id) : null,
      actor_name: r.actor_name || r.actor_display || null,
      created_at: r.created_at ? new Date(r.created_at).toISOString() : null,
    }))
  } catch {
    return []
  }
}

function parseDetail(value: unknown): Record<string, unknown> | null {
  if (!value) return null
  if (typeof value === "object") return value as Record<string, unknown>
  try {
    const parsed = JSON.parse(String(value))
    return parsed && typeof parsed === "object" ? parsed : null
  } catch {
    return null
  }
}
