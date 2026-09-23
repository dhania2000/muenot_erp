import "server-only"
/**
 * Organization hierarchy service.
 * ---------------------------------------------------------------------------
 * Models an enterprise org structure inside a single tenant as one
 * self-referential tree of typed nodes (`org_units`) plus a user↔unit
 * assignment layer (`org_unit_assignments`). This complements — it does NOT
 * replace — the existing HR `hr_departments`/`hr_designations` trees and the
 * finance cost-centre free-text field: those keep working, and org units can
 * be referenced from HR employees and finance journals for cross-module
 * reporting (see `org_unit_id` columns added by ensureOrgSchema()).
 *
 * Isolation: `org_units`, `org_unit_assignments` and `org_unit_change_log` are
 * registered as tenant-owned (lib/tenant-tables.ts), so every read/write goes
 * through the tenant-scoped helpers and is protected by the fail-closed guard.
 *
 * Subtree queries use a materialized `path` ("/1/4/9/") so a node's descendants
 * are a single indexed LIKE, and re-parenting can reject cycles without a
 * recursive CTE.
 */
import { query } from "@/lib/db"
import {
  currentTenantId,
  tenantSelect,
  tenantInsert,
  tenantUpdate,
  tenantDelete,
  requireOwnedRow,
} from "@/lib/tenant-scope"
import { nextRecordId } from "@/lib/record-ids"

// ---------------------------------------------------------------------------
// Unit types — the enterprise levels from, ordered broad → narrow.
// The order drives the default "suggested child type" and the display sort.
// ---------------------------------------------------------------------------
export const ORG_UNIT_TYPES = [
  "organization",
  "legal_entity",
  "group",
  "business_unit",
  "division",
  "department",
  "team",
  "branch",
  "location",
  "cost_center",
  "profit_center",
] as const

export type OrgUnitType = (typeof ORG_UNIT_TYPES)[number]

export const ORG_UNIT_TYPE_LABELS: Record<OrgUnitType, string> = {
  organization: "Organization",
  legal_entity: "Legal Entity",
  group: "Group",
  business_unit: "Business Unit",
  division: "Division",
  department: "Department",
  team: "Team",
  branch: "Branch",
  location: "Location",
  cost_center: "Cost Center",
  profit_center: "Profit Center",
}

const TYPE_SET = new Set<string>(ORG_UNIT_TYPES)
export function isOrgUnitType(v: unknown): v is OrgUnitType {
  return typeof v === "string" && TYPE_SET.has(v)
}

export type OrgUnit = {
  id: number
  tenant_id: number
  unit_code: string
  name: string
  unit_type: OrgUnitType
  parent_id: number | null
  path: string
  depth: number
  head_user_id: number | null
  external_code: string | null
  description: string | null
  status: "active" | "inactive"
  sort_order: number
  created_by: number | null
  created_at: string
  updated_at: string
  archived_at: string | null
}

export type OrgUnitNode = OrgUnit & {
  head_name: string | null
  member_count: number
  children: OrgUnitNode[]
}

export type Actor = { userId: number | null; name: string | null }

// ---------------------------------------------------------------------------
// Schema self-heal (mirrors database/migrations/2026-11-12-org-hierarchy.sql).
// ---------------------------------------------------------------------------
let ensured: Promise<void> | null = null

async function tableExists(table: string): Promise<boolean> {
  const rows = await query<any[]>(
    `SELECT 1 FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ? LIMIT 1`,
    [table],
  )
  return rows.length > 0
}
async function columnExists(table: string, column: string): Promise<boolean> {
  const rows = await query<any[]>(
    `SELECT 1 FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ? LIMIT 1`,
    [table, column],
  )
  return rows.length > 0
}

