import { NextRequest, NextResponse } from "next/server"
import { query } from "@/lib/db"
import { getSession } from "@/lib/auth"
import { nextRecordId } from "@/lib/record-ids"
import { nextRecordIdForPrefix } from "@/lib/settings/numbering"
import { RECRUITMENT_MODULE_CONFIGS } from "@/lib/recruitment-module-configs"
import type { FieldDef, ModuleConfig } from "@/lib/finance-schema"
import {
  RECRUITMENT_PERMISSION_KEYS,
  scopeWhereForModule,
  mergeScopeIntoWhere,
  canActOnRecord,
  canCreateInModule,
} from "@/lib/permission-enforce"

/**
 * Config-driven CRUD factory for the Recruitment modules. Mirrors
 * lib/finance-crud.ts: every module shares this factory, which handles auto
 * record IDs, server-side computed fields, filtering and the summary KPIs
 * declared by each ModuleConfig.
 */

/** Column keys a client is allowed to write (everything except computed fields). */
function inputKeys(cfg: ModuleConfig) {
  return cfg.fields.filter((f) => !f.computed).map((f) => f.key)
}

/** MySQL column type for a config field. */
function columnType(f: FieldDef, cfg: ModuleConfig): string {
  if (f.key === cfg.idColumn) return "VARCHAR(191) NULL"
  if (f.money || f.type === "number") return "DECIMAL(18,2) NULL"
  if (f.type === "date") return "DATE NULL"
  if (f.type === "textarea") return "TEXT NULL"
  return "VARCHAR(512) NULL"
}

/**
 * Self-healing schema: create the module's table (with its business-id unique
 * key + system columns) if it does not already exist. `CREATE TABLE IF NOT
 * EXISTS` is a no-op for the modules whose tables ship in the SQL migrations,
 * and it lets the newer operational sub-modules (candidate activities,
 * documents, referrals, tasks, follow-ups, vendors, costs) come online against
 * the live database without a manual migration step. Runs once per table per
 * process. The business-id UNIQUE key also gives duplicate protection.
 */
