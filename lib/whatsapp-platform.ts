import "server-only"
import { query } from "@/lib/db"
import { DEFAULT_WORKING_HOURS } from "@/lib/whatsapp-config"

/**
 * Data-access layer for the WhatsApp multi-agent PLATFORM: departments, agent
 * settings + membership, internal notes and department transfers.
 *
 * Mirrors database/migrations/2026-09-22-add-whatsapp-platform.sql. As with the
 * existing WhatsApp libs, ensureWhatsAppPlatformTables() self-heals the schema
 * at runtime so a deployment that has not imported the SQL yet still works.
 */

let platformEnsured = false

export async function ensureWhatsAppPlatformTables() {
  if (platformEnsured) return

  await query(
    `CREATE TABLE IF NOT EXISTS \`marketing_whatsapp_departments\` (
      \`id\` INT UNSIGNED NOT NULL AUTO_INCREMENT,
      \`name\` VARCHAR(120) NOT NULL,
      \`slug\` VARCHAR(120) NOT NULL,
      \`description\` VARCHAR(500) DEFAULT NULL,
      \`is_active\` TINYINT(1) NOT NULL DEFAULT 1,
      \`manager_user_id\` INT UNSIGNED DEFAULT NULL,
      \`routing_method\` VARCHAR(32) NOT NULL DEFAULT 'round_robin',
      \`working_hours\` TEXT DEFAULT NULL,
      \`auto_assign\` TINYINT(1) NOT NULL DEFAULT 1,
      \`keywords\` VARCHAR(1000) DEFAULT NULL,
      \`color\` VARCHAR(16) DEFAULT NULL,
      \`sort_order\` INT NOT NULL DEFAULT 0,
      \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      \`updated_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (\`id\`),
      UNIQUE KEY \`uniq_wa_dept_slug\` (\`slug\`),
      KEY \`idx_wa_dept_active\` (\`is_active\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  )

  await query(
    `CREATE TABLE IF NOT EXISTS \`marketing_whatsapp_department_agents\` (
      \`id\` INT UNSIGNED NOT NULL AUTO_INCREMENT,
      \`department_id\` INT UNSIGNED NOT NULL,
      \`user_id\` INT UNSIGNED NOT NULL,
      \`role\` ENUM('agent','manager') NOT NULL DEFAULT 'agent',
      \`is_active\` TINYINT(1) NOT NULL DEFAULT 1,
      \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (\`id\`),
      UNIQUE KEY \`uniq_wa_dept_agent\` (\`department_id\`, \`user_id\`),
      KEY \`idx_wa_dept_agent_user\` (\`user_id\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  )

  await query(
    `CREATE TABLE IF NOT EXISTS \`marketing_whatsapp_agent_settings\` (
      \`user_id\` INT UNSIGNED NOT NULL,
      \`is_agent\` TINYINT(1) NOT NULL DEFAULT 0,
      \`is_available\` TINYINT(1) NOT NULL DEFAULT 1,
      \`can_view_all\` TINYINT(1) NOT NULL DEFAULT 0,
      \`can_view_department\` TINYINT(1) NOT NULL DEFAULT 1,
      \`can_send\` TINYINT(1) NOT NULL DEFAULT 1,
      \`can_assign\` TINYINT(1) NOT NULL DEFAULT 0,
      \`can_reassign\` TINYINT(1) NOT NULL DEFAULT 0,
      \`can_close\` TINYINT(1) NOT NULL DEFAULT 1,
      \`can_send_templates\` TINYINT(1) NOT NULL DEFAULT 1,
      \`can_create_campaigns\` TINYINT(1) NOT NULL DEFAULT 0,
      \`can_view_analytics\` TINYINT(1) NOT NULL DEFAULT 0,
      \`can_manage_contacts\` TINYINT(1) NOT NULL DEFAULT 0,
      \`can_manage_automation\` TINYINT(1) NOT NULL DEFAULT 0,
      \`last_assigned_at\` DATETIME DEFAULT NULL,
      \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      \`updated_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (\`user_id\`),
      KEY \`idx_wa_agent_is_agent\` (\`is_agent\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  )

  await query(
    `CREATE TABLE IF NOT EXISTS \`marketing_whatsapp_internal_notes\` (
      \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      \`conversation_id\` INT UNSIGNED NOT NULL,
      \`user_id\` INT UNSIGNED DEFAULT NULL,
      \`note\` TEXT NOT NULL,
      \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (\`id\`),
      KEY \`idx_wa_note_convo\` (\`conversation_id\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  )

  await query(
    `CREATE TABLE IF NOT EXISTS \`marketing_whatsapp_transfers\` (
      \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      \`conversation_id\` INT UNSIGNED NOT NULL,
      \`from_department_id\` INT UNSIGNED DEFAULT NULL,
      \`to_department_id\` INT UNSIGNED DEFAULT NULL,
      \`from_agent_id\` INT UNSIGNED DEFAULT NULL,
      \`to_agent_id\` INT UNSIGNED DEFAULT NULL,
      \`transferred_by\` INT UNSIGNED DEFAULT NULL,
      \`reason\` VARCHAR(500) DEFAULT NULL,
      \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (\`id\`),
      KEY \`idx_wa_transfer_convo\` (\`conversation_id\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  )

  await query(
    `CREATE TABLE IF NOT EXISTS \`marketing_whatsapp_media\` (
      \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      \`message_id\` INT UNSIGNED DEFAULT NULL,
      \`conversation_id\` INT UNSIGNED DEFAULT NULL,
      \`media_id\` VARCHAR(191) NOT NULL,
      \`mime_type\` VARCHAR(128) DEFAULT NULL,
      \`filename\` VARCHAR(255) DEFAULT NULL,
      \`file_size\` INT UNSIGNED DEFAULT NULL,
      \`sha256\` VARCHAR(128) DEFAULT NULL,
      \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (\`id\`),
      UNIQUE KEY \`uniq_wa_media_id\` (\`media_id\`),
      KEY \`idx_wa_media_message\` (\`message_id\`),
      KEY \`idx_wa_media_convo\` (\`conversation_id\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  )

  // Conversation platform columns (idempotent).
  await ensureColumn("marketing_whatsapp_conversations", "department_id", "ADD COLUMN `department_id` INT UNSIGNED DEFAULT NULL")
  await ensureColumn("marketing_whatsapp_conversations", "bot_enabled", "ADD COLUMN `bot_enabled` TINYINT(1) NOT NULL DEFAULT 0")
  await ensureColumn("marketing_whatsapp_conversations", "sla_due_at", "ADD COLUMN `sla_due_at` DATETIME DEFAULT NULL")
  await ensureColumn("marketing_whatsapp_conversations", "first_response_at", "ADD COLUMN `first_response_at` DATETIME DEFAULT NULL")
  await ensureColumn("marketing_whatsapp_conversations", "closed_at", "ADD COLUMN `closed_at` DATETIME DEFAULT NULL")
  await ensureColumn("marketing_whatsapp_conversations", "closed_by", "ADD COLUMN `closed_by` INT UNSIGNED DEFAULT NULL")
  await ensureColumn("marketing_whatsapp_conversations", "source", "ADD COLUMN `source` VARCHAR(64) DEFAULT NULL")

  // Contact segmentation columns.
  await ensureColumn("marketing_whatsapp_contacts", "city", "ADD COLUMN `city` VARCHAR(120) DEFAULT NULL")
  await ensureColumn("marketing_whatsapp_contacts", "state", "ADD COLUMN `state` VARCHAR(120) DEFAULT NULL")
  await ensureColumn("marketing_whatsapp_contacts", "country", "ADD COLUMN `country` VARCHAR(120) DEFAULT NULL")
  await ensureColumn("marketing_whatsapp_contacts", "opted_in", "ADD COLUMN `opted_in` TINYINT(1) NOT NULL DEFAULT 1")
  await ensureColumn("marketing_whatsapp_contacts", "custom_attributes", "ADD COLUMN `custom_attributes` TEXT DEFAULT NULL")
  await ensureColumn("marketing_whatsapp_contacts", "last_interaction_at", "ADD COLUMN `last_interaction_at` DATETIME DEFAULT NULL")

  // Message campaign linkage.
  await ensureColumn("marketing_whatsapp_messages", "campaign_id", "ADD COLUMN `campaign_id` INT UNSIGNED DEFAULT NULL")

  await seedDefaultDepartments()
  platformEnsured = true
}

async function columnExists(table: string, column: string): Promise<boolean> {
  const rows = await query<{ c: number }[]>(
    `SELECT COUNT(*) AS c FROM information_schema.COLUMNS
      WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
    [table, column],
  )
  return (rows[0]?.c ?? 0) > 0
}

