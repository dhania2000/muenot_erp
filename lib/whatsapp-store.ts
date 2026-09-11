import "server-only"
import { query } from "@/lib/db"
import type { WhatsAppPriority, WhatsAppStatus, WhatsAppTeam } from "@/lib/whatsapp-shared"

/**
 * Data-access layer for WhatsApp conversations, contacts and messages.
 *
 * Kept separate from lib/whatsapp.ts (which owns the Graph API calls) so the
 * DB concerns and the network concerns stay decoupled. These tables are
 * created by database/migrations/2026-09-20-add-whatsapp-messaging.sql;
 * ensureWhatsAppMessagingTables() mirrors that migration at runtime so a
 * deployment that hasn't run the SQL yet still works (matching the existing
 * ensureWhatsAppTable pattern).
 */

let tablesEnsured = false

export async function ensureWhatsAppMessagingTables() {
  if (tablesEnsured) return
  await query(
    `CREATE TABLE IF NOT EXISTS \`marketing_whatsapp_contacts\` (
      \`id\` INT UNSIGNED NOT NULL AUTO_INCREMENT,
      \`phone_number\` VARCHAR(32) NOT NULL,
      \`profile_name\` VARCHAR(191) DEFAULT NULL,
      \`wa_contact_id\` VARCHAR(64) DEFAULT NULL,
      \`lead_id\` INT UNSIGNED DEFAULT NULL,
      \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      \`updated_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (\`id\`),
      UNIQUE KEY \`uniq_wa_contact_phone\` (\`phone_number\`),
      KEY \`idx_wa_contact_lead\` (\`lead_id\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  )
  await query(
    `CREATE TABLE IF NOT EXISTS \`marketing_whatsapp_conversations\` (
      \`id\` INT UNSIGNED NOT NULL AUTO_INCREMENT,
      \`contact_id\` INT UNSIGNED NOT NULL,
      \`phone_number_id\` VARCHAR(191) NOT NULL,
      \`waba_id\` VARCHAR(191) DEFAULT NULL,
      \`assigned_agent_id\` INT UNSIGNED DEFAULT NULL,
      \`assigned_team\` VARCHAR(64) DEFAULT NULL,
      \`priority\` ENUM('low','normal','high','urgent') NOT NULL DEFAULT 'normal',
      \`status\` ENUM('open','pending','closed') NOT NULL DEFAULT 'open',
      \`last_message_at\` DATETIME DEFAULT NULL,
      \`last_customer_message_at\` DATETIME DEFAULT NULL,
      \`unread_count\` INT UNSIGNED NOT NULL DEFAULT 0,
      \`last_message_preview\` VARCHAR(500) DEFAULT NULL,
      \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      \`updated_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (\`id\`),
      UNIQUE KEY \`uniq_wa_convo_contact_number\` (\`contact_id\`, \`phone_number_id\`),
      KEY \`idx_wa_convo_last_message\` (\`last_message_at\`),
      KEY \`idx_wa_convo_status\` (\`status\`),
      KEY \`idx_wa_convo_agent\` (\`assigned_agent_id\`),
      KEY \`idx_wa_convo_team\` (\`assigned_team\`),
      KEY \`idx_wa_convo_priority\` (\`priority\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  )
  await query(
    `CREATE TABLE IF NOT EXISTS \`marketing_whatsapp_messages\` (
      \`id\` INT UNSIGNED NOT NULL AUTO_INCREMENT,
      \`conversation_id\` INT UNSIGNED NOT NULL,
      \`wamid\` VARCHAR(191) DEFAULT NULL,
      \`direction\` ENUM('inbound','outbound') NOT NULL,
      \`message_type\` VARCHAR(32) NOT NULL DEFAULT 'text',
      \`message_body\` TEXT DEFAULT NULL,
      \`media_id\` VARCHAR(191) DEFAULT NULL,
      \`media_mime_type\` VARCHAR(128) DEFAULT NULL,
      \`media_filename\` VARCHAR(255) DEFAULT NULL,
      \`media_url\` VARCHAR(500) DEFAULT NULL,
      \`sender_phone\` VARCHAR(32) DEFAULT NULL,
      \`recipient_phone\` VARCHAR(32) DEFAULT NULL,
      \`status\` ENUM('received','queued','sent','delivered','read','failed') NOT NULL DEFAULT 'queued',
      \`status_rank\` TINYINT UNSIGNED NOT NULL DEFAULT 0,
      \`meta_timestamp\` DATETIME DEFAULT NULL,
      \`error_code\` VARCHAR(32) DEFAULT NULL,
      \`error_message\` VARCHAR(500) DEFAULT NULL,
      \`sent_at\` DATETIME DEFAULT NULL,
      \`delivered_at\` DATETIME DEFAULT NULL,
      \`read_at\` DATETIME DEFAULT NULL,
      \`sent_by_user_id\` INT UNSIGNED DEFAULT NULL,
      \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      \`updated_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (\`id\`),
      UNIQUE KEY \`uniq_wa_message_wamid\` (\`wamid\`),
      KEY \`idx_wa_message_conversation\` (\`conversation_id\`),
      KEY \`idx_wa_message_direction\` (\`direction\`),
      KEY \`idx_wa_message_status\` (\`status\`),
      KEY \`idx_wa_message_created\` (\`created_at\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  )
  await query(
    `CREATE TABLE IF NOT EXISTS \`marketing_whatsapp_webhook_events\` (
      \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      \`event_type\` VARCHAR(48) NOT NULL,
      \`wamid\` VARCHAR(191) DEFAULT NULL,
      \`phone_number_id\` VARCHAR(191) DEFAULT NULL,
      \`dedup_key\` VARCHAR(255) DEFAULT NULL,
      \`processing_status\` ENUM('received','processed','skipped','error') NOT NULL DEFAULT 'received',
      \`error\` VARCHAR(500) DEFAULT NULL,
      \`received_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (\`id\`),
      UNIQUE KEY \`uniq_wa_event_dedup\` (\`dedup_key\`),
      KEY \`idx_wa_event_wamid\` (\`wamid\`),
      KEY \`idx_wa_event_type\` (\`event_type\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  )
  await query(
    `CREATE TABLE IF NOT EXISTS \`marketing_whatsapp_assignments\` (
      \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      \`conversation_id\` INT UNSIGNED NOT NULL,
      \`action\` ENUM('assign','reassign','unassign') NOT NULL,
      \`assigned_agent_id\` INT UNSIGNED DEFAULT NULL,
      \`assigned_team\` VARCHAR(64) DEFAULT NULL,
      \`assigned_by\` INT UNSIGNED DEFAULT NULL,
      \`note\` VARCHAR(255) DEFAULT NULL,
      \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (\`id\`),
      KEY \`idx_wa_assign_convo\` (\`conversation_id\`),
      KEY \`idx_wa_assign_agent\` (\`assigned_agent_id\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  )

  // Self-heal the shared-inbox columns for deployments created before the
  // 2026-09-21 migration ran. Each ALTER is guarded by an information_schema
  // check so this stays idempotent and cheap (runs once per process).
  await ensureColumn("marketing_whatsapp_conversations", "assigned_agent_id", "ADD COLUMN `assigned_agent_id` INT UNSIGNED DEFAULT NULL")
  await ensureColumn("marketing_whatsapp_conversations", "assigned_team", "ADD COLUMN `assigned_team` VARCHAR(64) DEFAULT NULL")
  await ensureColumn("marketing_whatsapp_conversations", "priority", "ADD COLUMN `priority` ENUM('low','normal','high','urgent') NOT NULL DEFAULT 'normal'")
  await ensureColumn("marketing_whatsapp_contacts", "notes", "ADD COLUMN `notes` TEXT DEFAULT NULL")
  await ensureColumn("marketing_whatsapp_contacts", "tags", "ADD COLUMN `tags` VARCHAR(500) DEFAULT NULL")
  await ensureStatusSupportsPending()

  tablesEnsured = true
}

/** True when the named column exists on the given table in the current schema. */
async function columnExists(table: string, column: string): Promise<boolean> {
  const rows = await query<{ c: number }[]>(
    `SELECT COUNT(*) AS c FROM information_schema.COLUMNS
      WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
    [table, column],
  )
  return (rows[0]?.c ?? 0) > 0
}

