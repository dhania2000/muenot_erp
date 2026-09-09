import { NextRequest, NextResponse } from "next/server"
import { query } from "@/lib/db"
import { getSession } from "@/lib/auth"
import { nextRecordId } from "@/lib/record-ids"
import { SUPPORT_MODULE_CONFIGS } from "@/lib/support-module-configs"
import type { ModuleConfig } from "@/lib/finance-schema"

/**
 * Config-driven CRUD factory for the Support modules (Tickets, Orders).
 * Mirrors lib/recruitment-crud.ts: every module shares this factory, which
 * handles auto record IDs, server-side computed fields, filtering and the
 * summary KPIs declared by each ModuleConfig.
 */

/** Column keys a client is allowed to write (everything except computed fields). */
function inputKeys(cfg: ModuleConfig) {
  return cfg.fields.filter((f) => !f.computed).map((f) => f.key)
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

export function createSupportHandlers(moduleKey: string) {
  const cfg = SUPPORT_MODULE_CONFIGS[moduleKey]
  if (!cfg) throw new Error(`Unknown support module: ${moduleKey}`)
  const keys = inputKeys(cfg)

  async function GET(req: NextRequest) {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

    const { where, args } = buildWhere(cfg, req.nextUrl.searchParams)
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
          : await nextRecordId(cfg.idPrefix)
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

    const body = await req.json()
    const id = Number(body.id)
    if (!id) return NextResponse.json({ error: "Record id is required" }, { status: 400 })

    const [existing] = (await query(`SELECT * FROM ${cfg.table} WHERE id = ?`, [id])) as any[]
    if (!existing) return NextResponse.json({ error: "Record not found" }, { status: 404 })

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
    const id = Number(req.nextUrl.searchParams.get("id"))
    if (!id) return NextResponse.json({ error: "Record id is required" }, { status: 400 })
    await query(`DELETE FROM ${cfg.table} WHERE id = ?`, [id])
    return NextResponse.json({ ok: true })
  }

  return { GET, POST, PATCH, DELETE }
}
