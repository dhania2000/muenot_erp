import "server-only"
import { query } from "./db"
import {
  ABAC_ATTRIBUTE_CATALOG,
  type AbacPolicy,
  type AbacCombiningAlgorithm,
  type AttributeBag,
  isCombiningAlgorithm,
  sanitizePolicyInput,
} from "./abac-model"

/**
 * SPEC 9 — ABAC persistence (tenant-scoped) + attribute resolution.
 * ---------------------------------------------------------------------------
 * Policies live in one table per tenant with their conditions / module / action
 * scoping serialized as JSON, because a policy is always read and written as a
 * whole and its conditions are only ever interpreted by the pure engine
 * (lib/abac-model.ts). The tenant's chosen combining algorithm is a single
 * per-tenant setting.
 *
 * Everything is scoped by `tenant_id` (always derived from the verified
 * session, never client input), exactly like the RBAC role store.
 */

let schemaEnsured = false

export async function ensureAbacSchema() {
  if (schemaEnsured) return
  await query(
    `CREATE TABLE IF NOT EXISTS abac_policies (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT,
      tenant_id INT UNSIGNED NOT NULL,
      name VARCHAR(160) NOT NULL,
      description VARCHAR(400) DEFAULT NULL,
      effect ENUM('permit','deny') NOT NULL DEFAULT 'deny',
      priority INT NOT NULL DEFAULT 0,
      enabled TINYINT(1) NOT NULL DEFAULT 1,
      combine ENUM('all','any') NOT NULL DEFAULT 'all',
      modules_json TEXT NOT NULL,
      actions_json TEXT NOT NULL,
      conditions_json MEDIUMTEXT NOT NULL,
      created_by INT UNSIGNED DEFAULT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_abac_policies_tenant (tenant_id),
      KEY idx_abac_policies_enabled (tenant_id, enabled)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  )
  await query(
    `CREATE TABLE IF NOT EXISTS abac_settings (
      tenant_id INT UNSIGNED NOT NULL,
      algorithm VARCHAR(32) NOT NULL DEFAULT 'deny-overrides',
      default_decision ENUM('permit','deny') NOT NULL DEFAULT 'permit',
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (tenant_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  )
  schemaEnsured = true
}

type PolicyRow = {
  id: number
  name: string
  description: string | null
  effect: "permit" | "deny"
  priority: number
  enabled: number
  combine: "all" | "any"
  modules_json: string
  actions_json: string
  conditions_json: string
}

function parseJsonArray(raw: string, fallback: any[]): any[] {
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v) ? v : fallback
  } catch {
    return fallback
  }
}

function rowToPolicy(r: PolicyRow): AbacPolicy {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    effect: r.effect,
    priority: Number(r.priority) || 0,
    enabled: Boolean(r.enabled),
    combine: r.combine === "any" ? "any" : "all",
    modules: parseJsonArray(r.modules_json, ["*"]),
    actions: parseJsonArray(r.actions_json, ["*"]),
    conditions: parseJsonArray(r.conditions_json, []),
  }
}

export async function listPolicies(tenantId: number): Promise<AbacPolicy[]> {
  await ensureAbacSchema()
  const rows = await query<PolicyRow[]>(
    `SELECT id, name, description, effect, priority, enabled, combine,
            modules_json, actions_json, conditions_json
       FROM abac_policies WHERE tenant_id = ?
      ORDER BY priority DESC, name ASC`,
    [tenantId],
  )
  return rows.map(rowToPolicy)
}

/** Only the enabled policies — the set the enforcement engine evaluates. */
export async function listEnabledPolicies(tenantId: number): Promise<AbacPolicy[]> {
  await ensureAbacSchema()
  const rows = await query<PolicyRow[]>(
    `SELECT id, name, description, effect, priority, enabled, combine,
            modules_json, actions_json, conditions_json
       FROM abac_policies WHERE tenant_id = ? AND enabled = 1
      ORDER BY priority DESC, id ASC`,
    [tenantId],
  )
  return rows.map(rowToPolicy)
}

export async function getPolicy(tenantId: number, id: number): Promise<AbacPolicy | null> {
  await ensureAbacSchema()
  const rows = await query<PolicyRow[]>(
    `SELECT id, name, description, effect, priority, enabled, combine,
            modules_json, actions_json, conditions_json
       FROM abac_policies WHERE tenant_id = ? AND id = ? LIMIT 1`,
    [tenantId, id],
  )
  return rows[0] ? rowToPolicy(rows[0]) : null
}

