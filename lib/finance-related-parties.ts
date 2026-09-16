import "server-only"
import { query } from "@/lib/db"
import { ensureRegisterModuleTables } from "@/lib/finance-ensure"

// ---------------------------------------------------------------------------
// Related-party transaction identification (Phase 8, AS 18 / Ind AS 24)
// ---------------------------------------------------------------------------
// Related Parties is a disclosure master — it never records its own
// transactions. Instead, every existing Finance transaction (purchase bills,
// sales invoices, expenses, payments, journals, loans, provisions) is scanned
// and matched back to a declared related party. A transaction is a
// related-party transaction when its counterparty matches an *Active* related
// party by PAN, by GSTIN, or by name — and the transaction date falls inside
// that relationship's effective window (open-ended when either bound is null).
//
// Every source query is defensive: a source table or column that does not
// exist on this database yields an empty contribution instead of a 500, so the
// panel degrades gracefully as modules come and go.

export type RelatedPartyTxn = {
  party_id: string
  related_party: string
  relationship: string
  matched_on: "PAN" | "GSTIN" | "Name"
  source: string
  reference: string
  txn_date: string | null
  amount: number
}

export type RelatedPartyTxnResult = {
  rows: RelatedPartyTxn[]
  summary: {
    total_transactions: number
    total_amount: number
    related_parties_with_activity: number
    sources: { source: string; count: number; amount: number }[]
  }
  /** True when the related_parties master itself has at least one row. */
  hasParties: boolean
}

// A single source of finance transactions and how its counterparty columns map
// onto the related-party identity. `panColumn` / `gstinColumn` are omitted when
// the source table carries no such column (only a name match is then possible).
type Source = {
  key: string
  label: string
  table: string
  refColumn: string
  dateColumn: string
  amountExpr: string
  nameColumn: string
  panColumn?: string
  gstinColumn?: string
}

const SOURCES: Source[] = [
  {
    key: "purchase-bills",
    label: "Purchase Bill",
    table: "purchase_bills",
    refColumn: "bill_id",
    dateColumn: "bill_date",
    amountExpr: "COALESCE(t.gross_bill_amount, 0)",
    nameColumn: "vendor_name",
    panColumn: "vendor_pan",
    gstinColumn: "vendor_gstin",
  },
  {
    key: "sales-invoices",
    label: "Sales Invoice",
    table: "sales_invoices",
    refColumn: "invoice_id",
    dateColumn: "invoice_date",
    amountExpr: "COALESCE(t.invoice_total, 0)",
    // sales_invoices stores the customer name inline but keeps PAN/GSTIN on the
    // Clients master, so PAN/GSTIN columns are declared optionally and only used
    // when present on this database (resolveColumns drops them otherwise).
    nameColumn: "client_name",
    panColumn: "client_pan",
    gstinColumn: "client_gstin",
  },
  {
    key: "expenses",
    label: "Expense",
    table: "expenses",
    refColumn: "expense_id",
    dateColumn: "expense_date",
    amountExpr: "COALESCE(t.gross_amount, t.net_payable, t.taxable_amount, 0)",
    nameColumn: "party_name",
    panColumn: "vendor_pan",
    gstinColumn: "vendor_gstin",
  },
  {
    key: "payments",
    label: "Payment",
    table: "payments",
    refColumn: "payment_id",
    dateColumn: "payment_date",
    amountExpr: "COALESCE(t.net_amount, t.amount, 0)",
    nameColumn: "party_name",
  },
  {
    key: "journal-entries",
    label: "Journal Entry",
    table: "journal_entries",
    refColumn: "journal_entry_id",
    dateColumn: "journal_date",
    amountExpr: "COALESCE(t.debit, 0) + COALESCE(t.credit, 0)",
    nameColumn: "party_name",
  },
  {
    key: "loans-advances",
    label: "Loan / Advance",
    table: "loans_advances",
    refColumn: "loan_id",
    dateColumn: "disbursement_date",
    amountExpr: "COALESCE(t.principal, 0)",
    nameColumn: "party_name",
  },
  {
    key: "provisions-accruals",
    label: "Provision / Accrual",
    table: "provisions_accruals",
    refColumn: "provision_id",
    dateColumn: "provision_date",
    amountExpr: "COALESCE(t.amount, 0)",
    nameColumn: "related_party",
  },
]

/**
 * Which of a table's columns actually exist on this database. A source that is
 * missing its reference / date / name column is skipped entirely; a missing
 * PAN or GSTIN column simply drops that match clause rather than failing the
 * whole query (MySQL rejects a reference to a non-existent column).
 */
