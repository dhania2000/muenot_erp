import "server-only"
import { query, tableColumns } from "@/lib/db"

// =============================================================================
// SPEC 163 — Finance Core Integration (accounting-event architecture).
// -----------------------------------------------------------------------------
// Finance is the single source of truth for money. Every operational module —
// Sales, Purchases, Expenses, Payroll, Banking, Assets, Projects, Tax — feeds
// the SAME double-entry engine (finance-posting / finance-register-posting /
// finance-expense-posting / finance-bank-posting) and the SAME journal_entries
// + general_ledger tables. No module keeps its own parallel ledger.
//
// This layer adds NO new accounting logic. It is a read-only cockpit that:
//   * PHASE 1 — maps every existing Finance integration (the registry below);
//   * PHASE 2 — formalises the "accounting event": a posted source document is
//     stamped onto the ledger via source_module / source_reference /
//     source_entity_* and linked back by voucher_no, so a source row and its
//     ledger rows are always traceable to each other;
//   * PHASE 3 — surfaces each spec module and HOW it connects (a source table,
//     an accounting dimension, or a tax overlay);
//   * PHASE 4 — reconciles source transactions against the ledger: how many
//     source documents are posted, how many are stuck Unposted, and the posted
//     value / reconciliation state on the ledger side.
//
// Every table/column is probed with tableColumns() first, so an install whose
// Finance schema differs simply reports "no data" instead of crashing — exactly
// like operations-finance-report.ts.
// =============================================================================

const num = (v: unknown) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100

/** How a module reaches the ledger — drives the reconciliation strategy. */
export type IntegrationKind = "source" | "dimension" | "tax" | "account"

export type AccountingEventSource = {
  /** Stable key for the module card. */
  key: string
  /** Spec module name (one of the eight in SPEC 163). */
  module: string
  /** The concrete document / register that feeds the ledger. */
  sourceLabel: string
  /** One-line description of what flows into Finance. */
  description: string
  /** Lucide icon name, resolved on the client. */
  icon: string
  /** Reconciliation strategy for this module. */
  kind: IntegrationKind
  /** Route to the owning source module. */
  link: string
  /** Human description of the shared engine it posts through (no duplicate logic). */
  postingPath: string
  /** Source table for kind === "source". */
  table?: string
  /** Business-key column on the source table. */
  idColumn?: string
  /** Candidate money columns (first present wins) for the source-side total. */
  amountColumns?: string[]
  /** general_ledger.source_module value(s) produced by this module. */
  sourceModules?: string[]
  /** For kind === "account": account name/group patterns the postings land on. */
  accountPatterns?: string[]
}

/**
 * PHASE 1 + 3 — the canonical map of Finance integrations. Each of the eight
 * SPEC 163 modules appears exactly once, pointed at the real posting path it
 * already uses. Adding a genuinely new source module means adding one row here,
 * never a second accounting engine.
 */