async function ensureColumn(table: string, column: string, alterFragment: string) {
  try {
    if (await columnExists(table, column)) return
    await query(`ALTER TABLE \`${table}\` ${alterFragment}`)
  } catch {
    // Concurrent add / missing ALTER rights — safe to ignore.
  }
}

const DEFAULT_DEPARTMENTS = [
  { name: "Sales", slug: "sales", description: "New business, quotations and lead follow-up", order: 1 },
  { name: "Support", slug: "support", description: "Customer support and issue resolution", order: 2 },
  { name: "Marketing", slug: "marketing", description: "Campaigns, promotions and broadcasts", order: 3 },
  { name: "Accounts", slug: "accounts", description: "Billing, payments and invoices", order: 4 },
  { name: "HR", slug: "hr", description: "Recruitment and people operations", order: 5 },
  { name: "Operations", slug: "operations", description: "Delivery and project operations", order: 6 },
  { name: "Admin", slug: "admin", description: "Administrative and everything else", order: 7 },
]

async function seedDefaultDepartments() {
  try {
    const rows = await query<{ c: number }[]>("SELECT COUNT(*) AS c FROM `marketing_whatsapp_departments`")
    if ((rows[0]?.c ?? 0) > 0) return
    for (const d of DEFAULT_DEPARTMENTS) {
      await query(
        "INSERT INTO `marketing_whatsapp_departments` (name, slug, description, sort_order) VALUES (?, ?, ?, ?)",
        [d.name, d.slug, d.description, d.order],
      )
    }
  } catch {
    // ignore seed races
  }
}