/** Adds a column via the given ALTER fragment only when it does not exist yet. */
async function ensureColumn(table: string, column: string, alterFragment: string) {
  try {
    if (await columnExists(table, column)) return
    await query(`ALTER TABLE \`${table}\` ${alterFragment}`)
  } catch {
    // A concurrent process may have added it; ignore races and permission gaps.
  }
}

/** Extends the conversation status enum with 'pending' when it is missing. */
async function ensureStatusSupportsPending() {
  try {
    const rows = await query<{ t: string }[]>(
      `SELECT COLUMN_TYPE AS t FROM information_schema.COLUMNS
        WHERE table_schema = DATABASE()
          AND table_name = 'marketing_whatsapp_conversations'
          AND column_name = 'status'`,
    )
    const type = rows[0]?.t ?? ""
    if (type && !type.includes("pending")) {
      await query(
        "ALTER TABLE `marketing_whatsapp_conversations` MODIFY COLUMN `status` ENUM('open','pending','closed') NOT NULL DEFAULT 'open'",
      )
    }
  } catch {
    // Ignore — the enum already supports pending, or we lack ALTER rights.
  }
}

/* ------------------------------------------------------------------ */
/* Status ranking — prevents out-of-order webhooks moving backwards    */
/* ------------------------------------------------------------------ */

