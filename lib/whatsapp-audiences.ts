import "server-only"
import { query } from "@/lib/db"
import { ensureWhatsAppPlatformTables } from "@/lib/whatsapp-platform"
import type { AudienceCondition, AudienceFilter } from "@/lib/whatsapp-config"

/**
 * Audience segmentation engine.
 *
 * An audience is a saved filter over WhatsApp contacts. `resolveAudience`
 * compiles the JSON filter into a parameterized SQL WHERE clause so a campaign
 * can turn a segment into a concrete recipient list at launch time.
 *
 * Mirrors the `marketing_whatsapp_audiences` table from
 * 2026-09-22-add-whatsapp-platform.sql; ensureAudienceTables() self-heals the
 * schema at runtime (matching the rest of the WhatsApp libs).
 */

let ensured = false

export async function ensureAudienceTables() {
  if (ensured) return
  // Contacts + platform columns are created by the platform layer.
  await ensureWhatsAppPlatformTables()
  await query(
    `CREATE TABLE IF NOT EXISTS \`marketing_whatsapp_audiences\` (
      \`id\` INT UNSIGNED NOT NULL AUTO_INCREMENT,
      \`name\` VARCHAR(191) NOT NULL,
      \`description\` VARCHAR(500) DEFAULT NULL,
      \`filter_json\` TEXT DEFAULT NULL,
      \`created_by\` INT UNSIGNED DEFAULT NULL,
      \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      \`updated_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (\`id\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  )
  ensured = true
}

export type Audience = {
  id: number
  name: string
  description: string | null
  filter: AudienceFilter
  createdBy: number | null
  createdByName: string | null
  createdAt: string
  updatedAt: string
}

const EMPTY_FILTER: AudienceFilter = { match: "AND", conditions: [] }

function parseFilter(json: string | null): AudienceFilter {
  if (!json) return EMPTY_FILTER
  try {
    const parsed = JSON.parse(json) as AudienceFilter
    if (!parsed || !Array.isArray(parsed.conditions)) return EMPTY_FILTER
    return { match: parsed.match === "OR" ? "OR" : "AND", conditions: parsed.conditions }
  } catch {
    return EMPTY_FILTER
  }
}

export async function listAudiences(): Promise<Audience[]> {
  await ensureAudienceTables()
  const rows = await query<
    {
      id: number
      name: string
      description: string | null
      filter_json: string | null
      created_by: number | null
      created_by_name: string | null
      created_at: string
      updated_at: string
    }[]
  >(
    `SELECT a.*, u.name AS created_by_name
       FROM \`marketing_whatsapp_audiences\` a
       LEFT JOIN \`users\` u ON u.id = a.created_by
      ORDER BY a.created_at DESC`,
  )
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    filter: parseFilter(r.filter_json),
    createdBy: r.created_by,
    createdByName: r.created_by_name,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }))
}

