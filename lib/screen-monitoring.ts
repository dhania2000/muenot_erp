import { query } from "@/lib/db"
import type { SessionPayload } from "@/lib/auth"
import { getTimeZone, nowDateTimeInTz, todayInTz, hoursBetween } from "@/lib/hr-attendance"

// ---------------------------------------------------------------------------
// Screen Activity Monitoring — shared data layer.
//
// A monitoring session is created for each Clock In (linked to the existing
// hr_attendance row) and captures one screenshot every 60 seconds AFTER the
// employee explicitly grants browser screen-share permission. This module owns:
//   - self-healing schema for the three monitoring tables + the settings row
//   - the session lifecycle (start / event / stop / stale detection)
//   - screenshot metadata + secure (LONGBLOB, non-public) storage
//   - the audit trail
//   - retention cleanup + failed-capture retry helpers used by the cron
//
// It NEVER duplicates Attendance, Employee, RBAC, Notification or Storage
// systems — attendance stays the source of truth for clock in/out, employees
// come from the HR master, permissions from lib/permissions + lib/permission-store.
// ---------------------------------------------------------------------------

export const MONITORING_MODULE_KEY = "hr.screen_monitoring"

export type SessionStatus =
  | "Pending"
  | "Active"
  | "Paused"
  | "Stopped"
  | "Permission Denied"
  | "Failed"
  | "Completed"

export type PermissionStatus = "Pending" | "Granted" | "Denied" | "Revoked"

export type UploadStatus = "Pending" | "Uploaded" | "Failed"

export type MonitoringSettings = {
  enabled: boolean
  /** Screenshot retention window in days before file bytes are purged. */
  retention_days: number
  /** JPEG quality 0.1 – 1.0 used by the client compressor. */
  image_quality: number
  /** Capture cadence in seconds (spec default: 60). */
  capture_interval_seconds: number
  /** Longest edge the client downscales a frame to before compressing. */
  max_width: number
  /** Minutes without a capture before a still-Active session is deemed stale. */
  stale_after_minutes: number
}

export const DEFAULT_SETTINGS: MonitoringSettings = {
  enabled: true,
  retention_days: 30,
  image_quality: 0.6,
  capture_interval_seconds: 60,
  max_width: 1280,
  stale_after_minutes: 5,
}

export const RETENTION_CHOICES = [7, 30, 60, 90] as const

// ---------------------------------------------------------------------------
// Schema (idempotent, self-healing) — mirrors the ensure* pattern used across
// the HR modules so the feature comes online without a manual migration.
// ---------------------------------------------------------------------------
let schemaReady: Promise<void> | null = null

export function ensureMonitoringSchema(): Promise<void> {
  if (!schemaReady) schemaReady = doEnsureSchema()
  return schemaReady
}

