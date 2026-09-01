import { NextRequest, NextResponse } from "next/server"
import { query } from "@/lib/db"
import { getSession } from "@/lib/auth"
import { nextRecordId } from "@/lib/record-ids"
import { parseSpreadsheetDate } from "@/lib/excel-import"
import { FINANCE_MODULE_KEYS, financeModulePrefix } from "@/lib/finance-modules"

const modules = new Set(FINANCE_MODULE_KEYS)

export async function POST(req: NextRequest) {
  const session = await getSession(); if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const moduleKey = req.nextUrl.searchParams.get("module") || ""
  if (!modules.has(moduleKey)) return NextResponse.json({ error: "Invalid module" }, { status: 400 })

  const body = await req.json().catch(() => ({}))
  const rows = Array.isArray(body?.rows) ? body.rows : []
  if (!rows.length) return NextResponse.json({ error: "No rows to import" }, { status: 400 })

  const isBankTransactions = moduleKey === "bank-transactions"
  let imported = 0
  const errors: string[] = []

  for (let index = 0; index < rows.length; index++) {
    const row = rows[index] as Record<string, unknown>
    const partyName = String(row.party_name || "").trim()
    const accountName = String(row.account_name || "").trim()
    const amount = Number(row.amount || 0) || 0
    const debit = Number(row.debit || 0) || 0
    const credit = Number(row.credit || 0) || 0

    if (!partyName && !accountName && !amount && !debit && !credit) {
      errors.push(`Row ${index + 2}: needs at least a party/account name or an amount`)
      continue
    }

    try {
      const referenceNo = await nextRecordId(financeModulePrefix(moduleKey))
      const recordDate = parseSpreadsheetDate(String(row.record_date || ""))
      const columns = [
        "module_key", "reference_no", "record_date", "party_name", "account_name",
        "record_type", "amount", "debit", "credit", "status", "description",
        ...(isBankTransactions ? ["reconciliation_status"] : []),
      ]
      const values = [
        moduleKey,
        referenceNo,
        recordDate,
        partyName || null,
        accountName || null,
        String(row.record_type || "").trim() || null,
        amount,
        debit,
        credit,
        String(row.status || "").trim() || "Draft",
        String(row.description || "").trim() || null,
        ...(isBankTransactions ? [String(row.reconciliation_status || "").trim() || null] : []),
        session.userId,
      ]
      await query(
        `INSERT INTO finance_records (${columns.join(",")}, created_by) VALUES (${columns.map(() => "?").join(",")}, ?)`,
        values,
      )
      imported++
    } catch {
      errors.push(`Row ${index + 2}: could not import record`)
    }
  }

  return NextResponse.json({ imported, failed: errors.length, errors: errors.slice(0, 20) })
}
