import "server-only"
import { query, tableColumns } from "@/lib/db"
import { nextRecordId } from "@/lib/record-ids"
import {
  getEntityDef,
  searchFields,
  statusField,
  type EntityDef,
  type FieldDef,
} from "@/lib/management-entities"

/**
 * Management module — generic, schema-driven CRUD engine.
 * ---------------------------------------------------------------------------
 * All 13 Management entities are described in lib/management-entities.ts. This
 * engine builds self-healing tables and generic list/create/update/delete
 * operations from that config. Column names always come from the entity
 * definition (never from client input), and every value is parameterised, so
 * the dynamic SQL is injection-safe.
 *
 * Rows are scoped to the acting tenant when a tenant id is available (multi
 * tenant isolation), falling back to global rows for installs without tenants.
 */

export class ManagementError extends Error {
  status: number
  constructor(message: string, status = 400) {
    super(message)
    this.status = status
  }
}

const num = (v: any): number | null => {
  if (v === "" || v === null || v === undefined) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function sqlColumnType(field: FieldDef): string {
  switch (field.type) {
    case "textarea":
      return "TEXT"
    case "number":
      return "DECIMAL(18,2) DEFAULT NULL"
    case "date":
      return "DATE DEFAULT NULL"
    case "email":
      return "VARCHAR(190) DEFAULT NULL"
    case "select":
      return "VARCHAR(60) DEFAULT NULL"
    default:
      return "VARCHAR(255) DEFAULT NULL"
  }
}

// ── Schema (self-healing) ─────────────────────────────────────────────────────

const ensured = new Set<string>()

async function ensureSchema(entity: EntityDef): Promise<void> {
  if (ensured.has(entity.table)) return

  const columnDefs = entity.fields.map((f) => `  \`${f.name}\` ${sqlColumnType(f)}`).join(",\n")

  await query(
    `CREATE TABLE IF NOT EXISTS \`${entity.table}\` (
      id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
      record_id   VARCHAR(30) NOT NULL,
      tenant_id   INT UNSIGNED DEFAULT NULL,
${columnDefs},
      created_by  INT UNSIGNED DEFAULT NULL,
      created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_${entity.table}_record (record_id),
      KEY idx_${entity.table}_tenant (tenant_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  )

  // Add any columns introduced after the table was first created.
  const existing = await tableColumns(entity.table).catch(() => new Set<string>())
  for (const field of entity.fields) {
    if (!existing.has(field.name)) {
      await query(
        `ALTER TABLE \`${entity.table}\` ADD COLUMN \`${field.name}\` ${sqlColumnType(field)}`,
      ).catch(() => {})
    }
  }

  ensured.add(entity.table)
}

function resolveEntity(key: string): EntityDef {
  const entity = getEntityDef(key)
  if (!entity) throw new ManagementError("Unknown management entity.", 404)
  return entity
}

// ── Row mapping ────────────────────────────────────────────────────────────────

function mapRow(entity: EntityDef, row: any): Record<string, any> {
  const out: Record<string, any> = {
    id: Number(row.id),
    record_id: String(row.record_id),
    created_at: row.created_at ?? null,
    updated_at: row.updated_at ?? null,
  }
  for (const field of entity.fields) {
    const v = row[field.name]
    out[field.name] = field.type === "number" ? num(v) : v ?? null
  }
  return out
}

/** Coerce and collect the writable column values from a request body. */
function collectValues(entity: EntityDef, body: Record<string, any>): Record<string, any> {
  const values: Record<string, any> = {}
  for (const field of entity.fields) {
    if (!(field.name in body)) continue
    let v = body[field.name]
    if (field.type === "number") v = num(v)
    else if (typeof v === "string") v = v.trim() === "" ? null : v.trim()
    else if (v === undefined) v = null
    values[field.name] = v
  }
  return values
}

// ── List ─────────────────────────────────────────────────────────────────────

export type ListParams = {
  search?: string | null
  status?: string | null
}