const ensuredTables = new Set<string>()
async function ensureRecruitmentTable(cfg: ModuleConfig) {
  if (ensuredTables.has(cfg.table)) return
  const RESERVED = new Set(["id", "created_by", "created_at", "updated_at"])
  const cols: string[] = ["`id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY"]
  const seen = new Set<string>()
  for (const f of cfg.fields) {
    if (RESERVED.has(f.key) || seen.has(f.key)) continue
    seen.add(f.key)
    cols.push(`\`${f.key}\` ${columnType(f, cfg)}`)
  }
  if (!seen.has(cfg.idColumn)) cols.push(`\`${cfg.idColumn}\` VARCHAR(191) NULL`)
  cols.push("`created_by` BIGINT UNSIGNED NULL")
  cols.push("`created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP")
  cols.push("`updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP")
  cols.push(`UNIQUE KEY \`uq_${cfg.table}_bizid\` (\`${cfg.idColumn}\`)`)
  await query(
    `CREATE TABLE IF NOT EXISTS \`${cfg.table}\` (${cols.join(", ")}) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  )
  ensuredTables.add(cfg.table)
}

/** Build the shared WHERE clause + args from the request's query params. */
function buildWhere(cfg: ModuleConfig, p: URLSearchParams) {
  const conditions: string[] = []
  const args: any[] = []

  if (cfg.dateColumn) {
    if (p.get("date_from")) { conditions.push(`x.${cfg.dateColumn} >= ?`); args.push(p.get("date_from")) }
    if (p.get("date_to")) { conditions.push(`x.${cfg.dateColumn} <= ?`); args.push(p.get("date_to")) }
    if (p.get("month")) { conditions.push(`MONTH(x.${cfg.dateColumn}) = ?`); args.push(Number(p.get("month"))) }
    if (p.get("year")) { conditions.push(`YEAR(x.${cfg.dateColumn}) = ?`); args.push(Number(p.get("year"))) }
  }
  if (cfg.statusColumn && p.get("status")) {
    conditions.push(`x.${cfg.statusColumn} = ?`); args.push(p.get("status"))
  }
  for (const f of cfg.filters ?? []) {
    if (f.type === "select" && p.get(f.key)) { conditions.push(`x.${f.key} = ?`); args.push(p.get(f.key)) }
  }
  if (p.get("search") && cfg.searchColumns.length) {
    conditions.push("(" + cfg.searchColumns.map((c) => `x.${c} LIKE ?`).join(" OR ") + ")")
    const like = `%${p.get("search")}%`
    cfg.searchColumns.forEach(() => args.push(like))
  }

  return { where: conditions.length ? `WHERE ${conditions.join(" AND ")}` : "", args }
}

export function createRecruitmentHandlers(moduleKey: string) {
  const cfg = RECRUITMENT_MODULE_CONFIGS[moduleKey]
  if (!cfg) throw new Error(`Unknown recruitment module: ${moduleKey}`)
  const keys = inputKeys(cfg)
  const permissionKey = RECRUITMENT_PERMISSION_KEYS[moduleKey]

  async function GET(req: NextRequest) {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    await ensureRecruitmentTable(cfg)

    let { where, args } = buildWhere(cfg, req.nextUrl.searchParams)
    // Record-level permission scope: an employee configured with "added"/"owned"
    // only sees the rows they created/own.
    if (permissionKey) {
      const scoped = await scopeWhereForModule(session, permissionKey, "view", cfg.table, "x")
      const merged = mergeScopeIntoWhere(where, args, scoped)
      where = merged.where
      args = merged.args
    }
    const orderBy = cfg.dateColumn ? `x.${cfg.dateColumn} DESC, x.id DESC` : "x.id DESC"

    const rows = await query(
      `SELECT x.*, u.name AS created_by_name
         FROM ${cfg.table} x
         LEFT JOIN users u ON u.id = x.created_by
         ${where}
         ORDER BY ${orderBy}`,
      args,
    )

    const [summary] = (await query(
      `SELECT ${cfg.summarySelect} FROM ${cfg.table} x ${where}`,
      args,
    )) as any[]

    const statuses = cfg.statusColumn
      ? ((await query(
          `SELECT DISTINCT ${cfg.statusColumn} v FROM ${cfg.table}
             WHERE ${cfg.statusColumn} IS NOT NULL AND ${cfg.statusColumn} <> ''
             ORDER BY v ASC`,
        )) as any[]).map((r) => r.v)
      : []

    return NextResponse.json({ rows, summary: summary ?? {}, filterOptions: { statuses } })
  }

  async function POST(req: NextRequest) {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    await ensureRecruitmentTable(cfg)

    if (permissionKey && !(await canCreateInModule(session, permissionKey))) {
      return NextResponse.json({ error: "You do not have permission to create this record." }, { status: 403 })
    }

    const body = await req.json()
    const derived = cfg.compute ? cfg.compute(body) : {}

    const record: Record<string, any> = {}
    for (const k of keys) {
      if (k in derived) record[k] = (derived as any)[k]
      else if (body[k] !== undefined && body[k] !== "") record[k] = body[k]
    }
    Object.assign(record, derived)

    if (cfg.idPrefix) {
      const provided = cfg.editableId ? body[cfg.idColumn] : undefined
      record[cfg.idColumn] =
        provided !== undefined && provided !== null && String(provided).trim() !== ""
          ? String(provided).trim()
          : await nextRecordIdForPrefix(cfg.idPrefix)
    }

    record.created_by = session.userId

    const cols = Object.keys(record)
    await query(
      `INSERT INTO ${cfg.table} (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`,
      cols.map((c) => record[c]),
    )

    return NextResponse.json({ ok: true, id: record[cfg.idColumn] }, { status: 201 })
  }

  async function PATCH(req: NextRequest) {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    await ensureRecruitmentTable(cfg)

    const body = await req.json()
    const id = Number(body.id)
    if (!id) return NextResponse.json({ error: "Record id is required" }, { status: 400 })

    const [existing] = (await query(`SELECT * FROM ${cfg.table} WHERE id = ?`, [id])) as any[]
    if (!existing) return NextResponse.json({ error: "Record not found" }, { status: 404 })

    if (permissionKey && !(await canActOnRecord(session, permissionKey, "update", existing))) {
      return NextResponse.json({ error: "You do not have permission to update this record." }, { status: 403 })
    }

    const merged = { ...existing, ...body }
    const derived = cfg.compute ? cfg.compute(merged) : {}

    const update: Record<string, any> = {}
    for (const k of keys) {
      if (k === cfg.idColumn) continue
      if (k in derived) update[k] = (derived as any)[k]
      else if (body[k] !== undefined) update[k] = body[k]
    }
    Object.assign(update, derived)

    const cols = Object.keys(update)
    if (cols.length) {
      await query(
        `UPDATE ${cfg.table} SET ${cols.map((c) => `${c}=?`).join(",")} WHERE id=?`,
        [...cols.map((c) => update[c]), id],
      )
    }

    return NextResponse.json({ ok: true })
  }

  async function DELETE(req: NextRequest) {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    await ensureRecruitmentTable(cfg)
    const id = Number(req.nextUrl.searchParams.get("id"))
    if (!id) return NextResponse.json({ error: "Record id is required" }, { status: 400 })
    if (permissionKey) {
      const [existing] = (await query(`SELECT * FROM ${cfg.table} WHERE id = ?`, [id])) as any[]
      if (!existing) return NextResponse.json({ error: "Record not found" }, { status: 404 })
      if (!(await canActOnRecord(session, permissionKey, "delete", existing))) {
        return NextResponse.json({ error: "You do not have permission to delete this record." }, { status: 403 })
      }
    }
    await query(`DELETE FROM ${cfg.table} WHERE id = ?`, [id])
    return NextResponse.json({ ok: true })
  }

  return { GET, POST, PATCH, DELETE }
}
