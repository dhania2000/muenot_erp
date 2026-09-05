import { NextRequest, NextResponse } from "next/server"
import { query } from "@/lib/db"
import { getSession } from "@/lib/auth"
import { nextRecordId } from "@/lib/record-ids"
import { parseSpreadsheetDate } from "@/lib/excel-import"
import { FINANCE_MODULE_CONFIGS } from "@/lib/finance-module-configs"

/**
 * Config-driven bulk importer for a Finance module (e.g. a bank statement
 * uploaded into Bank Transactions). Rows arrive already mapped to canonical
 * column keys by the client; here we coerce types, stamp the selected account,
 * run the module's server-side compute, generate ids and insert each row.
 */
function parseAmount(value: unknown): number {
  if (value === null || value === undefined || value === "") return 0
  const n = Number(String(value).replace(/[^0-9.-]/g, ""))
  return Number.isFinite(n) ? n : 0
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ key: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { key } = await ctx.params
  const cfg = FINANCE_MODULE_CONFIGS[key]
  if (!cfg || !cfg.importSpec) {
    return NextResponse.json({ error: "This module does not support importing" }, { status: 400 })
  }
  const spec = cfg.importSpec

  const body = await req.json().catch(() => ({}))
  const rows = Array.isArray(body?.rows) ? (body.rows as Record<string, unknown>[]) : []
  const account = (body?.account ?? {}) as { bank_cash_account_id?: string; account_name?: string }

  if (!rows.length) return NextResponse.json({ error: "No rows to import" }, { status: 400 })
  if (spec.accountBound && !account.account_name) {
    return NextResponse.json({ error: "Select a bank / cash account before importing" }, { status: 400 })
  }

  let imported = 0
  const errors: string[] = []

  for (let index = 0; index < rows.length; index++) {
    const row = rows[index]
    const record: Record<string, any> = {}

    for (const col of spec.columns) {
      const raw = row[col.key]
      if (raw === undefined || raw === null || String(raw).trim() === "") continue
      if (col.type === "date") {
        const d = parseSpreadsheetDate(String(raw))
        if (d) record[col.key] = d
      } else if (col.type === "number") {
        record[col.key] = parseAmount(raw)
      } else {
        record[col.key] = String(raw).trim()
      }
    }

    if (spec.accountBound) {
      record.account_name = account.account_name
      if (account.bank_cash_account_id) record.bank_cash_account_id = account.bank_cash_account_id
    }

    const hasDate = !!record[cfg.dateColumn || "transaction_date"]
    const hasMovement = parseAmount(record.debit) !== 0 || parseAmount(record.credit) !== 0
    if (!hasDate && !hasMovement) {
      errors.push(`Row ${index + 2}: needs a date or a debit/credit amount`)
      continue
    }

    const derived = cfg.compute ? cfg.compute(record) : {}
    Object.assign(record, derived)

    if (cfg.statusColumn && !record[cfg.statusColumn]) record[cfg.statusColumn] = "Unreconciled"
    if (cfg.idPrefix) record[cfg.idColumn] = await nextRecordId(cfg.idPrefix)
    record.created_by = session.userId

    try {
      const cols = Object.keys(record)
      await query(
        `INSERT INTO ${cfg.table} (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`,
        cols.map((c) => record[c]),
      )
      imported++
    } catch {
      errors.push(`Row ${index + 2}: could not be saved`)
    }
  }

  return NextResponse.json({ imported, failed: errors.length, errors: errors.slice(0, 20) })
}
