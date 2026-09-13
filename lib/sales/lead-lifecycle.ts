import type { PoolConnection } from "mysql2/promise"
import { pool, query } from "@/lib/db"

/**
 * Central Sales lead lifecycle service.
 *
 * This module is the ONE place that mutates lead lifecycle state. API routes,
 * imports, and cross-module hooks all call these functions instead of writing
 * to `sales_leads` directly. That keeps a single source of truth for:
 *   - pipeline stage + lifecycle status transitions and their rules
 *   - health-score computation
 *   - append-only history (stage, owner, activity timeline)
 *   - audit log + in-app notifications
 *   - optimistic concurrency via row_version
 *
 * Won / Lost / Follow Up are STATES on the single lead row, never copied into
 * separate tables. History is append-only; rows are never moved to represent a
 * transition.
 */

// ---------------------------------------------------------------------------
// Domain constants
// ---------------------------------------------------------------------------

export const PIPELINE_STAGES = [
  "New",
  "Qualified",
  "Follow Up 1",
  "Follow Up 2",
  "Follow Up 3",
  "Follow Up 4",
  "Follow Up 5",
  "Follow Up 6",
  "Follow Up 7",
  "In Discussion",
  "Proposal Sent",
  "Ready",
  "Won",
  "Lost",
] as const
export type PipelineStage = (typeof PIPELINE_STAGES)[number]

export const LEAD_STATUSES = ["Open", "Won", "Lost", "Follow Up"] as const
export type LeadStatus = (typeof LEAD_STATUSES)[number]

export const LOST_REASONS = [
  "Budget",
  "Timing",
  "Competitor",
  "No response",
  "Not a fit",
  "Lost contact",
  "Duplicate",
  "Other",
] as const

const HEALTH_SCORE: Record<string, number> = {
  New: 5,
  Qualified: 25,
  "Follow Up 1": 20,
  "Follow Up 2": 35,
  "Follow Up 3": 40,
  "Follow Up 4": 45,
  "Follow Up 5": 50,
  "Follow Up 6": 55,
  "Follow Up 7": 60,
  "In Discussion": 50,
  "Proposal Sent": 70,
  Ready: 85,
  Won: 100,
  Lost: 0,
}

export function healthScoreForStage(stage: string): number {
  return HEALTH_SCORE[stage] ?? 5
}

/** Derive lifecycle status from a pipeline stage when not explicitly set. */
export function leadStatusForStage(stage: string): LeadStatus {
  if (stage === "Won") return "Won"
  if (stage === "Lost") return "Lost"
  if (stage.startsWith("Follow Up")) return "Follow Up"
  return "Open"
}

export class LeadConflictError extends Error {
  constructor(message = "This lead was modified by someone else. Refresh and try again.") {
    super(message)
    this.name = "LeadConflictError"
  }
}

export class LeadNotFoundError extends Error {
  constructor(message = "Lead not found") {
    super(message)
    this.name = "LeadNotFoundError"
  }
}

// ---------------------------------------------------------------------------
// Runtime schema self-heal (mirrors the migration for existing databases)
// ---------------------------------------------------------------------------

let schemaEnsured = false

async function columnExists(table: string, column: string): Promise<boolean> {
  const rows = await query<any[]>(
    `SELECT 1 FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ? LIMIT 1`,
    [table, column],
  )
  return rows.length > 0
}

async function addColumnIfMissing(table: string, column: string, ddl: string) {
  if (await columnExists(table, column)) return
  await query(`ALTER TABLE \`${table}\` ADD COLUMN ${ddl}`).catch(() => {})
}

async function addKeyIfMissing(table: string, keyName: string, ddl: string) {
  const rows = await query<any[]>(
    `SELECT 1 FROM information_schema.statistics
     WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ? LIMIT 1`,
    [table, keyName],
  )
  if (rows.length > 0) return
  await query(`ALTER TABLE \`${table}\` ADD ${ddl}`).catch(() => {})
}

/**
 * Idempotently ensures every lifecycle column/table exists. Runs once per
 * server process; safe to call at the top of any lifecycle operation.
 */