export async function createPolicy(tenantId: number, input: any, createdBy: number): Promise<number | null> {
  await ensureAbacSchema()
  const clean = sanitizePolicyInput(input)
  if (!clean) return null
  const res = await query<{ insertId: number }>(
    `INSERT INTO abac_policies
       (tenant_id, name, description, effect, priority, enabled, combine, modules_json, actions_json, conditions_json, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      tenantId,
      clean.name,
      clean.description,
      clean.effect,
      clean.priority,
      clean.enabled ? 1 : 0,
      clean.combine,
      JSON.stringify(clean.modules),
      JSON.stringify(clean.actions),
      JSON.stringify(clean.conditions),
      createdBy,
    ],
  )
  return (res as any).insertId as number
}

export async function updatePolicy(tenantId: number, id: number, input: any): Promise<boolean> {
  await ensureAbacSchema()
  const clean = sanitizePolicyInput(input)
  if (!clean) return false
  const owned = await query<{ id: number }[]>(
    `SELECT id FROM abac_policies WHERE tenant_id = ? AND id = ? LIMIT 1`,
    [tenantId, id],
  )
  if (owned.length === 0) return false
  await query(
    `UPDATE abac_policies
        SET name = ?, description = ?, effect = ?, priority = ?, enabled = ?, combine = ?,
            modules_json = ?, actions_json = ?, conditions_json = ?
      WHERE tenant_id = ? AND id = ?`,
    [
      clean.name,
      clean.description,
      clean.effect,
      clean.priority,
      clean.enabled ? 1 : 0,
      clean.combine,
      JSON.stringify(clean.modules),
      JSON.stringify(clean.actions),
      JSON.stringify(clean.conditions),
      tenantId,
      id,
    ],
  )
  return true
}

export async function deletePolicy(tenantId: number, id: number): Promise<void> {
  await ensureAbacSchema()
  await query(`DELETE FROM abac_policies WHERE tenant_id = ? AND id = ?`, [tenantId, id])
}

export type AbacSettings = { algorithm: AbacCombiningAlgorithm; defaultDecision: "permit" | "deny" }

export async function getAbacSettings(tenantId: number): Promise<AbacSettings> {
  await ensureAbacSchema()
  const rows = await query<{ algorithm: string; default_decision: "permit" | "deny" }[]>(
    `SELECT algorithm, default_decision FROM abac_settings WHERE tenant_id = ? LIMIT 1`,
    [tenantId],
  )
  const r = rows[0]
  return {
    algorithm: isCombiningAlgorithm(r?.algorithm) ? (r!.algorithm as AbacCombiningAlgorithm) : "deny-overrides",
    defaultDecision: r?.default_decision === "deny" ? "deny" : "permit",
  }
}

export async function setAbacSettings(tenantId: number, settings: Partial<AbacSettings>): Promise<void> {
  await ensureAbacSchema()
  const current = await getAbacSettings(tenantId)
  const algorithm = settings.algorithm && isCombiningAlgorithm(settings.algorithm) ? settings.algorithm : current.algorithm
  const defaultDecision = settings.defaultDecision === "deny" || settings.defaultDecision === "permit" ? settings.defaultDecision : current.defaultDecision
  await query(
    `INSERT INTO abac_settings (tenant_id, algorithm, default_decision)
     VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE algorithm = VALUES(algorithm), default_decision = VALUES(default_decision)`,
    [tenantId, algorithm, defaultDecision],
  )
}

// ---------------------------------------------------------------------------
// Subject-attribute resolution.
// ---------------------------------------------------------------------------
// Resolves the ATTRIBUTES of the acting user (department, branch, level, …)
// from hr_employees, defensively: the ERP schema varies between tenants, so we
// only read columns that actually exist and never fail the request when they
// don't. Missing attributes simply stay undefined and ABAC conditions that
// depend on them evaluate to false (fail-safe, per the engine's contract).

const columnCache = new Map<string, Set<string>>()

async function tableColumns(table: string): Promise<Set<string>> {
  const cached = columnCache.get(table)
  if (cached) return cached
  const rows = await query<{ c: string }[]>(
    `SELECT COLUMN_NAME AS c FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
    [table],
  )
  const set = new Set(rows.map((r) => r.c))
  columnCache.set(table, set)
  return set
}