/* ------------------------------------------------------------------ */
/* Departments                                                         */
/* ------------------------------------------------------------------ */

export type DepartmentRow = {
  id: number
  name: string
  slug: string
  description: string | null
  is_active: number
  manager_user_id: number | null
  routing_method: string
  working_hours: string | null
  auto_assign: number
  keywords: string | null
  color: string | null
  sort_order: number
}

export type Department = {
  id: number
  name: string
  slug: string
  description: string | null
  isActive: boolean
  managerUserId: number | null
  managerName: string | null
  routingMethod: string
  workingHours: Record<string, { open: string; close: string; enabled: boolean }>
  autoAssign: boolean
  keywords: string[]
  color: string | null
  sortOrder: number
  agentCount: number
  openConversations: number
}

function parseWorkingHours(json: string | null) {
  if (!json) return DEFAULT_WORKING_HOURS
  try {
    const parsed = JSON.parse(json)
    return parsed && typeof parsed === "object" ? parsed : DEFAULT_WORKING_HOURS
  } catch {
    return DEFAULT_WORKING_HOURS
  }
}

function parseKeywords(raw: string | null): string[] {
  if (!raw) return []
  return raw
    .split(/[\n,]/)
    .map((k) => k.trim().toLowerCase())
    .filter(Boolean)
}

