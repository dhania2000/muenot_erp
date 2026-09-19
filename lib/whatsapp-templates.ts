import "server-only"
import { query } from "@/lib/db"
import {
  fetchWhatsAppTemplatesDetailed,
  getWhatsAppIntegration,
  type DetailedWhatsAppTemplate,
  type TemplateComponent,
  type WhatsAppIntegrationRow,
} from "@/lib/whatsapp"
import { currentTenantId, currentTenantIdOrNull, forEachActiveTenant } from "@/lib/tenant-scope"

/**
 * Local template catalog + lifecycle for the WhatsApp platform.
 *
 * The base `marketing_whatsapp_templates` table is defined in
 * database/migrations/2026-09-22-add-whatsapp-platform.sql. This module adds the
 * lifecycle columns (quality score, rejection reason, versioning, usage counts,
 * soft-delete) and a companion version-history table, self-healing the schema at
 * runtime the same way lib/whatsapp-platform.ts does — so a deployment that has
 * not imported the SQL yet still works.
 *
 * Persisting templates locally is what unblocks status sync, rejection reasons,
 * usage counts, version history and an APPROVED-only send rule that does not have
 * to hit the Graph API on every request.
 */

let templatesEnsured = false

export async function ensureWhatsAppTemplateTables() {
  if (templatesEnsured) return

  await query(
    `CREATE TABLE IF NOT EXISTS \`marketing_whatsapp_templates\` (
      \`id\` INT UNSIGNED NOT NULL AUTO_INCREMENT,
      \`tenant_id\` INT UNSIGNED NOT NULL,
      \`integration_id\` INT UNSIGNED NOT NULL,
      \`name\` VARCHAR(191) NOT NULL,
      \`language\` VARCHAR(16) NOT NULL,
      \`category\` VARCHAR(48) DEFAULT NULL,
      \`status\` VARCHAR(32) NOT NULL DEFAULT 'PENDING',
      \`header_type\` VARCHAR(32) DEFAULT NULL,
      \`header_text\` VARCHAR(1000) DEFAULT NULL,
      \`body_text\` TEXT DEFAULT NULL,
      \`footer_text\` VARCHAR(1000) DEFAULT NULL,
      \`buttons_json\` TEXT DEFAULT NULL,
      \`variable_count\` INT UNSIGNED NOT NULL DEFAULT 0,
      \`meta_id\` VARCHAR(64) DEFAULT NULL,
      \`synced_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (\`id\`),
      UNIQUE KEY \`uniq_wa_template_tenant_integration\` (\`tenant_id\`, \`integration_id\`, \`name\`, \`language\`),
      KEY \`idx_wa_template_status\` (\`status\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  )

  // Lifecycle columns (idempotent).
  await ensureColumn("marketing_whatsapp_templates", "quality_score", "ADD COLUMN `quality_score` VARCHAR(32) DEFAULT NULL")
  await ensureColumn("marketing_whatsapp_templates", "rejected_reason", "ADD COLUMN `rejected_reason` VARCHAR(500) DEFAULT NULL")
  await ensureColumn("marketing_whatsapp_templates", "previous_status", "ADD COLUMN `previous_status` VARCHAR(32) DEFAULT NULL")
  await ensureColumn("marketing_whatsapp_templates", "status_changed_at", "ADD COLUMN `status_changed_at` DATETIME DEFAULT NULL")
  await ensureColumn("marketing_whatsapp_templates", "version", "ADD COLUMN `version` INT UNSIGNED NOT NULL DEFAULT 1")
  await ensureColumn("marketing_whatsapp_templates", "usage_count", "ADD COLUMN `usage_count` INT UNSIGNED NOT NULL DEFAULT 0")
  await ensureColumn("marketing_whatsapp_templates", "last_used_at", "ADD COLUMN `last_used_at` DATETIME DEFAULT NULL")
  await ensureColumn("marketing_whatsapp_templates", "created_by", "ADD COLUMN `created_by` INT UNSIGNED DEFAULT NULL")
  await ensureColumn("marketing_whatsapp_templates", "is_deleted", "ADD COLUMN `is_deleted` TINYINT(1) NOT NULL DEFAULT 0")
  await ensureColumn("marketing_whatsapp_templates", "created_at", "ADD COLUMN `created_at` TIMESTAMP NULL DEFAULT NULL")

  await query(
    `CREATE TABLE IF NOT EXISTS \`marketing_whatsapp_template_versions\` (
      \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      \`tenant_id\` INT UNSIGNED NOT NULL,
      \`integration_id\` INT UNSIGNED NOT NULL,
      \`template_id\` INT UNSIGNED NOT NULL,
      \`version\` INT UNSIGNED NOT NULL DEFAULT 1,
      \`status\` VARCHAR(32) DEFAULT NULL,
      \`category\` VARCHAR(48) DEFAULT NULL,
      \`body_text\` TEXT DEFAULT NULL,
      \`rejected_reason\` VARCHAR(500) DEFAULT NULL,
      \`change_type\` VARCHAR(32) NOT NULL DEFAULT 'sync',
      \`detail\` VARCHAR(500) DEFAULT NULL,
      \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (\`id\`),
      KEY \`idx_wa_tplver_template\` (\`template_id\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  )

  await ensureColumn("marketing_whatsapp_templates", "tenant_id", "ADD COLUMN `tenant_id` INT UNSIGNED DEFAULT NULL")
  await ensureColumn("marketing_whatsapp_templates", "integration_id", "ADD COLUMN `integration_id` INT UNSIGNED DEFAULT NULL")
  await ensureColumn("marketing_whatsapp_template_versions", "tenant_id", "ADD COLUMN `tenant_id` INT UNSIGNED DEFAULT NULL")
  await ensureColumn("marketing_whatsapp_template_versions", "integration_id", "ADD COLUMN `integration_id` INT UNSIGNED DEFAULT NULL")

  templatesEnsured = true
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

/* ------------------------------------------------------------------ */
/* Component parsing                                                    */
/* ------------------------------------------------------------------ */

const PLACEHOLDER_RE = /\{\{\s*(\d+)\s*\}\}/g

function countVariables(text: string): number {
  const found = new Set<number>()
  for (const m of text.matchAll(PLACEHOLDER_RE)) found.add(Number(m[1]))
  return found.size
}

type ParsedComponents = {
  headerType: string | null
  headerText: string | null
  bodyText: string | null
  footerText: string | null
  buttonsJson: string | null
  variableCount: number
}

function parseComponents(components: TemplateComponent[]): ParsedComponents {
  let headerType: string | null = null
  let headerText: string | null = null
  let bodyText: string | null = null
  let footerText: string | null = null
  let buttonsJson: string | null = null

  for (const c of components) {
    const type = (c.type ?? "").toUpperCase()
    if (type === "HEADER") {
      headerType = (c.format ?? "TEXT").toUpperCase()
      headerText = c.text ?? null
    } else if (type === "BODY") {
      bodyText = c.text ?? null
    } else if (type === "FOOTER") {
      footerText = c.text ?? null
    } else if (type === "BUTTONS" && Array.isArray(c.buttons)) {
      buttonsJson = JSON.stringify(c.buttons)
    }
  }

  return {
    headerType,
    headerText,
    bodyText,
    footerText,
    buttonsJson,
    variableCount: countVariables(bodyText ?? ""),
  }
}

/* ------------------------------------------------------------------ */
/* Sync from Meta                                                       */
/* ------------------------------------------------------------------ */

export type TemplateSyncResult = {
  ok: boolean
  error?: string
  total: number
  created: number
  updated: number
  statusChanges: number
  removed: number
}

/**
 * Pulls the full template catalog from Meta and reconciles it into the local
 * table: inserts new templates, updates changed ones, records status changes and
 * body edits into the version history, and soft-deletes templates that no longer
 * exist on Meta. Idempotent — safe to run on every GET and from the cron.
 */
export async function syncTemplatesFromMeta(
  integration?: WhatsAppIntegrationRow | null,
): Promise<TemplateSyncResult> {
  if (!integration && currentTenantIdOrNull() == null) {
    const aggregate: TemplateSyncResult = { ok: true, total: 0, created: 0, updated: 0, statusChanges: 0, removed: 0 }
    await forEachActiveTenant(async () => {
      const result = await syncTemplatesFromMeta()
      aggregate.ok = aggregate.ok && result.ok
      aggregate.total += result.total
      aggregate.created += result.created
      aggregate.updated += result.updated
      aggregate.statusChanges += result.statusChanges
      aggregate.removed += result.removed
      if (!result.ok) aggregate.error = result.error
    })
    return aggregate
  }
  await ensureWhatsAppTemplateTables()
  if (integration && integration.tenant_id !== currentTenantIdOrNull()) {
    return { ok: false, error: "WhatsApp integration does not belong to the active tenant.", total: 0, created: 0, updated: 0, statusChanges: 0, removed: 0 }
  }
  const wa = integration ?? (await getWhatsAppIntegration())
  if (!wa) return { ok: false, error: "No WhatsApp account is connected.", total: 0, created: 0, updated: 0, statusChanges: 0, removed: 0 }

  const fetched = await fetchWhatsAppTemplatesDetailed(wa)
  if (!fetched.ok) {
    return { ok: false, error: fetched.error, total: 0, created: 0, updated: 0, statusChanges: 0, removed: 0 }
  }

  const existing = await query<
    {
      id: number
      name: string
      language: string
      status: string
      category: string | null
      body_text: string | null
      is_deleted: number
    }[]
  >("SELECT id, name, language, status, category, body_text, is_deleted FROM `marketing_whatsapp_templates` WHERE tenant_id = ? AND integration_id = ?", [currentTenantId(), wa.id])
  const byKey = new Map(existing.map((r) => [`${r.name}::${r.language}`, r]))

  let created = 0
  let updated = 0
  let statusChanges = 0
  const seen = new Set<string>()

  for (const t of fetched.templates) {
    const key = `${t.name}::${t.language}`
    seen.add(key)
    const parsed = parseComponents(t.components)
    const status = (t.status || "PENDING").toUpperCase()
    const prev = byKey.get(key)

    if (!prev) {
      const result = await query<{ insertId: number }>(
        `INSERT INTO \`marketing_whatsapp_templates\`
          (tenant_id, integration_id, name, language, category, status, header_type, header_text, body_text, footer_text,
           buttons_json, variable_count, meta_id, quality_score, rejected_reason, status_changed_at,
           created_at, synced_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW(), NOW())`,
        [
          currentTenantId(),
          wa.id,
          t.name,
          t.language,
          t.category,
          status,
          parsed.headerType,
          parsed.headerText,
          parsed.bodyText,
          parsed.footerText,
          parsed.buttonsJson,
          parsed.variableCount,
          t.metaId,
          t.qualityScore,
          t.rejectedReason,
        ],
      )
      created++
      await recordVersion(result.insertId, 1, status, t.category, parsed.bodyText, t.rejectedReason, "created", "Discovered on Meta", wa.id)
      continue
    }

    const statusChanged = (prev.status || "").toUpperCase() !== status
    const bodyChanged = (prev.body_text ?? "") !== (parsed.bodyText ?? "")
    if (statusChanged) statusChanges++

    // Bump version only when the body content actually changes.
    const versionBump = bodyChanged ? "version = version + 1," : ""

    await query(
      `UPDATE \`marketing_whatsapp_templates\`
         SET category = ?, status = ?, header_type = ?, header_text = ?, body_text = ?,
             footer_text = ?, buttons_json = ?, variable_count = ?, meta_id = ?,
             quality_score = ?, rejected_reason = ?, is_deleted = 0, ${versionBump}
             previous_status = ?, status_changed_at = ${statusChanged ? "NOW()" : "status_changed_at"},
             synced_at = NOW()
       WHERE id = ? AND tenant_id = ? AND integration_id = ?`,
      [
        t.category,
        status,
        parsed.headerType,
        parsed.headerText,
        parsed.bodyText,
        parsed.footerText,
        parsed.buttonsJson,
        parsed.variableCount,
        t.metaId,
        t.qualityScore,
        t.rejectedReason,
        prev.status,
        prev.id,
        currentTenantId(),
        wa.id,
      ],
    )

    if (statusChanged || bodyChanged || prev.is_deleted === 1) {
      updated++
      const changeType = statusChanged ? "status" : bodyChanged ? "edited" : "restored"
      const detail = statusChanged
        ? `${prev.status || "—"} → ${status}${status === "REJECTED" && t.rejectedReason ? ` (${t.rejectedReason})` : ""}`
        : bodyChanged
          ? "Body content changed on Meta"
          : "Template reappeared on Meta"
      const verRow = await query<{ version: number }[]>(
        "SELECT version FROM `marketing_whatsapp_templates` WHERE id = ? AND tenant_id = ? AND integration_id = ? LIMIT 1",
        [prev.id, currentTenantId(), wa.id],
      )
      await recordVersion(prev.id, verRow[0]?.version ?? 1, status, t.category, parsed.bodyText, t.rejectedReason, changeType, detail, wa.id)
    }
  }

  // Soft-delete templates that vanished from Meta (never hard-delete: campaigns
  // and messages may still reference the name for historical reporting).
  let removed = 0
  for (const r of existing) {
    const key = `${r.name}::${r.language}`
    if (seen.has(key) || r.is_deleted === 1) continue
    await query("UPDATE `marketing_whatsapp_templates` SET is_deleted = 1, synced_at = NOW() WHERE id = ? AND tenant_id = ? AND integration_id = ?", [r.id, currentTenantId(), wa.id])
    await recordVersion(r.id, 1, r.status, r.category, r.body_text, null, "removed", "No longer present on Meta", wa.id)
    removed++
  }

  return { ok: true, total: fetched.templates.length, created, updated, statusChanges, removed }
}

