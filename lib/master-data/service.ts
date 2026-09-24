import "server-only"
/**
 * SPEC 90 — Centralized Master Data: canonical service (Phase 2 & 3).
 * ---------------------------------------------------------------------------
 * The single, uniform API every module uses to read and write masters. It
 * routes each call through registry.ts to the correct backing table — a new
 * canonical table, or an existing module table being delegated to — so callers
 * never care where a master physically lives. This is what makes the migration
 * from scattered/duplicated masters (Phase 3) a drop-in change: modules resolve
 * references through here instead of hard-coding or re-defining a list.
 */
import { query } from "@/lib/db"
import { ensureMasterDataSchema } from "./schema"
import { getMasterSource } from "./registry"
import type { MasterKind, MasterRow } from "./types"

export type ListOptions = {
  /** Required for tenant-scoped masters (cost_centers, locations, categories). */
  tenantId?: number
  search?: string
  activeOnly?: boolean
  /** Filter hierarchical masters by parent code (state.country, city.state, category.domain). */
  parent?: string
  limit?: number
}

function requireTenant(kind: MasterKind, tenantId?: number): number {
  if (tenantId == null) throw new Error(`Master "${kind}" is tenant-scoped; tenantId is required.`)
  return tenantId
}

function rowMapper(src: ReturnType<typeof getMasterSource>) {
  return (r: any): MasterRow => {
    const meta: Record<string, unknown> = {}
    for (const c of src.metaCols ?? []) meta[c] = r[c]
    return {
      code: String(r[src.codeCol]),
      name: String(r[src.nameCol] ?? ""),
      active: String(r[src.activeCol]) === src.activeTrue,
      parent: src.parentCol ? (r[src.parentCol] ?? null) : null,
      meta: Object.keys(meta).length ? meta : undefined,
    }
  }
}

/** List the values of a master, normalized to MasterRow. */
export async function listMaster(kind: MasterKind, opts: ListOptions = {}): Promise<MasterRow[]> {
  await ensureMasterDataSchema()
  const src = getMasterSource(kind)
  const cols = new Set<string>([src.codeCol, src.nameCol, src.activeCol])
  if (src.parentCol) cols.add(src.parentCol)
  for (const c of src.metaCols ?? []) cols.add(c)

  const where: string[] = []
  const args: any[] = []

  if (src.tenantScoped) {
    where.push("tenant_id = ?")
    args.push(requireTenant(kind, opts.tenantId))
  }
  if (opts.activeOnly !== false) {
    where.push(`${src.activeCol} = ?`)
    args.push(src.activeTrue)
  }
  if (opts.parent != null && src.parentCol) {
    where.push(`${src.parentCol} = ?`)
    args.push(opts.parent)
  }
  if (opts.search) {
    where.push(`(${src.codeCol} LIKE ? OR ${src.nameCol} LIKE ?)`)
    args.push(`%${opts.search}%`, `%${opts.search}%`)
  }

  const sql = `SELECT ${[...cols].join(", ")} FROM ${src.table}
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY ${src.nameCol} ASC
    LIMIT ${Math.min(Math.max(Number(opts.limit) || 500, 1), 2000)}`
  const rows = (await query<any[]>(sql, args)) as any[]
  return rows.map(rowMapper(src))
}

/** Fetch a single master value by code, or null. */
export async function getMaster(
  kind: MasterKind,
  code: string,
  opts: { tenantId?: number } = {},
): Promise<MasterRow | null> {
  await ensureMasterDataSchema()
  const src = getMasterSource(kind)
  const cols = new Set<string>([src.codeCol, src.nameCol, src.activeCol])
  if (src.parentCol) cols.add(src.parentCol)
  for (const c of src.metaCols ?? []) cols.add(c)

  const where = [`${src.codeCol} = ?`]
  const args: any[] = [code]
  if (src.tenantScoped) {
    where.push("tenant_id = ?")
    args.push(requireTenant(kind, opts.tenantId))
  }
  const rows = (await query<any[]>(
    `SELECT ${[...cols].join(", ")} FROM ${src.table} WHERE ${where.join(" AND ")} LIMIT 1`,
    args,
  )) as any[]
  return rows[0] ? rowMapper(src)(rows[0]) : null
}

