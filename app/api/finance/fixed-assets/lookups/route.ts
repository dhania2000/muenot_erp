import { NextRequest, NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { query } from "@/lib/db"

export const runtime = "nodejs"

// Read-only master lookups for the Fixed Assets form. Every list resolves
// against modules that already own the data — the Chart of Accounts for the
// three posting heads, and the distinct vendor / cost-centre / department /
// project values already used across Finance and Fixed Assets — so nothing new
// is mastered here. Each probe is guarded so a module absent in a given install
// is simply skipped rather than failing the whole lookup.

type Account = { account_id: string; account_code: string | null; account_name: string; account_group: string | null; account_type: string | null }

async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn()
  } catch {
    return fallback
  }
}

async function distinct(sql: string): Promise<string[]> {
  const rows = await safe(() => query(sql) as Promise<any[]>, [])
  return rows.map((r) => String(Object.values(r)[0] ?? "").trim()).filter(Boolean)
}

export async function GET(_req: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const accounts = await safe(
    () =>
      query(
        `SELECT account_id, account_code, account_name, account_group, account_type
           FROM chart_of_accounts
          WHERE active_status = 'Active'
          ORDER BY account_code, account_name`,
      ) as Promise<Account[]>,
    [],
  )

  const isAsset = (a: Account) => String(a.account_group || "").toLowerCase() === "asset"
  const isExpense = (a: Account) => String(a.account_group || "").toLowerCase() === "expense"
  const looksDepreciation = (a: Account) => /deprecia/i.test(a.account_name)

  const assetAccounts = accounts.filter(isAsset)
  const accumulatedDepreciationAccounts = accounts.filter((a) => isAsset(a) && (looksDepreciation(a) || /fixed asset/i.test(String(a.account_type || ""))))
  const depreciationExpenseAccounts = accounts.filter(isExpense)

  const vendors = Array.from(
    new Set([
      ...(await distinct(`SELECT DISTINCT customer_name FROM customers_vendors WHERE customer_name IS NOT NULL AND customer_name <> '' LIMIT 200`)),
      ...(await distinct(`SELECT DISTINCT vendor FROM fixed_assets WHERE vendor IS NOT NULL AND vendor <> '' LIMIT 200`)),
    ]),
  ).sort()

  const costCentres = Array.from(
    new Set([
      ...(await distinct(`SELECT DISTINCT cost_centre FROM expenses WHERE cost_centre IS NOT NULL AND cost_centre <> '' LIMIT 200`)),
      ...(await distinct(`SELECT DISTINCT cost_centre FROM fixed_assets WHERE cost_centre IS NOT NULL AND cost_centre <> '' LIMIT 200`)),
    ]),
  ).sort()

  const departments = Array.from(
    new Set([
      ...(await distinct(`SELECT DISTINCT department FROM hr_employees WHERE department IS NOT NULL AND department <> '' LIMIT 200`)),
      ...(await distinct(`SELECT DISTINCT department FROM fixed_assets WHERE department IS NOT NULL AND department <> '' LIMIT 200`)),
    ]),
  ).sort()

  const projects = await distinct(`SELECT DISTINCT project_name FROM operations_projects WHERE project_name IS NOT NULL AND project_name <> '' ORDER BY project_name LIMIT 200`)

  return NextResponse.json({
    assetAccounts,
    accumulatedDepreciationAccounts,
    depreciationExpenseAccounts,
    vendors,
    costCentres,
    departments,
    projects,
  })
}
