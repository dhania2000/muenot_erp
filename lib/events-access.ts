import "server-only"
import { randomBytes } from "node:crypto"
import { query } from "@/lib/db"

// ---------------------------------------------------------------------------
// Events + secure QR access data layer.
//
// Builds on the existing `hr_events` table (the legacy Events module) and adds
// two new tables — `event_participants` and `event_access_logs` — plus the
// extra event columns the production Events spec needs. Everything is created
// idempotently via ensureEventsAccessSchema(), mirroring the ensure* pattern
// used across the codebase (e.g. ensureEmployeeEventsSchema), so the feature
// works even before a hand-run migration.
//
// Security model:
//   - QR codes NEVER contain employee/event personal data — only an opaque,
//     cryptographically-random token that references a DB row.
//   - Two token namespaces: an Event token (identifies the event) and a
//     per-participant Employee Access token (authorizes one employee for one
//     event). Both are validated server-side at scan time.
//   - Employee status, event status and access window are always re-checked
//     LIVE from the database at scan time — never trusted from the token.
// ---------------------------------------------------------------------------

export const EVENT_STATUSES = ["draft", "scheduled", "live", "completed", "cancelled"] as const
export type EventStatus = (typeof EVENT_STATUSES)[number]

export const ACCESS_STATUSES = [
  "invited",
  "allowed",
  "checked_in",
  "checked_out",
  "revoked",
  "denied",
] as const
export type AccessStatus = (typeof ACCESS_STATUSES)[number]

// Reasons stored on every authorization decision (Phase 85).
export type ScanResult =
  | "APPROVED"
  | "ALREADY_CHECKED_IN"
  | "CHECKED_OUT"
  | "INACTIVE_EMPLOYEE"
  | "NOT_AUTHORIZED"
  | "QR_EXPIRED"
  | "QR_REVOKED"
  | "EVENT_CLOSED"
  | "EVENT_NOT_OPEN"
  | "EVENT_LANDING"
  | "INVALID_TOKEN"
  | "RATE_LIMITED"

/** Legacy statuses ("pending") map onto the new set for display/filtering. */
export function normalizeEventStatus(raw: string | null | undefined): EventStatus {
  const v = String(raw || "").toLowerCase()
  if (v === "pending") return "scheduled"
  if ((EVENT_STATUSES as readonly string[]).includes(v)) return v as EventStatus
  return "draft"
}

/** A cryptographically-random, URL-safe token that is hard to guess (Phase 37). */
export function generateToken(): string {
  return randomBytes(24).toString("base64url")
}

let ensured: Promise<void> | null = null
export function ensureEventsAccessSchema(): Promise<void> {
  if (!ensured) ensured = doEnsure()
  return ensured
}