async function tableColumns(table: string): Promise<Set<string> | null> {
  try {
    const rows = (await query(
      `SELECT COLUMN_NAME AS c FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
      [table],
    )) as any[]
    if (rows.length === 0) return null
    return new Set(rows.map((r) => String(r.c)))
  } catch {
    return null
  }
}

/**
 * Build the JOIN predicate that links a source transaction to an Active related
 * party. Matching precedence is PAN → GSTIN → Name; the `matched_on` label is
 * resolved by the same precedence so the strongest identifier wins. Only the
 * columns present in `cols` are referenced.
 */
function matchConditions(src: Source, cols: Set<string>) {
  const hasPan = !!src.panColumn && cols.has(src.panColumn)
  const hasGstin = !!src.gstinColumn && cols.has(src.gstinColumn)

  const clauses: string[] = []
  if (hasPan) {
    clauses.push(`(rp.pan <> '' AND UPPER(TRIM(t.${src.panColumn})) = UPPER(TRIM(rp.pan)))`)
  }
  if (hasGstin) {
    clauses.push(`(rp.gstin <> '' AND UPPER(TRIM(t.${src.gstinColumn})) = UPPER(TRIM(rp.gstin)))`)
  }
  clauses.push(
    `(t.${src.nameColumn} <> '' AND LOWER(TRIM(t.${src.nameColumn})) = LOWER(TRIM(rp.party_name)))`,
  )

  const matchedOn: string[] = []
  if (hasPan) {
    matchedOn.push(`WHEN rp.pan <> '' AND UPPER(TRIM(t.${src.panColumn})) = UPPER(TRIM(rp.pan)) THEN 'PAN'`)
  }
  if (hasGstin) {
    matchedOn.push(`WHEN rp.gstin <> '' AND UPPER(TRIM(t.${src.gstinColumn})) = UPPER(TRIM(rp.gstin)) THEN 'GSTIN'`)
  }

  return {
    join: `(${clauses.join(" OR ")})`,
    matchedOnExpr: matchedOn.length ? `CASE ${matchedOn.join(" ")} ELSE 'Name' END` : `'Name'`,
  }
}

async function runSource(src: Source): Promise<RelatedPartyTxn[]> {
  const cols = await tableColumns(src.table)
  // Skip a source whose table is absent or lacks the columns we depend on.
  if (!cols || !cols.has(src.refColumn) || !cols.has(src.dateColumn) || !cols.has(src.nameColumn)) {
    return []
  }

  const { join, matchedOnExpr } = matchConditions(src, cols)
  const sql = `
    SELECT rp.party_id                       AS party_id,
           rp.party_name                     AS related_party,
           COALESCE(NULLIF(rp.relationship,''),'—') AS relationship,
           ${matchedOnExpr}                  AS matched_on,
           '${src.label}'                    AS source,
           COALESCE(NULLIF(t.${src.refColumn},''),'—') AS reference,
           t.${src.dateColumn}               AS txn_date,
           ${src.amountExpr}                 AS amount
    FROM ${src.table} t
    JOIN related_parties rp
      ON rp.status = 'Active'
     AND ${join}
     AND (rp.effective_from IS NULL OR t.${src.dateColumn} IS NULL OR t.${src.dateColumn} >= rp.effective_from)
     AND (rp.effective_to   IS NULL OR t.${src.dateColumn} IS NULL OR t.${src.dateColumn} <= rp.effective_to)
    ORDER BY t.${src.dateColumn} DESC`

  try {
    const rows = (await query(sql)) as any[]
    return rows.map((r) => ({
      party_id: String(r.party_id ?? ""),
      related_party: String(r.related_party ?? ""),
      relationship: String(r.relationship ?? "—"),
      matched_on: (r.matched_on as RelatedPartyTxn["matched_on"]) ?? "Name",
      source: String(r.source ?? src.label),
      reference: String(r.reference ?? "—"),
      txn_date: r.txn_date ? String(r.txn_date).slice(0, 10) : null,
      amount: Number(r.amount) || 0,
    }))
  } catch (err) {
    console.log("[v0] related-party source failed for", src.table, (err as Error).message)
    return []
  }
}

export async function identifyRelatedPartyTransactions(): Promise<RelatedPartyTxnResult> {
  await ensureRegisterModuleTables()

  let hasParties = false
  try {
    const [{ c } = { c: 0 }] = (await query(
      "SELECT COUNT(*) AS c FROM related_parties WHERE status = 'Active'",
    )) as any[]
    hasParties = Number(c) > 0
  } catch {
    hasParties = false
  }

  // No active related parties → nothing can match, skip the source scans.
  if (!hasParties) {
    return {
      rows: [],
      summary: { total_transactions: 0, total_amount: 0, related_parties_with_activity: 0, sources: [] },
      hasParties: false,
    }
  }

  const perSource = await Promise.all(SOURCES.map(runSource))
  const rows = perSource.flat()

  // Newest transactions first across all sources.
  rows.sort((a, b) => (b.txn_date ?? "").localeCompare(a.txn_date ?? ""))

  const sourceAgg = new Map<string, { count: number; amount: number }>()
  const activeParties = new Set<string>()
  let totalAmount = 0
  for (const r of rows) {
    totalAmount += r.amount
    activeParties.add(r.party_id || r.related_party)
    const agg = sourceAgg.get(r.source) ?? { count: 0, amount: 0 }
    agg.count += 1
    agg.amount += r.amount
    sourceAgg.set(r.source, agg)
  }

  return {
    rows,
    summary: {
      total_transactions: rows.length,
      total_amount: totalAmount,
      related_parties_with_activity: activeParties.size,
      sources: [...sourceAgg.entries()].map(([source, v]) => ({ source, ...v })),
    },
    hasParties: true,
  }
}