export async function ensureLeadLifecycleSchema(): Promise<void> {
  if (schemaEnsured) return

  const newColumns: [string, string][] = [
    ["company_id", "`company_id` INT UNSIGNED DEFAULT NULL"],
    ["priority", "`priority` ENUM('Low','Medium','High','Urgent') DEFAULT NULL"],
    ["estimated_value", "`estimated_value` DECIMAL(14,2) DEFAULT NULL"],
    ["currency", "`currency` VARCHAR(8) DEFAULT NULL"],
    ["probability", "`probability` TINYINT UNSIGNED DEFAULT NULL"],
    ["expected_close_date", "`expected_close_date` DATE DEFAULT NULL"],
    ["campaign", "`campaign` VARCHAR(150) DEFAULT NULL"],
    ["tags", "`tags` VARCHAR(500) DEFAULT NULL"],
    ["next_follow_up_at", "`next_follow_up_at` DATETIME DEFAULT NULL"],
    ["won_at", "`won_at` DATETIME DEFAULT NULL"],
    ["won_value", "`won_value` DECIMAL(14,2) DEFAULT NULL"],
    ["won_by", "`won_by` INT UNSIGNED DEFAULT NULL"],
    ["won_notes", "`won_notes` TEXT DEFAULT NULL"],
    ["lost_at", "`lost_at` DATETIME DEFAULT NULL"],
    ["lost_reason", "`lost_reason` VARCHAR(120) DEFAULT NULL"],
    ["lost_notes", "`lost_notes` TEXT DEFAULT NULL"],
    ["lost_by", "`lost_by` INT UNSIGNED DEFAULT NULL"],
    ["reopened_at", "`reopened_at` DATETIME DEFAULT NULL"],
    ["archived_at", "`archived_at` DATETIME DEFAULT NULL"],
    ["row_version", "`row_version` INT UNSIGNED NOT NULL DEFAULT 1"],
    // lead_status may be absent on very old DBs; ensure it too.
    ["lead_status", "`lead_status` ENUM('Open','Won','Lost','Follow Up') NOT NULL DEFAULT 'Open'"],
  ]

  try {
    for (const [col, ddl] of newColumns) await addColumnIfMissing("sales_leads", col, ddl)
    await addKeyIfMissing("sales_leads", "idx_leads_company_id", "KEY `idx_leads_company_id` (`company_id`)")
    await addKeyIfMissing("sales_leads", "idx_leads_next_follow_up", "KEY `idx_leads_next_follow_up` (`next_follow_up_at`)")
    await addKeyIfMissing("sales_leads", "idx_leads_lead_status", "KEY `idx_leads_lead_status` (`lead_status`)")

    // Widen the pipeline status ENUM so all follow-up stages persist.
    await query(
      `ALTER TABLE sales_leads MODIFY \`status\` ENUM(${PIPELINE_STAGES.map((s) => `'${s}'`).join(",")}) NOT NULL DEFAULT 'New'`,
    ).catch(() => {})

    await query(`CREATE TABLE IF NOT EXISTS \`sales_lead_stage_history\` (
      \`id\` INT UNSIGNED NOT NULL AUTO_INCREMENT,
      \`lead_id\` INT UNSIGNED NOT NULL,
      \`from_status\` VARCHAR(40) DEFAULT NULL,
      \`to_status\` VARCHAR(40) DEFAULT NULL,
      \`from_lead_status\` VARCHAR(20) DEFAULT NULL,
      \`to_lead_status\` VARCHAR(20) DEFAULT NULL,
      \`note\` VARCHAR(500) DEFAULT NULL,
      \`changed_by\` INT UNSIGNED DEFAULT NULL,
      \`changed_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (\`id\`),
      KEY \`idx_stage_hist_lead\` (\`lead_id\`, \`changed_at\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

    await query(`CREATE TABLE IF NOT EXISTS \`sales_lead_owner_history\` (
      \`id\` INT UNSIGNED NOT NULL AUTO_INCREMENT,
      \`lead_id\` INT UNSIGNED NOT NULL,
      \`from_owner\` INT UNSIGNED DEFAULT NULL,
      \`to_owner\` INT UNSIGNED DEFAULT NULL,
      \`note\` VARCHAR(255) DEFAULT NULL,
      \`changed_by\` INT UNSIGNED DEFAULT NULL,
      \`changed_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (\`id\`),
      KEY \`idx_owner_hist_lead\` (\`lead_id\`, \`changed_at\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

    await query(`CREATE TABLE IF NOT EXISTS \`sales_lead_activities\` (
      \`id\` INT UNSIGNED NOT NULL AUTO_INCREMENT,
      \`lead_id\` INT UNSIGNED NOT NULL,
      \`activity_type\` VARCHAR(40) NOT NULL DEFAULT 'note',
      \`title\` VARCHAR(255) DEFAULT NULL,
      \`body\` TEXT DEFAULT NULL,
      \`ref_type\` VARCHAR(40) DEFAULT NULL,
      \`ref_id\` VARCHAR(64) DEFAULT NULL,
      \`occurred_at\` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      \`created_by\` INT UNSIGNED DEFAULT NULL,
      \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (\`id\`),
      KEY \`idx_activity_lead\` (\`lead_id\`, \`occurred_at\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

    await query(`CREATE TABLE IF NOT EXISTS \`sales_lead_followups\` (
      \`id\` INT UNSIGNED NOT NULL AUTO_INCREMENT,
      \`followup_code\` VARCHAR(30) DEFAULT NULL,
      \`lead_id\` INT UNSIGNED NOT NULL,
      \`due_at\` DATETIME NOT NULL,
      \`channel\` VARCHAR(40) DEFAULT NULL,
      \`purpose\` VARCHAR(255) DEFAULT NULL,
      \`status\` ENUM('Open','Done','Cancelled') NOT NULL DEFAULT 'Open',
      \`outcome\` TEXT DEFAULT NULL,
      \`assigned_to\` INT UNSIGNED DEFAULT NULL,
      \`completed_at\` DATETIME DEFAULT NULL,
      \`completed_by\` INT UNSIGNED DEFAULT NULL,
      \`created_by\` INT UNSIGNED DEFAULT NULL,
      \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      \`updated_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (\`id\`),
      UNIQUE KEY \`uniq_followup_code\` (\`followup_code\`),
      KEY \`idx_followup_lead\` (\`lead_id\`),
      KEY \`idx_followup_status_due\` (\`status\`, \`due_at\`),
      KEY \`idx_followup_assignee\` (\`assigned_to\`, \`status\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

    await query(`CREATE TABLE IF NOT EXISTS \`sales_audit_log\` (
      \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      \`entity_type\` VARCHAR(40) NOT NULL,
      \`entity_id\` VARCHAR(64) NOT NULL,
      \`action\` VARCHAR(60) NOT NULL,
      \`summary\` VARCHAR(500) DEFAULT NULL,
      \`meta\` JSON DEFAULT NULL,
      \`actor_id\` INT UNSIGNED DEFAULT NULL,
      \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (\`id\`),
      KEY \`idx_audit_entity\` (\`entity_type\`, \`entity_id\`, \`created_at\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

    await query(`CREATE TABLE IF NOT EXISTS \`sales_notifications\` (
      \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      \`user_id\` INT UNSIGNED NOT NULL,
      \`type\` VARCHAR(40) NOT NULL DEFAULT 'info',
      \`title\` VARCHAR(255) NOT NULL,
      \`body\` VARCHAR(500) DEFAULT NULL,
      \`link\` VARCHAR(255) DEFAULT NULL,
      \`entity_type\` VARCHAR(40) DEFAULT NULL,
      \`entity_id\` VARCHAR(64) DEFAULT NULL,
      \`is_read\` TINYINT(1) NOT NULL DEFAULT 0,
      \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (\`id\`),
      KEY \`idx_notif_user\` (\`user_id\`, \`is_read\`, \`created_at\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

    await query(`CREATE TABLE IF NOT EXISTS \`sales_event_dedup\` (
      \`event_key\` VARCHAR(191) NOT NULL,
      \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (\`event_key\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

    schemaEnsured = true
  } catch (error) {
    // Leave schemaEnsured false so a later call can retry, but don't crash the
    // request — reads still work against whatever columns already exist.
    console.error("[lead-lifecycle] ensureSchema failed", error)
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LeadRecord = {
  id: number
  lead_code: string
  contact_person: string | null
  company_name: string | null
  company_id: number | null
  email: string | null
  contact_number: string | null
  status: string
  lead_status: LeadStatus
  assigned_to: number | null
  priority: string | null
  estimated_value: string | null
  currency: string | null
  probability: number | null
  expected_close_date: string | null
  lead_health_score: number
  next_follow_up_at: string | null
  won_at: string | null
  lost_at: string | null
  lost_reason: string | null
  row_version: number
  archived_at: string | null
  [key: string]: unknown
}

export type Actor = number | null | undefined

// ---------------------------------------------------------------------------
// Shared write primitives (connection-aware so they compose in transactions)
// ---------------------------------------------------------------------------

async function run<T = any>(conn: PoolConnection | null, sql: string, params: any[] = []): Promise<T> {
  if (conn) {
    const [rows] = await conn.query(sql, params)
    return rows as T
  }
  return query<T>(sql, params)
}

export async function recordAudit(
  conn: PoolConnection | null,
  input: {
    entityType: string
    entityId: string | number
    action: string
    summary?: string | null
    meta?: Record<string, unknown> | null
    actorId?: Actor
  },
): Promise<void> {
  await run(
    conn,
    `INSERT INTO sales_audit_log (entity_type, entity_id, action, summary, meta, actor_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      input.entityType,
      String(input.entityId),
      input.action,
      input.summary ?? null,
      input.meta ? JSON.stringify(input.meta) : null,
      input.actorId ?? null,
    ],
  ).catch((e) => console.error("[lead-lifecycle] audit insert failed", e))
}

export async function notify(
  conn: PoolConnection | null,
  input: {
    userId: number | null | undefined
    type?: string
    title: string
    body?: string | null
    link?: string | null
    entityType?: string | null
    entityId?: string | number | null
  },
): Promise<void> {
  if (!input.userId) return
  await run(
    conn,
    `INSERT INTO sales_notifications (user_id, type, title, body, link, entity_type, entity_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      input.userId,
      input.type ?? "info",
      input.title,
      input.body ?? null,
      input.link ?? null,
      input.entityType ?? null,
      input.entityId != null ? String(input.entityId) : null,
    ],
  ).catch((e) => console.error("[lead-lifecycle] notify insert failed", e))
}

export async function logActivity(
  conn: PoolConnection | null,
  input: {
    leadId: number
    type: string
    title?: string | null
    body?: string | null
    refType?: string | null
    refId?: string | number | null
    occurredAt?: Date | string | null
    createdBy?: Actor
  },
): Promise<void> {
  await run(
    conn,
    `INSERT INTO sales_lead_activities (lead_id, activity_type, title, body, ref_type, ref_id, occurred_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.leadId,
      input.type,
      input.title ?? null,
      input.body ?? null,
      input.refType ?? null,
      input.refId != null ? String(input.refId) : null,
      input.occurredAt ? new Date(input.occurredAt) : new Date(),
      input.createdBy ?? null,
    ],
  ).catch((e) => console.error("[lead-lifecycle] activity insert failed", e))
}

/** Returns true when the event was seen before (should be skipped). */
async function alreadyProcessed(conn: PoolConnection | null, eventKey: string): Promise<boolean> {
  try {
    await run(conn, `INSERT INTO sales_event_dedup (event_key) VALUES (?)`, [eventKey])
    return false
  } catch (error: any) {
    if (error?.code === "ER_DUP_ENTRY") return true
    // If the dedup table is unavailable, fail open (process the event).
    return false
  }
}

// ---------------------------------------------------------------------------
// Lead code generation (race-safe via sequence table)
// ---------------------------------------------------------------------------

async function nextLeadCode(conn: PoolConnection): Promise<string> {
  // Seed the sequence to the current max so we never collide with legacy
  // MAX+1 generated codes, then atomically increment.
  const [maxRows] = await conn.query<any[]>(
    `SELECT COALESCE(MAX(CAST(SUBSTRING(lead_code, 5) AS UNSIGNED)), 0) AS max_num FROM sales_leads`,
  )
  const currentMax = Number(maxRows[0]?.max_num || 0)
  await conn.query(
    `INSERT INTO record_id_sequences (prefix, next_number) VALUES ('MLD', ?)
     ON DUPLICATE KEY UPDATE next_number = GREATEST(next_number, ?) + 1`,
    [currentMax + 1, currentMax],
  )
  const [rows] = await conn.query<any[]>(
    `SELECT next_number FROM record_id_sequences WHERE prefix = 'MLD' FOR UPDATE`,
  )
  const num = Number(rows[0]?.next_number || currentMax + 1)
  return `MLD-${String(num).padStart(3, "0")}`
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function getLead(id: number): Promise<LeadRecord | null> {
  const rows = await query<any[]>(
    `SELECT l.*, u.name AS assigned_to_name, c.name AS created_by_name
     FROM sales_leads l
     LEFT JOIN users u ON u.id = l.assigned_to
     LEFT JOIN users c ON c.id = l.created_by
     WHERE l.id = ? LIMIT 1`,
    [id],
  )
  return (rows[0] as LeadRecord) ?? null
}

export async function getLeadTimeline(id: number) {
  return query<any[]>(
    `SELECT a.*, u.name AS actor_name
     FROM sales_lead_activities a
     LEFT JOIN users u ON u.id = a.created_by
     WHERE a.lead_id = ?
     ORDER BY a.occurred_at DESC, a.id DESC
     LIMIT 200`,
    [id],
  )
}

export async function getStageHistory(id: number) {
  return query<any[]>(
    `SELECT h.*, u.name AS actor_name
     FROM sales_lead_stage_history h
     LEFT JOIN users u ON u.id = h.changed_by
     WHERE h.lead_id = ?
     ORDER BY h.changed_at DESC, h.id DESC`,
    [id],
  )
}

export async function getLeadFollowups(id: number) {
  return query<any[]>(
    `SELECT f.*, u.name AS assigned_to_name
     FROM sales_lead_followups f
     LEFT JOIN users u ON u.id = f.assigned_to
     WHERE f.lead_id = ?
     ORDER BY (f.status = 'Open') DESC, f.due_at ASC`,
    [id],
  )
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export async function createLead(
  input: Record<string, any>,
  actorId: Actor,
): Promise<{ id: number; lead_code: string }> {
  await ensureLeadLifecycleSchema()
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    const leadCode = await nextLeadCode(conn)
    const stage = (input.status as string) || "New"
    const leadStatus = leadStatusForStage(stage)

    const [result] = await conn.query<any>(
      `INSERT INTO sales_leads
       (lead_code, lead_date, contact_person, contact_number, email, designation, source_url, lead_source,
        company_name, company_id, industry, website, company_email, country, assigned_to, status, lead_status,
        priority, estimated_value, currency, probability, expected_close_date, campaign, tags,
        lead_health_score, remarks, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        leadCode,
        input.lead_date ? new Date(input.lead_date) : new Date(),
        input.contact_person || null,
        input.contact_number || null,
        input.email || null,
        input.designation || null,
        input.source_url || null,
        input.lead_source || null,
        input.company_name || null,
        input.company_id || null,
        input.industry || null,
        input.website || null,
        input.company_email || null,
        input.country || null,
        input.assigned_to || null,
        stage,
        leadStatus,
        input.priority || null,
        input.estimated_value || null,
        input.currency || null,
        input.probability ?? null,
        input.expected_close_date ? new Date(input.expected_close_date) : null,
        input.campaign || null,
        input.tags || null,
        healthScoreForStage(stage),
        input.remarks || null,
        actorId ?? null,
      ],
    )
    const leadId = Number(result.insertId)

    await run(conn, `INSERT INTO sales_lead_stage_history (lead_id, to_status, to_lead_status, note, changed_by)
       VALUES (?, ?, ?, 'Lead created', ?)`, [leadId, stage, leadStatus, actorId ?? null])
    await logActivity(conn, {
      leadId,
      type: "created",
      title: "Lead created",
      body: `${input.contact_person || "Contact"} · ${input.company_name || ""}`.trim(),
      createdBy: actorId,
    })
    if (input.assigned_to) {
      await run(conn, `INSERT INTO sales_lead_owner_history (lead_id, to_owner, note, changed_by) VALUES (?, ?, 'Initial assignment', ?)`,
        [leadId, input.assigned_to, actorId ?? null])
      await notify(conn, {
        userId: input.assigned_to,
        type: "lead_assigned",
        title: "New lead assigned to you",
        body: `${input.company_name || "Lead"} (${leadCode})`,
        link: `/modules/sales/leads/${leadId}`,
        entityType: "lead",
        entityId: leadId,
      })
    }
    await recordAudit(conn, {
      entityType: "lead",
      entityId: leadId,
      action: "create",
      summary: `Created lead ${leadCode}`,
      actorId,
    })

    await conn.commit()
    return { id: leadId, lead_code: leadCode }
  } catch (error) {
    await conn.rollback()
    throw error
  } finally {
    conn.release()
  }
}

// ---------------------------------------------------------------------------
// Transition (stage / owner / editable field changes) with concurrency guard
// ---------------------------------------------------------------------------

const EDITABLE_FIELDS = [
  "contact_person",
  "contact_number",
  "email",
  "designation",
  "source_url",
  "lead_source",
  "company_name",
  "company_id",
  "industry",
  "website",
  "company_email",
  "country",
  "priority",
  "estimated_value",
  "currency",
  "probability",
  "expected_close_date",
  "campaign",
  "tags",
  "follow_up_date",
  "remarks",
] as const

export async function updateLead(
  leadId: number,
  patch: Record<string, any>,
  actorId: Actor,
  opts: { expectedVersion?: number; note?: string } = {},
): Promise<LeadRecord> {
  await ensureLeadLifecycleSchema()
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    const [rows] = await conn.query<any[]>(`SELECT * FROM sales_leads WHERE id = ? FOR UPDATE`, [leadId])
    const current = rows[0] as LeadRecord | undefined
    if (!current) throw new LeadNotFoundError()

    if (opts.expectedVersion != null && Number(current.row_version) !== Number(opts.expectedVersion)) {
      throw new LeadConflictError()
    }

    const sets: string[] = []
    const values: any[] = []

    // Plain editable fields.
    for (const key of EDITABLE_FIELDS) {
      if (key in patch) {
        sets.push(`\`${key}\` = ?`)
        values.push(patch[key] === "" ? null : patch[key])
      }
    }

    // Stage transition.
    let stageChanged = false
    const nextStage = patch.status as string | undefined
    if (nextStage && nextStage !== current.status) {
      stageChanged = true
      sets.push("`status` = ?")
      values.push(nextStage)
      sets.push("`lead_health_score` = ?")
      values.push(healthScoreForStage(nextStage))
      sets.push("`last_contact_date` = NOW()")
      // Keep lifecycle status coherent with the stage unless caller overrides.
      if (!("lead_status" in patch)) {
        const derived = leadStatusForStage(nextStage)
        // Never silently flip an explicitly Won/Lost lead back via a plain stage edit.
        if (derived !== current.lead_status && current.lead_status !== "Won" && current.lead_status !== "Lost") {
          sets.push("`lead_status` = ?")
          values.push(derived)
        }
      }
    }

    // Explicit lifecycle status change (non-outcome; Won/Lost go through their own funcs).
    let lifecycleChanged = false
    const nextLeadStatus = patch.lead_status as LeadStatus | undefined
    if (nextLeadStatus && nextLeadStatus !== current.lead_status && nextLeadStatus !== "Won" && nextLeadStatus !== "Lost") {
      lifecycleChanged = true
      sets.push("`lead_status` = ?")
      values.push(nextLeadStatus)
    }

    // Owner change.
    let ownerChanged = false
    let newOwner: number | null = null
    if ("assigned_to" in patch) {
      newOwner = patch.assigned_to ? Number(patch.assigned_to) : null
      if (newOwner !== (current.assigned_to ?? null)) ownerChanged = true
    }

    if (sets.length === 0 && !ownerChanged) {
      await conn.rollback()
      return current
    }

    sets.push("`row_version` = `row_version` + 1")
    values.push(leadId)
    await conn.query(`UPDATE sales_leads SET ${sets.join(", ")} WHERE id = ?`, values)

    if (stageChanged || lifecycleChanged) {
      await run(conn, `INSERT INTO sales_lead_stage_history
        (lead_id, from_status, to_status, from_lead_status, to_lead_status, note, changed_by)
        VALUES (?, ?, ?, ?, ?, ?, ?)`, [
        leadId,
        current.status,
        nextStage ?? current.status,
        current.lead_status,
        nextLeadStatus ?? (nextStage ? leadStatusForStage(nextStage) : current.lead_status),
        opts.note ?? null,
        actorId ?? null,
      ])
      await logActivity(conn, {
        leadId,
        type: "stage_change",
        title: `Stage → ${nextStage ?? nextLeadStatus}`,
        body: opts.note ?? null,
        createdBy: actorId,
      })
      await notify(conn, {
        userId: current.assigned_to,
        type: "lead_stage",
        title: `Lead ${current.lead_code} moved to ${nextStage ?? nextLeadStatus}`,
        link: `/modules/sales/leads/${leadId}`,
        entityType: "lead",
        entityId: leadId,
      })
    }

    if (ownerChanged) {
      await run(conn, `INSERT INTO sales_lead_owner_history (lead_id, from_owner, to_owner, changed_by) VALUES (?, ?, ?, ?)`,
        [leadId, current.assigned_to ?? null, newOwner, actorId ?? null])
      await logActivity(conn, {
        leadId,
        type: "reassigned",
        title: "Owner changed",
        createdBy: actorId,
      })
      await notify(conn, {
        userId: newOwner,
        type: "lead_assigned",
        title: "A lead was assigned to you",
        body: `${current.company_name || "Lead"} (${current.lead_code})`,
        link: `/modules/sales/leads/${leadId}`,
        entityType: "lead",
        entityId: leadId,
      })
    }

    await recordAudit(conn, {
      entityType: "lead",
      entityId: leadId,
      action: "update",
      summary: stageChanged ? `Stage → ${nextStage}` : "Lead updated",
      meta: { fields: Object.keys(patch) },
      actorId,
    })

    await conn.commit()
    return (await getLead(leadId)) as LeadRecord
  } catch (error) {
    await conn.rollback()
    throw error
  } finally {
    conn.release()
  }
}

