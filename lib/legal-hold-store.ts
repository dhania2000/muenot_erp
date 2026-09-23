import "server-only"
/**
 * SPEC 72 — Legal Hold (server store + enforcement).
 * ---------------------------------------------------------------------------
 * Replaces the frontend-only localStorage placeholder (lib/governance-store.ts)
 * for legal holds with a real, tenant-scoped, audited, DB-backed model that
 * PROTECTS records and files from automated destruction while a matter is open.
 *
 * A hold owns one or more ITEMS, each declaring WHAT it covers (see
 * lib/legal-hold-model.ts for the scope taxonomy). The enforcement helpers here
 * are consulted by every automated deletion path:
 *
 *   • lib/retention-engine.ts (SPEC 71 record retention) — a module- or
 *     record-type-scoped hold skips the whole policy; record/criteria-scoped
 *     holds are added to the sweep's exclusion WHERE so held rows survive.
 *   • lib/storage/retention.ts (SPEC 36 storage retention) — a file- or
 *     module-scoped hold makes the sweep skip the covered file.
 *
 * The hold ALWAYS wins over any retention policy — it can never be overridden
 * by un-pausing a policy or by a shorter retention window.
 *
 * Everything is tenant-scoped: both aux tables key on `tenant_id`, so a hold
 * can never protect (or leak) another tenant's data. Self-heals its schema at
 * runtime (same pattern as lib/retention-engine.ts) so existing databases
 * converge without a manual migration step.
 */
import { query } from "@/lib/db"
import { recordAuditLog } from "@/lib/audit-log-store"
import {
  describeHoldItem,
  itemHoldsFile,
  itemTargetsPolicy,
  isPolicyFullyHeld,
  normalizeHoldInput,
  normalizeHoldItemInput,
  toLegalHoldStatus,
  FAMILY_SCOPES,
  type FileEvaluable,
  type LegalHoldItemMatch,
  type LegalHoldScope,
  type LegalHoldStatus,
  type PolicyTarget,
} from "@/lib/legal-hold-model"

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type Actor = { userId: number; name?: string | null; email?: string | null; role?: string | null }

export type LegalHoldItem = {
  id: number
  holdId: number
  scope: LegalHoldScope
  module: string | null
  catalogKey: string | null
  recordType: string | null
  recordRef: string | null
  matchField: string | null
  matchValue: string | null
  fileId: number | null
  note: string | null
  label: string
  createdByName: string | null
  createdAt: string
}

export type LegalHold = {
  id: number
  tenantId: number | null
  name: string
  reason: string | null
  status: LegalHoldStatus
  createdByName: string | null
  createdAt: string
  updatedAt: string
  releasedByName: string | null
  releasedReason: string | null
  releasedAt: string | null
  itemCount: number
  items?: LegalHoldItem[]
}

// ---------------------------------------------------------------------------
// Schema (self-healing)
// ---------------------------------------------------------------------------

let ensured: Promise<void> | null = null