export async function listDepartments(): Promise<Department[]> {
  await ensureWhatsAppPlatformTables()
  const rows = await query<(DepartmentRow & { manager_name: string | null; agent_count: number; open_count: number })[]>(
    `SELECT d.*, u.name AS manager_name,
            (SELECT COUNT(*) FROM \`marketing_whatsapp_department_agents\` da WHERE da.department_id = d.id AND da.is_active = 1) AS agent_count,
            (SELECT COUNT(*) FROM \`marketing_whatsapp_conversations\` c WHERE c.department_id = d.id AND c.status <> 'closed') AS open_count
       FROM \`marketing_whatsapp_departments\` d
       LEFT JOIN \`users\` u ON u.id = d.manager_user_id
      ORDER BY d.sort_order ASC, d.name ASC`,
  )
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    slug: r.slug,
    description: r.description,
    isActive: r.is_active === 1,
    managerUserId: r.manager_user_id,
    managerName: r.manager_name,
    routingMethod: r.routing_method,
    workingHours: parseWorkingHours(r.working_hours),
    autoAssign: r.auto_assign === 1,
    keywords: parseKeywords(r.keywords),
    color: r.color,
    sortOrder: r.sort_order,
    agentCount: Number(r.agent_count) || 0,
    openConversations: Number(r.open_count) || 0,
  }))
}

export async function getDepartment(id: number): Promise<DepartmentRow | null> {
  await ensureWhatsAppPlatformTables()
  const rows = await query<DepartmentRow[]>("SELECT * FROM `marketing_whatsapp_departments` WHERE id = ? LIMIT 1", [id])
  return rows[0] ?? null
}

function slugify(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 100) || "dept"
}

export async function createDepartment(input: {
  name: string
  description?: string | null
  routingMethod?: string
  managerUserId?: number | null
  keywords?: string | null
  color?: string | null
}): Promise<number> {
  await ensureWhatsAppPlatformTables()
  let slug = slugify(input.name)
  // ensure unique slug
  const clash = await query<{ c: number }[]>(
    "SELECT COUNT(*) AS c FROM `marketing_whatsapp_departments` WHERE slug = ?",
    [slug],
  )
  if ((clash[0]?.c ?? 0) > 0) slug = `${slug}-${Date.now().toString().slice(-4)}`

  const maxOrder = await query<{ m: number | null }[]>(
    "SELECT MAX(sort_order) AS m FROM `marketing_whatsapp_departments`",
  )
  const result = await query<{ insertId: number }>(
    `INSERT INTO \`marketing_whatsapp_departments\`
       (name, slug, description, routing_method, manager_user_id, keywords, color, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.name.trim(),
      slug,
      input.description?.trim() || null,
      input.routingMethod || "round_robin",
      input.managerUserId ?? null,
      input.keywords?.trim() || null,
      input.color?.trim() || null,
      (maxOrder[0]?.m ?? 0) + 1,
    ],
  )
  return result.insertId
}

export async function updateDepartment(
  id: number,
  patch: {
    name?: string
    description?: string | null
    isActive?: boolean
    routingMethod?: string
    managerUserId?: number | null
    autoAssign?: boolean
    keywords?: string | null
    color?: string | null
    workingHours?: unknown
  },
): Promise<void> {
  await ensureWhatsAppPlatformTables()
  const sets: string[] = []
  const params: (string | number | null)[] = []
  const push = (col: string, val: string | number | null) => {
    sets.push(`\`${col}\` = ?`)
    params.push(val)
  }
  if (patch.name !== undefined) push("name", patch.name.trim())
  if (patch.description !== undefined) push("description", patch.description?.trim() || null)
  if (patch.isActive !== undefined) push("is_active", patch.isActive ? 1 : 0)
  if (patch.routingMethod !== undefined) push("routing_method", patch.routingMethod)
  if (patch.managerUserId !== undefined) push("manager_user_id", patch.managerUserId)
  if (patch.autoAssign !== undefined) push("auto_assign", patch.autoAssign ? 1 : 0)
  if (patch.keywords !== undefined) push("keywords", patch.keywords?.trim() || null)
  if (patch.color !== undefined) push("color", patch.color?.trim() || null)
  if (patch.workingHours !== undefined) push("working_hours", JSON.stringify(patch.workingHours))
  if (!sets.length) return
  params.push(id)
  await query(`UPDATE \`marketing_whatsapp_departments\` SET ${sets.join(", ")} WHERE id = ?`, params)
}