// ---------------------------------------------------------------------------
// Outcome transitions: Won / Lost / Reopen
// ---------------------------------------------------------------------------

export async function markLeadWon(
  leadId: number,
  input: { value?: number | null; currency?: string | null; notes?: string | null; eventKey?: string },
  actorId: Actor,
): Promise<LeadRecord> {
  await ensureLeadLifecycleSchema()
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    if (input.eventKey && (await alreadyProcessed(conn, input.eventKey))) {
      await conn.commit()
      return (await getLead(leadId)) as LeadRecord
    }
    const [rows] = await conn.query<any[]>(`SELECT * FROM sales_leads WHERE id = ? FOR UPDATE`, [leadId])
    const current = rows[0] as LeadRecord | undefined
    if (!current) throw new LeadNotFoundError()

    await conn.query(
      `UPDATE sales_leads SET status = 'Won', lead_status = 'Won', lead_health_score = 100,
         won_at = NOW(), won_value = ?, won_by = ?, won_notes = ?, lost_at = NULL, lost_reason = NULL,
         lost_notes = NULL, lost_by = NULL, last_contact_date = NOW(), row_version = row_version + 1
       WHERE id = ?`,
      [input.value ?? current.estimated_value ?? null, actorId ?? null, input.notes ?? null, leadId],
    )
    // Close any open follow-ups.
    await conn.query(`UPDATE sales_lead_followups SET status = 'Done', completed_at = NOW(), completed_by = ?
       WHERE lead_id = ? AND status = 'Open'`, [actorId ?? null, leadId])
    await conn.query(`UPDATE sales_leads SET next_follow_up_at = NULL WHERE id = ?`, [leadId])

    await run(conn, `INSERT INTO sales_lead_stage_history
      (lead_id, from_status, to_status, from_lead_status, to_lead_status, note, changed_by)
      VALUES (?, ?, 'Won', ?, 'Won', ?, ?)`, [leadId, current.status, current.lead_status, input.notes ?? null, actorId ?? null])
    await logActivity(conn, {
      leadId,
      type: "won",
      title: "Lead won",
      body: input.notes ?? null,
      createdBy: actorId,
    })
    await notify(conn, {
      userId: current.assigned_to,
      type: "lead_won",
      title: `🎉 Lead ${current.lead_code} marked Won`,
      body: current.company_name,
      link: `/modules/sales/leads/${leadId}`,
      entityType: "lead",
      entityId: leadId,
    })
    await recordAudit(conn, {
      entityType: "lead",
      entityId: leadId,
      action: "won",
      summary: `Won${input.value ? ` (${input.value})` : ""}`,
      meta: { value: input.value ?? null },
      actorId,
    })
    await conn.commit()
    return (await getLead(leadId)) as LeadRecord
  } catch (error) {
    await conn.rollback()
    throw error
  } finally {
    conn.release()
  }
}

