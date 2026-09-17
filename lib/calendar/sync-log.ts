import "server-only"
import { query } from "@/lib/db"

/**
 * Central calendar sync audit log (spec Phases 45, 71, 90-92).
 *
 * Every reconciliation attempt — success, failure, retry, cancellation or
 * disconnect — is recorded here so the sync engine is observable and each
 * event's history can be traced back to its source record. Writing to the log
 * is always best-effort and never allowed to break a sync run.
 */

export type SyncAction =
  | "synced"
  | "sync_failed"
  | "retried"
  | "cancelled"
  | "disconnected"
  | "skipped"

let ensured: Promise<void> | null = null

export function ensureCalendarSyncLog(): Promise<void> {
  if (!ensured) ensured = doEnsure()
  return ensured
}

async function doEnsure() {
  try {
    await query(`CREATE TABLE IF NOT EXISTS calendar_sync_log (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      source_module VARCHAR(40) NOT NULL,
      source_record_id VARCHAR(64) NOT NULL,
      user_id INT UNSIGNED DEFAULT NULL,
      action VARCHAR(40) NOT NULL,
      status VARCHAR(40) DEFAULT NULL,
      external_event_id VARCHAR(255) DEFAULT NULL,
      message VARCHAR(500) DEFAULT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_sync_record (source_module, source_record_id, created_at),
      KEY idx_sync_user (user_id, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
  } catch (error) {
    console.error("[v0] ensureCalendarSyncLog failed:", (error as Error).message)
  }
}

export async function logCalendarSync(opts: {
  module: string
  recordId: string | number
  userId?: number | null
  action: SyncAction
  status?: string | null
  externalEventId?: string | null
  message?: string | null
}): Promise<void> {
  try {
    await ensureCalendarSyncLog()
    await query(
      `INSERT INTO calendar_sync_log
         (source_module, source_record_id, user_id, action, status, external_event_id, message)
       VALUES (?,?,?,?,?,?,?)`,
      [
        opts.module,
        String(opts.recordId),
        opts.userId ?? null,
        opts.action,
        opts.status ?? null,
        opts.externalEventId ?? null,
        opts.message ? opts.message.slice(0, 500) : null,
      ],
    )
  } catch (error) {
    console.error("[v0] logCalendarSync failed:", (error as Error).message)
  }
}
