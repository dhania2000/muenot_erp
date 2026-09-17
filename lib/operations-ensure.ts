import "server-only"
import { query } from "@/lib/db"

/**
 * Self-healing schema for the Operations Finance derivation, SOP versioning,
 * checklist items, and client-approval audit features. MySQL has no
 * "ADD COLUMN IF NOT EXISTS", so we probe information_schema before altering.
 * Everything here is additive — no existing Operations table is dropped or
 * rewritten. Runs once per process.
 */
let ensured = false

async function columnExists(table: string, column: string): Promise<boolean> {
  const rows = await query<any[]>(
    `SELECT 1 FROM information_schema.columns
       WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ? LIMIT 1`,
    [table, column],
  )
  return rows.length > 0
}

async function ensureColumn(table: string, column: string, definition: string) {
  if (!(await columnExists(table, column))) {
    await query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`)
  }
}

export async function ensureOperationsSchema(): Promise<void> {
  if (ensured) return
  try {
    // Phase 45 — single authoritative planning budget on the project master.
    await ensureColumn("operations_projects", "budget_amount", "DECIMAL(14,2) NULL")

    // Phase 40 — client-approval decision audit stamp.
    await ensureColumn("operations_client_approvals", "decided_by", "VARCHAR(255) NULL")
    await ensureColumn("operations_client_approvals", "decided_at", "DATETIME NULL")

    // Phase 33 — immutable SOP version history.
    await query(`CREATE TABLE IF NOT EXISTS operations_sop_versions (
      id INT AUTO_INCREMENT PRIMARY KEY,
      sop_id INT NOT NULL,
      sop_code VARCHAR(128) DEFAULT NULL,
      version VARCHAR(64) DEFAULT NULL,
      title VARCHAR(255) DEFAULT NULL,
      category VARCHAR(128) DEFAULT NULL,
      department VARCHAR(128) DEFAULT NULL,
      description TEXT DEFAULT NULL,
      owner VARCHAR(255) DEFAULT NULL,
      effective_date DATE DEFAULT NULL,
      review_date DATE DEFAULT NULL,
      next_review_date DATE DEFAULT NULL,
      approval_status VARCHAR(64) DEFAULT NULL,
      document_url VARCHAR(512) DEFAULT NULL,
      status VARCHAR(64) DEFAULT NULL,
      remarks TEXT DEFAULT NULL,
      change_type VARCHAR(32) DEFAULT NULL,
      snapshot_by INT UNSIGNED DEFAULT NULL,
      snapshot_by_name VARCHAR(255) DEFAULT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      KEY idx_sop_versions_sop (sop_id),
      KEY idx_sop_versions_created (created_at)
    )`)

    // Phases 62-64 — email history linking + threading on the existing
    // operations_emails table. Additive columns only; the base table (subject,
    // body, status, tracking) is left untouched.
    await ensureColumn("operations_emails", "entity_type", "VARCHAR(48) NULL")
    await ensureColumn("operations_emails", "entity_id", "VARCHAR(64) NULL")
    await ensureColumn("operations_emails", "project_id", "VARCHAR(64) NULL")
    await ensureColumn("operations_emails", "client_name", "VARCHAR(255) NULL")
    await ensureColumn("operations_emails", "template_id", "BIGINT NULL")
    await ensureColumn("operations_emails", "thread_id", "VARCHAR(255) NULL")
    await ensureColumn("operations_emails", "message_id", "VARCHAR(255) NULL")
    await ensureColumn("operations_emails", "in_reply_to", "VARCHAR(255) NULL")
    await ensureColumn("operations_emails", "references_hdr", "TEXT NULL")
    await ensureColumn("operations_emails", "provider_thread_id", "VARCHAR(255) NULL")
    await query(
      `CREATE INDEX idx_operations_emails_entity ON operations_emails (entity_type, entity_id)`,
    ).catch(() => {})
    await query(`CREATE INDEX idx_operations_emails_thread ON operations_emails (thread_id)`).catch(() => {})

    // Phases 65-67 — Operations meetings on the shared Google Calendar. Stores
    // the Google event id so reschedule updates and cancel cancels the SAME
    // event (never a duplicate). No new calendar system is introduced.
    await query(`CREATE TABLE IF NOT EXISTS operations_meetings (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      title VARCHAR(255) NOT NULL,
      meeting_type VARCHAR(48) DEFAULT 'Project Meeting',
      entity_type VARCHAR(48) DEFAULT NULL,
      entity_id VARCHAR(64) DEFAULT NULL,
      project_id VARCHAR(64) DEFAULT NULL,
      project_name VARCHAR(255) DEFAULT NULL,
      client_name VARCHAR(255) DEFAULT NULL,
      description TEXT DEFAULT NULL,
      start_time DATETIME NOT NULL,
      end_time DATETIME NOT NULL,
      attendees TEXT DEFAULT NULL,
      organizer_id INT UNSIGNED DEFAULT NULL,
      organizer_name VARCHAR(255) DEFAULT NULL,
      location VARCHAR(255) DEFAULT NULL,
      google_event_id VARCHAR(255) DEFAULT NULL,
      meet_link VARCHAR(512) DEFAULT NULL,
      html_link VARCHAR(512) DEFAULT NULL,
      status VARCHAR(32) DEFAULT 'Scheduled',
      remarks TEXT DEFAULT NULL,
      created_by INT UNSIGNED DEFAULT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      KEY idx_operations_meetings_project (project_id),
      KEY idx_operations_meetings_entity (entity_type, entity_id),
      KEY idx_operations_meetings_start (start_time)
    )`)

    // Phases 34-35 — checklist items driving completion %.
    await query(`CREATE TABLE IF NOT EXISTS operations_checklist_items (
      id INT AUTO_INCREMENT PRIMARY KEY,
      checklist_id INT NOT NULL,
      item_text VARCHAR(512) DEFAULT NULL,
      sort_order INT DEFAULT NULL,
      item_status VARCHAR(32) DEFAULT 'Pending',
      completed_by VARCHAR(255) DEFAULT NULL,
      completed_at DATETIME DEFAULT NULL,
      remarks TEXT DEFAULT NULL,
      created_by INT UNSIGNED DEFAULT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      KEY idx_checklist_items_checklist (checklist_id)
    )`)

    ensured = true
  } catch (error) {
    console.log("[v0] ensureOperationsSchema failed:", (error as Error).message)
  }
}