async function recordVersion(
  templateId: number,
  version: number,
  status: string | null,
  category: string | null,
  bodyText: string | null,
  rejectedReason: string | null,
  changeType: string,
  detail: string | null,
  integrationId: number,
) {
  try {
    await query(
      `INSERT INTO \`marketing_whatsapp_template_versions\`
        (tenant_id, integration_id, template_id, version, status, category, body_text, rejected_reason, change_type, detail)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [currentTenantId(), integrationId, templateId, version, status, category, bodyText, rejectedReason, changeType, detail],
    )
  } catch {
    // Non-fatal: history is best-effort.
  }
}

/* ------------------------------------------------------------------ */
/* Reads                                                                */
/* ------------------------------------------------------------------ */

export type LocalTemplate = {
  id: number
  name: string
  language: string
  category: string | null
  status: string
  headerType: string | null
  headerText: string | null
  bodyText: string | null
  footerText: string | null
  buttons: { type?: string; text?: string; url?: string; phone_number?: string }[]
  variableCount: number
  metaId: string | null
  qualityScore: string | null
  rejectedReason: string | null
  previousStatus: string | null
  statusChangedAt: string | null
  version: number
  usageCount: number
  lastUsedAt: string | null
  isDeleted: boolean
  syncedAt: string | null
  createdAt: string | null
}

type TemplateRow = {
  id: number
  name: string
  language: string
  category: string | null
  status: string
  header_type: string | null
  header_text: string | null
  body_text: string | null
  footer_text: string | null
  buttons_json: string | null
  variable_count: number
  meta_id: string | null
  quality_score: string | null
  rejected_reason: string | null
  previous_status: string | null
  status_changed_at: string | null
  version: number
  usage_count: number
  last_used_at: string | null
  is_deleted: number
  synced_at: string | null
  created_at: string | null
}

function mapRow(r: TemplateRow): LocalTemplate {
  let buttons: LocalTemplate["buttons"] = []
  if (r.buttons_json) {
    try {
      const parsed = JSON.parse(r.buttons_json)
      if (Array.isArray(parsed)) buttons = parsed
    } catch {
      buttons = []
    }
  }
  return {
    id: r.id,
    name: r.name,
    language: r.language,
    category: r.category,
    status: r.status,
    headerType: r.header_type,
    headerText: r.header_text,
    bodyText: r.body_text,
    footerText: r.footer_text,
    buttons,
    variableCount: Number(r.variable_count) || 0,
    metaId: r.meta_id,
    qualityScore: r.quality_score,
    rejectedReason: r.rejected_reason,
    previousStatus: r.previous_status,
    statusChangedAt: r.status_changed_at,
    version: Number(r.version) || 1,
    usageCount: Number(r.usage_count) || 0,
    lastUsedAt: r.last_used_at,
    isDeleted: r.is_deleted === 1,
    syncedAt: r.synced_at,
    createdAt: r.created_at,
  }
}

export async function listLocalTemplates(opts?: {
  includeDeleted?: boolean
  approvedOnly?: boolean
}): Promise<LocalTemplate[]> {
  await ensureWhatsAppTemplateTables()
  const where: string[] = []
  if (!opts?.includeDeleted) where.push("is_deleted = 0")
  if (opts?.approvedOnly) where.push("status = 'APPROVED'")
  where.push("tenant_id = ?")
  const rows = await query<TemplateRow[]>(
    `SELECT * FROM \`marketing_whatsapp_templates\`
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY (status = 'APPROVED') DESC, name ASC, language ASC`,
    [currentTenantId()],
  )
  return rows.map(mapRow)
}

export async function getLocalTemplate(id: number): Promise<LocalTemplate | null> {
  await ensureWhatsAppTemplateTables()
  const rows = await query<TemplateRow[]>("SELECT * FROM `marketing_whatsapp_templates` WHERE id = ? AND tenant_id = ? LIMIT 1", [id, currentTenantId()])
  return rows[0] ? mapRow(rows[0]) : null
}

/** Looks up a template by name (+ optional language) for send-time validation. */
export async function findLocalTemplate(name: string, language?: string, integrationId?: number | null): Promise<LocalTemplate | null> {
  await ensureWhatsAppTemplateTables()
  const params: (string | number)[] = [name, currentTenantId()]
  let sql = "SELECT * FROM `marketing_whatsapp_templates` WHERE name = ? AND tenant_id = ? AND is_deleted = 0"
  if (integrationId != null) {
    sql += " AND integration_id = ?"
    params.push(integrationId)
  }
  if (language) {
    sql += " AND language = ?"
    params.push(language)
  }
  sql += " ORDER BY (status = 'APPROVED') DESC LIMIT 1"
  const rows = await query<TemplateRow[]>(sql, params)
  return rows[0] ? mapRow(rows[0]) : null
}

export type TemplateVersion = {
  id: number
  version: number
  status: string | null
  category: string | null
  bodyText: string | null
  rejectedReason: string | null
  changeType: string
  detail: string | null
  createdAt: string
}

export async function listTemplateVersions(templateId: number): Promise<TemplateVersion[]> {
  await ensureWhatsAppTemplateTables()
  const rows = await query<
    {
      id: number
      version: number
      status: string | null
      category: string | null
      body_text: string | null
      rejected_reason: string | null
      change_type: string
      detail: string | null
      created_at: string
    }[]
  >(
    `SELECT v.* FROM \`marketing_whatsapp_template_versions\` v
       JOIN \`marketing_whatsapp_templates\` t ON t.id = v.template_id AND t.tenant_id = v.tenant_id AND t.integration_id = v.integration_id
      WHERE v.template_id = ? AND v.tenant_id = ? ORDER BY v.id DESC LIMIT 100`,
    [templateId, currentTenantId()],
  )
  return rows.map((r) => ({
    id: r.id,
    version: Number(r.version) || 1,
    status: r.status,
    category: r.category,
    bodyText: r.body_text,
    rejectedReason: r.rejected_reason,
    changeType: r.change_type,
    detail: r.detail,
    createdAt: r.created_at,
  }))
}

/* ------------------------------------------------------------------ */
/* Usage tracking                                                       */
/* ------------------------------------------------------------------ */

/**
 * Increments the usage counter for a template by name (+ optional language).
 * Called from the send and campaign paths. Best-effort and never throws so it
 * cannot break an actual send.
 */
export async function recordTemplateUsage(name: string, language?: string, count = 1, integrationId?: number | null): Promise<void> {
  try {
    await ensureWhatsAppTemplateTables()
    const params: (string | number)[] = [count, name, currentTenantId()]
    let sql =
      "UPDATE `marketing_whatsapp_templates` SET usage_count = usage_count + ?, last_used_at = NOW() WHERE name = ? AND tenant_id = ?"
    if (integrationId != null) {
      sql += " AND integration_id = ?"
      params.push(integrationId)
    }
    if (language) {
      sql += " AND language = ?"
      params.push(language)
    }
    await query(sql, params)
  } catch {
    // ignore — usage stats must never block a send
  }
}

/** Detects whether a template name+language already exists locally (dup guard). */
export async function templateExists(name: string, language: string): Promise<boolean> {
  await ensureWhatsAppTemplateTables()
  const rows = await query<{ c: number }[]>(
    "SELECT COUNT(*) AS c FROM `marketing_whatsapp_templates` WHERE name = ? AND language = ? AND tenant_id = ? AND is_deleted = 0",
    [name, language, currentTenantId()],
  )
  return (rows[0]?.c ?? 0) > 0
}
