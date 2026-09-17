import "server-only"
import { query } from "@/lib/db"

/**
 * Self-healing, ADDITIVE schema for the Internal (ERP-to-ERP) Calling feature.
 *
 * This is a brand-new, self-contained subsystem for browser WebRTC audio/video
 * calls between employees. It NEVER touches the existing Twilio calling tables
 * (`sales_calls`, `recruit_calls`) — those keep working exactly as before. All
 * tables here are prefixed `internal_call_*` so there is zero collision with any
 * existing communication table.
 *
 * MySQL has no "CREATE TABLE IF NOT EXISTS ... ADD COLUMN IF NOT EXISTS", so we
 * only ever CREATE TABLE IF NOT EXISTS and add indexes defensively. Runs once
 * per process.
 */
let ensured = false

async function ensureIndex(sql: string) {
  await query(sql).catch(() => {})
}

export async function ensureCallsSchema(): Promise<void> {
  if (ensured) return
  try {
    // --- call sessions: one row per call attempt. Server-generated id is the
    //     canonical Call Session ID. Media never flows through this table; only
    //     metadata is stored (no raw audio/video — Phase 47/48).
    await query(`CREATE TABLE IF NOT EXISTS internal_call_sessions (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      caller_user_id INT NOT NULL,
      receiver_user_id INT NOT NULL,
      caller_employee_id INT NULL,
      receiver_employee_id INT NULL,
      call_type VARCHAR(10) NOT NULL DEFAULT 'audio',
      status VARCHAR(20) NOT NULL DEFAULT 'calling',
      end_reason VARCHAR(48) NULL,
      project_id INT NULL,
      project_name VARCHAR(200) NULL,
      task_id INT NULL,
      task_name VARCHAR(200) NULL,
      origin VARCHAR(32) NULL,
      started_at DATETIME NULL DEFAULT CURRENT_TIMESTAMP,
      answered_at DATETIME NULL,
      ended_at DATETIME NULL,
      duration_seconds INT NOT NULL DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )`)
    await ensureIndex("CREATE INDEX idx_ics_caller ON internal_call_sessions (caller_user_id)")
    await ensureIndex("CREATE INDEX idx_ics_receiver ON internal_call_sessions (receiver_user_id)")
    await ensureIndex("CREATE INDEX idx_ics_status ON internal_call_sessions (status)")
    await ensureIndex("CREATE INDEX idx_ics_started ON internal_call_sessions (started_at)")
    await ensureIndex("CREATE INDEX idx_ics_project ON internal_call_sessions (project_id)")
    await ensureIndex("CREATE INDEX idx_ics_task ON internal_call_sessions (task_id)")
    // Detect duplicate/concurrent active sessions between the same pair fast.
    await ensureIndex("CREATE INDEX idx_ics_active_pair ON internal_call_sessions (status, caller_user_id, receiver_user_id)")

    // --- signaling channel: offer / answer / ICE candidates / bye. Polled by
    //     the peer. Media is P2P over WebRTC; only these small SDP/ICE blobs
    //     transit the ERP server (Phase 6). ms-precision timestamps for ordering.
    await query(`CREATE TABLE IF NOT EXISTS internal_call_signals (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      session_id BIGINT NOT NULL,
      from_user_id INT NOT NULL,
      to_user_id INT NOT NULL,
      kind VARCHAR(16) NOT NULL,
      payload MEDIUMTEXT NOT NULL,
      created_at TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP(3)
    )`)
    await ensureIndex("CREATE INDEX idx_icsig_inbox ON internal_call_signals (session_id, to_user_id, id)")
    await ensureIndex("CREATE INDEX idx_icsig_created ON internal_call_signals (created_at)")

    // --- audit / event log for every important transition (Phase 65).
    await query(`CREATE TABLE IF NOT EXISTS internal_call_events (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      session_id BIGINT NOT NULL,
      actor_user_id INT NULL,
      event VARCHAR(40) NOT NULL,
      detail VARCHAR(255) NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`)
    await ensureIndex("CREATE INDEX idx_ice_session ON internal_call_events (session_id)")
    await ensureIndex("CREATE INDEX idx_ice_event ON internal_call_events (event)")
    await ensureIndex("CREATE INDEX idx_ice_created ON internal_call_events (created_at)")

    // --- lightweight presence heartbeat. This is NOT an employee master
    //     (Phase 41): online/offline is derived from last_seen_at, busy/in-call
    //     is derived live from active sessions, and DND is an opt-in flag. HR
    //     Employee Master remains the identity source of truth.
    await query(`CREATE TABLE IF NOT EXISTS internal_call_presence (
      user_id INT PRIMARY KEY,
      last_seen_at DATETIME NOT NULL,
      dnd TINYINT(1) NOT NULL DEFAULT 0,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )`)
    await ensureIndex("CREATE INDEX idx_icp_seen ON internal_call_presence (last_seen_at)")

    ensured = true
  } catch (error) {
    console.log("[v0] ensureCallsSchema failed:", (error as Error).message)
  }
}