async function doEnsureSchema() {
  await query(`
    CREATE TABLE IF NOT EXISTS screen_monitoring_sessions (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      session_id VARCHAR(48) NOT NULL,
      employee_id BIGINT UNSIGNED NOT NULL,
      employee_name VARCHAR(180) NOT NULL,
      user_id INT UNSIGNED DEFAULT NULL,
      attendance_id BIGINT UNSIGNED DEFAULT NULL,
      attendance_ref VARCHAR(40) DEFAULT NULL,
      work_date DATE NOT NULL,
      started_at DATETIME NOT NULL,
      stopped_at DATETIME DEFAULT NULL,
      duration_seconds INT UNSIGNED DEFAULT NULL,
      status ENUM('Pending','Active','Paused','Stopped','Permission Denied','Failed','Completed') NOT NULL DEFAULT 'Pending',
      permission_status ENUM('Pending','Granted','Denied','Revoked') NOT NULL DEFAULT 'Pending',
      capture_count INT UNSIGNED NOT NULL DEFAULT 0,
      last_capture_at DATETIME DEFAULT NULL,
      source_type VARCHAR(40) DEFAULT NULL,
      browser VARCHAR(120) DEFAULT NULL,
      os VARCHAR(120) DEFAULT NULL,
      device_id VARCHAR(120) DEFAULT NULL,
      consent_at DATETIME DEFAULT NULL,
      stop_reason VARCHAR(60) DEFAULT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_sms_session (session_id),
      KEY idx_sms_employee (employee_id),
      KEY idx_sms_user (user_id),
      KEY idx_sms_attendance (attendance_id),
      KEY idx_sms_workdate (work_date),
      KEY idx_sms_status (status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `)

  await query(`
    CREATE TABLE IF NOT EXISTS screen_monitoring_screenshots (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      screenshot_id VARCHAR(48) NOT NULL,
      session_pk BIGINT UNSIGNED NOT NULL,
      session_id VARCHAR(48) NOT NULL,
      attendance_id BIGINT UNSIGNED DEFAULT NULL,
      employee_id BIGINT UNSIGNED NOT NULL,
      captured_at DATETIME NOT NULL,
      capture_sequence INT UNSIGNED NOT NULL,
      source_type VARCHAR(40) DEFAULT NULL,
      file_ref VARCHAR(120) NOT NULL,
      file_size INT UNSIGNED NOT NULL DEFAULT 0,
      file_mime VARCHAR(80) NOT NULL DEFAULT 'image/jpeg',
      file_data LONGBLOB NULL,
      width INT UNSIGNED DEFAULT NULL,
      height INT UNSIGNED DEFAULT NULL,
      upload_status ENUM('Pending','Uploaded','Failed') NOT NULL DEFAULT 'Pending',
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_smss_screenshot (screenshot_id),
      UNIQUE KEY uq_smss_seq (session_pk, capture_sequence),
      UNIQUE KEY uq_smss_ref (file_ref),
      KEY idx_smss_session (session_pk),
      KEY idx_smss_employee (employee_id),
      KEY idx_smss_captured (captured_at),
      KEY idx_smss_upload (upload_status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `)

  await query(`
    CREATE TABLE IF NOT EXISTS screen_monitoring_audit (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      action VARCHAR(40) NOT NULL,
      session_pk BIGINT UNSIGNED DEFAULT NULL,
      session_id VARCHAR(48) DEFAULT NULL,
      screenshot_pk BIGINT UNSIGNED DEFAULT NULL,
      employee_id BIGINT UNSIGNED DEFAULT NULL,
      user_id INT UNSIGNED DEFAULT NULL,
      user_name VARCHAR(191) DEFAULT NULL,
      detail JSON NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_sma_action (action),
      KEY idx_sma_session (session_pk),
      KEY idx_sma_created (created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `)

  // Ephemeral WebRTC signaling relay for the live-view feature. Each row is a
  // single offer/answer/ICE message between one HR viewer and the employee
  // broadcaster for a session. Rows are short-lived: consumed on read and
  // swept after a few minutes. No media ever touches the server — this table
  // only brokers the peer-to-peer handshake.
  await query(`
    CREATE TABLE IF NOT EXISTS screen_monitoring_signals (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      session_pk BIGINT UNSIGNED NOT NULL,
      viewer_id VARCHAR(64) NOT NULL,
      sender ENUM('viewer','broadcaster') NOT NULL,
      kind ENUM('offer','answer','ice','bye') NOT NULL,
      payload LONGTEXT NULL,
      consumed TINYINT(1) NOT NULL DEFAULT 0,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_sig_poll (session_pk, sender, consumed),
      KEY idx_sig_created (created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `)

  await query(`
    CREATE TABLE IF NOT EXISTS screen_monitoring_settings (
      id TINYINT UNSIGNED NOT NULL DEFAULT 1,
      enabled TINYINT(1) NOT NULL DEFAULT 1,
      retention_days INT UNSIGNED NOT NULL DEFAULT 30,
      image_quality DECIMAL(3,2) NOT NULL DEFAULT 0.60,
      capture_interval_seconds INT UNSIGNED NOT NULL DEFAULT 60,
      max_width INT UNSIGNED NOT NULL DEFAULT 1280,
      stale_after_minutes INT UNSIGNED NOT NULL DEFAULT 5,
      updated_by INT UNSIGNED DEFAULT NULL,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `)
  await query("INSERT IGNORE INTO screen_monitoring_settings (id) VALUES (1)")
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
export async function getMonitoringSettings(): Promise<MonitoringSettings> {
  await ensureMonitoringSchema()
  const rows = await query<any[]>("SELECT * FROM screen_monitoring_settings WHERE id = 1 LIMIT 1")
  const r = rows[0]
  if (!r) return { ...DEFAULT_SETTINGS }
  return {
    enabled: Boolean(Number(r.enabled)),
    retention_days: Number(r.retention_days) || DEFAULT_SETTINGS.retention_days,
    image_quality: Number(r.image_quality) || DEFAULT_SETTINGS.image_quality,
    capture_interval_seconds: Number(r.capture_interval_seconds) || DEFAULT_SETTINGS.capture_interval_seconds,
    max_width: Number(r.max_width) || DEFAULT_SETTINGS.max_width,
    stale_after_minutes: Number(r.stale_after_minutes) || DEFAULT_SETTINGS.stale_after_minutes,
  }
}

export async function saveMonitoringSettings(
  patch: Partial<MonitoringSettings>,
  updatedBy: number,
): Promise<MonitoringSettings> {
  await ensureMonitoringSchema()
  const current = await getMonitoringSettings()
  const next: MonitoringSettings = {
    enabled: patch.enabled ?? current.enabled,
    retention_days: clamp(patch.retention_days ?? current.retention_days, 1, 3650),
    image_quality: clampFloat(patch.image_quality ?? current.image_quality, 0.1, 1),
    capture_interval_seconds: clamp(patch.capture_interval_seconds ?? current.capture_interval_seconds, 15, 3600),
    max_width: clamp(patch.max_width ?? current.max_width, 320, 3840),
    stale_after_minutes: clamp(patch.stale_after_minutes ?? current.stale_after_minutes, 2, 120),
  }
  await query(
    `UPDATE screen_monitoring_settings
       SET enabled=?, retention_days=?, image_quality=?, capture_interval_seconds=?, max_width=?, stale_after_minutes=?, updated_by=?
     WHERE id = 1`,
    [
      next.enabled ? 1 : 0,
      next.retention_days,
      next.image_quality,
      next.capture_interval_seconds,
      next.max_width,
      next.stale_after_minutes,
      updatedBy,
    ],
  )
  return next
}

function clamp(v: number, lo: number, hi: number): number {
  const n = Math.round(Number(v))
  if (!Number.isFinite(n)) return lo
  return Math.min(hi, Math.max(lo, n))
}
function clampFloat(v: number, lo: number, hi: number): number {
  const n = Number(v)
  if (!Number.isFinite(n)) return lo
  return Math.min(hi, Math.max(lo, n))
}

// ---------------------------------------------------------------------------
// Employee + attendance resolution (reuses the HR master + attendance table)
// ---------------------------------------------------------------------------
export type EmployeeRef = { id: number; employee_name: string }

/** The employee linked to the session's login email (never creates one here). */
export async function resolveEmployeeForSession(session: SessionPayload): Promise<EmployeeRef | null> {
  const rows = await query<EmployeeRef[]>(
    "SELECT id, employee_name FROM hr_employees WHERE official_email = ? OR personal_email = ? LIMIT 1",
    [session.email, session.email],
  )
  return rows[0] ?? null
}

/** Today's attendance row for an employee, if any. */
export async function todaysAttendance(
  employeeId: number,
  timeZone: string,
): Promise<{ id: number; attendance_id: string; work_date: string; clock_out: string | null } | null> {
  const rows = await query<any[]>(
    "SELECT id, attendance_id, work_date, clock_out, active_since FROM hr_attendance WHERE employee_id = ? AND work_date = ? LIMIT 1",
    [employeeId, todayInTz(timeZone)],
  )
  return rows[0] ?? null
}

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------
export type MonitoringSession = {
  id: number
  session_id: string
  employee_id: number
  employee_name: string
  user_id: number | null
  attendance_id: number | null
  attendance_ref: string | null
  work_date: string
  started_at: string
  stopped_at: string | null
  duration_seconds: number | null
  status: SessionStatus
  permission_status: PermissionStatus
  capture_count: number
  last_capture_at: string | null
  source_type: string | null
  browser: string | null
  os: string | null
  device_id: string | null
  consent_at: string | null
  stop_reason: string | null
}

function genId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`.toUpperCase()
}

/** The open (Pending/Active/Paused) session for an attendance row, if any. */
export async function openSessionForAttendance(attendanceId: number): Promise<MonitoringSession | null> {
  await ensureMonitoringSchema()
  const rows = await query<MonitoringSession[]>(
    `SELECT * FROM screen_monitoring_sessions
      WHERE attendance_id = ? AND status IN ('Pending','Active','Paused')
      ORDER BY id DESC LIMIT 1`,
    [attendanceId],
  )
  return rows[0] ?? null
}

export async function getSessionById(id: number): Promise<MonitoringSession | null> {
  await ensureMonitoringSchema()
  const rows = await query<MonitoringSession[]>("SELECT * FROM screen_monitoring_sessions WHERE id = ? LIMIT 1", [id])
  return rows[0] ?? null
}

export async function getSessionByBusinessId(sessionId: string): Promise<MonitoringSession | null> {
  await ensureMonitoringSchema()
  const rows = await query<MonitoringSession[]>(
    "SELECT * FROM screen_monitoring_sessions WHERE session_id = ? LIMIT 1",
    [sessionId],
  )
  return rows[0] ?? null
}

export type StartSessionInput = {
  employee: EmployeeRef
  userId: number
  attendanceId: number | null
  attendanceRef: string | null
  workDate: string
  permissionGranted: boolean
  sourceType?: string | null
  browser?: string | null
  os?: string | null
  deviceId?: string | null
}

/**
 * Start (or reuse) a monitoring session for a Clock In. Idempotent per
 * attendance row: an already-open session is returned instead of creating a
 * duplicate (Phase 33). Permission denial still records a session so the
 * status is auditable and visible (Phase 1.6 / Phase 4).
 */
export async function startSession(input: StartSessionInput): Promise<MonitoringSession> {
  await ensureMonitoringSchema()
  const tz = await getTimeZone()
  const now = nowDateTimeInTz(tz)

  if (input.attendanceId) {
    const existing = await openSessionForAttendance(input.attendanceId)
    if (existing) return existing
  }

  const status: SessionStatus = input.permissionGranted ? "Active" : "Permission Denied"
  const permission: PermissionStatus = input.permissionGranted ? "Granted" : "Denied"
  const sessionId = genId("SMS")

  await query(
    `INSERT INTO screen_monitoring_sessions
       (session_id, employee_id, employee_name, user_id, attendance_id, attendance_ref, work_date,
        started_at, status, permission_status, source_type, browser, os, device_id, consent_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      sessionId,
      input.employee.id,
      input.employee.employee_name,
      input.userId,
      input.attendanceId,
      input.attendanceRef,
      input.workDate,
      now,
      status,
      permission,
      input.sourceType ?? null,
      input.browser ?? null,
      input.os ?? null,
      input.deviceId ?? null,
      input.permissionGranted ? now : null,
    ],
  )
  const created = await getSessionByBusinessId(sessionId)
  return created as MonitoringSession
}