export async function listEntities(
  key: string,
  params: ListParams,
  tenantId: number | null,
): Promise<{ rows: Record<string, any>[]; total: number }> {
  const entity = resolveEntity(key)
  await ensureSchema(entity)

  const where: string[] = []
  const args: any[] = []

  if (tenantId != null) {
    where.push("(tenant_id = ? OR tenant_id IS NULL)")
    args.push(tenantId)
  }

  const search = params.search?.trim()
  if (search) {
    const cols = searchFields(entity)
    if (cols.length) {
      where.push(`(${cols.map((c) => `\`${c}\` LIKE ?`).join(" OR ")})`)
      const like = `%${search}%`
      cols.forEach(() => args.push(like))
    }
  }

  if (params.status && params.status !== "all" && statusField(entity)) {
    where.push("`status` = ?")
    args.push(params.status)
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : ""
  const rows = (await query(
    `SELECT * FROM \`${entity.table}\` ${whereSql} ORDER BY id DESC LIMIT 2000`,
    args,
  ).catch(() => [])) as any[]

  return { rows: rows.map((r) => mapRow(entity, r)), total: rows.length }
}

// ── Get one ────────────────────────────────────────────────────────────────────

export async function getEntity(
  key: string,
  recordId: string,
  tenantId: number | null,
): Promise<Record<string, any> | null> {
  const entity = resolveEntity(key)
  await ensureSchema(entity)
  const rows = (await query(
    `SELECT * FROM \`${entity.table}\` WHERE record_id = ? LIMIT 1`,
    [recordId],
  ).catch(() => [])) as any[]
  const row = rows[0]
  if (!row) return null
  if (tenantId != null && row.tenant_id != null && Number(row.tenant_id) !== tenantId) return null
  return mapRow(entity, row)
}

// ── Create ─────────────────────────────────────────────────────────────────────

export async function createEntity(
  key: string,
  body: Record<string, any>,
  ctx: { userId: number; tenantId: number | null },
): Promise<Record<string, any>> {
  const entity = resolveEntity(key)
  await ensureSchema(entity)

  const values = collectValues(entity, body)

  for (const field of entity.fields) {
    if (field.required && (values[field.name] == null || values[field.name] === "")) {
      throw new ManagementError(`${field.label} is required.`)
    }
  }

  const recordId = await nextRecordId(entity.prefix, { digits: 6, allowCustom: true })

  const columns = ["record_id", "tenant_id", "created_by", ...Object.keys(values)]
  const placeholders = columns.map(() => "?").join(", ")
  const args = [recordId, ctx.tenantId, ctx.userId, ...Object.keys(values).map((k) => values[k])]

  await query(
    `INSERT INTO \`${entity.table}\` (${columns.map((c) => `\`${c}\``).join(", ")}) VALUES (${placeholders})`,
    args,
  )

  const created = await getEntity(key, recordId, ctx.tenantId)
  if (!created) throw new ManagementError("Failed to load the created record.", 500)
  return created
}

// ── Update ─────────────────────────────────────────────────────────────────────

export async function updateEntity(
  key: string,
  recordId: string,
  body: Record<string, any>,
  tenantId: number | null,
): Promise<Record<string, any>> {
  const entity = resolveEntity(key)
  await ensureSchema(entity)

  const existing = await getEntity(key, recordId, tenantId)
  if (!existing) throw new ManagementError("Record not found.", 404)

  const values = collectValues(entity, body)

  for (const field of entity.fields) {
    if (field.required && field.name in values && (values[field.name] == null || values[field.name] === "")) {
      throw new ManagementError(`${field.label} is required.`)
    }
  }

  const cols = Object.keys(values)
  if (cols.length === 0) return existing

  const setSql = cols.map((c) => `\`${c}\` = ?`).join(", ")
  const args = [...cols.map((c) => values[c]), recordId]
  await query(`UPDATE \`${entity.table}\` SET ${setSql} WHERE record_id = ?`, args)

  const updated = await getEntity(key, recordId, tenantId)
  if (!updated) throw new ManagementError("Failed to load the updated record.", 500)
  return updated
}

// ── Delete ─────────────────────────────────────────────────────────────────────

export async function deleteEntity(
  key: string,
  recordId: string,
  tenantId: number | null,
): Promise<void> {
  const entity = resolveEntity(key)
  await ensureSchema(entity)

  const existing = await getEntity(key, recordId, tenantId)
  if (!existing) throw new ManagementError("Record not found.", 404)

  await query(`DELETE FROM \`${entity.table}\` WHERE record_id = ?`, [recordId])
}
