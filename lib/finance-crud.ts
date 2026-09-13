import { NextRequest, NextResponse } from "next/server"
import { randomUUID } from "crypto"
import { query } from "@/lib/db"
import { getSession } from "@/lib/auth"
import { nextRecordId } from "@/lib/record-ids"
import { nextRecordIdForPrefix } from "@/lib/settings/numbering"
import { FINANCE_MODULE_CONFIGS } from "@/lib/finance-module-configs"
import type { ModuleConfig } from "@/lib/finance-schema"
import { ensureFreelanceInvoiceColumns, ensureFteInvoiceColumns, ensureCustomerVendorGstColumns, ensurePurchaseBillColumns } from "@/lib/finance-ensure"
import { nextPurchaseBillId, computePurchaseBillServerFields } from "@/lib/finance-purchase-bills"
import { syncGstInputForBill, deleteGstInputForBill } from "@/lib/finance-gst-input"
import { syncPurchaseBillPosting, reversePurchaseBillPosting } from "@/lib/finance-posting"
import { computeBillItems, persistBillItems } from "@/lib/purchase-bill-items"
import type { SupplyType } from "@/lib/sales-invoice-compute"

/**
 * Optional per-module server augmentation. Runs AFTER the pure `compute`, can
 * touch the database (vendor snapshot, company settings) and its output is
 * authoritative — it overrides anything the browser sent. Kept here (server
 * only) rather than in the shared config module so server imports never leak
 * into the client bundle.
 */
const SERVER_AUGMENT: Record<
  string,
  (merged: Record<string, any>, opts: { isCreate: boolean }) => Promise<Record<string, any>>
> = {
  "purchase-bills": computePurchaseBillServerFields,
}

/** Optional per-module custom business-key generator (Phase 1: PB-2026-000001). */
const ID_GENERATORS: Record<string, (record: Record<string, any>) => Promise<string>> = {
  "purchase-bills": (record) => nextPurchaseBillId(record.bill_date),
}

/**
 * Optional per-module side effect that runs AFTER a create/update has been
 * committed to the module's own table. For Purchase Bills this is where the
 * frozen line-item snapshot is persisted (Phase 6/7) and the bill is projected
 * into the GST Input / ITC register (Phase 11–20). Everything here keys off the
 * authoritative, server-recomputed row, never the raw browser payload.
 */
const AFTER_WRITE: Record<
  string,
  (ctx: { finalRow: Record<string, any>; body: Record<string, any>; userId: number; isCreate: boolean }) => Promise<void>
> = {
  "purchase-bills": async ({ finalRow, body, userId }) => {
    const billId = finalRow[cfgIdColumn("purchase-bills")]
    if (!billId) return
    // Persist the frozen multi-line snapshot when the client sent line items.
    const raw = Array.isArray(body.__items) ? (body.__items as any[]) : null
    if (raw && raw.length > 0) {
      const supplyType = (finalRow.supply_type as SupplyType) || "Intra-State"
      const { items } = computeBillItems(raw, supplyType)
      await persistBillItems(String(billId), items)
    }
    // Project into the ITC register (idempotent: create → edit → re-post never
    // duplicates a credit, and a zero-GST / excluded bill removes its record).
    await syncGstInputForBill(String(billId), { createdBy: userId })
    // Project into the Journal + General Ledger (Phases 33–37). Idempotent and
    // failure-tolerant — a posting error leaves the bill "Unposted" and the next
    // save retries, so it never blocks bill CRUD.
    await syncPurchaseBillPosting(String(billId), { createdBy: userId })
  },
}

/** Optional per-module side effect that runs when a record is deleted. */
const AFTER_DELETE: Record<string, (row: Record<string, any>) => Promise<void>> = {
  "purchase-bills": async (row) => {
    const billId = row?.bill_id
    if (!billId) return
    // Reverse the accounting posting first so the ledger stays balanced, then
    // unwind the dependent registers.
    await reversePurchaseBillPosting(row)
    await deleteGstInputForBill(String(billId))
    await query(`DELETE FROM purchase_bill_items WHERE bill_id = ?`, [billId])
  },
}