async function doEnsure() {
  // Base table (created by the legacy module; ensure it exists on fresh installs).
  try {
    await query(`CREATE TABLE IF NOT EXISTS hr_events (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT,
      name VARCHAR(200) NOT NULL,
      label_color VARCHAR(20) DEFAULT '#4f46e5',
      location VARCHAR(255) DEFAULT NULL,
      description TEXT DEFAULT NULL,
      start_at DATETIME NOT NULL,
      end_at DATETIME NOT NULL,
      repeat_enabled TINYINT(1) NOT NULL DEFAULT 0,
      repeat_cycle VARCHAR(10) DEFAULT 'week',
      repeat_every INT DEFAULT 1,
      repeat_ends_on DATE DEFAULT NULL,
      host_name VARCHAR(150) DEFAULT NULL,
      attendee_type VARCHAR(20) DEFAULT 'all_employees',
      attendees JSON DEFAULT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'scheduled',
      created_by INT UNSIGNED DEFAULT NULL,
      created_by_name VARCHAR(150) DEFAULT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
  } catch (error) {
    console.error("[v0] ensureEventsAccessSchema (hr_events) failed:", (error as Error).message)
  }

  // Extra event columns — added individually so an existing one doesn't abort the rest.
  for (const col of [
    "ADD COLUMN IF NOT EXISTS `event_ref` VARCHAR(30) DEFAULT NULL",
    "ADD COLUMN IF NOT EXISTS `capacity` INT UNSIGNED DEFAULT NULL",
    "ADD COLUMN IF NOT EXISTS `instructions` TEXT DEFAULT NULL",
    "ADD COLUMN IF NOT EXISTS `contact_person` VARCHAR(150) DEFAULT NULL",
    "ADD COLUMN IF NOT EXISTS `meeting_details` TEXT DEFAULT NULL",
    "ADD COLUMN IF NOT EXISTS `event_token` VARCHAR(64) DEFAULT NULL",
    "ADD COLUMN IF NOT EXISTS `access_before_minutes` INT NOT NULL DEFAULT 30",
    "ADD COLUMN IF NOT EXISTS `access_after_minutes` INT NOT NULL DEFAULT 0",
    "ADD COLUMN IF NOT EXISTS `allow_dob` TINYINT(1) NOT NULL DEFAULT 0",
    "ADD COLUMN IF NOT EXISTS `updated_at` TIMESTAMP NULL DEFAULT NULL",
  ]) {
    try {
      await query(`ALTER TABLE hr_events ${col}`)
    } catch {
      /* column already present on servers without IF NOT EXISTS */
    }
  }
  try {
    await query("ALTER TABLE hr_events ADD UNIQUE KEY uniq_event_token (event_token)")
  } catch {
    /* index already present */
  }

  try {
    await query(`CREATE TABLE IF NOT EXISTS event_participants (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      event_id INT UNSIGNED NOT NULL,
      employee_pk INT UNSIGNED NOT NULL,
      employee_ref VARCHAR(50) DEFAULT NULL,
      employee_name VARCHAR(150) DEFAULT NULL,
      designation VARCHAR(150) DEFAULT NULL,
      department VARCHAR(150) DEFAULT NULL,
      employment_status VARCHAR(40) DEFAULT NULL,
      invitation_status VARCHAR(20) NOT NULL DEFAULT 'invited',
      access_status VARCHAR(20) NOT NULL DEFAULT 'invited',
      token VARCHAR(64) DEFAULT NULL,
      token_active TINYINT(1) NOT NULL DEFAULT 1,
      revoked_reason VARCHAR(255) DEFAULT NULL,
      checked_in_at DATETIME DEFAULT NULL,
      checked_out_at DATETIME DEFAULT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uniq_event_employee (event_id, employee_pk),
      UNIQUE KEY uniq_participant_token (token),
      KEY idx_participant_event (event_id),
      KEY idx_participant_employee (employee_pk)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
  } catch (error) {
    console.error("[v0] ensureEventsAccessSchema (event_participants) failed:", (error as Error).message)
  }

  try {
    await query(`CREATE TABLE IF NOT EXISTS event_access_logs (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      event_id INT UNSIGNED DEFAULT NULL,
      participant_id BIGINT UNSIGNED DEFAULT NULL,
      employee_pk INT UNSIGNED DEFAULT NULL,
      employee_name VARCHAR(150) DEFAULT NULL,
      token_ref VARCHAR(64) DEFAULT NULL,
      result VARCHAR(30) NOT NULL,
      reason VARCHAR(255) DEFAULT NULL,
      scanner_name VARCHAR(150) DEFAULT NULL,
      venue VARCHAR(255) DEFAULT NULL,
      device_info VARCHAR(255) DEFAULT NULL,
      scan_time TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_log_event (event_id, scan_time),
      KEY idx_log_participant (participant_id),
      KEY idx_log_result (result)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
  } catch (error) {
    console.error("[v0] ensureEventsAccessSchema (event_access_logs) failed:", (error as Error).message)
  }

  // Backfill event_ref and event_token for events created before this feature.
  try {
    const rows = await query<{ id: number }[]>(
      "SELECT id FROM hr_events WHERE event_token IS NULL OR event_token = '' OR event_ref IS NULL OR event_ref = ''",
    )
    for (const r of rows) {
      await query("UPDATE hr_events SET event_token = COALESCE(NULLIF(event_token,''), ?), event_ref = COALESCE(NULLIF(event_ref,''), ?) WHERE id = ?", [
        generateToken(),
        `EVT-${String(r.id).padStart(4, "0")}`,
        r.id,
      ])
    }
  } catch (error) {
    console.error("[v0] ensureEventsAccessSchema backfill failed:", (error as Error).message)
  }
}

// ---------------------------------------------------------------------------
// Access-window evaluation (Phases 15, 16, 84)
// ---------------------------------------------------------------------------

export type EventRow = {
  id: number
  name: string
  location: string | null
  start_at: string
  end_at: string
  status: string
  event_token: string | null
  access_before_minutes: number
  access_after_minutes: number
  allow_dob: number
}

export function isEventClosed(status: string): boolean {
  const s = normalizeEventStatus(status)
  return s === "completed" || s === "cancelled"
}

/** Is "now" within [start - before, end + after] for the event? */
export function isWithinAccessWindow(event: Pick<EventRow, "start_at" | "end_at" | "access_before_minutes" | "access_after_minutes">, now = new Date()): boolean {
  const start = new Date(String(event.start_at).replace(" ", "T"))
  const end = new Date(String(event.end_at).replace(" ", "T"))
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return false
  const open = new Date(start.getTime() - (event.access_before_minutes || 0) * 60_000)
  const close = new Date(end.getTime() + (event.access_after_minutes || 0) * 60_000)
  return now >= open && now <= close
}

// ---------------------------------------------------------------------------
// Lightweight in-memory rate limiter for the public scan endpoint (Phase 38).
// Sufficient for a single-node deployment; keyed by IP + token bucket.
// ---------------------------------------------------------------------------

declare global {
  // eslint-disable-next-line no-var
  var __eventScanHits: Map<string, number[]> | undefined
}
const scanHits = globalThis.__eventScanHits ?? new Map<string, number[]>()
if (process.env.NODE_ENV !== "production") globalThis.__eventScanHits = scanHits

export function rateLimitScan(key: string, limit = 20, windowMs = 60_000): boolean {
  const now = Date.now()
  const hits = (scanHits.get(key) ?? []).filter((t) => now - t < windowMs)
  hits.push(now)
  scanHits.set(key, hits)
  return hits.length <= limit
}

export async function logScan(opts: {
  eventId?: number | null
  participantId?: number | null
  employeePk?: number | null
  employeeName?: string | null
  tokenRef?: string | null
  result: ScanResult
  reason?: string | null
  scannerName?: string | null
  venue?: string | null
  deviceInfo?: string | null
}): Promise<void> {
  try {
    await query(
      `INSERT INTO event_access_logs
         (event_id, participant_id, employee_pk, employee_name, token_ref, result, reason, scanner_name, venue, device_info)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [
        opts.eventId ?? null,
        opts.participantId ?? null,
        opts.employeePk ?? null,
        opts.employeeName ?? null,
        opts.tokenRef ?? null,
        opts.result,
        opts.reason ?? null,
        opts.scannerName ?? null,
        opts.venue ?? null,
        opts.deviceInfo ?? null,
      ],
    )
  } catch (error) {
    console.error("[v0] logScan failed:", (error as Error).message)
  }
}