/**
 * Close a session: compute duration, set the terminal status and stop reason.
 * Never re-opens an already-terminal session (Phase 5 — do not continue after
 * Clock Out).
 */
export async function stopSession(
  id: number,
  opts: { reason?: string; status?: SessionStatus; permissionStatus?: PermissionStatus } = {},
): Promise<MonitoringSession | null> {
  await ensureMonitoringSchema()
  const session = await getSessionById(id)
  if (!session) return null
  if (session.stopped_at) return session // already closed — idempotent

  const tz = await getTimeZone()
  const now = nowDateTimeInTz(tz)
  const duration = Math.round(hoursBetween(session.started_at, now) * 3600)
  const status: SessionStatus = opts.status ?? (session.status === "Permission Denied" ? "Permission Denied" : "Completed")

  const sets = ["stopped_at = ?", "duration_seconds = ?", "status = ?", "stop_reason = ?"]
  const params: unknown[] = [now, duration, status, opts.reason ?? "clock_out"]
  if (opts.permissionStatus) {
    sets.push("permission_status = ?")
    params.push(opts.permissionStatus)
  }
  params.push(id)
  await query(`UPDATE screen_monitoring_sessions SET ${sets.join(", ")} WHERE id = ?`, params)
  return getSessionById(id)
}

/** Update the live permission/status of an in-progress session. */
export async function updateSessionStatus(
  id: number,
  patch: { status?: SessionStatus; permissionStatus?: PermissionStatus },
): Promise<void> {
  await ensureMonitoringSchema()
  const sets: string[] = []
  const params: unknown[] = []
  if (patch.status) {
    sets.push("status = ?")
    params.push(patch.status)
  }
  if (patch.permissionStatus) {
    sets.push("permission_status = ?")
    params.push(patch.permissionStatus)
  }
  if (!sets.length) return
  params.push(id)
  await query(`UPDATE screen_monitoring_sessions SET ${sets.join(", ")} WHERE id = ? AND stopped_at IS NULL`, params)
}