export type MessageStatus = "received" | "queued" | "sent" | "delivered" | "read" | "failed"

/**
 * Higher rank = later in the lifecycle. A status update only applies when its
 * rank is >= the stored rank, so a late "delivered" cannot overwrite "read".
 * `failed` shares rank with `sent` so it can replace an optimistic sent state
 * but never downgrade a delivered/read message.
 */
export const STATUS_RANK: Record<MessageStatus, number> = {
  received: 0,
  queued: 1,
  sent: 2,
  failed: 2,
  delivered: 3,
  read: 4,
}

/** Normalises a phone number to bare digits (E.164 without the leading +). */
export function normalizePhone(input: string): string {
  return input.replace(/[^\d]/g, "")
}

/* ------------------------------------------------------------------ */
/* Row types                                                           */
/* ------------------------------------------------------------------ */

export type WhatsAppContactRow = {
  id: number
  phone_number: string
  profile_name: string | null
  wa_contact_id: string | null
  lead_id: number | null
}

export type WhatsAppConversationRow = {
  id: number
  contact_id: number
  phone_number_id: string
  waba_id: string | null
  assigned_agent_id: number | null
  assigned_team: string | null
  priority: WhatsAppPriority
  status: WhatsAppStatus
  last_message_at: string | null
  last_customer_message_at: string | null
  unread_count: number
  last_message_preview: string | null
}

export type WhatsAppMessageRow = {
  id: number
  conversation_id: number
  wamid: string | null
  direction: "inbound" | "outbound"
  message_type: string
  message_body: string | null
  media_id: string | null
  media_mime_type: string | null
  media_filename: string | null
  media_url: string | null
  sender_phone: string | null
  recipient_phone: string | null
  status: MessageStatus
  status_rank: number
  meta_timestamp: string | null
  error_code: string | null
  error_message: string | null
  sent_at: string | null
  delivered_at: string | null
  read_at: string | null
  created_at: string
  updated_at: string
}

/* ------------------------------------------------------------------ */
/* Contacts                                                            */
/* ------------------------------------------------------------------ */

/**
 * Best-effort match of a WhatsApp number to an existing CRM lead by comparing
 * the last 10 digits (national significant number). Never creates a lead.
 */
async function findLeadIdByPhone(phone: string): Promise<number | null> {
  const last10 = phone.slice(-10)
  if (last10.length < 10) return null
  try {
    const rows = await query<{ id: number }[]>(
      `SELECT id FROM \`sales_leads\`
       WHERE contact_number IS NOT NULL
         AND RIGHT(REGEXP_REPLACE(contact_number, '[^0-9]', ''), 10) = ?
       ORDER BY id ASC LIMIT 1`,
      [last10],
    )
    return rows[0]?.id ?? null
  } catch {
    // REGEXP_REPLACE requires MySQL 8+. If unavailable, skip linking silently.
    return null
  }
}