export async function markLeadLost(
  leadId: number,
  input: { reason: string; notes?: string | null; eventKey?: string },
  actorId: Actor,
): Promise<LeadRecord> {
  await ensureLeadLifecycleSchema()
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    if (input.eventKey && (await alreadyProcessed(conn, input.eventKey))) {
      await conn.commit()
      return (await getLead(leadId)) as LeadRecord
    }
    const [rows] = await conn.query<any[]>(`SELECT * FROM sales_leads WHERE id = ? FOR UPDATE`, [leadId])
    const current = rows[0] as LeadRecord | undefined
    if (!current) throw new LeadNotFoundError()

    await conn.query(
      `UPDATE sales_leads SET status = 'Lost', lead_status = 'Lost', lead_health_score = 0,
         lost_at = NOW(), lost_reason = ?, lost_notes = ?, lost_by = ?, won_at = NULL, won_value = NULL,
         won_by = NULL, won_notes = NULL, next_follow_up_at = NULL, row_version = row_version + 1
       WHERE id = ?`,
      [input.reason, input.notes ?? null, actorId ?? null, leadId],
    )
    await conn.query(`UPDATE sales_lead_followups SET status = 'Cancelled'
       WHERE lead_id = ? AND status = 'Open'`, [leadId])

    await run(conn, `INSERT INTO sales_lead_stage_history
      (lead_id, from_status, to_status, from_lead_status, to_lead_status, note, changed_by)
      VALUES (?, ?, 'Lost', ?, 'Lost', ?, ?)`, [leadId, current.status, current.lead_status, `${input.reason}${input.notes ? ` — ${input.notes}` : ""}`, actorId ?? null])
    await logActivity(conn, {
      leadId,
      type: "lost",
      title: `Lead lost · ${input.reason}`,
      body: input.notes ?? null,
      createdBy: actorId,
    })
    await notify(conn, {
      userId: current.assigned_to,
      type: "lead_lost",
      title: `Lead ${current.lead_code} marked Lost`,
      body: input.reason,
      link: `/modules/sales/leads/${leadId}`,
      entityType: "lead",
      entityId: leadId,
    })
    await recordAudit(conn, {
      entityType: "lead",
      entityId: leadId,
      action: "lost",
      summary: `Lost — ${input.reason}`,
      meta: { reason: input.reason },
      actorId,
    })
    await conn.commit()
    return (await getLead(leadId)) as LeadRecord
  } catch (error) {
    await conn.rollback()
    throw error
  } finally {
    conn.release()
  }
}