export async function deleteDepartment(id: number): Promise<void> {
  await ensureWhatsAppPlatformTables()
  // Detach conversations first so we never orphan a FK.
  await query("UPDATE `marketing_whatsapp_conversations` SET department_id = NULL WHERE department_id = ?", [id])
  await query("DELETE FROM `marketing_whatsapp_departments` WHERE id = ?", [id])
}

/* ------------------------------------------------------------------ */
/* Department membership                                               */
/* ------------------------------------------------------------------ */

export type DepartmentMember = {
  userId: number
  name: string
  role: "agent" | "manager"
  isActive: boolean
  isAvailable: boolean
}

export async function listDepartmentAgents(departmentId: number): Promise<DepartmentMember[]> {
  await ensureWhatsAppPlatformTables()
  const rows = await query<
    { user_id: number; name: string; role: "agent" | "manager"; is_active: number; is_available: number | null }[]
  >(
    `SELECT da.user_id, u.name, da.role, da.is_active,
            COALESCE(s.is_available, 1) AS is_available
       FROM \`marketing_whatsapp_department_agents\` da
       JOIN \`users\` u ON u.id = da.user_id
       LEFT JOIN \`marketing_whatsapp_agent_settings\` s ON s.user_id = da.user_id
      WHERE da.department_id = ?
      ORDER BY da.role DESC, u.name ASC`,
    [departmentId],
  )
  return rows.map((r) => ({
    userId: r.user_id,
    name: r.name,
    role: r.role,
    isActive: r.is_active === 1,
    isAvailable: (r.is_available ?? 1) === 1,
  }))
}

export async function setDepartmentAgents(
  departmentId: number,
  members: { userId: number; role: "agent" | "manager" }[],
): Promise<void> {
  await ensureWhatsAppPlatformTables()
  await query("DELETE FROM `marketing_whatsapp_department_agents` WHERE department_id = ?", [departmentId])
  for (const m of members) {
    await query(
      `INSERT INTO \`marketing_whatsapp_department_agents\` (department_id, user_id, role, is_active)
       VALUES (?, ?, ?, 1)
       ON DUPLICATE KEY UPDATE role = VALUES(role), is_active = 1`,
      [departmentId, m.userId, m.role],
    )
    // Anyone added to a department is implicitly a WhatsApp agent.
    await query(
      `INSERT INTO \`marketing_whatsapp_agent_settings\` (user_id, is_agent)
       VALUES (?, 1)
       ON DUPLICATE KEY UPDATE is_agent = 1`,
      [m.userId],
    )
  }
}

/* ------------------------------------------------------------------ */
/* Agent settings                                                      */
/* ------------------------------------------------------------------ */

export type AgentSettingsRow = {
  user_id: number
  is_agent: number
  is_available: number
  can_view_all: number
  can_view_department: number
  can_send: number
  can_assign: number
  can_reassign: number
  can_close: number
  can_send_templates: number
  can_create_campaigns: number
  can_view_analytics: number
  can_manage_contacts: number
  can_manage_automation: number
  last_assigned_at: string | null
}