export async function findOrCreateContact(input: {
  phone: string
  profileName?: string | null
  waContactId?: string | null
}): Promise<WhatsAppContactRow> {
  await ensureWhatsAppMessagingTables()
  const phone = normalizePhone(input.phone)

  const existing = await query<WhatsAppContactRow[]>(
    "SELECT * FROM `marketing_whatsapp_contacts` WHERE phone_number = ? LIMIT 1",
    [phone],
  )
  if (existing[0]) {
    // Keep the profile name fresh when Meta gives us a newer one.
    if (input.profileName && input.profileName !== existing[0].profile_name) {
      await query("UPDATE `marketing_whatsapp_contacts` SET profile_name = ? WHERE id = ?", [
        input.profileName,
        existing[0].id,
      ])
      existing[0].profile_name = input.profileName
    }
    return existing[0]
  }

  const leadId = await findLeadIdByPhone(phone)
  const result = await query<{ insertId: number }>(
    `INSERT INTO \`marketing_whatsapp_contacts\` (phone_number, profile_name, wa_contact_id, lead_id)
     VALUES (?, ?, ?, ?)`,
    [phone, input.profileName ?? null, input.waContactId ?? null, leadId],
  )
  const rows = await query<WhatsAppContactRow[]>(
    "SELECT * FROM `marketing_whatsapp_contacts` WHERE id = ? LIMIT 1",
    [result.insertId],
  )
  return rows[0]
}

export async function linkContactToLead(contactId: number, leadId: number | null) {
  await ensureWhatsAppMessagingTables()
  await query("UPDATE `marketing_whatsapp_contacts` SET lead_id = ? WHERE id = ?", [leadId, contactId])
}

/* ------------------------------------------------------------------ */
/* Conversations                                                       */
/* ------------------------------------------------------------------ */

export async function findOrCreateConversation(input: {
  contactId: number
  phoneNumberId: string
  wabaId?: string | null
}): Promise<WhatsAppConversationRow> {
  await ensureWhatsAppMessagingTables()
  const existing = await query<WhatsAppConversationRow[]>(
    "SELECT * FROM `marketing_whatsapp_conversations` WHERE contact_id = ? AND phone_number_id = ? LIMIT 1",
    [input.contactId, input.phoneNumberId],
  )
  if (existing[0]) return existing[0]

  const result = await query<{ insertId: number }>(
    `INSERT INTO \`marketing_whatsapp_conversations\` (contact_id, phone_number_id, waba_id)
     VALUES (?, ?, ?)`,
    [input.contactId, input.phoneNumberId, input.wabaId ?? null],
  )
  const rows = await query<WhatsAppConversationRow[]>(
    "SELECT * FROM `marketing_whatsapp_conversations` WHERE id = ? LIMIT 1",
    [result.insertId],
  )
  return rows[0]
}

function preview(type: string, body: string | null): string {
  if (body && body.trim()) return body.trim().slice(0, 480)
  const map: Record<string, string> = {
    image: "[Image]",
    document: "[Document]",
    video: "[Video]",
    audio: "[Audio]",
    sticker: "[Sticker]",
    location: "[Location]",
    contacts: "[Contact]",
  }
  return map[type] || "[Message]"
}

/* ------------------------------------------------------------------ */
/* Messages                                                            */
/* ------------------------------------------------------------------ */

export type InboundMessageInput = {
  conversationId: number
  wamid: string
  messageType: string
  body: string | null
  mediaId?: string | null
  mediaMimeType?: string | null
  mediaFilename?: string | null
  senderPhone: string
  recipientPhone: string
  metaTimestamp: Date
}

/**
 * Inserts an inbound message idempotently (unique wamid) and bumps the
 * conversation's unread count + preview + last-message timestamps. Returns
 * false when the wamid already existed (duplicate webhook delivery).
 */