// ---------------------------------------------------------------------------
// Screenshots (secure LONGBLOB storage + metadata)
// ---------------------------------------------------------------------------
export type ScreenshotInput = {
  session: MonitoringSession
  captureSequence: number
  bytes: Buffer
  mime: string
  width: number | null
  height: number | null
  sourceType: string | null
}

export type SaveScreenshotResult = { ok: true; screenshotId: string; duplicate: boolean } | { ok: false; error: string }

/**
 * Persist a captured screenshot. The (session_pk, capture_sequence) unique key
 * makes this idempotent — a retried upload for the same sequence returns the
 * existing row instead of creating a duplicate (Phase 3 / Phase 33). Rejects
 * captures for a session that is not Active (Phase 5 — no post-stop capture).
 */
export async function saveScreenshot(input: ScreenshotInput): Promise<SaveScreenshotResult> {
  await ensureMonitoringSchema()
  const s = input.session
  if (s.stopped_at || s.status !== "Active") {
    return { ok: false, error: "Session is not active" }
  }
  const tz = await getTimeZone()
  const now = nowDateTimeInTz(tz)
  const screenshotId = genId("SHOT")
  const fileRef = `screen-monitoring/${s.session_id}/${String(input.captureSequence).padStart(5, "0")}-${screenshotId}.jpg`

  try {
    await query(
      `INSERT INTO screen_monitoring_screenshots
         (screenshot_id, session_pk, session_id, attendance_id, employee_id, captured_at, capture_sequence,
          source_type, file_ref, file_size, file_mime, file_data, width, height, upload_status)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'Uploaded')`,
      [
        screenshotId,
        s.id,
        s.session_id,
        s.attendance_id,
        s.employee_id,
        now,
        input.captureSequence,
        input.sourceType,
        fileRef,
        input.bytes.length,
        input.mime,
        input.bytes,
        input.width,
        input.height,
      ],
    )
  } catch (e) {
    // Duplicate (session_pk, capture_sequence) — treat as already-captured.
    const msg = e instanceof Error ? e.message : String(e)
    if (/duplicate/i.test(msg)) return { ok: true, screenshotId, duplicate: true }
    return { ok: false, error: msg }
  }

  // Advance the session capture counters.
  await query(
    "UPDATE screen_monitoring_sessions SET capture_count = capture_count + 1, last_capture_at = ? WHERE id = ?",
    [now, s.id],
  )
  return { ok: true, screenshotId, duplicate: false }
}

