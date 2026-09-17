import { query } from "@/lib/db"

// ---------------------------------------------------------------------------
// Legal Contracts — audit trail (server-only).
//
// Records every meaningful action on a contract template or generated contract
// (Phases 74-76): creation, version, status change, generation, edit, download,
// email, renewal, termination. Logging is always best effort — an audit write
// must never break the primary operation. Mirrors hr-letters-audit.
// ---------------------------------------------------------------------------

export type ContractEntity = "template" | "contract"

export type ContractEventType =
  | "template_created"
  | "template_updated"
  | "version_created"
  | "template_status_changed"
  | "template_approved"
  | "template_published"
  | "template_archived"
  | "contract_generated"
  | "contract_edited"
  | "contract_status_changed"
  | "contract_downloaded"
  | "contract_emailed"
  | "contract_email_failed"
  | "contract_renewed"
  | "contract_terminated"
  | "contract_cancelled"
  | "reminder_sent"

let ensured: Promise<void> | null = null

/** Idempotently create the contract event log. Safe to call repeatedly. */
export function ensureContractEventsSchema(): Promise<void> {
  if (!ensured) ensured = doEnsure()
  return ensured
}

async function doEnsure() {
  try {
    await query(`CREATE TABLE IF NOT EXISTS legal_contract_events (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      entity_type VARCHAR(20) NOT NULL,
      entity_id BIGINT UNSIGNED NOT NULL,
      entity_ref VARCHAR(60) DEFAULT NULL,
      event_type VARCHAR(60) NOT NULL,
      summary VARCHAR(300) NOT NULL,
      detail JSON DEFAULT NULL,
      actor_id BIGINT UNSIGNED DEFAULT NULL,
      actor_name VARCHAR(150) DEFAULT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_legal_event_entity (entity_type, entity_id, created_at),
      KEY idx_legal_event_type (event_type)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
  } catch (error) {
    console.error("[v0] ensureContractEventsSchema failed:", (error as Error).message)
  }
}

export type ContractEvent = {
  id: number
  entity_type: ContractEntity
  entity_id: number
  entity_ref: string | null
  event_type: ContractEventType
  summary: string
  detail: Record<string, unknown> | null
  actor_id: number | null
  actor_name: string | null
  created_at: string | null
}

export async function logContractEvent(opts: {
  entity: ContractEntity
  entityId: number
  entityRef?: string | null
  type: ContractEventType
  summary: string
  detail?: Record<string, unknown> | null
  actorId?: number | null
  actorName?: string | null
}): Promise<void> {
  try {
    await ensureContractEventsSchema()
    await query(
      `INSERT INTO legal_contract_events
         (entity_type, entity_id, entity_ref, event_type, summary, detail, actor_id, actor_name)
       VALUES (?,?,?,?,?,?,?,?)`,
      [
        opts.entity,
        opts.entityId,
        opts.entityRef ?? null,
        opts.type,
        opts.summary,
        opts.detail && Object.keys(opts.detail).length ? JSON.stringify(opts.detail) : null,
        opts.actorId ?? null,
        opts.actorName ?? null,
      ],
    )
  } catch (error) {
    console.error("[v0] logContractEvent failed:", (error as Error).message)
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

/** Full audit history for one entity, newest first. */
export async function getContractEvents(entity: ContractEntity, entityId: number): Promise<ContractEvent[]> {
  try {
    await ensureContractEventsSchema()
    const rows = await query<any[]>(
      `SELECT e.*, u.name AS actor_display
         FROM legal_contract_events e
         LEFT JOIN users u ON u.id = e.actor_id
        WHERE e.entity_type = ? AND e.entity_id = ?
        ORDER BY e.created_at DESC, e.id DESC`,
      [entity, entityId],
    ).catch(() =>
      query<any[]>(
        `SELECT * FROM legal_contract_events WHERE entity_type = ? AND entity_id = ? ORDER BY created_at DESC, id DESC`,
        [entity, entityId],
      ),
    )
    return rows.map((r) => ({
      id: Number(r.id),
      entity_type: r.entity_type,
      entity_id: Number(r.entity_id),
      entity_ref: r.entity_ref ?? null,
      event_type: r.event_type,
      summary: r.summary,
      detail: parseDetail(r.detail),
      actor_id: r.actor_id != null ? Number(r.actor_id) : null,
      actor_name: r.actor_name || r.actor_display || null,
      created_at: r.created_at ? new Date(r.created_at).toISOString() : null,
    }))
  } catch {
    return []
  }
}