export const ACCOUNTING_EVENT_SOURCES: AccountingEventSource[] = [
  {
    key: "sales",
    module: "Sales",
    sourceLabel: "Sales Invoices",
    description: "Customer invoices recognise receivable, revenue and output tax.",
    icon: "ReceiptText",
    kind: "source",
    link: "/modules/finance/sales-invoices",
    postingPath: "Posted through the double-entry engine (postSalesInvoice).",
    table: "sales_invoices",
    idColumn: "invoice_id",
    amountColumns: ["invoice_total", "grand_total", "total_amount", "net_receivable"],
    sourceModules: ["Sales Invoice"],
  },
  {
    key: "purchases",
    module: "Purchases",
    sourceLabel: "Purchase Bills",
    description: "Vendor bills recognise purchases/expense, input tax credit and payable.",
    icon: "ShoppingCart",
    kind: "source",
    link: "/modules/finance/purchase-bills",
    postingPath: "Posted through the double-entry engine (syncPurchaseBillPosting).",
    table: "purchase_bills",
    idColumn: "bill_id",
    amountColumns: ["gross_bill_amount", "grand_total", "total_amount"],
    sourceModules: ["Purchase Bill"],
  },
  {
    key: "expenses",
    module: "Expenses",
    sourceLabel: "Expenses",
    description: "Approved expenses accrue the cost and the employee / vendor payable.",
    icon: "Wallet",
    kind: "source",
    link: "/modules/finance/expenses",
    postingPath: "Posted through the shared engine (syncExpensePosting); recruitment costs mirror in here too.",
    table: "expenses",
    idColumn: "expense_id",
    amountColumns: ["gross_amount", "total_amount", "amount", "taxable_amount"],
    sourceModules: ["Expense", "Expense Payment"],
  },
  {
    key: "payroll",
    module: "Payroll",
    sourceLabel: "Salary & Wages",
    description: "Payroll costs book to salary / wage heads via Finance, not a parallel ledger.",
    icon: "Users",
    kind: "account",
    link: "/modules/finance/journal-entries",
    postingPath: "Routed through Finance Expenses & Journal onto salary / wage account heads.",
    accountPatterns: ["salary", "salaries", "payroll", "wages", "wage", "payslip", "remuneration"],
    sourceModules: ["Payroll"],
  },
  {
    key: "banking",
    module: "Banking",
    sourceLabel: "Bank & Cash Transactions",
    description: "Receipts and payments move cash and clear the contra account head.",
    icon: "Landmark",
    kind: "source",
    link: "/modules/finance/bank-transactions",
    postingPath: "Posted through the shared engine (syncBankTransactionPosting).",
    table: "bank_transactions",
    idColumn: "transaction_id",
    amountColumns: ["amount", "transaction_amount", "deposit", "withdrawal"],
    sourceModules: ["Bank Transaction", "Payment", "Expense Payment"],
  },
  {
    key: "assets",
    module: "Assets",
    sourceLabel: "Fixed Assets & Registers",
    description: "Asset acquisitions capitalise cost against the funding source.",
    icon: "Boxes",
    kind: "source",
    link: "/modules/finance/fixed-assets",
    postingPath: "Posted through the register engine (syncRegisterPosting).",
    table: "fixed_assets",
    idColumn: "asset_id",
    amountColumns: ["cost", "acquisition_cost", "amount"],
    sourceModules: ["Fixed Assets", "Investments", "Loans & Advances", "Provisions & Accruals", "Capital & Equity"],
  },
  {
    key: "projects",
    module: "Projects",
    sourceLabel: "Project Costing",
    description: "Every posting can carry a project tag; project cost rolls up live.",
    icon: "FolderKanban",
    kind: "dimension",
    link: "/modules/operations/project-cost",
    postingPath: "Connected as an accounting dimension — postings are tagged with project_id / project_name.",
  },
  {
    key: "tax",
    module: "Tax",
    sourceLabel: "GST & TDS",
    description: "GST and TDS are captured on every posting and settled by filings.",
    icon: "Percent",
    kind: "tax",
    link: "/modules/finance/gst-filing",
    postingPath: "GST / TDS captured on each posting; filings post through the engine (GST Filing, TDS Filing).",
    sourceModules: ["GST Filing", "TDS Filing"],
  },
]

type GlAggregate = {
  rows: number
  vouchers: number
  debit: number
  credit: number
  gst: number
  tds: number
  reconciled: number
}

const emptyAgg = (): GlAggregate => ({ rows: 0, vouchers: 0, debit: 0, credit: 0, gst: 0, tds: 0, reconciled: 0 })

function readAgg(row: any): GlAggregate {
  return {
    rows: num(row?.rows),
    vouchers: num(row?.vouchers),
    debit: round2(num(row?.debit)),
    credit: round2(num(row?.credit)),
    gst: round2(num(row?.gst)),
    tds: round2(num(row?.tds)),
    reconciled: num(row?.reconciled),
  }
}

const RECON_EXPR = `CASE WHEN COALESCE(NULLIF(reconciliation_status,''),'Unreconciled') = 'Reconciled' THEN 1 ELSE 0 END`

/** Pull the whole ledger, grouped by source_module, in one pass. */
async function ledgerBySourceModule(): Promise<Map<string, GlAggregate>> {
  const cols = await tableColumns("general_ledger")
  if (!cols.has("source_module")) return new Map()
  const rows = (await query(
    `SELECT COALESCE(NULLIF(source_module,''),'—') AS source_module,
            COUNT(*) AS rows,
            COUNT(DISTINCT voucher_no) AS vouchers,
            SUM(debit) AS debit, SUM(credit) AS credit,
            SUM(gst_amount) AS gst, SUM(tds_amount) AS tds,
            SUM(${RECON_EXPR}) AS reconciled
       FROM general_ledger
      GROUP BY 1`,
  )) as any[]
  const map = new Map<string, GlAggregate>()
  for (const r of rows) map.set(String(r.source_module), readAgg(r))
  return map
}

/** Ledger activity tagged to a project (the Projects dimension link). */
async function ledgerForProjects(): Promise<GlAggregate & { projects: number }> {
  const cols = await tableColumns("general_ledger")
  if (!cols.has("project_id") && !cols.has("project_name")) return { ...emptyAgg(), projects: 0 }
  const hasId = cols.has("project_id")
  const hasName = cols.has("project_name")
  const where = [
    hasId ? `(project_id IS NOT NULL AND project_id <> '')` : null,
    hasName ? `(project_name IS NOT NULL AND project_name <> '')` : null,
  ]
    .filter(Boolean)
    .join(" OR ")
  const dim = hasName ? `COALESCE(NULLIF(project_name,''), project_id)` : `project_id`
  const [row] = (await query(
    `SELECT COUNT(*) AS rows, COUNT(DISTINCT voucher_no) AS vouchers,
            SUM(debit) AS debit, SUM(credit) AS credit,
            SUM(gst_amount) AS gst, SUM(tds_amount) AS tds,
            SUM(${RECON_EXPR}) AS reconciled,
            COUNT(DISTINCT ${dim}) AS projects
       FROM general_ledger
      WHERE ${where}`,
  )) as any[]
  return { ...readAgg(row), projects: num(row?.projects) }
}