async function runEnsure(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS \`legal_holds\` (
      \`id\` INT UNSIGNED NOT NULL AUTO_INCREMENT,
      \`tenant_id\` INT UNSIGNED DEFAULT NULL,
      \`name\` VARCHAR(200) NOT NULL,
      \`reason\` VARCHAR(1000) DEFAULT NULL,
      \`status\` VARCHAR(16) NOT NULL DEFAULT 'active',
      \`created_by\` INT UNSIGNED DEFAULT NULL,
      \`released_by\` INT UNSIGNED DEFAULT NULL,
      \`released_reason\` VARCHAR(1000) DEFAULT NULL,
      \`released_at\` DATETIME DEFAULT NULL,
      \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      \`updated_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (\`id\`),
      KEY \`idx_legal_hold_tenant\` (\`tenant_id\`),
      KEY \`idx_legal_hold_status\` (\`tenant_id\`, \`status\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)

  await query(`
    CREATE TABLE IF NOT EXISTS \`legal_hold_items\` (
      \`id\` INT UNSIGNED NOT NULL AUTO_INCREMENT,
      \`tenant_id\` INT UNSIGNED DEFAULT NULL,
      \`hold_id\` INT UNSIGNED NOT NULL,
      \`scope\` VARCHAR(16) NOT NULL DEFAULT 'record',
      \`module\` VARCHAR(96) DEFAULT NULL,
      \`catalog_key\` VARCHAR(120) DEFAULT NULL,
      \`record_type\` VARCHAR(160) DEFAULT NULL,
      \`record_ref\` VARCHAR(190) DEFAULT NULL,
      \`match_field\` VARCHAR(96) DEFAULT NULL,
      \`match_value\` VARCHAR(190) DEFAULT NULL,
      \`file_id\` BIGINT UNSIGNED DEFAULT NULL,
      \`note\` VARCHAR(500) DEFAULT NULL,
      \`created_by\` INT UNSIGNED DEFAULT NULL,
      \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (\`id\`),
      KEY \`idx_legal_hold_items_hold\` (\`hold_id\`),
      KEY \`idx_legal_hold_items_scope\` (\`tenant_id\`, \`scope\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)
}

export function ensureLegalHoldSchema(): Promise<void> {
  if (!ensured) {
    ensured = runEnsure().catch((err) => {
      ensured = null
      throw err
    })
  }
  return ensured
}

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

type HoldRow = {
  id: number
  tenant_id: number | null
  name: string
  reason: string | null
  status: string
  created_by_name: string | null
  created_at: string
  updated_at: string
  released_by_name: string | null
  released_reason: string | null
  released_at: string | null
  item_count: number
}

function toHold(row: HoldRow): LegalHold {
  return {
    id: Number(row.id),
    tenantId: row.tenant_id,
    name: row.name,
    reason: row.reason,
    status: toLegalHoldStatus(row.status),
    createdByName: row.created_by_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    releasedByName: row.released_by_name,
    releasedReason: row.released_reason,
    releasedAt: row.released_at,
    itemCount: Number(row.item_count ?? 0),
  }
}

type ItemRow = {
  id: number
  hold_id: number
  scope: string
  module: string | null
  catalog_key: string | null
  record_type: string | null
  record_ref: string | null
  match_field: string | null
  match_value: string | null
  file_id: number | null
  note: string | null
  created_by_name: string | null
  created_at: string
}

function toItem(row: ItemRow): LegalHoldItem {
  const scope = (["module", "record_type", "record", "criteria", "file"] as const).includes(
    row.scope as LegalHoldScope,
  )
    ? (row.scope as LegalHoldScope)
    : "record"
  const item: LegalHoldItem = {
    id: Number(row.id),
    holdId: Number(row.hold_id),
    scope,
    module: row.module,
    catalogKey: row.catalog_key,
    recordType: row.record_type,
    recordRef: row.record_ref,
    matchField: row.match_field,
    matchValue: row.match_value,
    fileId: row.file_id == null ? null : Number(row.file_id),
    note: row.note,
    label: "",
    createdByName: row.created_by_name,
    createdAt: row.created_at,
  }
  item.label = describeHoldItem(item)
  return item
}

const HOLD_SELECT = `
  SELECT h.*, u.name AS created_by_name, ru.name AS released_by_name,
         (SELECT COUNT(*) FROM legal_hold_items i WHERE i.hold_id = h.id) AS item_count
    FROM legal_holds h
    LEFT JOIN users u ON u.id = h.created_by
    LEFT JOIN users ru ON ru.id = h.released_by
`

function auditContext(tenantId: number | null, actor: Actor) {
  return {
    tenantId,
    actorUserId: actor.userId,
    actorName: actor.name ?? null,
    actorEmail: actor.email ?? null,
    actorRole: actor.role ?? null,
  }
}

// ---------------------------------------------------------------------------
// Hold CRUD (tenant-scoped, audited)
// ---------------------------------------------------------------------------

export async function listHolds(tenantId: number | null): Promise<LegalHold[]> {
  await ensureLegalHoldSchema()
  const rows = (await query(
    `${HOLD_SELECT} WHERE h.tenant_id = ? OR (h.tenant_id IS NULL AND ? IS NULL)
      ORDER BY (h.status = 'active') DESC, h.created_at DESC`,
    [tenantId, tenantId],
  )) as HoldRow[]
  return rows.map(toHold)
}

async function getHoldRow(tenantId: number | null, id: number): Promise<HoldRow | null> {
  const rows = (await query(
    `${HOLD_SELECT} WHERE h.id = ? AND (h.tenant_id = ? OR (h.tenant_id IS NULL AND ? IS NULL)) LIMIT 1`,
    [id, tenantId, tenantId],
  )) as HoldRow[]
  return rows[0] ?? null
}

export async function listItems(tenantId: number | null, holdId: number): Promise<LegalHoldItem[]> {
  await ensureLegalHoldSchema()
  const rows = (await query(
    `SELECT i.*, u.name AS created_by_name
       FROM legal_hold_items i
       LEFT JOIN users u ON u.id = i.created_by
      WHERE i.hold_id = ? AND (i.tenant_id = ? OR (i.tenant_id IS NULL AND ? IS NULL))
      ORDER BY i.id ASC`,
    [holdId, tenantId, tenantId],
  )) as ItemRow[]
  return rows.map(toItem)
}

export async function getHold(tenantId: number | null, id: number): Promise<LegalHold | null> {
  await ensureLegalHoldSchema()
  const row = await getHoldRow(tenantId, id)
  if (!row) return null
  const hold = toHold(row)
  hold.items = await listItems(tenantId, id)
  return hold
}

export type CreateHoldInput = {
  name?: unknown
  reason?: unknown
  items?: unknown
}

export async function createHold(
  tenantId: number | null,
  raw: CreateHoldInput,
  actor: Actor,
): Promise<LegalHold> {
  await ensureLegalHoldSchema()
  const header = normalizeHoldInput(raw)
  // Validate every item up front so a bad item rejects the whole create.
  const rawItems = Array.isArray(raw.items) ? raw.items : []
  const items = rawItems.map((i) => normalizeHoldItemInput((i ?? {}) as Record<string, unknown>))

  const res = (await query(
    `INSERT INTO legal_holds (tenant_id, name, reason, status, created_by) VALUES (?, ?, ?, 'active', ?)`,
    [tenantId, header.name, header.reason, actor.userId],
  )) as { insertId: number }
  const id = res.insertId

  for (const item of items) {
    await query(
      `INSERT INTO legal_hold_items
         (tenant_id, hold_id, scope, module, catalog_key, record_type, record_ref, match_field, match_value, file_id, note, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        tenantId,
        id,
        item.scope,
        item.module,
        item.catalogKey,
        item.recordType,
        item.recordRef,
        item.matchField,
        item.matchValue,
        item.fileId,
        item.note,
        actor.userId,
      ],
    )
  }

  await recordAuditLog({
    action: "legal_hold.create",
    entityType: "legal_hold",
    entityId: id,
    entityLabel: header.name,
    after: { name: header.name, reason: header.reason, items: items.map(describeHoldItem) },
    context: auditContext(tenantId, actor),
  })
  return (await getHold(tenantId, id))!
}