/**
 * Candidate hr_employees column names for each attribute, tried in order. The
 * first column that exists on the table wins. Keeps ABAC working across the
 * schema variations seen in the ERP without hard-coding one layout.
 */
const SUBJECT_COLUMN_CANDIDATES: Record<string, string[]> = {
  department: ["department", "department_name", "dept", "department_id"],
  branch: ["branch", "branch_name", "branch_id"],
  entity: ["entity", "legal_entity", "entity_id", "legal_entity_id"],
  location: ["location", "work_location", "office_location", "location_id"],
  employee_level: ["employee_level", "level", "grade", "seniority", "band"],
  data_classification: ["data_clearance", "clearance", "data_classification"],
  project: ["project", "project_name", "project_id"],
  cost_center: ["cost_center", "cost_centre", "cost_center_id"],
  geography: ["geography", "region", "country", "territory"],
}

/**
 * Best-effort subject attributes for a user. `manager_chain` is the set of
 * user-ids that report (directly or transitively) to this user, so policies can
 * grant a manager access to their subordinates' records via an `in` test on
 * `resource.owner_id`.
 */
export async function resolveSubjectAttributes(userId: number): Promise<AttributeBag> {
  const bag: AttributeBag = {}
  try {
    const empCols = await tableColumns("hr_employees").catch(() => new Set<string>())
    if (empCols.has("user_id")) {
      const selects: string[] = []
      const aliasFor: Record<string, string> = {}
      for (const [attr, candidates] of Object.entries(SUBJECT_COLUMN_CANDIDATES)) {
        const col = candidates.find((c) => empCols.has(c))
        if (col) {
          const alias = `attr_${attr}`
          selects.push(`\`${col}\` AS ${alias}`)
          aliasFor[attr] = alias
        }
      }
      // Always try to pull the employee id so we can compute the report chain.
      const idCol = empCols.has("employee_id") ? "employee_id" : empCols.has("id") ? "id" : null
      if (idCol) selects.push(`\`${idCol}\` AS attr_self_id`)

      if (selects.length > 0) {
        const rows = await query<Record<string, any>[]>(
          `SELECT ${selects.join(", ")} FROM hr_employees WHERE user_id = ? LIMIT 1`,
          [userId],
        )
        const row = rows[0]
        if (row) {
          for (const [attr, alias] of Object.entries(aliasFor)) {
            const v = row[alias]
            if (v !== null && v !== undefined && v !== "") bag[attr] = v
          }
        }
      }
    }
  } catch {
    // ignore — resolution is best-effort; unresolved attributes stay undefined.
  }

  // The acting user's own id is always available and useful for owner tests.
  bag.user_id = userId
  bag.manager_chain = await resolveReportChain(userId).catch(() => [])
  return bag
}

/**
 * The set of user-ids beneath `managerUserId` in the reporting tree. Reads
 * hr_employees(manager_id → user_id) breadth-first with a depth cap, guarding
 * against cycles. Returns [] when the columns don't exist.
 */
async function resolveReportChain(managerUserId: number, maxDepth = 6): Promise<number[]> {
  const cols = await tableColumns("hr_employees").catch(() => new Set<string>())
  if (!cols.has("user_id") || !cols.has("manager_id")) return []

  const seen = new Set<number>()
  let frontier: number[] = [managerUserId]
  const collected = new Set<number>()

  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
    const placeholders = frontier.map(() => "?").join(",")
    const rows = await query<{ user_id: number }[]>(
      `SELECT DISTINCT e.user_id
         FROM hr_employees e
         JOIN hr_employees m ON e.manager_id = m.employee_id
        WHERE m.user_id IN (${placeholders}) AND e.user_id IS NOT NULL`,
      frontier,
    )
    const next: number[] = []
    for (const r of rows) {
      const uid = Number(r.user_id)
      if (!Number.isFinite(uid) || seen.has(uid) || uid === managerUserId) continue
      seen.add(uid)
      collected.add(uid)
      next.push(uid)
    }
    frontier = next
  }
  return [...collected]
}

/** The attribute catalog, re-exported for the API/UI without a server import. */
export { ABAC_ATTRIBUTE_CATALOG }