export type AgentProfile = {
  userId: number
  name: string
  email: string
  role: "admin" | "employee"
  designation: string | null
  isAgent: boolean
  isAvailable: boolean
  departments: { id: number; name: string; role: "agent" | "manager" }[]
  caps: {
    canViewAll: boolean
    canViewDepartment: boolean
    canSend: boolean
    canAssign: boolean
    canReassign: boolean
    canClose: boolean
    canSendTemplates: boolean
    canCreateCampaigns: boolean
    canViewAnalytics: boolean
    canManageContacts: boolean
    canManageAutomation: boolean
  }
}

const CAP_COLUMNS = [
  "can_view_all",
  "can_view_department",
  "can_send",
  "can_assign",
  "can_reassign",
  "can_close",
  "can_send_templates",
  "can_create_campaigns",
  "can_view_analytics",
  "can_manage_contacts",
  "can_manage_automation",
] as const

export async function getAgentSettings(userId: number): Promise<AgentSettingsRow | null> {
  await ensureWhatsAppPlatformTables()
  const rows = await query<AgentSettingsRow[]>(
    "SELECT * FROM `marketing_whatsapp_agent_settings` WHERE user_id = ? LIMIT 1",
    [userId],
  )
  return rows[0] ?? null
}

export async function listAgentProfiles(): Promise<AgentProfile[]> {
  await ensureWhatsAppPlatformTables()
  const users = await query<
    { id: number; name: string; email: string; role: "admin" | "employee"; designation: string | null }[]
  >("SELECT id, name, email, role, designation FROM `users` WHERE status = 'active' ORDER BY name ASC")

  const settings = await query<AgentSettingsRow[]>("SELECT * FROM `marketing_whatsapp_agent_settings`")
  const settingsByUser = new Map(settings.map((s) => [s.user_id, s]))

  const memberships = await query<
    { user_id: number; department_id: number; name: string; role: "agent" | "manager" }[]
  >(
    `SELECT da.user_id, da.department_id, d.name, da.role
       FROM \`marketing_whatsapp_department_agents\` da
       JOIN \`marketing_whatsapp_departments\` d ON d.id = da.department_id
      WHERE da.is_active = 1`,
  )
  const memByUser = new Map<number, { id: number; name: string; role: "agent" | "manager" }[]>()
  for (const m of memberships) {
    const arr = memByUser.get(m.user_id) ?? []
    arr.push({ id: m.department_id, name: m.name, role: m.role })
    memByUser.set(m.user_id, arr)
  }

  return users.map((u) => {
    const s = settingsByUser.get(u.id)
    const isAdmin = u.role === "admin"
    return {
      userId: u.id,
      name: u.name,
      email: u.email,
      role: u.role,
      designation: u.designation,
      isAgent: isAdmin || (s?.is_agent ?? 0) === 1,
      isAvailable: (s?.is_available ?? 1) === 1,
      departments: memByUser.get(u.id) ?? [],
      caps: {
        canViewAll: isAdmin || (s?.can_view_all ?? 0) === 1,
        canViewDepartment: isAdmin || (s?.can_view_department ?? 1) === 1,
        canSend: isAdmin || (s?.can_send ?? 1) === 1,
        canAssign: isAdmin || (s?.can_assign ?? 0) === 1,
        canReassign: isAdmin || (s?.can_reassign ?? 0) === 1,
        canClose: isAdmin || (s?.can_close ?? 1) === 1,
        canSendTemplates: isAdmin || (s?.can_send_templates ?? 1) === 1,
        canCreateCampaigns: isAdmin || (s?.can_create_campaigns ?? 0) === 1,
        canViewAnalytics: isAdmin || (s?.can_view_analytics ?? 0) === 1,
        canManageContacts: isAdmin || (s?.can_manage_contacts ?? 0) === 1,
        canManageAutomation: isAdmin || (s?.can_manage_automation ?? 0) === 1,
      },
    }
  })
}

export type WhatsAppCaps = {
  isAgent: boolean
  canViewAll: boolean
  canViewDepartment: boolean
  canSend: boolean
  canAssign: boolean
  canReassign: boolean
  canClose: boolean
  canSendTemplates: boolean
  canCreateCampaigns: boolean
  canViewAnalytics: boolean
  canManageContacts: boolean
  canManageAutomation: boolean
  /** Admins can manage departments, agents and settings; agents cannot. */
  canManagePlatform: boolean
}