export async function addItem(
  tenantId: number | null,
  holdId: number,
  raw: Record<string, unknown>,
  actor: Actor,
): Promise<LegalHoldItem | null> {
  await ensureLegalHoldSchema()
  const hold = await getHoldRow(tenantId, holdId)
  if (!hold) return null
  if (toLegalHoldStatus(hold.status) !== "active") {
    throw new Error("Cannot add items to a released hold")
  }
  const item = normalizeHoldItemInput(raw)
  const res = (await query(
    `INSERT INTO legal_hold_items
       (tenant_id, hold_id, scope, module, catalog_key, record_type, record_ref, match_field, match_value, file_id, note, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      tenantId,
      holdId,
      item.scope,
      item.module,
      item.catalogKey,
      item.recordType,
      item.recordRef,
      item.matchField,
      item.matchValue,
      item.fileId,
      item.note,
      actor.userId,
    ],
  )) as { insertId: number }
  await recordAuditLog({
    action: "legal_hold.item_add",
    entityType: "legal_hold",
    entityId: holdId,
    entityLabel: hold.name,
    after: { item: describeHoldItem(item) },
    context: auditContext(tenantId, actor),
  })
  const rows = (await query(
    `SELECT i.*, u.name AS created_by_name FROM legal_hold_items i LEFT JOIN users u ON u.id = i.created_by WHERE i.id = ?`,
    [res.insertId],
  )) as ItemRow[]
  return rows[0] ? toItem(rows[0]) : null
}

export async function removeItem(
  tenantId: number | null,
  holdId: number,
  itemId: number,
  actor: Actor,
): Promise<boolean> {
  await ensureLegalHoldSchema()
  const hold = await getHoldRow(tenantId, holdId)
  if (!hold) return false
  if (toLegalHoldStatus(hold.status) !== "active") {
    throw new Error("Cannot modify items on a released hold")
  }
  const rows = (await query(
    `SELECT id FROM legal_hold_items WHERE id = ? AND hold_id = ? AND (tenant_id = ? OR (tenant_id IS NULL AND ? IS NULL)) LIMIT 1`,
    [itemId, holdId, tenantId, tenantId],
  )) as { id: number }[]
  if (rows.length === 0) return false
  await query(
    `DELETE FROM legal_hold_items WHERE id = ? AND hold_id = ? AND (tenant_id = ? OR (tenant_id IS NULL AND ? IS NULL))`,
    [itemId, holdId, tenantId, tenantId],
  )
  await recordAuditLog({
    action: "legal_hold.item_remove",
    entityType: "legal_hold",
    entityId: holdId,
    entityLabel: hold.name,
    before: { itemId },
    context: auditContext(tenantId, actor),
  })
  return true
}

export async function releaseHold(
  tenantId: number | null,
  id: number,
  reason: string,
  actor: Actor,
): Promise<LegalHold | null> {
  await ensureLegalHoldSchema()
  const row = await getHoldRow(tenantId, id)
  if (!row) return null
  if (toLegalHoldStatus(row.status) === "released") return getHold(tenantId, id)
  const trimmedReason = String(reason ?? "").trim().slice(0, 1000)
  if (!trimmedReason) throw new Error("A release reason is required")

  await query(
    `UPDATE legal_holds SET status = 'released', released_by = ?, released_reason = ?, released_at = NOW()
      WHERE id = ? AND (tenant_id = ? OR (tenant_id IS NULL AND ? IS NULL))`,
    [actor.userId, trimmedReason, id, tenantId, tenantId],
  )
  await recordAuditLog({
    action: "legal_hold.release",
    entityType: "legal_hold",
    entityId: id,
    entityLabel: row.name,
    before: { status: "active" },
    after: { status: "released", reason: trimmedReason },
    context: auditContext(tenantId, actor),
  })
  return getHold(tenantId, id)
}

/** Delete a RELEASED hold and its items. Active holds can never be deleted. */
export async function deleteHold(tenantId: number | null, id: number, actor: Actor): Promise<boolean> {
  await ensureLegalHoldSchema()
  const row = await getHoldRow(tenantId, id)
  if (!row) return false
  if (toLegalHoldStatus(row.status) === "active") {
    throw new Error("Release the hold before deleting it")
  }
  await query(`DELETE FROM legal_hold_items WHERE hold_id = ? AND (tenant_id = ? OR (tenant_id IS NULL AND ? IS NULL))`, [
    id,
    tenantId,
    tenantId,
  ])
  await query(`DELETE FROM legal_holds WHERE id = ? AND (tenant_id = ? OR (tenant_id IS NULL AND ? IS NULL))`, [
    id,
    tenantId,
    tenantId,
  ])
  await recordAuditLog({
    action: "legal_hold.delete",
    entityType: "legal_hold",
    entityId: id,
    entityLabel: row.name,
    before: { name: row.name },
    context: auditContext(tenantId, actor),
  })
  return true
}

// ---------------------------------------------------------------------------
// Enforcement — consulted by the automated deletion services
// ---------------------------------------------------------------------------

/** An active hold item paired with the name of the hold that owns it. */
type NamedMatch = { match: LegalHoldItemMatch; holdName: string }

/** Fetch every ACTIVE hold item for the tenant, mapped for the pure predicates. */
async function activeMatches(
  tenantId: number | null,
  scopes?: readonly LegalHoldScope[],
): Promise<NamedMatch[]> {
  await ensureLegalHoldSchema()
  const scopeClause =
    scopes && scopes.length > 0 ? ` AND i.scope IN (${scopes.map(() => "?").join(", ")})` : ""
  const rows = (await query(
    `SELECT i.scope, i.module, i.catalog_key, i.record_type, i.record_ref, i.match_field, i.match_value, i.file_id, h.name AS hold_name
       FROM legal_hold_items i
       JOIN legal_holds h ON h.id = i.hold_id
      WHERE h.status = 'active' AND (h.tenant_id = ? OR (h.tenant_id IS NULL AND ? IS NULL))${scopeClause}`,
    [tenantId, tenantId, ...(scopes ?? [])],
  )) as (Omit<ItemRow, "id" | "hold_id" | "note" | "created_by_name" | "created_at"> & { hold_name: string })[]
  return rows.map((r) => ({
    holdName: r.hold_name,
    match: {
      scope: (["module", "record_type", "record", "criteria", "file"] as const).includes(r.scope as LegalHoldScope)
        ? (r.scope as LegalHoldScope)
        : "record",
      module: r.module,
      catalogKey: r.catalog_key,
      recordType: r.record_type,
      recordRef: r.record_ref,
      matchField: r.match_field,
      matchValue: r.match_value,
      fileId: r.file_id == null ? null : Number(r.file_id),
    },
  }))
}

export type PolicyHoldCoverage = {
  /** A module- or record-type-scoped hold covers the whole policy — skip it. */
  fullyHeld: boolean
  /** Names of the holds that fully cover the policy (for the skip reason). */
  holdNames: string[]
  /** Specific record ids to exclude from the sweep (record-scoped holds). */
  recordRefs: string[]
  /** Field/value criteria to exclude from the sweep (criteria-scoped holds). */
  criteria: { field: string; value: string | null }[]
}

/**
 * Resolve how active legal holds affect one retention policy's target family.
 * The retention engine uses this to skip a fully-held policy or to exclude the
 * individual held rows from an otherwise-eligible sweep.
 */
export async function getPolicyHoldCoverage(
  tenantId: number | null,
  policy: PolicyTarget,
): Promise<PolicyHoldCoverage> {
  const named = await activeMatches(tenantId, ["module", "record_type", "record", "criteria"])
  const matches = named.map((n) => n.match)
  const fullyHeld = isPolicyFullyHeld(matches, policy)

  const holdNames = new Set<string>()
  const recordRefs: string[] = []
  const criteria: { field: string; value: string | null }[] = []

  for (const { match: m, holdName } of named) {
    if (!itemTargetsPolicy(m, policy)) continue
    if (FAMILY_SCOPES.includes(m.scope)) {
      holdNames.add(holdName)
    } else if (m.scope === "record" && m.recordRef != null) {
      recordRefs.push(m.recordRef)
    } else if (m.scope === "criteria" && m.matchField) {
      criteria.push({ field: m.matchField, value: m.matchValue })
    }
  }

  return { fullyHeld, holdNames: [...holdNames], recordRefs, criteria }
}

export type FileHoldResult = { held: boolean; holdName: string | null }

/**
 * Is a storage file protected by an active legal hold? Consulted by the SPEC 36
 * storage retention sweep before deleting bytes/metadata.
 */
export async function isFileUnderLegalHold(
  tenantId: number | null,
  file: FileEvaluable,
): Promise<FileHoldResult> {
  const named = await activeMatches(tenantId, ["file", "module"])
  for (const { match, holdName } of named) {
    if (itemHoldsFile(match, file)) return { held: true, holdName }
  }
  return { held: false, holdName: null }
}
