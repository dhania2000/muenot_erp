import "server-only"
import { query } from "@/lib/db"

/**
 * Self-healing, ADDITIVE schema for the Messages module. Extends the original
 * three-table messaging schema (conversations / conversation_participants /
 * messages) with conversation types, group metadata, per-participant state
 * (pin/mute/archive/admin), rich message fields (reply/importance/attachments/
 * edit/delete/ERP-link), attachments, reports, audit and notifications.
 *
 * MySQL has no "ADD COLUMN IF NOT EXISTS", so we probe information_schema
 * before altering. Nothing here drops or rewrites an existing column, so the
 * original Messages functionality keeps working while the new columns default
 * to backward-compatible values (existing conversations => type 'direct').
 *
 * Runs once per process.
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

async function ensureIndex(sql: string) {
  await query(sql).catch(() => {})
}

export async function ensureMessagesSchema(): Promise<void> {
  if (ensured) return
  try {
    // --- conversations: type + group metadata + activity + direct dedupe key
    await ensureColumn("conversations", "type", "VARCHAR(20) NOT NULL DEFAULT 'direct'")
    await ensureColumn("conversations", "name", "VARCHAR(200) NULL")
    await ensureColumn("conversations", "description", "TEXT NULL")
    await ensureColumn("conversations", "photo_url", "VARCHAR(512) NULL")
    await ensureColumn("conversations", "department", "VARCHAR(120) NULL")
    await ensureColumn("conversations", "status", "VARCHAR(20) NOT NULL DEFAULT 'active'")
    await ensureColumn("conversations", "direct_key", "VARCHAR(40) NULL")
    await ensureColumn("conversations", "last_message_at", "DATETIME NULL")
    // Unique dedupe for direct chats (NULLs allowed & ignored by MySQL uniqueness).
    await ensureIndex("CREATE UNIQUE INDEX uq_conversations_direct_key ON conversations (direct_key)")
    await ensureIndex("CREATE INDEX idx_conversations_type ON conversations (type)")
    await ensureIndex("CREATE INDEX idx_conversations_activity ON conversations (last_message_at)")

    // --- conversation_participants: role + per-user state + lifecycle
    await ensureColumn("conversation_participants", "role", "VARCHAR(20) NOT NULL DEFAULT 'member'")
    await ensureColumn("conversation_participants", "is_pinned", "TINYINT(1) NOT NULL DEFAULT 0")
    await ensureColumn("conversation_participants", "is_muted", "TINYINT(1) NOT NULL DEFAULT 0")
    await ensureColumn("conversation_participants", "is_archived", "TINYINT(1) NOT NULL DEFAULT 0")
    await ensureColumn("conversation_participants", "notif_setting", "VARCHAR(20) NOT NULL DEFAULT 'all'")
    await ensureColumn("conversation_participants", "joined_at", "DATETIME NULL DEFAULT CURRENT_TIMESTAMP")
    await ensureColumn("conversation_participants", "left_at", "DATETIME NULL")

    // --- messages: type / reply / importance / edit-delete / ERP link
    await ensureColumn("messages", "message_type", "VARCHAR(20) NOT NULL DEFAULT 'text'")
    await ensureColumn("messages", "reply_to_id", "INT NULL")
    await ensureColumn("messages", "importance", "VARCHAR(12) NOT NULL DEFAULT 'normal'")
    await ensureColumn("messages", "edited_at", "DATETIME NULL")
    await ensureColumn("messages", "deleted_at", "DATETIME NULL")
    await ensureColumn("messages", "deleted_by", "INT NULL")
    await ensureColumn("messages", "source_module", "VARCHAR(48) NULL")
    await ensureColumn("messages", "source_record_id", "VARCHAR(64) NULL")
    await ensureColumn("messages", "source_label", "VARCHAR(200) NULL")
    await ensureColumn("messages", "has_attachment", "TINYINT(1) NOT NULL DEFAULT 0")
    await ensureIndex("CREATE INDEX idx_messages_reply ON messages (reply_to_id)")

    // --- attachments (metadata only; files live in Blob, served via authed proxy)
    await query(`CREATE TABLE IF NOT EXISTS message_attachments (
      id INT AUTO_INCREMENT PRIMARY KEY,
      message_id INT NULL,
      conversation_id INT NOT NULL,
      uploaded_by INT NOT NULL,
      file_name VARCHAR(255) NOT NULL,
      file_type VARCHAR(120) NULL,
      file_size INT NULL,
      storage_url VARCHAR(1024) NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      KEY idx_attachments_message (message_id),
      KEY idx_attachments_conversation (conversation_id)
    )`)

    // --- abuse / policy reports
    await query(`CREATE TABLE IF NOT EXISTS message_reports (
      id INT AUTO_INCREMENT PRIMARY KEY,
      message_id INT NOT NULL,
      conversation_id INT NOT NULL,
      reported_by INT NOT NULL,
      reason VARCHAR(500) NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'open',
      reviewed_by INT NULL,
      reviewed_at DATETIME NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      KEY idx_reports_status (status),
      KEY idx_reports_message (message_id)
    )`)

    // --- audit trail
    await query(`CREATE TABLE IF NOT EXISTS message_audit (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      action VARCHAR(48) NOT NULL,
      conversation_id INT NULL,
      message_id INT NULL,
      actor_id INT NOT NULL,
      actor_name VARCHAR(190) NULL,
      detail VARCHAR(500) NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      KEY idx_audit_conversation (conversation_id),
      KEY idx_audit_action (action),
      KEY idx_audit_created (created_at)
    )`)

    // --- in-app notifications (mirrors the sales_notifications pattern)
    await query(`CREATE TABLE IF NOT EXISTS message_notifications (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      conversation_id INT NULL,
      message_id INT NULL,
      type VARCHAR(32) NOT NULL DEFAULT 'message',
      title VARCHAR(200) NULL,
      body VARCHAR(500) NULL,
      is_read TINYINT(1) NOT NULL DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      KEY idx_msg_notif_user (user_id, is_read),
      KEY idx_msg_notif_created (created_at)
    )`)

    // Backfill activity timestamp for existing conversations so sorting works.
    await query(
      `UPDATE conversations c SET c.last_message_at = COALESCE(
         (SELECT MAX(created_at) FROM messages m WHERE m.conversation_id = c.id), c.created_at)
       WHERE c.last_message_at IS NULL`,
    ).catch(() => {})

    ensured = true
  } catch (error) {
    console.log("[v0] ensureMessagesSchema failed:", (error as Error).message)
  }
}