export async function getAudience(id: number): Promise<Audience | null> {
  await ensureAudienceTables()
  const rows = await query<
    { id: number; name: string; description: string | null; filter_json: string | null; created_by: number | null; created_at: string; updated_at: string }[]
  >("SELECT * FROM `marketing_whatsapp_audiences` WHERE id = ? LIMIT 1", [id])
  const r = rows[0]
  if (!r) return null
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    filter: parseFilter(r.filter_json),
    createdBy: r.created_by,
    createdByName: null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

export async function createAudience(input: {
  name: string
  description?: string | null
  filter: AudienceFilter
  createdBy: number | null
}): Promise<number> {
  await ensureAudienceTables()
  const result = await query<{ insertId: number }>(
    "INSERT INTO `marketing_whatsapp_audiences` (name, description, filter_json, created_by) VALUES (?, ?, ?, ?)",
    [input.name.trim(), input.description?.trim() || null, JSON.stringify(input.filter ?? EMPTY_FILTER), input.createdBy],
  )
  return result.insertId
}

export async function updateAudience(
  id: number,
  patch: { name?: string; description?: string | null; filter?: AudienceFilter },
): Promise<void> {
  await ensureAudienceTables()
  const sets: string[] = []
  const params: (string | null)[] = []
  if (patch.name !== undefined) {
    sets.push("name = ?")
    params.push(patch.name.trim())
  }
  if (patch.description !== undefined) {
    sets.push("description = ?")
    params.push(patch.description?.trim() || null)
  }
  if (patch.filter !== undefined) {
    sets.push("filter_json = ?")
    params.push(JSON.stringify(patch.filter))
  }
  if (!sets.length) return
  await query(`UPDATE \`marketing_whatsapp_audiences\` SET ${sets.join(", ")} WHERE id = ?`, [...params, String(id)])
}

export async function deleteAudience(id: number): Promise<void> {
  await ensureAudienceTables()
  await query("DELETE FROM `marketing_whatsapp_audiences` WHERE id = ?", [id])
}

/* ------------------------------------------------------------------ */
/* Filter → SQL compiler                                               */
/* ------------------------------------------------------------------ */

export type AudienceContact = {
  contactId: number
  phone: string
  name: string | null
  optedIn: boolean
}

/**
 * Compiles one condition into a SQL fragment against the
 * `marketing_whatsapp_contacts c` alias. Unknown fields/operators return null
 * so they are skipped rather than breaking the whole query.
 */
function compileCondition(cond: AudienceCondition): { sql: string; params: (string | number)[] } | null {
  const value = (cond.value ?? "").trim()
  switch (cond.field) {
    case "tag":
      if (!value) return null
      return { sql: "c.tags LIKE ?", params: [`%${value}%`] }
    case "city":
      return { sql: cond.op === "contains" ? "c.city LIKE ?" : "c.city = ?", params: [cond.op === "contains" ? `%${value}%` : value] }
    case "state":
      return { sql: cond.op === "contains" ? "c.state LIKE ?" : "c.state = ?", params: [cond.op === "contains" ? `%${value}%` : value] }
    case "country":
      return { sql: cond.op === "contains" ? "c.country LIKE ?" : "c.country = ?", params: [cond.op === "contains" ? `%${value}%` : value] }
    case "opted_in": {
      const truthy = value === "" || value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes"
      return { sql: "c.opted_in = ?", params: [truthy ? 1 : 0] }
    }
    case "last_interaction_days": {
      const days = Number(value)
      if (!Number.isFinite(days) || days < 0) return null
      // gt → interacted MORE than N days ago (stale); otherwise within N days.
      if (cond.op === "gt") return { sql: "(c.last_interaction_at IS NULL OR c.last_interaction_at < (NOW() - INTERVAL ? DAY))", params: [days] }
      return { sql: "c.last_interaction_at >= (NOW() - INTERVAL ? DAY)", params: [days] }
    }
    case "has_conversation":
      return { sql: "EXISTS (SELECT 1 FROM `marketing_whatsapp_conversations` cc WHERE cc.contact_id = c.id)", params: [] }
    case "lead_status":
      if (!value) return null
      return {
        sql: "EXISTS (SELECT 1 FROM `sales_leads` l WHERE l.id = c.lead_id AND l.status = ?)",
        params: [value],
      }
    case "department": {
      const deptId = Number(value)
      if (!Number.isFinite(deptId)) return null
      return {
        sql: "EXISTS (SELECT 1 FROM `marketing_whatsapp_conversations` cc WHERE cc.contact_id = c.id AND cc.department_id = ?)",
        params: [deptId],
      }
    }
    case "assigned_agent": {
      const agentId = Number(value)
      if (!Number.isFinite(agentId)) return null
      return {
        sql: "EXISTS (SELECT 1 FROM `marketing_whatsapp_conversations` cc WHERE cc.contact_id = c.id AND cc.assigned_agent_id = ?)",
        params: [agentId],
      }
    }
    default:
      return null
  }
}

function buildWhere(filter: AudienceFilter): { where: string; params: (string | number)[] } {
  const clauses: string[] = []
  const params: (string | number)[] = []
  for (const cond of filter.conditions ?? []) {
    const compiled = compileCondition(cond)
    if (!compiled) continue
    clauses.push(`(${compiled.sql})`)
    params.push(...compiled.params)
  }
  if (!clauses.length) return { where: "", params: [] }
  const joiner = filter.match === "OR" ? " OR " : " AND "
  return { where: `WHERE ${clauses.join(joiner)}`, params }
}

/** Counts contacts matching a filter. Only opted-in contacts are broadcastable. */
export async function countAudience(filter: AudienceFilter, optedInOnly = true): Promise<number> {
  await ensureAudienceTables()
  const { where, params } = buildWhere(filter)
  const optClause = optedInOnly ? (where ? " AND c.opted_in = 1" : "WHERE c.opted_in = 1") : ""
  const rows = await query<{ c: number }[]>(
    `SELECT COUNT(*) AS c FROM \`marketing_whatsapp_contacts\` c ${where}${optClause}`,
    params,
  )
  return Number(rows[0]?.c ?? 0)
}

/** Resolves a filter into the concrete recipient list (opted-in only). */
export async function resolveAudience(filter: AudienceFilter, limit = 5000): Promise<AudienceContact[]> {
  await ensureAudienceTables()
  const { where, params } = buildWhere(filter)
  const optClause = where ? " AND c.opted_in = 1" : "WHERE c.opted_in = 1"
  const rows = await query<{ id: number; phone_number: string; profile_name: string | null; opted_in: number }[]>(
    `SELECT c.id, c.phone_number, c.profile_name, c.opted_in
       FROM \`marketing_whatsapp_contacts\` c ${where}${optClause}
       ORDER BY c.id ASC LIMIT ?`,
    [...params, limit],
  )
  return rows.map((r) => ({
    contactId: r.id,
    phone: r.phone_number,
    name: r.profile_name,
    optedIn: r.opted_in === 1,
  }))
}

/** A small preview: count + first few sample names/numbers for the builder UI. */
export async function previewAudience(filter: AudienceFilter): Promise<{ count: number; sample: AudienceContact[] }> {
  const count = await countAudience(filter)
  const sample = await resolveAudience(filter, 5)
  return { count, sample }
}
