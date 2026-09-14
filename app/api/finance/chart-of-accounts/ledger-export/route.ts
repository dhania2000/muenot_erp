import { NextRequest, NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { query } from "@/lib/db"

// ---------------------------------------------------------------------------
// Chart of Accounts — Account Ledger export (requirement 49).
//
// Returns every posted General Ledger line, grouped by account and ordered
// chronologically so the stored running balance reads top-down. Optionally
// scoped to a single account via ?accountId=. This is a pure read of the
// existing general_ledger — it exposes the same data the account-detail page
// already shows, formatted for a spreadsheet export.
// ---------------------------------------------------------------------------

export async function GET(req: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const accountId = req.nextUrl.searchParams.get("accountId")?.trim() || ""

  const where = accountId ? "WHERE gl.account_id = ?" : ""
  const args = accountId ? [accountId] : []

  const rows = (await query(
    `SELECT gl.account_id, gl.account_name, gl.account_group,
            coa.account_code,
            gl.ledger_id, gl.transaction_date, gl.voucher_no, gl.voucher_type,
            gl.reference_no, gl.party_name, gl.description,
            gl.debit, gl.credit, gl.balance, gl.balance_type,
            gl.source_module, gl.source_reference, gl.journal_entry_id
       FROM general_ledger gl
       LEFT JOIN chart_of_accounts coa ON coa.account_id = gl.account_id
       ${where}
      ORDER BY gl.account_id ASC, gl.transaction_date ASC, gl.id ASC
      LIMIT 20000`,
    args,
  ).catch(() => [])) as any[]

  return NextResponse.json({ rows })
}
