import "server-only"
import type { RowDataPacket } from "mysql2"
import { pool, query } from "@/lib/db"
import { IDLE_GRACE_MS } from "@/lib/attendance-idle-config"

/** One row per continuous inactivity stretch, not one row per heartbeat. */
export type IdleWindow = { startMs: number; endMs: number }

export function idleBreakSeconds(window: IdleWindow): number {
  return Math.max(0, Math.floor((window.endMs - window.startMs - IDLE_GRACE_MS) / 1000))
}

export function summarizeIdleWindows(windows: IdleWindow[]) {
  return {
    idleSeconds: windows.reduce((sum, window) => sum + Math.max(0, Math.floor((window.endMs - window.startMs) / 1000)), 0),
    breakSeconds: windows.reduce((sum, window) => sum + idleBreakSeconds(window), 0),
  }
}

let ensured: Promise<void> | null = null
export function ensureIdleSessionSchema(): Promise<void> {
  if (!ensured) ensured = query(`CREATE TABLE IF NOT EXISTS hr_attendance_idle_sessions (
    tenant_id INT UNSIGNED NOT NULL,
    attendance_row_id BIGINT UNSIGNED NOT NULL,
    session_key CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    start_ms BIGINT UNSIGNED NOT NULL,
    end_ms BIGINT UNSIGNED NOT NULL,
    ended TINYINT(1) NOT NULL DEFAULT 0,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (tenant_id,attendance_row_id,session_key),
    KEY idx_attendance_idle_row (attendance_row_id),
    CONSTRAINT fk_attendance_idle_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
    CONSTRAINT fk_attendance_idle_attendance FOREIGN KEY (attendance_row_id) REFERENCES hr_attendance(id) ON DELETE CASCADE,
    CONSTRAINT ck_attendance_idle_range CHECK (end_ms >= start_ms)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`).then(() => {}).catch(error => { ensured = null; throw error })
  return ensured
}

type IdleRow = RowDataPacket & { start_ms: string | number; end_ms: string | number }
function summarizeRows(rows: IdleRow[]) {
  return summarizeIdleWindows(rows.map(row => ({ startMs: Number(row.start_ms), endMs: Number(row.end_ms) })))
}

/** Idempotent heartbeat/final report. Replayed or out-of-order requests cannot add time twice. */
export async function upsertIdleSession(input: {
  tenantId: number; attendanceRowId: number; employeeId: number; sessionKey: string;
  startMs: number; endMs: number; ended: boolean
}) {
  await ensureIdleSessionSchema()
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    const [attendance] = await conn.query<any[]>(`SELECT id FROM hr_attendance
      WHERE id=? AND employee_id=? AND clock_in IS NOT NULL AND clock_out IS NULL
      FOR UPDATE`, [input.attendanceRowId, input.employeeId])
    if (!attendance[0]) { await conn.rollback(); return null }
    await conn.query(`INSERT INTO hr_attendance_idle_sessions
      (tenant_id,attendance_row_id,session_key,start_ms,end_ms,ended) VALUES (?,?,?,?,?,?)
      ON DUPLICATE KEY UPDATE end_ms=GREATEST(end_ms,VALUES(end_ms)),ended=GREATEST(ended,VALUES(ended))`,
      [input.tenantId, input.attendanceRowId, input.sessionKey, input.startMs, input.endMs, input.ended ? 1 : 0])
    const [rows] = await conn.query<IdleRow[]>(`SELECT start_ms,end_ms FROM hr_attendance_idle_sessions
      WHERE tenant_id=? AND attendance_row_id=?`, [input.tenantId, input.attendanceRowId])
    const totals = summarizeRows(rows)
    await conn.query("UPDATE hr_attendance SET idle_minutes=? WHERE id=? AND employee_id=?", [Math.floor(totals.idleSeconds / 60), input.attendanceRowId, input.employeeId])
    await conn.commit()
    return totals
  } catch (error) { await conn.rollback().catch(() => {}); throw error } finally { conn.release() }
}

/** Exact second-level totals for this attendance row, with a separate grace per session. */
export async function getIdleSessionTotals(tenantId: number, attendanceRowId: number) {
  await ensureIdleSessionSchema()
  const rows = await query<IdleRow[]>(`SELECT start_ms,end_ms FROM hr_attendance_idle_sessions
    WHERE tenant_id=? AND attendance_row_id=?`, [tenantId, attendanceRowId])
  return { ...summarizeRows(rows), hasSessions: rows.length > 0 }
}