/**
 * Validate that a reference code exists (and, by default, is active). This is
 * the function modules call before persisting a foreign master reference —
 * replacing ad-hoc free-text acceptance (Phase 3/4).
 */
export async function isValidMasterRef(
  kind: MasterKind,
  code: string | null | undefined,
  opts: { tenantId?: number; allowInactive?: boolean } = {},
): Promise<boolean> {
  if (code == null || code === "") return false
  const row = await getMaster(kind, String(code), { tenantId: opts.tenantId })
  if (!row) return false
  return opts.allowInactive ? true : row.active
}

// ---------------------------------------------------------------------------
// Writes (canonical masters only — delegated masters are owned by their module)
// ---------------------------------------------------------------------------

export type UpsertInput = {
  code: string
  name: string
  active?: boolean
  parent?: string | null
  meta?: Record<string, unknown>
}

function assertWritable(kind: MasterKind) {
  const src = getMasterSource(kind)
  if (!src.writable) {
    throw new Error(
      `Master "${kind}" is delegated to its owning module and is read-only here. ` +
        `Manage it via that module (e.g. HR / Finance).`,
    )
  }
  return src
}

async function audit(
  kind: MasterKind,
  code: string,
  action: string,
  tenantId: number | null,
  userId: number | null,
  oldValue: unknown,
  newValue: unknown,
) {
  await query(
    `INSERT INTO md_master_audit (tenant_id, master_kind, code, action, user_id, old_value, new_value)
     VALUES (?,?,?,?,?,?,?)`,
    [tenantId, kind, code, action, userId, oldValue ? JSON.stringify(oldValue) : null, newValue ? JSON.stringify(newValue) : null],
  )
}

/** Create or update a canonical master value (upsert by code). */
export async function upsertMaster(
  kind: MasterKind,
  input: UpsertInput,
  ctx: { tenantId?: number; userId?: number } = {},
): Promise<void> {
  await ensureMasterDataSchema()
  const src = assertWritable(kind)
  const code = String(input.code || "").trim()
  if (!code) throw new Error("code is required")
  if (!input.name || !String(input.name).trim()) throw new Error("name is required")

  const record: Record<string, any> = {
    [src.codeCol]: code,
    [src.nameCol]: String(input.name).trim(),
    [src.activeCol]: input.active === false ? 0 : 1,
  }
  if (src.parentCol && input.parent !== undefined) record[src.parentCol] = input.parent
  for (const c of src.metaCols ?? []) {
    if (input.meta && c in input.meta) record[c] = input.meta[c] as any
  }
  if (src.tenantScoped) record.tenant_id = requireTenant(kind, ctx.tenantId)

  const prev = await getMaster(kind, code, { tenantId: ctx.tenantId })
  const cols = Object.keys(record)
  const updates = cols.filter((c) => c !== src.codeCol && c !== "tenant_id")

  await query(
    `INSERT INTO ${src.table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})
     ON DUPLICATE KEY UPDATE ${updates.map((c) => `${c} = VALUES(${c})`).join(", ")}`,
    cols.map((c) => record[c]),
  )
  await audit(kind, code, prev ? "update" : "create", src.tenantScoped ? (ctx.tenantId ?? null) : null, ctx.userId ?? null, prev, {
    code,
    name: record[src.nameCol],
  })
}

/**
 * Deactivate a canonical master value. Never hard-deletes: historical rows that
 * reference the code keep resolving (backward compatibility, Phase 4).
 */
export async function deactivateMaster(
  kind: MasterKind,
  code: string,
  ctx: { tenantId?: number; userId?: number } = {},
): Promise<void> {
  await ensureMasterDataSchema()
  const src = assertWritable(kind)
  const where = [`${src.codeCol} = ?`]
  const args: any[] = [String(src.activeTrue) === "1" ? 0 : "Inactive", code]
  if (src.tenantScoped) {
    where.push("tenant_id = ?")
    args.push(requireTenant(kind, ctx.tenantId))
  }
  await query(`UPDATE ${src.table} SET ${src.activeCol} = ? WHERE ${where.join(" AND ")}`, args)
  await audit(kind, code, "deactivate", src.tenantScoped ? (ctx.tenantId ?? null) : null, ctx.userId ?? null, { code }, null)
}