/** Resolve a module's id column without importing the whole config graph twice. */
function cfgIdColumn(moduleKey: string): string {
  return FINANCE_MODULE_CONFIGS[moduleKey]?.idColumn ?? "id"
}

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
  if (cfg.financialYearColumn && p.get("financial_year")) {
    conditions.push(`x.${cfg.financialYearColumn} = ?`); args.push(p.get("financial_year"))
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

export function createFinanceHandlers(moduleKey: string) {
  const cfg = FINANCE_MODULE_CONFIGS[moduleKey]
  if (!cfg) throw new Error(`Unknown finance module: ${moduleKey}`)
  const keys = inputKeys(cfg)

  // Modules with invoice actions carry a few extra columns (recipient email +
  // send tracking) that aren't in the base migration. Self-heal them once.
  const ensureSchema = async () => {
    if (moduleKey === "freelance-invoices") await ensureFreelanceInvoiceColumns()
    if (moduleKey === "fte-invoices") await ensureFteInvoiceColumns()
    if (moduleKey === "customers-vendors") await ensureCustomerVendorGstColumns()
    if (moduleKey === "purchase-bills") await ensurePurchaseBillColumns()
  }

  const augment = SERVER_AUGMENT[moduleKey]
  const idGenerator = ID_GENERATORS[moduleKey]

  async function GET(req: NextRequest) {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

    await ensureSchema()
    const { where, args } = buildWhere(cfg, req.nextUrl.searchParams)
    const orderBy = cfg.dateColumn ? `x.${cfg.dateColumn} DESC, x.id DESC` : "x.id DESC"

    const rows = await query(
      `SELECT x.*, u.name AS created_by_name${cfg.extraSelect ? `, ${cfg.extraSelect}` : ""}
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

    const financialYears = cfg.financialYearColumn
      ? ((await query(
          `SELECT DISTINCT ${cfg.financialYearColumn} v FROM ${cfg.table}
             WHERE ${cfg.financialYearColumn} IS NOT NULL AND ${cfg.financialYearColumn} <> ''
             ORDER BY v DESC`,
        )) as any[]).map((r) => r.v)
      : []

    return NextResponse.json({ rows, summary: summary ?? {}, filterOptions: { financialYears } })
  }

  async function POST(req: NextRequest) {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

    await ensureSchema()
    const body = await req.json()
    const derived = cfg.compute ? cfg.compute(body) : {}

    const record: Record<string, any> = {}
    for (const k of keys) {
      if (k in derived) record[k] = (derived as any)[k]
      else if (body[k] !== undefined && body[k] !== "") record[k] = body[k]
    }
    Object.assign(record, derived)

    // Server-authoritative augmentation (vendor snapshot, place-of-supply GST,
    // due date). Runs on the merged record and overrides browser-sent values.
    if (augment) {
      const extra = await augment({ ...body, ...record }, { isCreate: true })
      for (const k of keys) if (k in extra) record[k] = (extra as any)[k]
      Object.assign(record, extra)
    }

    if (idGenerator) {
      // Custom immutable business key (never client-supplied, concurrency-safe).
      record[cfg.idColumn] = await idGenerator(record)
    } else if (cfg.manualId) {
      if (!body[cfg.idColumn]) return NextResponse.json({ error: `${cfg.idColumn} is required` }, { status: 400 })
      record[cfg.idColumn] = body[cfg.idColumn]
    } else if (cfg.idPrefix) {
      // editableId modules keep a hand-entered business key, but fall back to an
      // auto-generated id whenever the user leaves the field blank.
      const provided = cfg.editableId ? body[cfg.idColumn] : undefined
      record[cfg.idColumn] =
        provided !== undefined && provided !== null && String(provided).trim() !== ""
          ? String(provided).trim()
          : await nextRecordIdForPrefix(cfg.idPrefix)
    }

    if (cfg.trackingId) {
      record.tracking_id = randomUUID()
      record.opened = 0
      record.open_count = 0
    }

    record.created_by = session.userId

    const cols = Object.keys(record)
    await query(
      `INSERT INTO ${cfg.table} (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`,
      cols.map((c) => record[c]),
    )

    const afterWrite = AFTER_WRITE[moduleKey]
    if (afterWrite) await afterWrite({ finalRow: record, body, userId: session.userId, isCreate: true })

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
      if (k === cfg.idColumn && !cfg.manualId) continue
      if (k in derived) update[k] = (derived as any)[k]
      else if (body[k] !== undefined) update[k] = body[k]
    }
    Object.assign(update, derived)

    // Server-authoritative augmentation on the merged row. The immutable id
    // column is never included in the update set (skipped above), so the Bill
    // ID stays frozen across edits.
    if (augment) {
      const extra = await augment({ ...merged, ...derived, ...update }, { isCreate: false })
      for (const k of keys) {
        if (k === cfg.idColumn && !cfg.manualId) continue
        if (k in extra) update[k] = (extra as any)[k]
      }
      for (const [k, v] of Object.entries(extra)) {
        if (k === cfg.idColumn) continue
        update[k] = v
      }
    }

    const cols = Object.keys(update)
    if (cols.length) {
      await query(
        `UPDATE ${cfg.table} SET ${cols.map((c) => `${c}=?`).join(",")} WHERE id=?`,
        [...cols.map((c) => update[c]), id],
      )
    }

    const afterWrite = AFTER_WRITE[moduleKey]
    if (afterWrite) {
      // Re-read the row so the side effect keys off the committed state (the
      // update set only carries changed columns, not the whole bill).
      const [finalRow] = (await query(`SELECT * FROM ${cfg.table} WHERE id = ?`, [id])) as any[]
      if (finalRow) await afterWrite({ finalRow, body, userId: session.userId, isCreate: false })
    }

    return NextResponse.json({ ok: true })
  }

  async function DELETE(req: NextRequest) {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    const id = Number(req.nextUrl.searchParams.get("id"))
    if (!id) return NextResponse.json({ error: "Record id is required" }, { status: 400 })

    // Capture the row before deletion so module side effects can unwind
    // dependent records (line items, ITC register) keyed off its business id.
    const afterDelete = AFTER_DELETE[moduleKey]
    let doomed: Record<string, any> | null = null
    if (typeof afterDelete === "function") {
      const [row] = (await query(`SELECT * FROM ${cfg.table} WHERE id = ?`, [id])) as any[]
      doomed = row ?? null
    }

    await query(`DELETE FROM ${cfg.table} WHERE id = ?`, [id])

    if (typeof afterDelete === "function" && doomed) await afterDelete(doomed)

    return NextResponse.json({ ok: true })
  }

  return { GET, POST, PATCH, DELETE }
}