// ---------------------------------------------------------------------------
// Audit (Phase 16)
// ---------------------------------------------------------------------------
export type MonitoringAuditAction =
  | "monitoring_started"
  | "permission_granted"
  | "permission_denied"
  | "permission_revoked"
  | "capture_created"
  | "capture_failed"
  | "monitoring_stopped"
  | "screenshot_viewed"
  | "screenshot_downloaded"
  | "screenshot_deleted"
  | "session_stale"
  | "retention_cleanup"
  | "settings_updated"

export async function logMonitoringAudit(entry: {
  action: MonitoringAuditAction
  sessionPk?: number | null
  sessionId?: string | null
  screenshotPk?: number | null
  employeeId?: number | null
  userId?: number | null
  userName?: string | null
  detail?: Record<string, unknown> | null
}): Promise<void> {
  try {
    await ensureMonitoringSchema()
    await query(
      `INSERT INTO screen_monitoring_audit
         (action, session_pk, session_id, screenshot_pk, employee_id, user_id, user_name, detail)
       VALUES (?,?,?,?,?,?,?,?)`,
      [
        entry.action,
        entry.sessionPk ?? null,
        entry.sessionId ?? null,
        entry.screenshotPk ?? null,
        entry.employeeId ?? null,
        entry.userId ?? null,
        entry.userName ?? null,
        entry.detail ? JSON.stringify(entry.detail) : null,
      ],
    )
  } catch {
    // Audit is best-effort; never block the underlying action.
  }
}

// ---------------------------------------------------------------------------
// Cron helpers — stale detection + retention cleanup (Phase 8 / 19 / 20)
// ---------------------------------------------------------------------------
export type CleanupResult = {
  staleClosed: number
  screenshotsPurged: number
  emptySessionsMarked: number
}

/**
 * Mark still-open sessions whose last capture is older than the stale window as
 * disconnected, and purge screenshot bytes past the retention window (retaining
 * the metadata rows for audit). Idempotent — safe to run repeatedly.
 */