/** Ledger activity landing on salary / wage account heads (the Payroll link). */
async function ledgerForAccountPatterns(patterns: string[]): Promise<GlAggregate> {
  const cols = await tableColumns("general_ledger")
  const targets = [
    cols.has("account_name") ? "account_name" : null,
    cols.has("account_group") ? "account_group" : null,
    cols.has("account_type") ? "account_type" : null,
  ].filter(Boolean) as string[]
  if (!targets.length || !patterns.length) return emptyAgg()
  const clauses: string[] = []
  const args: any[] = []
  for (const col of targets) {
    for (const p of patterns) {
      clauses.push(`LOWER(${col}) LIKE ?`)
      args.push(`%${p.toLowerCase()}%`)
    }
  }
  const [row] = (await query(
    `SELECT COUNT(*) AS rows, COUNT(DISTINCT voucher_no) AS vouchers,
            SUM(debit) AS debit, SUM(credit) AS credit,
            SUM(gst_amount) AS gst, SUM(tds_amount) AS tds,
            SUM(${RECON_EXPR}) AS reconciled
       FROM general_ledger
      WHERE ${clauses.join(" OR ")}`,
    args,
  )) as any[]
  return readAgg(row)
}

type SourceDocStats = { total: number; posted: number; unposted: number; attention: number; amount: number | null }

/** Count / total the source documents for a table-backed module. */
async function sourceDocStats(src: AccountingEventSource): Promise<SourceDocStats | null> {
  if (!src.table || !src.idColumn) return null
  let cols: Set<string>
  try {
    cols = await tableColumns(src.table)
  } catch {
    return null
  }
  if (!cols.size) return null

  const hasVoucher = cols.has("voucher_no")
  const hasPostingStatus = cols.has("posting_status")
  const amountCol = (src.amountColumns ?? []).find((c) => cols.has(c)) ?? null

  const postedExpr = hasVoucher
    ? `SUM(CASE WHEN voucher_no IS NOT NULL AND voucher_no <> '' THEN 1 ELSE 0 END)`
    : `0`
  const attentionExpr = hasPostingStatus
    ? `SUM(CASE WHEN COALESCE(NULLIF(posting_status,''),'') = 'Unposted' THEN 1 ELSE 0 END)`
    : `0`
  const amountExpr = amountCol ? `SUM(\`${amountCol}\`)` : `NULL`

  try {
    const [row] = (await query(
      `SELECT COUNT(*) AS total, ${postedExpr} AS posted, ${attentionExpr} AS attention, ${amountExpr} AS amount
         FROM \`${src.table}\``,
    )) as any[]
    const total = num(row?.total)
    const posted = num(row?.posted)
    return {
      total,
      posted,
      unposted: Math.max(0, total - posted),
      attention: num(row?.attention),
      amount: amountCol ? round2(num(row?.amount)) : null,
    }
  } catch {
    return null
  }
}

export type ModuleIntegration = {
  key: string
  module: string
  sourceLabel: string
  description: string
  icon: string
  kind: IntegrationKind
  link: string
  postingPath: string
  docs: SourceDocStats | null
  ledger: {
    rows: number
    vouchers: number
    value: number
    gst: number
    tds: number
    reconciled: number
    unreconciled: number
    projects?: number
  }
  status: "Connected" | "Attention" | "Pending" | "Idle"
}

export type IntegrationOverview = {
  generatedAt: string
  summary: {
    modules: number
    connectedModules: number
    attentionModules: number
    ledgerVouchers: number
    ledgerValue: number
    taxCaptured: number
    unreconciledRows: number
    attentionDocs: number
  }
  modules: ModuleIntegration[]
}

function statusFor(kind: IntegrationKind, docs: SourceDocStats | null, ledgerVouchers: number): ModuleIntegration["status"] {
  if (docs) {
    if (docs.attention > 0) return "Attention"
    if (docs.posted > 0) return "Connected"
    if (docs.total > 0) return "Pending"
    return "Idle"
  }
  return ledgerVouchers > 0 ? "Connected" : "Idle"
}

/**
 * PHASE 4 — build the live reconciliation overview across all eight modules.
 * Runs the ledger aggregates once and the per-source-table probes in parallel.
 */