export async function recordInboundMessage(input: InboundMessageInput): Promise<boolean> {
  await ensureWhatsAppMessagingTables()
  const ts = input.metaTimestamp
  const tsSql = ts.toISOString().slice(0, 19).replace("T", " ")

  const result = await query<{ insertId: number; affectedRows: number }>(
    `INSERT IGNORE INTO \`marketing_whatsapp_messages\`
      (conversation_id, wamid, direction, message_type, message_body, media_id, media_mime_type,
       media_filename, sender_phone, recipient_phone, status, status_rank, meta_timestamp)
     VALUES (?, ?, 'inbound', ?, ?, ?, ?, ?, ?, ?, 'received', 0, ?)`,
    [
      input.conversationId,
      input.wamid,
      input.messageType,
      input.body,
      input.mediaId ?? null,
      input.mediaMimeType ?? null,
      input.mediaFilename ?? null,
      input.senderPhone,
      input.recipientPhone,
      tsSql,
    ],
  )
  if (!result.affectedRows) return false // duplicate wamid

  await query(
    `UPDATE \`marketing_whatsapp_conversations\`
       SET unread_count = unread_count + 1,
           last_message_at = ?,
           last_customer_message_at = ?,
           last_message_preview = ?,
           status = 'open'
     WHERE id = ?`,
    [tsSql, tsSql, preview(input.messageType, input.body), input.conversationId],
  )
  return true
}

export type OutboundMessageInput = {
  conversationId: number
  wamid: string | null
  messageType: string
  body: string | null
  senderPhone: string | null
  recipientPhone: string
  status: MessageStatus
  sentByUserId?: number | null
}

/** Inserts an outbound message we just sent and refreshes the conversation. */
export async function recordOutboundMessage(input: OutboundMessageInput): Promise<number> {
  await ensureWhatsAppMessagingTables()
  const nowSql = new Date().toISOString().slice(0, 19).replace("T", " ")
  const rank = STATUS_RANK[input.status]

  const result = await query<{ insertId: number }>(
    `INSERT INTO \`marketing_whatsapp_messages\`
      (conversation_id, wamid, direction, message_type, message_body, sender_phone, recipient_phone,
       status, status_rank, meta_timestamp, sent_at, sent_by_user_id)
     VALUES (?, ?, 'outbound', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.conversationId,
      input.wamid,
      input.messageType,
      input.body,
      input.senderPhone,
      input.recipientPhone,
      input.status,
      rank,
      nowSql,
      input.status === "sent" ? nowSql : null,
      input.sentByUserId ?? null,
    ],
  )

  await query(
    `UPDATE \`marketing_whatsapp_conversations\`
       SET last_message_at = ?, last_message_preview = ?
     WHERE id = ?`,
    [nowSql, preview(input.messageType, input.body), input.conversationId],
  )
  return result.insertId
}

export type EchoMessageInput = {
  conversationId: number
  wamid: string
  messageType: string
  body: string | null
  mediaId?: string | null
  mediaMimeType?: string | null
  mediaFilename?: string | null
  senderPhone: string | null
  recipientPhone: string
  metaTimestamp: Date
}

/**
 * Records a coexistence echo: a message the business owner sent to a customer
 * from the WhatsApp Business App (Meta mirrors it on `smb_message_echoes`).
 *
 * It is stored as an OUTBOUND message so it lines up with replies sent from the
 * ERP. Insertion is idempotent on `wamid` (INSERT IGNORE), so Meta's retries —
 * and any overlap with a message we sent ourselves via the API — never create
 * duplicates. Unlike an inbound message it does NOT bump the unread counter.
 * Returns false when the echo was already stored.
 */
export async function recordEchoMessage(input: EchoMessageInput): Promise<boolean> {
  await ensureWhatsAppMessagingTables()
  const ts = input.metaTimestamp
  const tsSql = ts.toISOString().slice(0, 19).replace("T", " ")
  const rank = STATUS_RANK.sent

  const result = await query<{ affectedRows: number }>(
    `INSERT IGNORE INTO \`marketing_whatsapp_messages\`
      (conversation_id, wamid, direction, message_type, message_body, media_id, media_mime_type,
       media_filename, sender_phone, recipient_phone, status, status_rank, meta_timestamp, sent_at)
     VALUES (?, ?, 'outbound', ?, ?, ?, ?, ?, ?, ?, 'sent', ?, ?, ?)`,
    [
      input.conversationId,
      input.wamid,
      input.messageType,
      input.body,
      input.mediaId ?? null,
      input.mediaMimeType ?? null,
      input.mediaFilename ?? null,
      input.senderPhone,
      input.recipientPhone,
      rank,
      tsSql,
      tsSql,
    ],
  )
  if (!result.affectedRows) return false // duplicate wamid

  await query(
    `UPDATE \`marketing_whatsapp_conversations\`
       SET last_message_at = ?, last_message_preview = ?, status = 'open'
     WHERE id = ?`,
    [tsSql, preview(input.messageType, input.body), input.conversationId],
  )
  return true
}