export async function reopenLead(
  leadId: number,
  input: { toStage?: string; note?: string | null },
  actorId: Actor,
): Promise<LeadRecord> {
  await ensureLeadLifecycleSchema()
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    const [rows] = await conn.query<any[]>(`SELECT * FROM sales_leads WHERE id = ? FOR UPDATE`, [leadId])
    const current = rows[0] as LeadRecord | undefined
    if (!current) throw new LeadNotFoundError()

    const toStage = input.toStage && PIPELINE_STAGES.includes(input.toStage as PipelineStage) ? input.toStage : "Qualified"
    const leadStatus = leadStatusForStage(toStage)
    await conn.query(
      `UPDATE sales_leads SET status = ?, lead_status = ?, lead_health_score = ?, reopened_at = NOW(),
         won_at = NULL, won_value = NULL, won_by = NULL, won_notes = NULL,
         lost_at = NULL, lost_reason = NULL, lost_notes = NULL, lost_by = NULL,
         row_version = row_version + 1
       WHERE id = ?`,
      [toStage, leadStatus, healthScoreForStage(toStage), leadId],
    )
    await run(conn, `INSERT INTO sales_lead_stage_history
      (lead_id, from_status, to_status, from_lead_status, to_lead_status, note, changed_by)
      VALUES (?, ?, ?, ?, ?, ?, ?)`, [leadId, current.status, toStage, current.lead_status, leadStatus, input.note ?? "Lead reopened", actorId ?? null])
    await logActivity(conn, { leadId, type: "reopened", title: "Lead reopened", body: input.note ?? null, createdBy: actorId })
    await recordAudit(conn, { entityType: "lead", entityId: leadId, action: "reopen", summary: `Reopened → ${toStage}`, actorId })
    await conn.commit()
    return (await getLead(leadId)) as LeadRecord
  } catch (error) {
    await conn.rollback()
    throw error
  } finally {
    conn.release()
  }
}