export async function getIntegrationOverview(): Promise<IntegrationOverview> {
  const [glMap, projectAgg, taxTotals] = await Promise.all([
    ledgerBySourceModule(),
    ledgerForProjects(),
    (async () => {
      const cols = await tableColumns("general_ledger")
      if (!cols.has("gst_amount") && !cols.has("tds_amount")) return { gst: 0, tds: 0 }
      const [row] = (await query(
        `SELECT SUM(gst_amount) AS gst, SUM(tds_amount) AS tds FROM general_ledger`,
      )) as any[]
      return { gst: round2(num(row?.gst)), tds: round2(num(row?.tds)) }
    })(),
  ])

  const modules: ModuleIntegration[] = await Promise.all(
    ACCOUNTING_EVENT_SOURCES.map(async (src) => {
      // Sum the ledger side across every source_module this module produces.
      let agg = emptyAgg()
      let projects: number | undefined
      if (src.kind === "dimension") {
        agg = projectAgg
        projects = projectAgg.projects
      } else if (src.kind === "account") {
        agg = await ledgerForAccountPatterns(src.accountPatterns ?? [])
      } else {
        for (const sm of src.sourceModules ?? []) {
          const a = glMap.get(sm)
          if (!a) continue
          agg = {
            rows: agg.rows + a.rows,
            vouchers: agg.vouchers + a.vouchers,
            debit: round2(agg.debit + a.debit),
            credit: round2(agg.credit + a.credit),
            gst: round2(agg.gst + a.gst),
            tds: round2(agg.tds + a.tds),
            reconciled: agg.reconciled + a.reconciled,
          }
        }
      }

      const docs = src.kind === "source" ? await sourceDocStats(src) : null

      return {
        key: src.key,
        module: src.module,
        sourceLabel: src.sourceLabel,
        description: src.description,
        icon: src.icon,
        kind: src.kind,
        link: src.link,
        postingPath: src.postingPath,
        docs,
        ledger: {
          rows: agg.rows,
          vouchers: agg.vouchers,
          value: round2(Math.max(agg.debit, agg.credit)),
          gst: agg.gst,
          tds: agg.tds,
          reconciled: agg.reconciled,
          unreconciled: Math.max(0, agg.rows - agg.reconciled),
          projects,
        },
        status: statusFor(src.kind, docs, agg.vouchers),
      } satisfies ModuleIntegration
    }),
  )

  const ledgerVouchers = modules.reduce((s, m) => s + m.ledger.vouchers, 0)
  const ledgerValue = round2(modules.reduce((s, m) => s + m.ledger.value, 0))
  const unreconciledRows = modules.reduce((s, m) => s + m.ledger.unreconciled, 0)
  const attentionDocs = modules.reduce((s, m) => s + (m.docs?.attention ?? 0), 0)

  return {
    generatedAt: new Date().toISOString(),
    summary: {
      modules: modules.length,
      connectedModules: modules.filter((m) => m.status === "Connected").length,
      attentionModules: modules.filter((m) => m.status === "Attention").length,
      ledgerVouchers,
      ledgerValue,
      taxCaptured: round2(taxTotals.gst + taxTotals.tds),
      unreconciledRows,
      attentionDocs,
    },
    modules,
  }
}

export type PostingException = {
  module: string
  sourceLabel: string
  link: string
  reference: string
  postingStatus: string
}

/**
 * PHASE 4 — the reconciliation exceptions: table-backed source documents that
 * are stuck in an "Unposted" state (a posting was expected but did not land on
 * the ledger). These are exactly the rows the ledger sync / a re-save repairs.
 */
export async function getPostingExceptions(limitPerModule = 20): Promise<PostingException[]> {
  const out: PostingException[] = []
  for (const src of ACCOUNTING_EVENT_SOURCES) {
    if (src.kind !== "source" || !src.table || !src.idColumn) continue
    let cols: Set<string>
    try {
      cols = await tableColumns(src.table)
    } catch {
      continue
    }
    if (!cols.has("posting_status") || !cols.has(src.idColumn)) continue
    try {
      const rows = (await query(
        `SELECT \`${src.idColumn}\` AS reference, posting_status
           FROM \`${src.table}\`
          WHERE COALESCE(NULLIF(posting_status,''),'') = 'Unposted'
          ORDER BY id DESC
          LIMIT ?`,
        [limitPerModule],
      )) as any[]
      for (const r of rows) {
        out.push({
          module: src.module,
          sourceLabel: src.sourceLabel,
          link: src.link,
          reference: String(r.reference ?? "—"),
          postingStatus: String(r.posting_status ?? "Unposted"),
        })
      }
    } catch {
      // Table shape differs on this install — skip it, never crash the cockpit.
    }
  }
  return out
}