/**
 * Resolves the effective WhatsApp capabilities for a session. Admins get
 * everything; employees fall back to their agent-settings row (with the same
 * sensible defaults used across the platform).
 */
export async function resolveWhatsAppCaps(session: {
  userId: number
  role: "admin" | "employee"
}): Promise<WhatsAppCaps> {
  const isAdmin = session.role === "admin"
  const s = isAdmin ? null : await getAgentSettings(session.userId)
  const on = (v: number | undefined, dflt: number) => (isAdmin ? true : (v ?? dflt) === 1)
  return {
    isAgent: isAdmin || (s?.is_agent ?? 0) === 1,
    canViewAll: on(s?.can_view_all, 0),
    canViewDepartment: on(s?.can_view_department, 1),
    canSend: on(s?.can_send, 1),
    canAssign: on(s?.can_assign, 0),
    canReassign: on(s?.can_reassign, 0),
    canClose: on(s?.can_close, 1),
    canSendTemplates: on(s?.can_send_templates, 1),
    canCreateCampaigns: on(s?.can_create_campaigns, 0),
    canViewAnalytics: on(s?.can_view_analytics, 0),
    canManageContacts: on(s?.can_manage_contacts, 0),
    canManageAutomation: on(s?.can_manage_automation, 0),
    canManagePlatform: isAdmin,
  }
}

export async function upsertAgentSettings(
  userId: number,
  patch: Record<string, boolean>,
): Promise<void> {
  await ensureWhatsAppPlatformTables()
  const allowed = new Set<string>(["is_agent", "is_available", ...CAP_COLUMNS])
  const cols: string[] = []
  const vals: number[] = []
  for (const [k, v] of Object.entries(patch)) {
    if (!allowed.has(k)) continue
    cols.push(k)
    vals.push(v ? 1 : 0)
  }
  if (!cols.length) {
    // Ensure a row exists even if nothing changed.
    await query(
      "INSERT INTO `marketing_whatsapp_agent_settings` (user_id) VALUES (?) ON DUPLICATE KEY UPDATE user_id = user_id",
      [userId],
    )
    return
  }
  const insertCols = ["user_id", ...cols].map((c) => `\`${c}\``).join(", ")
  const placeholders = ["?", ...cols.map(() => "?")].join(", ")
  const updates = cols.map((c) => `\`${c}\` = VALUES(\`${c}\`)`).join(", ")
  await query(
    `INSERT INTO \`marketing_whatsapp_agent_settings\` (${insertCols})
     VALUES (${placeholders})
     ON DUPLICATE KEY UPDATE ${updates}`,
    [userId, ...vals],
  )
}

/* ------------------------------------------------------------------ */
/* Internal notes                                                      */
/* ------------------------------------------------------------------ */

export type InternalNote = {
  id: number
  conversationId: number
  userId: number | null
  userName: string | null
  note: string
  createdAt: string
}

export async function listInternalNotes(conversationId: number): Promise<InternalNote[]> {
  await ensureWhatsAppPlatformTables()
  const rows = await query<
    { id: number; conversation_id: number; user_id: number | null; user_name: string | null; note: string; created_at: string }[]
  >(
    `SELECT n.id, n.conversation_id, n.user_id, u.name AS user_name, n.note, n.created_at
       FROM \`marketing_whatsapp_internal_notes\` n
       LEFT JOIN \`users\` u ON u.id = n.user_id
      WHERE n.conversation_id = ?
      ORDER BY n.created_at ASC`,
    [conversationId],
  )
  return rows.map((r) => ({
    id: r.id,
    conversationId: r.conversation_id,
    userId: r.user_id,
    userName: r.user_name,
    note: r.note,
    createdAt: r.created_at,
  }))
}