export async function runMonitoringCleanup(): Promise<CleanupResult> {
  await ensureMonitoringSchema()
  const settings = await getMonitoringSettings()
  const tz = await getTimeZone()
  const now = nowDateTimeInTz(tz)

  // 1. Stale session detection — Active/Pending with no recent capture.
  const stale = await query<{ id: number; session_id: string; employee_id: number }[]>(
    `SELECT id, session_id, employee_id FROM screen_monitoring_sessions
      WHERE stopped_at IS NULL
        AND status IN ('Active','Pending','Paused')
        AND TIMESTAMPDIFF(MINUTE, COALESCE(last_capture_at, started_at), ?) >= ?`,
    [now, settings.stale_after_minutes],
  )
  for (const row of stale) {
    await query(
      `UPDATE screen_monitoring_sessions
         SET status='Failed', stop_reason='stale_disconnected', stopped_at=?,
             duration_seconds=TIMESTAMPDIFF(SECOND, started_at, ?)
       WHERE id=? AND stopped_at IS NULL`,
      [now, now, row.id],
    )
    await logMonitoringAudit({
      action: "session_stale",
      sessionPk: row.id,
      sessionId: row.session_id,
      employeeId: row.employee_id,
      detail: { reason: "no captures within stale window" },
    })
  }

  // 2. Retention cleanup — free bytes past retention, keep metadata for audit.
  const purge = await query<{ c: number }[]>(
    `SELECT COUNT(*) AS c FROM screen_monitoring_screenshots
      WHERE file_data IS NOT NULL
        AND captured_at < (NOW() - INTERVAL ? DAY)`,
    [settings.retention_days],
  )
  const purgeCount = Number(purge[0]?.c || 0)
  if (purgeCount > 0) {
    await query(
      `UPDATE screen_monitoring_screenshots
         SET file_data = NULL, upload_status = 'Pending'
       WHERE file_data IS NOT NULL AND captured_at < (NOW() - INTERVAL ? DAY)`,
      [settings.retention_days],
    )
    await logMonitoringAudit({
      action: "retention_cleanup",
      detail: { purged: purgeCount, retention_days: settings.retention_days },
    })
  }

  return { staleClosed: stale.length, screenshotsPurged: purgeCount, emptySessionsMarked: 0 }
}

// ---------------------------------------------------------------------------
// Live view — WebRTC signaling relay (peer-to-peer; no media on the server)
// ---------------------------------------------------------------------------
export type SignalSender = "viewer" | "broadcaster"
export type SignalKind = "offer" | "answer" | "ice" | "bye"

export type SignalMessage = {
  id: number
  viewer_id: string
  sender: SignalSender
  kind: SignalKind
  payload: string | null
}

/** Store one handshake message for the other peer to pick up on its next poll. */
export async function postSignal(input: {
  sessionPk: number
  viewerId: string
  sender: SignalSender
  kind: SignalKind
  payload: string | null
}): Promise<void> {
  await ensureMonitoringSchema()
  await query(
    `INSERT INTO screen_monitoring_signals (session_pk, viewer_id, sender, kind, payload)
     VALUES (?,?,?,?,?)`,
    [input.sessionPk, input.viewerId.slice(0, 64), input.sender, input.kind, input.payload ?? null],
  )
}

/**
 * Drain the messages addressed to `reader` for a session (viewers only see the
 * broadcaster messages tagged with their own viewerId; the broadcaster sees all
 * viewer messages). Read rows are marked consumed so each is delivered once, and
 * stale signals (> 3 min) are swept opportunistically.
 */
export async function pollSignals(input: {
  sessionPk: number
  reader: SignalSender
  viewerId?: string
}): Promise<SignalMessage[]> {
  await ensureMonitoringSchema()
  // Opportunistic cleanup so the relay table never grows unbounded.
  await query(`DELETE FROM screen_monitoring_signals WHERE created_at < (NOW() - INTERVAL 3 MINUTE)`)

  const wantSender: SignalSender = input.reader === "viewer" ? "broadcaster" : "viewer"
  const where = ["session_pk = ?", "sender = ?", "consumed = 0"]
  const params: unknown[] = [input.sessionPk, wantSender]
  if (input.reader === "viewer") {
    where.push("viewer_id = ?")
    params.push(input.viewerId ?? "")
  }
  const rows = await query<SignalMessage[]>(
    `SELECT id, viewer_id, sender, kind, payload FROM screen_monitoring_signals
      WHERE ${where.join(" AND ")} ORDER BY id ASC LIMIT 100`,
    params,
  )
  if (rows.length) {
    const ids = rows.map((r) => r.id)
    await query(
      `UPDATE screen_monitoring_signals SET consumed = 1 WHERE id IN (${ids.map(() => "?").join(",")})`,
      ids,
    )
  }
  return rows
}