/**
 * Applies a status webhook to an outbound message, honouring status ranking so
 * out-of-order events never move a message backwards.
 */
export async function updateMessageStatusByWamid(input: {
  wamid: string
  status: MessageStatus
  timestamp?: Date | null
  errorCode?: string | null
  errorMessage?: string | null
}): Promise<boolean> {
  await ensureWhatsAppMessagingTables()
  const rank = STATUS_RANK[input.status]
  const tsSql = (input.timestamp ?? new Date()).toISOString().slice(0, 19).replace("T", " ")

  const column =
    input.status === "delivered" ? "delivered_at" : input.status === "read" ? "read_at" : input.status === "sent" ? "sent_at" : null

  const setTimestamp = column ? `, \`${column}\` = COALESCE(\`${column}\`, ?)` : ""
  const params: (string | number | null)[] = [input.status, rank]
  if (column) params.push(tsSql)
  params.push(input.errorCode ?? null, input.errorMessage ?? null, input.wamid, rank)

  const result = await query<{ affectedRows: number }>(
    `UPDATE \`marketing_whatsapp_messages\`
       SET status = ?, status_rank = ?${setTimestamp},
           error_code = COALESCE(?, error_code),
           error_message = COALESCE(?, error_message)
     WHERE wamid = ? AND status_rank <= ?`,
    params,
  )
  return result.affectedRows > 0
}

/* ------------------------------------------------------------------ */
/* Queries for the UI                                                  */
/* ------------------------------------------------------------------ */

export type ConversationListItem = {
  id: number
  contactId: number
  phoneNumber: string
  profileName: string | null
  leadId: number | null
  leadCode: string | null
  leadName: string | null
  status: WhatsAppStatus
  priority: WhatsAppPriority
  assignedAgentId: number | null
  assignedAgentName: string | null
  assignedTeam: string | null
  unreadCount: number
  lastMessagePreview: string | null
  lastMessageAt: string | null
  lastCustomerMessageAt: string | null
}

type ConversationJoinRow = {
  id: number
  contact_id: number
  phone_number: string
  profile_name: string | null
  lead_id: number | null
  lead_code: string | null
  lead_name: string | null
  status: WhatsAppStatus
  priority: WhatsAppPriority
  assigned_agent_id: number | null
  assigned_agent_name: string | null
  assigned_team: string | null
  unread_count: number
  last_message_preview: string | null
  last_message_at: string | null
  last_customer_message_at: string | null
}

// Shared projection so the list and the detail query never drift apart.
const CONVERSATION_SELECT = `
  SELECT c.id, c.contact_id, ct.phone_number, ct.profile_name, ct.lead_id,
         l.lead_code, l.contact_person AS lead_name, c.status, c.priority,
         c.assigned_agent_id, u.name AS assigned_agent_name, c.assigned_team,
         c.unread_count, c.last_message_preview, c.last_message_at, c.last_customer_message_at
    FROM \`marketing_whatsapp_conversations\` c
    JOIN \`marketing_whatsapp_contacts\` ct ON ct.id = c.contact_id
    LEFT JOIN \`sales_leads\` l ON l.id = ct.lead_id
    LEFT JOIN \`users\` u ON u.id = c.assigned_agent_id`

function mapConversationRow(r: ConversationJoinRow): ConversationListItem {
  return {
    id: r.id,
    contactId: r.contact_id,
    phoneNumber: r.phone_number,
    profileName: r.profile_name,
    leadId: r.lead_id,
    leadCode: r.lead_code,
    leadName: r.lead_name,
    status: r.status,
    priority: r.priority,
    assignedAgentId: r.assigned_agent_id,
    assignedAgentName: r.assigned_agent_name,
    assignedTeam: r.assigned_team,
    unreadCount: r.unread_count,
    lastMessagePreview: r.last_message_preview,
    lastMessageAt: r.last_message_at,
    lastCustomerMessageAt: r.last_customer_message_at,
  }
}

