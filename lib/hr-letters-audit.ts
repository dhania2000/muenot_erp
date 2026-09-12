import { query } from "@/lib/db"

// ---------------------------------------------------------------------------
// HR Letters — audit trail (server-only).
//
// Every meaningful action on a generated letter (creation, regeneration,
// status change, email delivery, cancellation, filing into the employee
// document vault) is recorded here so the registry has a complete, tamper-
// evident history — mirroring hr_employee_events. Logging is always best
// effort: an audit failure must never break the primary operation.
// ---------------------------------------------------------------------------

export type LetterEventType =
  | "generated"
  | "regenerated"
  | "status_changed"
  | "issued"
  | "delivered"
  | "emailed"
  | "cancelled"
  | "deleted"
  | "filed_to_documents"
  | "pdf_downloaded"

let ensured: Promise<void> | null = null

/** Idempotently create the letter event log. Safe to call repeatedly. */
export function ensureLetterEventsSchema(): Promise<void> {
  if (!ensured) ensured = doEnsure()
  return ensured
}

async function doEnsure() {
  try {
    await query(`CREATE TABLE IF NOT EXISTS hr_letter_events (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      letter_id BIGINT UNSIGNED NOT NULL,
      letter_number VARCHAR(40) DEFAULT NULL,
      event_type VARCHAR(60) NOT NULL,
      summary VARCHAR(255) NOT NULL,
      detail JSON DEFAULT NULL,
      actor_id BIGINT UNSIGNED DEFAULT NULL,
      actor_name VARCHAR(150) DEFAULT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_hr_letter_event_letter (letter_id, created_at),
      KEY idx_hr_letter_event_type (event_type)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
  } catch (error) {
    console.error("[v0] ensureLetterEventsSchema failed:", (error as Error).message)
  }
}

export type LetterEvent = {
  id: number
  letter_id: number
  letter_number: string | null
  event_type: LetterEventType
  summary: string
  detail: Record<string, unknown> | null
  actor_id: number | null
  actor_name: string | null
  created_at: string | null
}

export async function logLetterEvent(opts: {
  letterId: number
  letterNumber?: string | null
  type: LetterEventType
  summary: string
  detail?: Record<string, unknown> | null
  actorId?: number | null
  actorName?: string | null
}): Promise<void> {
  try {
    await ensureLetterEventsSchema()
    await query(
      `INSERT INTO hr_letter_events
         (letter_id, letter_number, event_type, summary, detail, actor_id, actor_name)
       VALUES (?,?,?,?,?,?,?)`,
      [
        opts.letterId,
        opts.letterNumber ?? null,
        opts.type,
        opts.summary,
        opts.detail && Object.keys(opts.detail).length ? JSON.stringify(opts.detail) : null,
        opts.actorId ?? null,
        opts.actorName ?? null,
      ],
    )
  } catch (error) {
    // Never let audit logging break the primary operation.
    console.error("[v0] logLetterEvent failed:", (error as Error).message)
  }
}

/** Full audit history for a letter, newest first. */
export async function getLetterEvents(letterId: number): Promise<LetterEvent[]> {
  try {
    await ensureLetterEventsSchema()
    const rows = await query<any[]>(
      `SELECT e.*, u.name AS actor_display
         FROM hr_letter_events e
         LEFT JOIN users u ON u.id = e.actor_id
        WHERE e.letter_id = ?
        ORDER BY e.created_at DESC, e.id DESC`,
      [letterId],
    )
    return rows.map((r) => ({
      id: Number(r.id),
      letter_id: Number(r.letter_id),
      letter_number: r.letter_number ?? null,
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