// ---------------------------------------------------------------------------
// Follow-ups
// ---------------------------------------------------------------------------

export async function createFollowUp(
  input: { leadId: number; dueAt: string | Date; channel?: string | null; purpose?: string | null; assignedTo?: number | null },
  actorId: Actor,
) {
  await ensureLeadLifecycleSchema()
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    const [rows] = await conn.query<any[]>(`SELECT * FROM sales_leads WHERE id = ? FOR UPDATE`, [input.leadId])
    const lead = rows[0] as LeadRecord | undefined
    if (!lead) throw new LeadNotFoundError()

    const [seqRows] = await conn.query<any[]>(
      `INSERT INTO record_id_sequences (prefix, next_number) VALUES ('FUP', 1)
       ON DUPLICATE KEY UPDATE next_number = next_number + 1`,
    )
    void seqRows
    const [cur] = await conn.query<any[]>(`SELECT next_number FROM record_id_sequences WHERE prefix = 'FUP' FOR UPDATE`)
    const code = `FUP-${String(Number(cur[0]?.next_number || 1)).padStart(4, "0")}`

    const assignedTo = input.assignedTo ?? lead.assigned_to ?? actorId ?? null
    const [result] = await conn.query<any>(
      `INSERT INTO sales_lead_followups (followup_code, lead_id, due_at, channel, purpose, assigned_to, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [code, input.leadId, new Date(input.dueAt), input.channel ?? null, input.purpose ?? null, assignedTo, actorId ?? null],
    )

    // Cache the earliest open follow-up on the lead + keep it in the Follow Up lifecycle.
    await conn.query(
      `UPDATE sales_leads SET next_follow_up_at = (
         SELECT MIN(due_at) FROM sales_lead_followups WHERE lead_id = ? AND status = 'Open'
       ),
       lead_status = CASE WHEN lead_status IN ('Won','Lost') THEN lead_status ELSE 'Follow Up' END,
       row_version = row_version + 1
       WHERE id = ?`,
      [input.leadId, input.leadId],
    )

    await logActivity(conn, {
      leadId: input.leadId,
      type: "followup_scheduled",
      title: `Follow-up scheduled`,
      body: `${input.purpose || "Follow up"}${input.channel ? ` via ${input.channel}` : ""}`,
      refType: "followup",
      refId: code,
      createdBy: actorId,
    })
    await notify(conn, {
      userId: assignedTo,
      type: "followup_due",
      title: "Follow-up scheduled",
      body: `${lead.company_name || lead.lead_code}: ${input.purpose || "Follow up"}`,
      link: `/modules/sales/leads/${input.leadId}`,
      entityType: "followup",
      entityId: code,
    })
    await recordAudit(conn, { entityType: "followup", entityId: code, action: "create", summary: `Follow-up for ${lead.lead_code}`, actorId })

    await conn.commit()
    return { id: Number(result.insertId), followup_code: code }
  } catch (error) {
    await conn.rollback()
    throw error
  } finally {
    conn.release()
  }
}

export async function completeFollowUp(
  followupId: number,
  input: { outcome?: string | null; nextStage?: string | null },
  actorId: Actor,
) {
  await ensureLeadLifecycleSchema()
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    const [rows] = await conn.query<any[]>(`SELECT * FROM sales_lead_followups WHERE id = ? FOR UPDATE`, [followupId])
    const fu = rows[0] as any
    if (!fu) throw new LeadNotFoundError("Follow-up not found")

    await conn.query(
      `UPDATE sales_lead_followups SET status = 'Done', outcome = ?, completed_at = NOW(), completed_by = ? WHERE id = ?`,
      [input.outcome ?? null, actorId ?? null, followupId],
    )
    await conn.query(
      `UPDATE sales_leads SET next_follow_up_at = (
         SELECT MIN(due_at) FROM sales_lead_followups WHERE lead_id = ? AND status = 'Open'
       ), last_contact_date = NOW(), row_version = row_version + 1 WHERE id = ?`,
      [fu.lead_id, fu.lead_id],
    )
    await logActivity(conn, {
      leadId: fu.lead_id,
      type: "followup_done",
      title: "Follow-up completed",
      body: input.outcome ?? null,
      refType: "followup",
      refId: fu.followup_code,
      createdBy: actorId,
    })
    await recordAudit(conn, { entityType: "followup", entityId: fu.followup_code, action: "complete", summary: input.outcome ?? "Completed", actorId })
    await conn.commit()

    if (input.nextStage) {
      await updateLead(fu.lead_id, { status: input.nextStage }, actorId, { note: "Advanced after follow-up" })
    }
    return { success: true }
  } catch (error) {
    await conn.rollback()
    throw error
  } finally {
    conn.release()
  }
}

export async function cancelFollowUp(followupId: number, actorId: Actor) {
  await ensureLeadLifecycleSchema()
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    const [rows] = await conn.query<any[]>(`SELECT * FROM sales_lead_followups WHERE id = ? FOR UPDATE`, [followupId])
    const fu = rows[0] as any
    if (!fu) throw new LeadNotFoundError("Follow-up not found")
    await conn.query(`UPDATE sales_lead_followups SET status = 'Cancelled' WHERE id = ?`, [followupId])
    await conn.query(
      `UPDATE sales_leads SET next_follow_up_at = (
         SELECT MIN(due_at) FROM sales_lead_followups WHERE lead_id = ? AND status = 'Open'
       ) WHERE id = ?`,
      [fu.lead_id, fu.lead_id],
    )
    await logActivity(conn, { leadId: fu.lead_id, type: "followup_cancelled", title: "Follow-up cancelled", refType: "followup", refId: fu.followup_code, createdBy: actorId })
    await conn.commit()
    return { success: true }
  } catch (error) {
    await conn.rollback()
    throw error
  } finally {
    conn.release()
  }
}

// ---------------------------------------------------------------------------
// Cross-module hook: attach an external event to a lead's timeline
// ---------------------------------------------------------------------------

export async function attachLeadEvent(input: {
  leadId: number
  type: string
  title: string
  body?: string | null
  refType?: string | null
  refId?: string | number | null
  actorId?: Actor
  touchContact?: boolean
}) {
  await ensureLeadLifecycleSchema()
  await logActivity(null, {
    leadId: input.leadId,
    type: input.type,
    title: input.title,
    body: input.body ?? null,
    refType: input.refType ?? null,
    refId: input.refId ?? null,
    createdBy: input.actorId,
  })
  if (input.touchContact) {
    await query(`UPDATE sales_leads SET last_contact_date = NOW() WHERE id = ?`, [input.leadId]).catch(() => {})
  }
}