/** Restricts which conversations a viewer may see (RBAC scoping). */
export type InboxScope = {
  /** When false, the viewer only sees unassigned conversations + their own. */
  seeAll: boolean
  /** The viewer's user id — used for the "assigned to me" restriction. */
  userId: number
}

export type ConversationFilter = {
  view?: "all" | "mine" | "unassigned"
  status?: WhatsAppStatus
  priority?: WhatsAppPriority
  team?: string
  agentId?: number
  unreadOnly?: boolean
  since?: string
  search?: string
}

export async function listConversations(
  filter?: ConversationFilter,
  scope?: InboxScope,
): Promise<ConversationListItem[]> {
  await ensureWhatsAppMessagingTables()
  const where: string[] = []
  const params: (string | number)[] = []

  // RBAC: non-privileged agents only see unassigned conversations or ones
  // assigned to them, so they can never open another agent's private threads.
  if (scope && !scope.seeAll) {
    where.push("(c.assigned_agent_id = ? OR c.assigned_agent_id IS NULL)")
    params.push(scope.userId)
  }

  if (filter?.view === "mine" && scope) {
    where.push("c.assigned_agent_id = ?")
    params.push(scope.userId)
  } else if (filter?.view === "unassigned") {
    where.push("c.assigned_agent_id IS NULL")
  }

  if (filter?.status) {
    where.push("c.status = ?")
    params.push(filter.status)
  }
  if (filter?.priority) {
    where.push("c.priority = ?")
    params.push(filter.priority)
  }
  if (filter?.team) {
    where.push("c.assigned_team = ?")
    params.push(filter.team)
  }
  if (typeof filter?.agentId === "number") {
    where.push("c.assigned_agent_id = ?")
    params.push(filter.agentId)
  }
  if (filter?.unreadOnly) where.push("c.unread_count > 0")
  if (filter?.since) {
    where.push("c.last_message_at >= ?")
    params.push(filter.since)
  }
  if (filter?.search) {
    where.push("(ct.phone_number LIKE ? OR ct.profile_name LIKE ? OR l.contact_person LIKE ?)")
    const like = `%${filter.search}%`
    params.push(like, like, like)
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : ""

  const rows = await query<ConversationJoinRow[]>(
    `${CONVERSATION_SELECT}
       ${whereSql}
       ORDER BY (c.last_message_at IS NULL), c.last_message_at DESC
       LIMIT 200`,
    params,
  )
  return rows.map(mapConversationRow)
}

export async function getConversation(id: number): Promise<ConversationListItem | null> {
  await ensureWhatsAppMessagingTables()
  const list = await query<ConversationJoinRow[]>(`${CONVERSATION_SELECT} WHERE c.id = ? LIMIT 1`, [id])
  const r = list[0]
  return r ? mapConversationRow(r) : null
}

/** True when this viewer is allowed to open/act on this conversation. */
export function canAccessConversation(conversation: ConversationListItem, scope: InboxScope): boolean {
  if (scope.seeAll) return true
  return conversation.assignedAgentId === null || conversation.assignedAgentId === scope.userId
}

/** Builds the RBAC scope for a viewer. Admins see and manage everything. */
export function inboxScopeFor(role: "admin" | "employee", userId: number): InboxScope {
  return { seeAll: role === "admin", userId }
}

/** Only admins may route conversations to other agents / teams. */
export function canManageInbox(role: "admin" | "employee"): boolean {
  return role === "admin"
}

/* ------------------------------------------------------------------ */
/* Assignment, status & priority                                       */
/* ------------------------------------------------------------------ */

export type AgentOption = { id: number; name: string; role: "admin" | "employee" }

/** Active ERP users who can be assigned WhatsApp conversations. */
export async function listAgents(): Promise<AgentOption[]> {
  return query<AgentOption[]>(
    `SELECT id, name, role FROM \`users\` WHERE status = 'active' ORDER BY name ASC`,
  )
}

/**
 * Assigns, reassigns or unassigns a conversation and appends an audit row.
 * Passing agentId=null and team=null unassigns. The action is derived from the
 * previous assignment so the audit log reads naturally.
 */
export async function assignConversation(input: {
  conversationId: number
  agentId: number | null
  team: string | null
  byUserId: number
  note?: string | null
}): Promise<void> {
  await ensureWhatsAppMessagingTables()
  const prev = await query<{ assigned_agent_id: number | null; assigned_team: string | null }[]>(
    "SELECT assigned_agent_id, assigned_team FROM `marketing_whatsapp_conversations` WHERE id = ? LIMIT 1",
    [input.conversationId],
  )
  const hadAssignment = Boolean(prev[0]?.assigned_agent_id || prev[0]?.assigned_team)
  const hasAssignment = Boolean(input.agentId || input.team)
  const action = !hasAssignment ? "unassign" : hadAssignment ? "reassign" : "assign"

  await query(
    "UPDATE `marketing_whatsapp_conversations` SET assigned_agent_id = ?, assigned_team = ? WHERE id = ?",
    [input.agentId, input.team, input.conversationId],
  )
  await query(
    `INSERT INTO \`marketing_whatsapp_assignments\`
       (conversation_id, action, assigned_agent_id, assigned_team, assigned_by, note)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [input.conversationId, action, input.agentId, input.team, input.byUserId, input.note ?? null],
  )
}

export async function setConversationStatus(conversationId: number, status: WhatsAppStatus): Promise<void> {
  await ensureWhatsAppMessagingTables()
  await query("UPDATE `marketing_whatsapp_conversations` SET status = ? WHERE id = ?", [status, conversationId])
}

export async function setConversationPriority(conversationId: number, priority: WhatsAppPriority): Promise<void> {
  await ensureWhatsAppMessagingTables()
  await query("UPDATE `marketing_whatsapp_conversations` SET priority = ? WHERE id = ?", [priority, conversationId])
}

export async function listMessages(conversationId: number): Promise<WhatsAppMessageRow[]> {
  await ensureWhatsAppMessagingTables()
  return query<WhatsAppMessageRow[]>(
    `SELECT * FROM \`marketing_whatsapp_messages\`
      WHERE conversation_id = ?
      ORDER BY COALESCE(meta_timestamp, created_at) ASC, id ASC
      LIMIT 500`,
    [conversationId],
  )
}

export async function markConversationRead(conversationId: number) {
  await ensureWhatsAppMessagingTables()
  await query("UPDATE `marketing_whatsapp_conversations` SET unread_count = 0 WHERE id = ?", [
    conversationId,
  ])
}

/** Returns the most recent inbound wamids that have not been marked read yet. */
export async function getUnreadInboundWamids(conversationId: number): Promise<string[]> {
  const rows = await query<{ wamid: string }[]>(
    `SELECT wamid FROM \`marketing_whatsapp_messages\`
      WHERE conversation_id = ? AND direction = 'inbound' AND status <> 'read' AND wamid IS NOT NULL
      ORDER BY id DESC LIMIT 20`,
    [conversationId],
  )
  return rows.map((r) => r.wamid)
}

/* ------------------------------------------------------------------ */
/* Webhook event audit log                                             */
/* ------------------------------------------------------------------ */

export async function logWebhookEvent(input: {
  eventType: string
  wamid?: string | null
  phoneNumberId?: string | null
  dedupKey?: string | null
  processingStatus?: "received" | "processed" | "skipped" | "error"
  error?: string | null
}): Promise<boolean> {
  await ensureWhatsAppMessagingTables()
  try {
    const result = await query<{ affectedRows: number }>(
      `INSERT INTO \`marketing_whatsapp_webhook_events\`
        (event_type, wamid, phone_number_id, dedup_key, processing_status, error)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE processing_status = VALUES(processing_status), error = VALUES(error)`,
      [
        input.eventType,
        input.wamid ?? null,
        input.phoneNumberId ?? null,
        input.dedupKey ?? null,
        input.processingStatus ?? "received",
        input.error ?? null,
      ],
    )
    return result.affectedRows > 0
  } catch {
    return false
  }
}
