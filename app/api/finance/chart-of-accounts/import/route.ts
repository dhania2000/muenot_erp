import { NextRequest, NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { query } from "@/lib/db"
import { ensureChartOfAccountsColumns } from "@/lib/finance-ensure"
import { guardChartOfAccountWrite } from "@/lib/finance-coa"
import { nextRecordId } from "@/lib/record-ids"
import { syncOpeningBalancePosting } from "@/lib/finance-opening-balance"
import { COA_ACCOUNT_TYPES, natureForAccountType } from "@/lib/finance-module-configs"
import { financialYearFor } from "@/lib/finance-calc"

// ---------------------------------------------------------------------------
// Chart of Accounts — bulk import (requirement 50).
//
// This reuses the SINGLE accounting system every Finance module shares. Each
// imported row runs through the same integrity rules the interactive CRUD uses:
//   • unique account_code + valid, acyclic parent hierarchy (guardChartOfAccountWrite);
//   • nature / financial-year derived from the account type (never trusted from the file);
//   • opening balances projected into a real, balanced Journal + General Ledger
//     voucher via syncOpeningBalancePosting (never a bare number on the table).
// It creates NO parallel ledger and adds NO new account key — an imported row is
// matched to an existing account by account_id or account_code and updated in
// place, otherwise created with a server-generated COA-#### id.
// ---------------------------------------------------------------------------

type RawRow = {
  account_id?: string
  account_code?: string
  account_name?: string
  account_group?: string
  account_type?: string
  parent?: string
  opening_balance?: string
  opening_balance_date?: string
  active_status?: string
}

const VALID_STATUS = new Set(["Active", "Inactive", "Archived"])

function normType(value: string): string {
  const v = (value || "").trim()
  const hit = COA_ACCOUNT_TYPES.find((t) => t.toLowerCase() === v.toLowerCase())
  return hit ?? ""
}

function toNumber(value: string): number {
  const n = Number(String(value ?? "").replace(/[,₹\s]/g, ""))
  return Number.isFinite(n) ? Math.round((n + Number.EPSILON) * 100) / 100 : 0
}

function parseDate(value: string): string | null {
  const trimmed = (value || "").trim()
  if (!trimmed) return null
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed
  const m = trimmed.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/)
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`
  const d = new Date(trimmed)
  if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10)
  return null
}

export async function POST(req: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  await ensureChartOfAccountsColumns().catch(() => {})

  const body = await req.json().catch(() => ({}))
  const rows: RawRow[] = Array.isArray(body?.rows) ? body.rows : []
  if (rows.length === 0) {
    return NextResponse.json({ error: "No rows to import." }, { status: 400 })
  }
  if (rows.length > 2000) {
    return NextResponse.json({ error: "Too many rows — import up to 2000 at a time." }, { status: 400 })
  }

  // Snapshot existing accounts so we can resolve parents (by id or code) and
  // decide create-vs-update without a query per row. Newly created accounts are
  // added to these maps as we go so a parent defined earlier in the same file
  // resolves for a child defined later.
  const existing = (await query(
    `SELECT id, account_id, account_code, account_group, active_status, is_system FROM chart_of_accounts`,
  )) as any[]
  const byId = new Map<string, any>()
  const byCode = new Map<string, any>()
  for (const r of existing) {
    byId.set(String(r.account_id), r)
    if (r.account_code) byCode.set(String(r.account_code).toLowerCase(), r)
  }

  let created = 0
  let updated = 0
  const errors: { row: number; account: string; message: string }[] = []
  const postedAccountIds: string[] = []

  for (let i = 0; i < rows.length; i++) {
    const raw = rows[i]
    const rowNo = i + 2 // account for the header row in the source sheet
    const name = (raw.account_name ?? "").toString().trim()
    const code = (raw.account_code ?? "").toString().trim()
    const label = name || code || `Row ${rowNo}`

    try {
      if (!name) {
        errors.push({ row: rowNo, account: label, message: "Account name is required." })
        continue
      }

      const group = normType(raw.account_group ?? "") || "Asset"
      const nature = natureForAccountType(group)

      // Match an existing account: prefer an explicit id, then a unique code.
      const target =
        (raw.account_id && byId.get(String(raw.account_id).trim())) ||
        (code && byCode.get(code.toLowerCase())) ||
        null

      // Resolve parent against ids first, then codes (existing + just-created).
      const parentRaw = (raw.parent ?? "").toString().trim()
      let parentId = ""
      if (parentRaw) {
        const p = byId.get(parentRaw) || byCode.get(parentRaw.toLowerCase())
        if (p) parentId = String(p.account_id)
        else
          errors.push({
            row: rowNo,
            account: label,
            message: `Parent "${parentRaw}" not found — imported as a top-level account.`,
          })
      }

      const status = VALID_STATUS.has((raw.active_status ?? "").trim())
        ? (raw.active_status ?? "").trim()
        : "Active"
      const opening = toNumber(raw.opening_balance ?? "")
      const obDate = parseDate(raw.opening_balance_date ?? "")
      const finYear = financialYearFor(obDate ?? new Date().toISOString().slice(0, 10))

      const merged: Record<string, any> = {
        id: target?.id,
        account_id: target?.account_id,
        account_code: code || target?.account_code || "",
        account_name: name,
        account_group: group,
        account_type: (raw.account_type ?? "").toString().trim(),
        nature,
        parent_account_id: parentId,
        opening_balance: opening,
        opening_balance_type: nature,
        opening_balance_date: obDate,
        financial_year: finYear,
        active_status: status,
      }

      const guard = await guardChartOfAccountWrite(merged, {
        isCreate: !target,
        existing: target ?? null,
      })
      if (guard) {
        errors.push({ row: rowNo, account: label, message: guard })
        continue
      }

      let accountId: string
      if (target) {
        accountId = String(target.account_id)
        await query(
          `UPDATE chart_of_accounts SET
             account_code = ?, account_name = ?, account_group = ?, account_type = ?,
             nature = ?, parent_account_id = ?, opening_balance = ?, opening_balance_type = ?,
             opening_balance_date = ?, financial_year = ?, active_status = ?
           WHERE id = ?`,
          [
            merged.account_code || null,
            merged.account_name,
            merged.account_group,
            merged.account_type || null,
            merged.nature,
            merged.parent_account_id || null,
            merged.opening_balance,
            merged.opening_balance_type,
            merged.opening_balance_date,
            merged.financial_year,
            merged.active_status,
            target.id,
          ],
        )
        updated++
      } else {
        accountId = await nextRecordId("COA")
        await query(
          `INSERT INTO chart_of_accounts
             (account_id, account_code, account_name, account_group, account_type, nature,
              parent_account_id, opening_balance, opening_balance_type, opening_balance_date,
              financial_year, active_status, is_system)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0)`,
          [
            accountId,
            merged.account_code || null,
            merged.account_name,
            merged.account_group,
            merged.account_type || null,
            merged.nature,
            merged.parent_account_id || null,
            merged.opening_balance,
            merged.opening_balance_type,
            merged.opening_balance_date,
            merged.financial_year,
            merged.active_status,
          ],
        )
        created++
        // Register the new account so later rows can parent to it by id/code.
        const rec = { id: 0, account_id: accountId, account_code: merged.account_code }
        byId.set(accountId, rec)
        if (merged.account_code) byCode.set(String(merged.account_code).toLowerCase(), rec)
      }

      postedAccountIds.push(accountId)
    } catch (error) {
      errors.push({ row: rowNo, account: label, message: (error as Error)?.message || "Import failed." })
    }
  }

  // Project every imported opening balance into a balanced Journal + GL voucher.
  // Idempotent per account, so re-imports never double-post.
  for (const accountId of postedAccountIds) {
    await syncOpeningBalancePosting(accountId, { createdBy: null }).catch(() => {})
  }

  return NextResponse.json({ created, updated, failed: errors.length, errors })
}