async function runEnsure(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS org_units (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT,
      tenant_id INT UNSIGNED DEFAULT NULL,
      unit_code VARCHAR(40) NOT NULL,
      name VARCHAR(180) NOT NULL,
      unit_type ENUM(
        'organization','legal_entity','group','business_unit','division',
        'department','team','branch','location','cost_center','profit_center'
      ) NOT NULL,
      parent_id INT UNSIGNED DEFAULT NULL,
      path VARCHAR(600) NOT NULL DEFAULT '',
      depth INT UNSIGNED NOT NULL DEFAULT 0,
      head_user_id INT UNSIGNED DEFAULT NULL,
      external_code VARCHAR(80) DEFAULT NULL,
      description TEXT DEFAULT NULL,
      status ENUM('active','inactive') NOT NULL DEFAULT 'active',
      sort_order INT NOT NULL DEFAULT 0,
      created_by INT UNSIGNED DEFAULT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      archived_at TIMESTAMP NULL DEFAULT NULL,
      PRIMARY KEY (id),
      UNIQUE KEY uq_org_units_tenant_code (tenant_id, unit_code),
      KEY idx_org_units_tenant (tenant_id),
      KEY idx_org_units_parent (parent_id),
      KEY idx_org_units_type (unit_type),
      KEY idx_org_units_path (path)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)

  await query(`
    CREATE TABLE IF NOT EXISTS org_unit_assignments (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT,
      tenant_id INT UNSIGNED DEFAULT NULL,
      org_unit_id INT UNSIGNED NOT NULL,
      user_id INT UNSIGNED NOT NULL,
      assignment_title VARCHAR(150) DEFAULT NULL,
      is_primary TINYINT(1) NOT NULL DEFAULT 0,
      created_by INT UNSIGNED DEFAULT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_org_assignment (tenant_id, org_unit_id, user_id),
      KEY idx_org_assignment_tenant (tenant_id),
      KEY idx_org_assignment_unit (org_unit_id),
      KEY idx_org_assignment_user (user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)

  await query(`
    CREATE TABLE IF NOT EXISTS org_unit_change_log (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT,
      tenant_id INT UNSIGNED DEFAULT NULL,
      org_unit_id INT UNSIGNED DEFAULT NULL,
      action VARCHAR(40) NOT NULL,
      actor_user_id INT UNSIGNED DEFAULT NULL,
      actor_name VARCHAR(180) DEFAULT NULL,
      detail VARCHAR(500) DEFAULT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_org_change_tenant (tenant_id),
      KEY idx_org_change_unit (org_unit_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)

  // Cross-module integration: reference an org unit from HR employees and the
  // finance journal so hierarchy can slice HR / Finance / reporting. Additive
  // and nullable — existing rows and code paths are unaffected.
  if ((await tableExists("hr_employees")) && !(await columnExists("hr_employees", "org_unit_id"))) {
    await query(`ALTER TABLE hr_employees ADD COLUMN org_unit_id INT UNSIGNED DEFAULT NULL`).catch(() => {})
    await query(`ALTER TABLE hr_employees ADD KEY idx_hr_employees_org_unit (org_unit_id)`).catch(() => {})
  }
  if ((await tableExists("journal_entries")) && !(await columnExists("journal_entries", "org_unit_id"))) {
    await query(`ALTER TABLE journal_entries ADD COLUMN org_unit_id INT UNSIGNED DEFAULT NULL`).catch(() => {})
    await query(`ALTER TABLE journal_entries ADD KEY idx_journal_entries_org_unit (org_unit_id)`).catch(() => {})
  }
}

export async function ensureOrgSchema(): Promise<void> {
  if (!ensured) {
    ensured = runEnsure().catch((err) => {
      ensured = null
      throw err
    })
  }
  return ensured
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** Flat list of all units for the current tenant, with head name + member count. */
export async function listOrgUnits(): Promise<Array<OrgUnit & { head_name: string | null; member_count: number }>> {
  await ensureOrgSchema()
  const tenantId = currentTenantId()
  // head_name / member_count are derived via correlated lookups scoped to the
  // same tenant so the guard is satisfied on every referenced table.
  const rows = await query<any[]>(
    `SELECT u.*,
            (SELECT name FROM users hu WHERE hu.id = u.head_user_id AND hu.tenant_id = u.tenant_id LIMIT 1) AS head_name,
            (SELECT COUNT(*) FROM org_unit_assignments a WHERE a.org_unit_id = u.id AND a.tenant_id = u.tenant_id) AS member_count
       FROM org_units u
      WHERE u.tenant_id = ?
      ORDER BY u.depth ASC, u.sort_order ASC, u.name ASC`,
    [tenantId],
  )
  return rows as any
}

/** The org units as a nested tree (roots first). */
export async function getOrgTree(): Promise<OrgUnitNode[]> {
  const flat = await listOrgUnits()
  const byId = new Map<number, OrgUnitNode>()
  for (const u of flat) byId.set(u.id, { ...(u as any), children: [] })
  const roots: OrgUnitNode[] = []
  for (const node of byId.values()) {
    if (node.parent_id && byId.has(node.parent_id)) {
      byId.get(node.parent_id)!.children.push(node)
    } else {
      roots.push(node)
    }
  }
  return roots
}

export async function getOrgUnit(id: number): Promise<OrgUnit | null> {
  await ensureOrgSchema()
  const rows = await tenantSelect<any[]>("org_units", { where: "id = ?", params: [id], tail: "LIMIT 1" })
  return (rows[0] as OrgUnit) ?? null
}

export type AssignmentRow = {
  id: number
  org_unit_id: number
  user_id: number
  assignment_title: string | null
  is_primary: number
  user_name: string | null
  user_email: string | null
}

export async function listUnitAssignments(orgUnitId: number): Promise<AssignmentRow[]> {
  await ensureOrgSchema()
  await requireOwnedRow("org_units", orgUnitId) // IDOR guard
  const tenantId = currentTenantId()
  const rows = await query<any[]>(
    `SELECT a.id, a.org_unit_id, a.user_id, a.assignment_title, a.is_primary,
            u.name AS user_name, u.email AS user_email
       FROM org_unit_assignments a
       JOIN users u ON u.id = a.user_id AND u.tenant_id = a.tenant_id
      WHERE a.tenant_id = ? AND a.org_unit_id = ?
      ORDER BY a.is_primary DESC, u.name ASC`,
    [tenantId, orgUnitId],
  )
  return rows as AssignmentRow[]
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

async function logChange(orgUnitId: number | null, action: string, actor: Actor, detail: string): Promise<void> {
  try {
    await tenantInsert("org_unit_change_log", {
      org_unit_id: orgUnitId,
      action,
      actor_user_id: actor.userId,
      actor_name: actor.name,
      detail: detail.slice(0, 500),
    })
  } catch {
    // Audit is best-effort; never block the primary operation.
  }
}

export type CreateOrgUnitInput = {
  name: string
  unit_type: OrgUnitType
  parent_id?: number | null
  head_user_id?: number | null
  external_code?: string | null
  description?: string | null
  status?: "active" | "inactive"
  sort_order?: number
}

export async function createOrgUnit(input: CreateOrgUnitInput, actor: Actor): Promise<OrgUnit> {
  await ensureOrgSchema()
  const name = String(input.name || "").trim()
  if (!name) throw new OrgValidationError("Name is required")
  if (!isOrgUnitType(input.unit_type)) throw new OrgValidationError("Invalid unit type")

  let parent: OrgUnit | null = null
  if (input.parent_id) {
    parent = await getOrgUnit(Number(input.parent_id))
    if (!parent) throw new OrgValidationError("Parent unit not found")
  }

  const unitCode = await nextRecordId("ORG", { allowCustom: true })
  const depth = parent ? parent.depth + 1 : 0

  const { insertId } = await tenantInsert("org_units", {
    unit_code: unitCode,
    name,
    unit_type: input.unit_type,
    parent_id: parent?.id ?? null,
    path: "", // set below once we know insertId
    depth,
    head_user_id: input.head_user_id ?? null,
    external_code: input.external_code?.trim() || null,
    description: input.description?.trim() || null,
    status: input.status === "inactive" ? "inactive" : "active",
    sort_order: Number.isFinite(input.sort_order) ? Number(input.sort_order) : 0,
    created_by: actor.userId,
  })

  const path = `${parent ? parent.path : "/"}${insertId}/`
  await tenantUpdate("org_units", { path }, "id = ?", [insertId])

  const created = (await getOrgUnit(insertId))!
  await logChange(insertId, "create", actor, `Created ${ORG_UNIT_TYPE_LABELS[input.unit_type]} "${name}" (${unitCode})`)
  return created
}

export type UpdateOrgUnitInput = Partial<{
  name: string
  unit_type: OrgUnitType
  parent_id: number | null
  head_user_id: number | null
  external_code: string | null
  description: string | null
  status: "active" | "inactive"
  sort_order: number
}>

export async function updateOrgUnit(id: number, input: UpdateOrgUnitInput, actor: Actor): Promise<OrgUnit> {
  await ensureOrgSchema()
  const current = await getOrgUnit(id)
  if (!current) throw new OrgNotFoundError()

  const set: Record<string, any> = {}
  if (input.name !== undefined) {
    const name = String(input.name).trim()
    if (!name) throw new OrgValidationError("Name is required")
    set.name = name
  }
  if (input.unit_type !== undefined) {
    if (!isOrgUnitType(input.unit_type)) throw new OrgValidationError("Invalid unit type")
    set.unit_type = input.unit_type
  }
  if (input.head_user_id !== undefined) set.head_user_id = input.head_user_id ?? null
  if (input.external_code !== undefined) set.external_code = input.external_code?.trim() || null
  if (input.description !== undefined) set.description = input.description?.trim() || null
  if (input.status !== undefined) set.status = input.status === "inactive" ? "inactive" : "active"
  if (input.sort_order !== undefined) set.sort_order = Number(input.sort_order) || 0

  // Re-parenting requires cycle checks and a subtree path rewrite.
  let reparented = false
  if (input.parent_id !== undefined) {
    const newParentId = input.parent_id ? Number(input.parent_id) : null
    if (newParentId !== current.parent_id) {
      await applyReparent(current, newParentId)
      reparented = true
    }
  }

  if (Object.keys(set).length > 0) {
    await tenantUpdate("org_units", set, "id = ?", [id])
  }

  const updated = (await getOrgUnit(id))!
  const changed = [...Object.keys(set), reparented ? "parent" : ""].filter(Boolean).join(", ")
  await logChange(id, "update", actor, `Updated "${updated.name}"${changed ? ` — ${changed}` : ""}`)
  return updated
}

/** Move a node (and its subtree) under a new parent, rejecting cycles. */
async function applyReparent(node: OrgUnit, newParentId: number | null): Promise<void> {
  let newParent: OrgUnit | null = null
  if (newParentId) {
    if (newParentId === node.id) throw new OrgValidationError("A unit cannot be its own parent")
    newParent = await getOrgUnit(newParentId)
    if (!newParent) throw new OrgValidationError("Parent unit not found")
    // Descendant check: the new parent must not sit inside this node's subtree.
    if (newParent.path.includes(`/${node.id}/`)) {
      throw new OrgValidationError("Cannot move a unit under one of its own descendants")
    }
  }

  const oldPathPrefix = node.path // e.g. "/3/7/"
  const newDepth = newParent ? newParent.depth + 1 : 0
  const newPathPrefix = `${newParent ? newParent.path : "/"}${node.id}/`
  const depthDelta = newDepth - node.depth

  // Update the node itself.
  await tenantUpdate(
    "org_units",
    { parent_id: newParent?.id ?? null, path: newPathPrefix, depth: newDepth },
    "id = ?",
    [node.id],
  )

  // Rewrite every descendant's path prefix and depth in one scoped statement.
  const tenantId = currentTenantId()
  await query(
    `UPDATE org_units
        SET path = CONCAT(?, SUBSTRING(path, ?)),
            depth = depth + ?
      WHERE tenant_id = ? AND path LIKE ? AND id <> ?`,
    [newPathPrefix, oldPathPrefix.length + 1, depthDelta, tenantId, `${oldPathPrefix}%`, node.id],
  )
}

export type DeleteMode = "block" | "reparent" | "cascade"

export async function deleteOrgUnit(id: number, mode: DeleteMode, actor: Actor): Promise<void> {
  await ensureOrgSchema()
  const node = await getOrgUnit(id)
  if (!node) throw new OrgNotFoundError()
  const tenantId = currentTenantId()

  const children = await query<any[]>(
    `SELECT id FROM org_units WHERE tenant_id = ? AND parent_id = ?`,
    [tenantId, id],
  )

  if (children.length > 0) {
    if (mode === "block") {
      throw new OrgValidationError("This unit has child units. Move or remove them first, or choose a delete mode.")
    }
    if (mode === "reparent") {
      // Re-home direct children under this node's parent, preserving the tree.
      for (const child of children) {
        const childNode = await getOrgUnit(child.id)
        if (childNode) await applyReparent(childNode, node.parent_id)
      }
    }
    if (mode === "cascade") {
      // Delete the whole subtree (assignments first for referential cleanliness).
      const subtree = await query<any[]>(
        `SELECT id FROM org_units WHERE tenant_id = ? AND path LIKE ? AND id <> ?`,
        [tenantId, `${node.path}%`, id],
      )
      for (const s of subtree) {
        await tenantDelete("org_unit_assignments", "org_unit_id = ?", [s.id])
      }
      await query(`DELETE FROM org_units WHERE tenant_id = ? AND path LIKE ? AND id <> ?`, [
        tenantId,
        `${node.path}%`,
        id,
      ])
    }
  }

  await tenantDelete("org_unit_assignments", "org_unit_id = ?", [id])
  await tenantDelete("org_units", "id = ?", [id])
  await logChange(null, "delete", actor, `Deleted "${node.name}" (${node.unit_code})${children.length ? ` [${mode}]` : ""}`)
}

// ---------------------------------------------------------------------------
// Assignments (users ↔ org units)
// ---------------------------------------------------------------------------

export async function assignUser(
  orgUnitId: number,
  userId: number,
  opts: { title?: string | null; isPrimary?: boolean },
  actor: Actor,
): Promise<void> {
  await ensureOrgSchema()
  const unit = await getOrgUnit(orgUnitId)
  if (!unit) throw new OrgNotFoundError()
  // Confirm the user belongs to this tenant (IDOR / cross-tenant guard).
  const tenantId = currentTenantId()
  const users = await query<any[]>(`SELECT id, name FROM users WHERE id = ? AND tenant_id = ? LIMIT 1`, [
    userId,
    tenantId,
  ])
  if (users.length === 0) throw new OrgValidationError("User not found in this organization")

  if (opts.isPrimary) {
    // A user has at most one primary unit — demote any existing primary.
    await query(`UPDATE org_unit_assignments SET is_primary = 0 WHERE tenant_id = ? AND user_id = ?`, [
      tenantId,
      userId,
    ])
  }

  await query(
    `INSERT INTO org_unit_assignments (tenant_id, org_unit_id, user_id, assignment_title, is_primary, created_by)
     VALUES (?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE assignment_title = VALUES(assignment_title), is_primary = VALUES(is_primary)`,
    [tenantId, orgUnitId, userId, opts.title?.trim() || null, opts.isPrimary ? 1 : 0, actor.userId],
  )
  await logChange(orgUnitId, "assign", actor, `Assigned ${users[0].name || `user #${userId}`} to "${unit.name}"`)
}

export async function unassignUser(orgUnitId: number, userId: number, actor: Actor): Promise<void> {
  await ensureOrgSchema()
  const unit = await getOrgUnit(orgUnitId)
  if (!unit) throw new OrgNotFoundError()
  await tenantDelete("org_unit_assignments", "org_unit_id = ? AND user_id = ?", [orgUnitId, userId])
  await logChange(orgUnitId, "unassign", actor, `Removed user #${userId} from "${unit.name}"`)
}

/** All org-unit memberships for one user (used by HR / profile integration). */
export async function listUserUnits(userId: number): Promise<Array<OrgUnit & { assignment_title: string | null; is_primary: number }>> {
  await ensureOrgSchema()
  const tenantId = currentTenantId()
  const rows = await query<any[]>(
    `SELECT u.*, a.assignment_title, a.is_primary
       FROM org_unit_assignments a
       JOIN org_units u ON u.id = a.org_unit_id AND u.tenant_id = a.tenant_id
      WHERE a.tenant_id = ? AND a.user_id = ?
      ORDER BY a.is_primary DESC, u.depth ASC`,
    [tenantId, userId],
  )
  return rows as any
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------
export class OrgValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "OrgValidationError"
  }
}
export class OrgNotFoundError extends Error {
  constructor(message = "Organization unit not found") {
    super(message)
    this.name = "OrgNotFoundError"
  }
}
