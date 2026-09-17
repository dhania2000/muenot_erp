import { query, pool } from "@/lib/db"
import {
  boardColumnFor,
  canTransition,
  CLOSED_STATUSES,
  OPEN_STATUSES,
  type PlannerStatus,
} from "@/lib/marketing/planner-constants"

export const runtime = "nodejs"

// ---------------------------------------------------------------------------
// Self-healing schema
// ---------------------------------------------------------------------------
// The Planner shipped with a minimal `marketing_planner_items` table. Rather
// than assume a migration was run against the production (Hostinger) database,
// every entry point calls `ensurePlannerSchema()`, which adds any missing
// columns / tables idempotently. This mirrors the pattern in journeys-db.ts.

let schemaReady: Promise<void> | null = null

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
  await query(`ALTER TABLE ${table} ADD COLUMN ${ddl}`)
}

async function indexExists(table: string, index: string): Promise<boolean> {
  const rows = await query<any[]>(
    `SELECT 1 FROM information_schema.statistics
      WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ? LIMIT 1`,
    [table, index],
  )
  return rows.length > 0
}

async function addIndexIfMissing(table: string, index: string, ddl: string) {
  if (await indexExists(table, index)) return
  await query(`ALTER TABLE ${table} ADD ${ddl}`)
}

async function doEnsure() {
  // Base table (no-op if the migration already created it).
  await query(`
    CREATE TABLE IF NOT EXISTS marketing_planner_items (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      item_code VARCHAR(40) NOT NULL,
      title VARCHAR(190) NOT NULL,
      description VARCHAR(1000) NULL,
      channel VARCHAR(60) NOT NULL DEFAULT 'Email',
      status VARCHAR(40) NOT NULL DEFAULT 'Backlog',
      sort_order INT NOT NULL DEFAULT 0,
      due_date DATE NULL,
      publish_at DATETIME NULL,
      published_at DATETIME NULL,
      campaign VARCHAR(190) NULL,
      owner_id INT UNSIGNED NULL,
      assignee_id INT UNSIGNED NULL,
      color VARCHAR(20) NULL,
      tags JSON NULL,
      meta JSON NULL,
      archived_at DATETIME NULL,
      created_by INT UNSIGNED NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_planner_code (item_code),
      KEY idx_mp_status (status, sort_order)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)

  // The original table used an ENUM restricted to 4 statuses. Widen it to a
  // VARCHAR so the expanded workflow (Draft, Scheduled, Review, ...) fits
  // without a destructive migration. MODIFY is idempotent.
  await query(
    `ALTER TABLE marketing_planner_items MODIFY COLUMN status VARCHAR(40) NOT NULL DEFAULT 'Backlog'`,
  ).catch(() => {})

  // Phase 2 / 3 / 6 / 11 / 12 / 49 — item master extensions.
  await addColumnIfMissing("marketing_planner_items", "content_type", "`content_type` VARCHAR(60) NOT NULL DEFAULT 'Other'")
  await addColumnIfMissing("marketing_planner_items", "priority", "`priority` VARCHAR(16) NOT NULL DEFAULT 'Normal'")
  await addColumnIfMissing("marketing_planner_items", "start_date", "`start_date` DATE NULL")
  await addColumnIfMissing("marketing_planner_items", "campaign_id", "`campaign_id` INT UNSIGNED NULL")
  await addColumnIfMissing("marketing_planner_items", "journey_id", "`journey_id` INT UNSIGNED NULL")
  await addColumnIfMissing("marketing_planner_items", "segment_id", "`segment_id` INT UNSIGNED NULL")
  await addColumnIfMissing("marketing_planner_items", "email_template_id", "`email_template_id` INT UNSIGNED NULL")
  await addColumnIfMissing("marketing_planner_items", "whatsapp_template_name", "`whatsapp_template_name` VARCHAR(191) NULL")
  await addColumnIfMissing("marketing_planner_items", "brief", "`brief` JSON NULL")
  await addColumnIfMissing("marketing_planner_items", "target_audience", "`target_audience` JSON NULL")
  await addColumnIfMissing("marketing_planner_items", "estimated_budget", "`estimated_budget` DECIMAL(14,2) NULL")
  await addColumnIfMissing("marketing_planner_items", "actual_spend", "`actual_spend` DECIMAL(14,2) NULL")
  await addColumnIfMissing("marketing_planner_items", "related_type", "`related_type` VARCHAR(40) NULL")
  await addColumnIfMissing("marketing_planner_items", "related_id", "`related_id` VARCHAR(64) NULL")

  // Review / approval (Phase 35-37).
  await addColumnIfMissing("marketing_planner_items", "review_status", "`review_status` VARCHAR(24) NOT NULL DEFAULT 'None'")
  await addColumnIfMissing("marketing_planner_items", "submitted_by", "`submitted_by` INT UNSIGNED NULL")
  await addColumnIfMissing("marketing_planner_items", "submitted_at", "`submitted_at` DATETIME NULL")
  await addColumnIfMissing("marketing_planner_items", "reviewed_by", "`reviewed_by` INT UNSIGNED NULL")
  await addColumnIfMissing("marketing_planner_items", "reviewed_at", "`reviewed_at` DATETIME NULL")

  // Blocked (Phase 32).
  await addColumnIfMissing("marketing_planner_items", "blocked_reason", "`blocked_reason` VARCHAR(500) NULL")
  await addColumnIfMissing("marketing_planner_items", "blocked_by", "`blocked_by` INT UNSIGNED NULL")
  await addColumnIfMissing("marketing_planner_items", "blocked_at", "`blocked_at` DATETIME NULL")

  // Scheduling / cancellation (Phase 23 / 65 / 88).
  await addColumnIfMissing("marketing_planner_items", "ready_at", "`ready_at` DATETIME NULL")
  await addColumnIfMissing("marketing_planner_items", "cancelled_at", "`cancelled_at` DATETIME NULL")
  await addColumnIfMissing("marketing_planner_items", "cancelled_by", "`cancelled_by` INT UNSIGNED NULL")
  await addColumnIfMissing("marketing_planner_items", "cancel_reason", "`cancel_reason` VARCHAR(500) NULL")

  // Recurrence (Phase 67 / 68).
  await addColumnIfMissing("marketing_planner_items", "recurrence", "`recurrence` JSON NULL")
  await addColumnIfMissing("marketing_planner_items", "recurrence_parent_id", "`recurrence_parent_id` BIGINT UNSIGNED NULL")
  await addColumnIfMissing("marketing_planner_items", "next_recurrence_at", "`next_recurrence_at` DATETIME NULL")

  // Optimistic concurrency (Phase 78).
  await addColumnIfMissing("marketing_planner_items", "row_version", "`row_version` INT NOT NULL DEFAULT 1")

  // Helpful indexes.
  await addIndexIfMissing("marketing_planner_items", "idx_mp_channel", "KEY idx_mp_channel (channel)")
  await addIndexIfMissing("marketing_planner_items", "idx_mp_due", "KEY idx_mp_due (due_date)")
  await addIndexIfMissing("marketing_planner_items", "idx_mp_owner", "KEY idx_mp_owner (owner_id)")
  await addIndexIfMissing("marketing_planner_items", "idx_mp_archived", "KEY idx_mp_archived (archived_at)")
  await addIndexIfMissing("marketing_planner_items", "idx_mp_campaign", "KEY idx_mp_campaign (campaign_id)")
  await addIndexIfMissing("marketing_planner_items", "idx_mp_priority", "KEY idx_mp_priority (priority)")
  await addIndexIfMissing("marketing_planner_items", "idx_mp_publish", "KEY idx_mp_publish (publish_at)")

  // --- Assignees (Phase 14 / 15) ------------------------------------------
  await query(`
    CREATE TABLE IF NOT EXISTS marketing_planner_assignees (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      item_id BIGINT UNSIGNED NOT NULL,
      user_id INT UNSIGNED NOT NULL,
      role VARCHAR(16) NOT NULL DEFAULT 'contributor',
      assigned_by INT UNSIGNED NULL,
      assigned_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_planner_assignee (item_id, user_id),
      KEY idx_pa_user (user_id),
      KEY idx_pa_item (item_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)

  // --- Dependencies (Phase 30 / 31) ---------------------------------------
  await query(`
    CREATE TABLE IF NOT EXISTS marketing_planner_dependencies (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      item_id BIGINT UNSIGNED NOT NULL,
      depends_on_id BIGINT UNSIGNED NOT NULL,
      created_by INT UNSIGNED NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_planner_dep (item_id, depends_on_id),
      KEY idx_pd_item (item_id),
      KEY idx_pd_dep (depends_on_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)

  // --- Comments / review notes (Phase 37) ---------------------------------
  await query(`
    CREATE TABLE IF NOT EXISTS marketing_planner_comments (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      item_id BIGINT UNSIGNED NOT NULL,
      kind VARCHAR(16) NOT NULL DEFAULT 'comment',
      user_id INT UNSIGNED NULL,
      body VARCHAR(2000) NOT NULL,
      meta JSON NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      KEY idx_pc_item (item_id, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)

  // --- Content versions (Phase 38) ----------------------------------------
  await query(`
    CREATE TABLE IF NOT EXISTS marketing_planner_versions (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      item_id BIGINT UNSIGNED NOT NULL,
      version INT NOT NULL,
      snapshot JSON NULL,
      change_summary VARCHAR(500) NULL,
      changed_by INT UNSIGNED NULL,
      changed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      KEY idx_pv_item (item_id, version)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)

  // --- Reminders (Phase 27 / 29) — one row per (item, stage) is the -------
  // idempotency guard so repeated cron runs never re-notify.
  await query(`
    CREATE TABLE IF NOT EXISTS marketing_planner_reminders (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      item_id BIGINT UNSIGNED NOT NULL,
      stage VARCHAR(24) NOT NULL,
      due_at DATETIME NULL,
      sent_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_planner_reminder (item_id, stage),
      KEY idx_pr_item (item_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)

  // --- Activity / audit log (Phase 75) ------------------------------------
  await query(`
    CREATE TABLE IF NOT EXISTS marketing_planner_activity (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      item_id BIGINT UNSIGNED NOT NULL,
      action VARCHAR(40) NOT NULL,
      field VARCHAR(60) NULL,
      old_value TEXT NULL,
      new_value TEXT NULL,
      reason VARCHAR(500) NULL,
      user_id INT UNSIGNED NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      KEY idx_pact_item (item_id, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)

  // --- Asset links (Phase 10 / 39 / 40) — links to the existing Marketing --
  // Library / documents by reference. We never store the files themselves.
  await query(`
    CREATE TABLE IF NOT EXISTS marketing_planner_assets (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      item_id BIGINT UNSIGNED NOT NULL,
      library_asset_id VARCHAR(64) NULL,
      label VARCHAR(255) NOT NULL,
      url VARCHAR(1000) NULL,
      kind VARCHAR(40) NULL,
      created_by INT UNSIGNED NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      KEY idx_pas_item (item_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)

  // Permission features (Phase 73). No-op when the marketing module is absent.
  const feats: [string, string, string, number][] = [
    ["Marketing Planner", "marketing.planner.view", "View the marketing content calendar", 90],
    ["Manage Marketing Planner", "marketing.planner.manage", "Create, edit and schedule planner items", 91],
    ["Assign Planner Work", "marketing.planner.assign", "Assign planner items to team members", 92],
    ["Approve Planner Content", "marketing.planner.approve", "Review and approve planner content", 93],
    ["Publish Planner Content", "marketing.planner.publish", "Mark planner content as published", 94],
    ["Export Planner Data", "marketing.planner.export", "Export planner metadata", 95],
  ]
  for (const [name, slug, desc, sort] of feats) {
    await query(
      `INSERT IGNORE INTO features (module_id,name,slug,description,sort_order)
         SELECT id,?,?,?,? FROM modules WHERE slug='marketing'`,
      [name, slug, desc, sort],
    ).catch(() => {})
  }
}

export function ensurePlannerSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = doEnsure().catch((err) => {
      // Reset so a transient failure can be retried on the next call.
      schemaReady = null
      throw err
    })
  }
  return schemaReady
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PlannerBrief = {
  objective?: string
  audience?: string
  key_message?: string
  cta?: string
  keywords?: string
  reference?: string
  notes?: string
}

export type PlannerItemInput = {
  title?: string
  description?: string | null
  content_type?: string
  channel?: string
  status?: string
  priority?: string
  start_date?: string | null
  due_date?: string | null
  publish_at?: string | null
  campaign?: string | null
  campaign_id?: number | null
  journey_id?: number | null
  segment_id?: number | null
  email_template_id?: number | null
  whatsapp_template_name?: string | null
  owner_id?: number | null
  assignee_id?: number | null
  brief?: PlannerBrief | null
  target_audience?: any
  estimated_budget?: number | null
  actual_spend?: number | null
  tags?: string[] | null
  color?: string | null
  related_type?: string | null
  related_id?: string | null
  recurrence?: any
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseJson<T>(value: any, fallback: T): T {
  if (value == null) return fallback
  if (typeof value === "object") return value as T
  try {
    return JSON.parse(String(value)) as T
  } catch {
    return fallback
  }
}

function toJsonParam(value: any): string | null {
  if (value == null) return null
  return JSON.stringify(value)
}

async function logActivity(
  itemId: number,
  action: string,
  opts: { field?: string; oldValue?: any; newValue?: any; reason?: string; userId?: number | null },
) {
  await query(
    `INSERT INTO marketing_planner_activity (item_id, action, field, old_value, new_value, reason, user_id)
     VALUES (?,?,?,?,?,?,?)`,
    [
      itemId,
      action,
      opts.field ?? null,
      opts.oldValue == null ? null : String(opts.oldValue),
      opts.newValue == null ? null : String(opts.newValue),
      opts.reason ?? null,
      opts.userId ?? null,
    ],
  ).catch(() => {})
}

async function notify(
  userId: number | null | undefined,
  type: string,
  title: string,
  body: string,
  itemId: number,
  dedupKey?: string,
) {
  if (!userId) return
  // Optional idempotency via sales_event_dedup (shared with the sales engine).
  if (dedupKey) {
    try {
      const res: any = await query(`INSERT IGNORE INTO sales_event_dedup (event_key) VALUES (?)`, [dedupKey])
      if (res && typeof res.affectedRows === "number" && res.affectedRows === 0) return
    } catch {
      // dedup table may not exist on some installs — fall through and notify.
    }
  }
  await query(
    `INSERT INTO sales_notifications (user_id, type, title, body, link, entity_type, entity_id)
     VALUES (?,?,?,?,?,?,?)`,
    [userId, type, title, body, `/modules/marketing/planner?item=${itemId}`, "marketing_planner", String(itemId)],
  ).catch(() => {})
}

/** Recipients for an item = owner + primary assignee + contributors, de-duped. */
async function recipientsFor(itemId: number, ownerId?: number | null): Promise<number[]> {
  const rows = await query<any[]>(
    `SELECT user_id FROM marketing_planner_assignees WHERE item_id = ?`,
    [itemId],
  ).catch(() => [])
  const ids = new Set<number>()
  if (ownerId) ids.add(Number(ownerId))
  for (const r of rows) ids.add(Number(r.user_id))
  return [...ids]
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export async function createItem(input: PlannerItemInput, userId: number | null): Promise<any> {
  await ensurePlannerSchema()
  if (!input.title || !input.title.trim()) throw new Error("Title is required")

  const status = (input.status as PlannerStatus) || "Backlog"
  const placeholder = `MP-TMP-${Date.now()}-${Math.floor(Math.random() * 1e6)}`

  const res: any = await query(
    `INSERT INTO marketing_planner_items
       (item_code, title, description, content_type, channel, status, priority,
        start_date, due_date, publish_at, campaign, campaign_id, journey_id, segment_id,
        email_template_id, whatsapp_template_name, owner_id, assignee_id,
        brief, target_audience, estimated_budget, actual_spend, tags, color,
        related_type, related_id, recurrence, created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      placeholder,
      input.title.trim(),
      input.description ?? null,
      input.content_type || "Other",
      input.channel || "Email",
      status,
      input.priority || "Normal",
      input.start_date || null,
      input.due_date || null,
      input.publish_at || null,
      input.campaign ?? null,
      input.campaign_id ?? null,
      input.journey_id ?? null,
      input.segment_id ?? null,
      input.email_template_id ?? null,
      input.whatsapp_template_name ?? null,
      input.owner_id ?? null,
      input.assignee_id ?? null,
      toJsonParam(input.brief),
      toJsonParam(input.target_audience),
      input.estimated_budget ?? null,
      input.actual_spend ?? null,
      toJsonParam(input.tags),
      input.color ?? null,
      input.related_type ?? null,
      input.related_id ?? null,
      toJsonParam(input.recurrence),
      userId,
    ],
  )
  const id = Number(res.insertId)
  const code = `MP-${String(id).padStart(5, "0")}`
  await query(`UPDATE marketing_planner_items SET item_code = ? WHERE id = ?`, [code, id])

  // Primary assignee row mirrors assignee_id for consistent workload queries.
  if (input.assignee_id) {
    await query(
      `INSERT IGNORE INTO marketing_planner_assignees (item_id, user_id, role, assigned_by)
       VALUES (?,?, 'primary', ?)`,
      [id, input.assignee_id, userId],
    )
    await notify(
      input.assignee_id,
      "info",
      "New planner item assigned",
      `${input.title.trim()} was assigned to you`,
      id,
    )
  }

  await logActivity(id, "created", { userId, newValue: status })
  await snapshotVersion(id, "Created", userId)
  return getItem(id)
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

function shapeRow(r: any) {
  if (!r) return r
  return {
    ...r,
    brief: parseJson(r.brief, {}),
    target_audience: parseJson(r.target_audience, null),
    tags: parseJson<string[]>(r.tags, []),
    recurrence: parseJson(r.recurrence, null),
    board_column: boardColumnFor(r.status),
    is_overdue:
      !!r.due_date &&
      !CLOSED_STATUSES.includes(r.status) &&
      new Date(`${String(r.due_date).slice(0, 10)}T23:59:59`) < new Date(),
  }
}

export async function getItem(id: number): Promise<any | null> {
  await ensurePlannerSchema()
  const rows = await query<any[]>(
    `SELECT i.*, c.name AS campaign_name, j.name AS journey_name, s.name AS segment_name,
            ou.name AS owner_name, au.name AS assignee_name,
            et.name AS email_template_name
       FROM marketing_planner_items i
       LEFT JOIN marketing_whatsapp_campaigns c ON c.id = i.campaign_id
       LEFT JOIN marketing_journeys j ON j.id = i.journey_id
       LEFT JOIN marketing_segments s ON s.id = i.segment_id
       LEFT JOIN users ou ON ou.id = i.owner_id
       LEFT JOIN users au ON au.id = i.assignee_id
       LEFT JOIN sales_email_templates et ON et.id = i.email_template_id
      WHERE i.id = ? LIMIT 1`,
    [id],
  ).catch(async () => {
    // Fallback for installs missing some joined tables — never crash the read.
    return query<any[]>(`SELECT * FROM marketing_planner_items WHERE id = ? LIMIT 1`, [id])
  })
  const row = rows[0]
  if (!row) return null

  const [assignees, deps, dependents, assets] = await Promise.all([
    query<any[]>(
      `SELECT a.id, a.user_id, a.role, a.assigned_by, a.assigned_at, u.name, u.email
         FROM marketing_planner_assignees a LEFT JOIN users u ON u.id = a.user_id
        WHERE a.item_id = ? ORDER BY a.role='primary' DESC, u.name ASC`,
      [id],
    ).catch(() => []),
    query<any[]>(
      `SELECT d.depends_on_id AS id, i.item_code, i.title, i.status
         FROM marketing_planner_dependencies d
         JOIN marketing_planner_items i ON i.id = d.depends_on_id
        WHERE d.item_id = ?`,
      [id],
    ).catch(() => []),
    query<any[]>(
      `SELECT d.item_id AS id, i.item_code, i.title, i.status
         FROM marketing_planner_dependencies d
         JOIN marketing_planner_items i ON i.id = d.item_id
        WHERE d.depends_on_id = ?`,
      [id],
    ).catch(() => []),
    query<any[]>(`SELECT * FROM marketing_planner_assets WHERE item_id = ? ORDER BY created_at DESC`, [id]).catch(
      () => [],
    ),
  ])

  const shaped = shapeRow(row)
  shaped.assignees = assignees
  shaped.contributors = assignees.filter((a: any) => a.role !== "primary")
  shaped.dependencies = deps
  shaped.dependents = dependents
  shaped.assets = assets
  if (shaped.estimated_budget != null && shaped.actual_spend != null) {
    shaped.budget_variance = Number(shaped.estimated_budget) - Number(shaped.actual_spend)
    shaped.over_budget = Number(shaped.actual_spend) > Number(shaped.estimated_budget)
  }
  return shaped
}

export type ListParams = {
  search?: string
  status?: string[]
  priority?: string[]
  channel?: string[]
  content_type?: string[]
  campaign_id?: number
  journey_id?: number
  owner_id?: number
  assignee_id?: number
  from?: string
  to?: string
  includeArchived?: boolean
  overdueOnly?: boolean
  sort?: string
  dir?: "asc" | "desc"
  page?: number
  pageSize?: number
  // When set, restricts to items the user owns / is assigned to (Phase 74).
  scopeUserId?: number
}

const SORT_COLUMNS: Record<string, string> = {
  due_date: "i.due_date",
  publish_at: "i.publish_at",
  priority: "FIELD(i.priority,'Urgent','High','Normal','Low')",
  created_at: "i.created_at",
  updated_at: "i.updated_at",
  title: "i.title",
  status: "i.status",
}

export async function listItems(params: ListParams): Promise<{ items: any[]; total: number; summary: any }> {
  await ensurePlannerSchema()
  const where: string[] = []
  const args: any[] = []

  if (!params.includeArchived) where.push(`i.status <> 'Archived'`)
  if (params.search) {
    where.push(
      `(i.title LIKE ? OR i.item_code LIKE ? OR i.campaign LIKE ? OR i.content_type LIKE ? OR i.channel LIKE ? OR JSON_SEARCH(i.tags, 'one', ?) IS NOT NULL)`,
    )
    const like = `%${params.search}%`
    args.push(like, like, like, like, like, `%${params.search}%`)
  }
  const inClause = (col: string, vals?: string[] | number[]) => {
    if (!vals || vals.length === 0) return
    where.push(`${col} IN (${vals.map(() => "?").join(",")})`)
    args.push(...vals)
  }
  inClause("i.status", params.status)
  inClause("i.priority", params.priority)
  inClause("i.channel", params.channel)
  inClause("i.content_type", params.content_type)
  if (params.campaign_id) {
    where.push("i.campaign_id = ?")
    args.push(params.campaign_id)
  }
  if (params.journey_id) {
    where.push("i.journey_id = ?")
    args.push(params.journey_id)
  }
  if (params.owner_id) {
    where.push("i.owner_id = ?")
    args.push(params.owner_id)
  }
  if (params.assignee_id) {
    where.push(
      `(i.assignee_id = ? OR EXISTS (SELECT 1 FROM marketing_planner_assignees a WHERE a.item_id = i.id AND a.user_id = ?))`,
    )
    args.push(params.assignee_id, params.assignee_id)
  }
  if (params.from) {
    where.push(`(i.due_date >= ? OR i.publish_at >= ?)`)
    args.push(params.from, params.from)
  }
  if (params.to) {
    where.push(`(i.due_date <= ? OR i.publish_at <= ?)`)
    args.push(params.to, `${params.to} 23:59:59`)
  }
  if (params.overdueOnly) {
    where.push(`i.due_date < CURDATE() AND i.status NOT IN ('Published','Completed','Cancelled','Archived')`)
  }
  if (params.scopeUserId) {
    where.push(
      `(i.owner_id = ? OR i.assignee_id = ? OR i.created_by = ? OR EXISTS (SELECT 1 FROM marketing_planner_assignees a WHERE a.item_id = i.id AND a.user_id = ?))`,
    )
    args.push(params.scopeUserId, params.scopeUserId, params.scopeUserId, params.scopeUserId)
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : ""

  const sortCol = SORT_COLUMNS[params.sort || "updated_at"] || "i.updated_at"
  const dir = params.dir === "asc" ? "ASC" : "DESC"
  const page = Math.max(1, params.page || 1)
  const pageSize = Math.min(200, Math.max(1, params.pageSize || 50))
  const offset = (page - 1) * pageSize

  const totalRows = await query<any[]>(
    `SELECT COUNT(*) AS c FROM marketing_planner_items i ${whereSql}`,
    args,
  )
  const total = Number(totalRows[0]?.c || 0)

  const rows = await query<any[]>(
    `SELECT i.*, c.name AS campaign_name, j.name AS journey_name,
            ou.name AS owner_name, au.name AS assignee_name
       FROM marketing_planner_items i
       LEFT JOIN marketing_whatsapp_campaigns c ON c.id = i.campaign_id
       LEFT JOIN marketing_journeys j ON j.id = i.journey_id
       LEFT JOIN users ou ON ou.id = i.owner_id
       LEFT JOIN users au ON au.id = i.assignee_id
       ${whereSql}
       ORDER BY ${sortCol} ${dir}, i.id DESC
       LIMIT ? OFFSET ?`,
    [...args, pageSize, offset],
  ).catch(async () =>
    query<any[]>(
      `SELECT * FROM marketing_planner_items i ${whereSql} ORDER BY i.updated_at DESC LIMIT ? OFFSET ?`,
      [...args, pageSize, offset],
    ),
  )

  const summary = await computeSummary(whereSql, args)
  return { items: rows.map(shapeRow), total, summary }
}

async function computeSummary(whereSql: string, args: any[]) {
  const rows = await query<any[]>(
    `SELECT i.status, COUNT(*) AS c FROM marketing_planner_items i ${whereSql} GROUP BY i.status`,
    args,
  ).catch(() => [])
  const byStatus: Record<string, number> = {}
  let total = 0
  for (const r of rows) {
    byStatus[r.status] = Number(r.c)
    total += Number(r.c)
  }
  const overdueRows = await query<any[]>(
    `SELECT COUNT(*) AS c FROM marketing_planner_items i ${whereSql}
      ${whereSql ? "AND" : "WHERE"} i.due_date < CURDATE()
        AND i.status NOT IN ('Published','Completed','Cancelled','Archived')`,
    args,
  ).catch(() => [{ c: 0 }])
  return { total, byStatus, overdue: Number(overdueRows[0]?.c || 0) }
}

// ---------------------------------------------------------------------------
// Update (with optimistic concurrency + audit + versioning)
// ---------------------------------------------------------------------------

const EDITABLE_FIELDS: (keyof PlannerItemInput)[] = [
  "title",
  "description",
  "content_type",
  "channel",
  "priority",
  "start_date",
  "due_date",
  "publish_at",
  "campaign",
  "campaign_id",
  "journey_id",
  "segment_id",
  "email_template_id",
  "whatsapp_template_name",
  "owner_id",
  "brief",
  "target_audience",
  "estimated_budget",
  "actual_spend",
  "tags",
  "color",
  "related_type",
  "related_id",
  "recurrence",
]

const JSON_FIELDS = new Set(["brief", "target_audience", "tags", "recurrence"])

export async function updateItem(
  id: number,
  input: PlannerItemInput,
  userId: number | null,
  expectedVersion?: number,
): Promise<any> {
  await ensurePlannerSchema()
  const existing = await getItem(id)
  if (!existing) throw new Error("Not found")
  if (expectedVersion != null && Number(existing.row_version) !== Number(expectedVersion)) {
    const err: any = new Error("This item was changed by someone else. Reload and try again.")
    err.code = "CONFLICT"
    throw err
  }

  const sets: string[] = []
  const args: any[] = []
  let briefOrContentChanged = false

  for (const field of EDITABLE_FIELDS) {
    if (!(field in input)) continue
    let value: any = (input as any)[field]
    if (JSON_FIELDS.has(field)) value = toJsonParam(value)
    sets.push(`${field} = ?`)
    args.push(value ?? null)
    if (["title", "description", "brief"].includes(field)) briefOrContentChanged = true
    const oldVal = (existing as any)[field]
    await logActivity(id, "updated", {
      field,
      oldValue: JSON_FIELDS.has(field) ? JSON.stringify(oldVal) : oldVal,
      newValue: JSON_FIELDS.has(field) ? JSON.stringify((input as any)[field]) : value,
      userId,
    })
  }

  if (sets.length === 0) return existing

  sets.push("row_version = row_version + 1")
  args.push(id)
  await query(`UPDATE marketing_planner_items SET ${sets.join(", ")} WHERE id = ?`, args)

  if (briefOrContentChanged) await snapshotVersion(id, "Content edited", userId)
  return getItem(id)
}

async function snapshotVersion(id: number, summary: string, userId: number | null) {
  const rows = await query<any[]>(
    `SELECT title, description, brief, content_type, channel, row_version FROM marketing_planner_items WHERE id = ?`,
    [id],
  ).catch(() => [])
  const row = rows[0]
  if (!row) return
  await query(
    `INSERT INTO marketing_planner_versions (item_id, version, snapshot, change_summary, changed_by)
     VALUES (?,?,?,?,?)`,
    [
      id,
      Number(row.row_version || 1),
      JSON.stringify({
        title: row.title,
        description: row.description,
        brief: parseJson(row.brief, {}),
        content_type: row.content_type,
        channel: row.channel,
      }),
      summary,
      userId,
    ],
  ).catch(() => {})
}

// ---------------------------------------------------------------------------
// Status transitions (Phase 21 / 22 / 24 / 84)
// ---------------------------------------------------------------------------

export async function transitionItem(
  id: number,
  to: PlannerStatus,
  userId: number | null,
  opts: { reason?: string; expectedVersion?: number } = {},
): Promise<any> {
  await ensurePlannerSchema()
  const item = await getItem(id)
  if (!item) throw new Error("Not found")
  const from = item.status as PlannerStatus
  if (from === to) return item

  if (opts.expectedVersion != null && Number(item.row_version) !== Number(opts.expectedVersion)) {
    const err: any = new Error("This item was changed by someone else. Reload and try again.")
    err.code = "CONFLICT"
    throw err
  }

  if (!canTransition(from, to)) {
    const err: any = new Error(`Cannot move from ${from} to ${to}`)
    err.code = "INVALID_TRANSITION"
    throw err
  }

  // Validation gates (Phase 22).
  if (to === "Planned") {
    if (!item.channel || !item.content_type || !(item.owner_id || item.assignee_id)) {
      const err: any = new Error("Set channel, content type and an owner/assignee before planning.")
      err.code = "VALIDATION"
      throw err
    }
  }
  if (to === "Scheduled" && !item.publish_at) {
    const err: any = new Error("A publish date is required before scheduling.")
    err.code = "VALIDATION"
    throw err
  }
  // Published must be a real confirmation — route it through publishItem (Phase 88).
  if (to === "Published") {
    return publishItem(id, userId, opts.reason)
  }
  // Dependency gate for completion (Phase 31).
  if (to === "Completed") {
    const openDeps = (item.dependencies || []).filter(
      (d: any) => !["Published", "Completed", "Cancelled"].includes(d.status),
    )
    if (openDeps.length > 0) {
      const err: any = new Error("Complete required dependencies first.")
      err.code = "DEPENDENCY"
      throw err
    }
  }

  const extra: string[] = ["status = ?", "row_version = row_version + 1"]
  const args: any[] = [to]
  if (to === "Scheduled") {
    extra.push("ready_at = NULL")
  }
  if (to === "Cancelled") {
    extra.push("cancelled_at = NOW()", "cancelled_by = ?", "cancel_reason = ?")
    args.push(userId, opts.reason ?? null)
  }
  if (to === "Archived") {
    extra.push("archived_at = NOW()")
  }
  if (to === "Blocked") {
    extra.push("blocked_at = NOW()", "blocked_by = ?", "blocked_reason = ?")
    args.push(userId, opts.reason ?? null)
  } else if (from === "Blocked") {
    extra.push("blocked_at = NULL", "blocked_by = NULL", "blocked_reason = NULL")
  }
  args.push(id)

  await query(`UPDATE marketing_planner_items SET ${extra.join(", ")} WHERE id = ?`, args)
  await logActivity(id, "status_changed", { field: "status", oldValue: from, newValue: to, reason: opts.reason, userId })

  // Notify (Phase 71).
  const recipients = await recipientsFor(id, item.owner_id)
  for (const uid of recipients) {
    if (uid === userId) continue
    await notify(uid, "info", `Planner item ${to}`, `${item.title} moved to ${to}`, id)
  }
  return getItem(id)
}

// ---------------------------------------------------------------------------
// Scheduling / publishing (Phase 23 / 43 / 88 / 89)
// ---------------------------------------------------------------------------

export async function scheduleItem(
  id: number,
  publishAt: string,
  userId: number | null,
): Promise<any> {
  await ensurePlannerSchema()
  const item = await getItem(id)
  if (!item) throw new Error("Not found")
  if (!publishAt) {
    const err: any = new Error("A publish date/time is required.")
    err.code = "VALIDATION"
    throw err
  }
  await query(
    `UPDATE marketing_planner_items SET publish_at = ?, status = 'Scheduled', ready_at = NULL, row_version = row_version + 1 WHERE id = ?`,
    [publishAt, id],
  )
  await logActivity(id, "scheduled", { field: "publish_at", oldValue: item.publish_at, newValue: publishAt, userId })
  const recipients = await recipientsFor(id, item.owner_id)
  for (const uid of recipients) {
    if (uid === userId) continue
    await notify(uid, "info", "Planner item scheduled", `${item.title} is scheduled for ${publishAt}`, id)
  }
  return getItem(id)
}

/**
 * Manual publish confirmation (Phase 88). The Planner never becomes a send
 * engine — actual delivery is handed off to Email / WhatsApp / campaign
 * systems. This records that publishing was confirmed.
 */
export async function publishItem(id: number, userId: number | null, note?: string): Promise<any> {
  await ensurePlannerSchema()
  const item = await getItem(id)
  if (!item) throw new Error("Not found")
  await query(
    `UPDATE marketing_planner_items SET status = 'Published', published_at = NOW(), row_version = row_version + 1 WHERE id = ?`,
    [id],
  )
  await logActivity(id, "published", { field: "status", oldValue: item.status, newValue: "Published", reason: note, userId })
  const recipients = await recipientsFor(id, item.owner_id)
  for (const uid of recipients) {
    await notify(uid, "success", "Planner item published", `${item.title} was published`, id)
  }
  return getItem(id)
}

// ---------------------------------------------------------------------------
// Assignment (Phase 14 / 15)
// ---------------------------------------------------------------------------

export async function assignItem(
  id: number,
  data: { primary?: number | null; contributors?: number[] },
  userId: number | null,
): Promise<any> {
  await ensurePlannerSchema()
  const item = await getItem(id)
  if (!item) throw new Error("Not found")

  await query(`DELETE FROM marketing_planner_assignees WHERE item_id = ?`, [id])
  const contributors = (data.contributors || []).filter((c) => c && c !== data.primary)

  if (data.primary) {
    await query(
      `INSERT INTO marketing_planner_assignees (item_id, user_id, role, assigned_by) VALUES (?,?, 'primary', ?)`,
      [id, data.primary, userId],
    )
  }
  for (const c of contributors) {
    await query(
      `INSERT IGNORE INTO marketing_planner_assignees (item_id, user_id, role, assigned_by) VALUES (?,?, 'contributor', ?)`,
      [id, c, userId],
    )
  }
  await query(`UPDATE marketing_planner_items SET assignee_id = ?, row_version = row_version + 1 WHERE id = ?`, [
    data.primary ?? null,
    id,
  ])
  await logActivity(id, "assigned", {
    field: "assignee_id",
    oldValue: item.assignee_id,
    newValue: data.primary ?? null,
    userId,
  })

  const notifyIds = new Set<number>()
  if (data.primary) notifyIds.add(data.primary)
  contributors.forEach((c) => notifyIds.add(c))
  for (const uid of notifyIds) {
    if (uid === userId) continue
    await notify(uid, "info", "You were assigned planner work", `${item.title} was assigned to you`, id)
  }
  return getItem(id)
}

// ---------------------------------------------------------------------------
// Review / approval (Phase 35 / 36 / 37)
// ---------------------------------------------------------------------------

export async function reviewAction(
  id: number,
  action: "submit" | "approve" | "reject" | "request_changes",
  userId: number | null,
  note?: string,
): Promise<any> {
  await ensurePlannerSchema()
  const item = await getItem(id)
  if (!item) throw new Error("Not found")

  if (action === "submit") {
    await query(
      `UPDATE marketing_planner_items
          SET review_status = 'Pending', submitted_by = ?, submitted_at = NOW(),
              status = CASE WHEN status IN ('Backlog','Draft','Planned','Assigned','In Progress') THEN 'Review' ELSE status END,
              row_version = row_version + 1
        WHERE id = ?`,
      [userId, id],
    )
    await logActivity(id, "submitted_review", { userId, reason: note })
    if (item.owner_id && item.owner_id !== userId) {
      await notify(item.owner_id, "info", "Content submitted for review", `${item.title} is awaiting your review`, id)
    }
  } else {
    const map = { approve: "Approved", reject: "Rejected", request_changes: "Changes Requested" } as const
    const reviewStatus = map[action]
    await query(
      `UPDATE marketing_planner_items
          SET review_status = ?, reviewed_by = ?, reviewed_at = NOW(),
              status = CASE WHEN ? = 'Approved' THEN status ELSE 'In Progress' END,
              row_version = row_version + 1
        WHERE id = ?`,
      [reviewStatus, userId, reviewStatus, id],
    )
    await logActivity(id, "review_" + action, { field: "review_status", newValue: reviewStatus, reason: note, userId })
    const recipients = await recipientsFor(id, item.submitted_by)
    for (const uid of recipients) {
      if (uid === userId) continue
      await notify(uid, action === "approve" ? "success" : "warning", `Content ${reviewStatus.toLowerCase()}`, `${item.title}: ${reviewStatus}`, id)
    }
  }

  if (note) {
    await query(
      `INSERT INTO marketing_planner_comments (item_id, kind, user_id, body, meta) VALUES (?, 'review', ?, ?, ?)`,
      [id, userId, note, JSON.stringify({ action })],
    )
  }
  return getItem(id)
}

// ---------------------------------------------------------------------------
// Duplicate (Phase 66)
// ---------------------------------------------------------------------------

export async function duplicateItem(id: number, userId: number | null): Promise<any> {
  await ensurePlannerSchema()
  const src = await getItem(id)
  if (!src) throw new Error("Not found")
  return createItem(
    {
      title: `${src.title} (Copy)`,
      description: src.description,
      content_type: src.content_type,
      channel: src.channel,
      status: "Draft",
      priority: src.priority,
      campaign: src.campaign,
      campaign_id: src.campaign_id,
      journey_id: src.journey_id,
      segment_id: src.segment_id,
      email_template_id: src.email_template_id,
      whatsapp_template_name: src.whatsapp_template_name,
      owner_id: src.owner_id,
      brief: src.brief,
      target_audience: src.target_audience,
      estimated_budget: src.estimated_budget,
      tags: src.tags,
      color: src.color,
    },
    userId,
  )
}

// ---------------------------------------------------------------------------
// Dependencies (Phase 30 / 31)
// ---------------------------------------------------------------------------

export async function addDependency(itemId: number, dependsOnId: number, userId: number | null) {
  await ensurePlannerSchema()
  if (itemId === dependsOnId) throw new Error("An item cannot depend on itself")
  // Prevent a direct cycle.
  const reverse = await query<any[]>(
    `SELECT 1 FROM marketing_planner_dependencies WHERE item_id = ? AND depends_on_id = ? LIMIT 1`,
    [dependsOnId, itemId],
  )
  if (reverse.length) throw new Error("That would create a circular dependency")
  await query(
    `INSERT IGNORE INTO marketing_planner_dependencies (item_id, depends_on_id, created_by) VALUES (?,?,?)`,
    [itemId, dependsOnId, userId],
  )
  await logActivity(itemId, "dependency_added", { newValue: dependsOnId, userId })
  return getItem(itemId)
}

export async function removeDependency(itemId: number, dependsOnId: number, userId: number | null) {
  await ensurePlannerSchema()
  await query(`DELETE FROM marketing_planner_dependencies WHERE item_id = ? AND depends_on_id = ?`, [
    itemId,
    dependsOnId,
  ])
  await logActivity(itemId, "dependency_removed", { oldValue: dependsOnId, userId })
  return getItem(itemId)
}

// ---------------------------------------------------------------------------
// Comments / versions / activity / assets
// ---------------------------------------------------------------------------

export async function addComment(itemId: number, body: string, userId: number | null) {
  await ensurePlannerSchema()
  if (!body || !body.trim()) throw new Error("Comment cannot be empty")
  await query(`INSERT INTO marketing_planner_comments (item_id, kind, user_id, body) VALUES (?, 'comment', ?, ?)`, [
    itemId,
    userId,
    body.trim(),
  ])
  return listComments(itemId)
}

export async function listComments(itemId: number) {
  await ensurePlannerSchema()
  return query<any[]>(
    `SELECT c.*, u.name AS user_name FROM marketing_planner_comments c
       LEFT JOIN users u ON u.id = c.user_id
      WHERE c.item_id = ? ORDER BY c.created_at ASC`,
    [itemId],
  ).catch(() => [])
}

export async function listVersions(itemId: number) {
  await ensurePlannerSchema()
  return query<any[]>(
    `SELECT v.*, u.name AS changed_by_name FROM marketing_planner_versions v
       LEFT JOIN users u ON u.id = v.changed_by
      WHERE v.item_id = ? ORDER BY v.version DESC, v.id DESC`,
    [itemId],
  ).catch(() => [])
}

export async function listActivity(itemId: number) {
  await ensurePlannerSchema()
  return query<any[]>(
    `SELECT a.*, u.name AS user_name FROM marketing_planner_activity a
       LEFT JOIN users u ON u.id = a.user_id
      WHERE a.item_id = ? ORDER BY a.created_at DESC, a.id DESC LIMIT 200`,
    [itemId],
  ).catch(() => [])
}

export async function addAsset(
  itemId: number,
  data: { label: string; url?: string; kind?: string; library_asset_id?: string },
  userId: number | null,
) {
  await ensurePlannerSchema()
  await query(
    `INSERT INTO marketing_planner_assets (item_id, library_asset_id, label, url, kind, created_by) VALUES (?,?,?,?,?,?)`,
    [itemId, data.library_asset_id ?? null, data.label, data.url ?? null, data.kind ?? null, userId],
  )
  await logActivity(itemId, "asset_added", { newValue: data.label, userId })
  return query<any[]>(`SELECT * FROM marketing_planner_assets WHERE item_id = ? ORDER BY created_at DESC`, [itemId])
}

export async function removeAsset(itemId: number, assetId: number, userId: number | null) {
  await ensurePlannerSchema()
  await query(`DELETE FROM marketing_planner_assets WHERE id = ? AND item_id = ?`, [assetId, itemId])
  await logActivity(itemId, "asset_removed", { oldValue: assetId, userId })
  return query<any[]>(`SELECT * FROM marketing_planner_assets WHERE item_id = ? ORDER BY created_at DESC`, [itemId])
}

export async function deleteItem(id: number, userId: number | null) {
  await ensurePlannerSchema()
  await query(`DELETE FROM marketing_planner_items WHERE id = ?`, [id])
  await logActivity(id, "deleted", { userId })
}

// ---------------------------------------------------------------------------
// Analytics (Phase 53-59)
// ---------------------------------------------------------------------------

export async function analytics(scopeUserId?: number) {
  await ensurePlannerSchema()
  const scope = scopeUserId
    ? `WHERE (owner_id = ${Number(scopeUserId)} OR assignee_id = ${Number(scopeUserId)})`
    : ""

  const [byStatus, byChannel, byType, byCampaign, byOwner, perf, workload] = await Promise.all([
    query<any[]>(`SELECT status, COUNT(*) c FROM marketing_planner_items ${scope} GROUP BY status`).catch(() => []),
    query<any[]>(`SELECT channel, COUNT(*) c FROM marketing_planner_items ${scope} GROUP BY channel ORDER BY c DESC`).catch(
      () => [],
    ),
    query<any[]>(
      `SELECT content_type, COUNT(*) c FROM marketing_planner_items ${scope} GROUP BY content_type ORDER BY c DESC`,
    ).catch(() => []),
    query<any[]>(
      `SELECT COALESCE(c.name, i.campaign, 'Unassigned') AS campaign, COUNT(*) c
         FROM marketing_planner_items i LEFT JOIN marketing_whatsapp_campaigns c ON c.id = i.campaign_id
         ${scope} GROUP BY campaign ORDER BY c DESC LIMIT 20`,
    ).catch(() => []),
    query<any[]>(
      `SELECT COALESCE(u.name,'Unassigned') AS owner, COUNT(*) c
         FROM marketing_planner_items i LEFT JOIN users u ON u.id = i.owner_id
         ${scope} GROUP BY owner ORDER BY c DESC LIMIT 20`,
    ).catch(() => []),
    query<any[]>(
      `SELECT
         SUM(CASE WHEN status IN ('Published','Completed') THEN 1 ELSE 0 END) AS done,
         SUM(CASE WHEN status IN ('Published','Completed') AND (published_at IS NULL OR due_date IS NULL OR DATE(published_at) <= due_date) THEN 1 ELSE 0 END) AS on_time,
         SUM(CASE WHEN due_date < CURDATE() AND status NOT IN ('Published','Completed','Cancelled','Archived') THEN 1 ELSE 0 END) AS overdue,
         COUNT(*) AS total
       FROM marketing_planner_items ${scope}`,
    ).catch(() => [{}]),
    query<any[]>(
      `SELECT u.id AS user_id, u.name,
              SUM(CASE WHEN a.item_id IS NOT NULL THEN 1 ELSE 0 END) AS assigned,
              SUM(CASE WHEN i.status = 'In Progress' THEN 1 ELSE 0 END) AS in_progress,
              SUM(CASE WHEN i.due_date BETWEEN CURDATE() AND DATE_ADD(CURDATE(), INTERVAL 7 DAY)
                        AND i.status NOT IN ('Published','Completed','Cancelled','Archived') THEN 1 ELSE 0 END) AS due_soon,
              SUM(CASE WHEN i.due_date < CURDATE() AND i.status NOT IN ('Published','Completed','Cancelled','Archived') THEN 1 ELSE 0 END) AS overdue
         FROM marketing_planner_assignees a
         JOIN marketing_planner_items i ON i.id = a.item_id
         JOIN users u ON u.id = a.user_id
        GROUP BY u.id, u.name ORDER BY assigned DESC LIMIT 25`,
    ).catch(() => []),
  ])

  const p = perf[0] || {}
  const total = Number(p.total || 0)
  const done = Number(p.done || 0)
  return {
    byStatus,
    byChannel,
    byType,
    byCampaign,
    byOwner,
    workload,
    performance: {
      total,
      done,
      overdue: Number(p.overdue || 0),
      onTimePct: done ? Math.round((Number(p.on_time || 0) / done) * 100) : 0,
      completionPct: total ? Math.round((done / total) * 100) : 0,
      overduePct: total ? Math.round((Number(p.overdue || 0) / total) * 100) : 0,
    },
  }
}

// ---------------------------------------------------------------------------
// Cron engine (Phase 24 / 26 / 27 / 28 / 29 / 68)
// ---------------------------------------------------------------------------

const REMINDER_STAGES: { stage: string; days: number }[] = [
  { stage: "d7", days: 7 },
  { stage: "d3", days: 3 },
  { stage: "d1", days: 1 },
  { stage: "due", days: 0 },
]

export async function runPlannerCron(): Promise<{
  reminders: number
  overdue: number
  readied: number
  recurring: number
}> {
  await ensurePlannerSchema()
  let reminders = 0
  let overdue = 0
  let readied = 0
  let recurring = 0

  // 1) Due-date reminders (7/3/1/0 days out). One row per (item,stage) guards
  //    against duplicate notifications across repeated cron runs (Phase 29).
  for (const { stage, days } of REMINDER_STAGES) {
    const due = await query<any[]>(
      `SELECT i.id, i.title, i.owner_id, i.assignee_id, i.due_date
         FROM marketing_planner_items i
        WHERE i.due_date = DATE_ADD(CURDATE(), INTERVAL ? DAY)
          AND i.status NOT IN ('Published','Completed','Cancelled','Archived')
          AND NOT EXISTS (
            SELECT 1 FROM marketing_planner_reminders r WHERE r.item_id = i.id AND r.stage = ?
          )`,
      [days, stage],
    ).catch(() => [])
    for (const row of due) {
      const inserted: any = await query(
        `INSERT IGNORE INTO marketing_planner_reminders (item_id, stage, due_at) VALUES (?,?,?)`,
        [row.id, stage, row.due_date ? `${row.due_date} 09:00:00` : null],
      ).catch(() => ({ affectedRows: 0 }))
      if (!inserted || inserted.affectedRows === 0) continue
      const recips = await recipientsFor(row.id, row.owner_id)
      const label = days === 0 ? "due today" : `due in ${days} day${days === 1 ? "" : "s"}`
      for (const uid of recips) {
        await notify(uid, "warning", `Planner item ${label}`, `${row.title} is ${label}`, row.id)
        reminders++
      }
    }
  }

  // 2) Overdue notifications (Phase 25 / 26). Idempotent via a per-item stage.
  const overdueRows = await query<any[]>(
    `SELECT i.id, i.title, i.owner_id, i.due_date
       FROM marketing_planner_items i
      WHERE i.due_date < CURDATE()
        AND i.status NOT IN ('Published','Completed','Cancelled','Archived')
        AND NOT EXISTS (
          SELECT 1 FROM marketing_planner_reminders r WHERE r.item_id = i.id AND r.stage = 'overdue'
        )`,
  ).catch(() => [])
  for (const row of overdueRows) {
    const inserted: any = await query(
      `INSERT IGNORE INTO marketing_planner_reminders (item_id, stage, due_at) VALUES (?, 'overdue', ?)`,
      [row.id, row.due_date ? `${row.due_date} 23:59:59` : null],
    ).catch(() => ({ affectedRows: 0 }))
    if (!inserted || inserted.affectedRows === 0) continue
    const recips = await recipientsFor(row.id, row.owner_id)
    for (const uid of recips) {
      await notify(uid, "error", "Planner item overdue", `${row.title} is past its due date`, row.id)
    }
    await logActivity(row.id, "overdue_flagged", {})
    overdue++
  }

  // 3) Scheduled -> Ready when the publish time has arrived. We deliberately do
  //    NOT auto-mark Published (Phase 24 / 88) — publishing requires an explicit
  //    confirmation / external hand-off.
  const readyRows = await query<any[]>(
    `SELECT id, title, owner_id FROM marketing_planner_items
      WHERE status = 'Scheduled' AND publish_at IS NOT NULL AND publish_at <= NOW()`,
  ).catch(() => [])
  for (const row of readyRows) {
    await query(
      `UPDATE marketing_planner_items SET status = 'Ready', ready_at = NOW(), row_version = row_version + 1 WHERE id = ? AND status = 'Scheduled'`,
      [row.id],
    )
    await logActivity(row.id, "ready_to_publish", { newValue: "Ready" })
    const recips = await recipientsFor(row.id, row.owner_id)
    for (const uid of recips) {
      await notify(uid, "info", "Planner item ready to publish", `${row.title} reached its scheduled time`, row.id, `planner-ready-${row.id}`)
    }
    readied++
  }

  // 4) Recurring generation (Phase 68). Generate the next instance for items
  //    whose next_recurrence_at has arrived.
  const recurringRows = await query<any[]>(
    `SELECT * FROM marketing_planner_items
      WHERE recurrence IS NOT NULL AND next_recurrence_at IS NOT NULL AND next_recurrence_at <= NOW()
      LIMIT 50`,
  ).catch(() => [])
  for (const row of recurringRows) {
    const rec = parseJson<any>(row.recurrence, null)
    if (!rec || !rec.freq) continue
    const next = advanceRecurrence(new Date(row.next_recurrence_at || Date.now()), rec)
    const child = await createItem(
      {
        title: row.title,
        description: row.description,
        content_type: row.content_type,
        channel: row.channel,
        status: "Backlog",
        priority: row.priority,
        campaign: row.campaign,
        campaign_id: row.campaign_id,
        journey_id: row.journey_id,
        owner_id: row.owner_id,
        due_date: next ? next.toISOString().slice(0, 10) : null,
      },
      row.created_by ?? null,
    )
    await query(`UPDATE marketing_planner_items SET recurrence_parent_id = ? WHERE id = ?`, [row.id, child.id]).catch(
      () => {},
    )
    // Roll the parent's next occurrence forward (or stop if past `until`).
    if (next && (!rec.until || next <= new Date(rec.until))) {
      await query(`UPDATE marketing_planner_items SET next_recurrence_at = ? WHERE id = ?`, [
        `${next.toISOString().slice(0, 10)} 00:00:00`,
        row.id,
      ])
    } else {
      await query(`UPDATE marketing_planner_items SET next_recurrence_at = NULL WHERE id = ?`, [row.id])
    }
    recurring++
  }

  return { reminders, overdue, readied, recurring }
}

function advanceRecurrence(from: Date, rec: any): Date | null {
  const interval = Math.max(1, Number(rec.interval || 1))
  const d = new Date(from)
  switch (rec.freq) {
    case "daily":
      d.setDate(d.getDate() + interval)
      return d
    case "weekly":
      d.setDate(d.getDate() + 7 * interval)
      return d
    case "monthly":
      d.setMonth(d.getMonth() + interval)
      return d
    default:
      if (rec.custom_days) {
        d.setDate(d.getDate() + Number(rec.custom_days))
        return d
      }
      return null
  }
}

export { OPEN_STATUSES }