export async function addInternalNote(input: {
  conversationId: number
  userId: number | null
  note: string
}): Promise<number> {
  await ensureWhatsAppPlatformTables()
  const result = await query<{ insertId: number }>(
    "INSERT INTO `marketing_whatsapp_internal_notes` (conversation_id, user_id, note) VALUES (?, ?, ?)",
    [input.conversationId, input.userId, input.note.trim()],
  )
  return result.insertId
}

/* ------------------------------------------------------------------ */
/* Department transfers                                                */
/* ------------------------------------------------------------------ */

export async function recordTransfer(input: {
  conversationId: number
  fromDepartmentId: number | null
  toDepartmentId: number | null
  fromAgentId: number | null
  toAgentId: number | null
  transferredBy: number | null
  reason?: string | null
}): Promise<void> {
  await ensureWhatsAppPlatformTables()
  await query(
    `INSERT INTO \`marketing_whatsapp_transfers\`
       (conversation_id, from_department_id, to_department_id, from_agent_id, to_agent_id, transferred_by, reason)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      input.conversationId,
      input.fromDepartmentId,
      input.toDepartmentId,
      input.fromAgentId,
      input.toAgentId,
      input.transferredBy,
      input.reason ?? null,
    ],
  )
}

export type TransferLogItem = {
  id: number
  fromDepartment: string | null
  toDepartment: string | null
  fromAgent: string | null
  toAgent: string | null
  by: string | null
  reason: string | null
  createdAt: string
}

export async function listTransfers(conversationId: number): Promise<TransferLogItem[]> {
  await ensureWhatsAppPlatformTables()
  const rows = await query<
    {
      id: number
      from_dept: string | null
      to_dept: string | null
      from_agent: string | null
      to_agent: string | null
      by_name: string | null
      reason: string | null
      created_at: string
    }[]
  >(
    `SELECT t.id, fd.name AS from_dept, td.name AS to_dept,
            fa.name AS from_agent, ta.name AS to_agent, bu.name AS by_name,
            t.reason, t.created_at
       FROM \`marketing_whatsapp_transfers\` t
       LEFT JOIN \`marketing_whatsapp_departments\` fd ON fd.id = t.from_department_id
       LEFT JOIN \`marketing_whatsapp_departments\` td ON td.id = t.to_department_id
       LEFT JOIN \`users\` fa ON fa.id = t.from_agent_id
       LEFT JOIN \`users\` ta ON ta.id = t.to_agent_id
       LEFT JOIN \`users\` bu ON bu.id = t.transferred_by
      WHERE t.conversation_id = ?
      ORDER BY t.created_at ASC`,
    [conversationId],
  )
  return rows.map((r) => ({
    id: r.id,
    fromDepartment: r.from_dept,
    toDepartment: r.to_dept,
    fromAgent: r.from_agent,
    toAgent: r.to_agent,
    by: r.by_name,
    reason: r.reason,
    createdAt: r.created_at,
  }))
}

/** Records downloaded media metadata (never the token or the blob). */
export async function recordMedia(input: {
  messageId?: number | null
  conversationId?: number | null
  mediaId: string
  mimeType?: string | null
  filename?: string | null
  fileSize?: number | null
  sha256?: string | null
}): Promise<void> {
  await ensureWhatsAppPlatformTables()
  await query(
    `INSERT INTO \`marketing_whatsapp_media\`
       (message_id, conversation_id, media_id, mime_type, filename, file_size, sha256)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE mime_type = VALUES(mime_type), filename = VALUES(filename),
       file_size = VALUES(file_size), sha256 = VALUES(sha256)`,
    [
      input.messageId ?? null,
      input.conversationId ?? null,
      input.mediaId,
      input.mimeType ?? null,
      input.filename ?? null,
      input.fileSize ?? null,
      input.sha256 ?? null,
    ],
  )
}
