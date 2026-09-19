import "server-only"
import { pool, query } from "@/lib/db"
import { nextRecordId } from "@/lib/record-ids"
import { financialYearFor } from "@/lib/finance-calc"
import { postLines, type PostingLine } from "@/lib/finance-posting"
import { ensureFixedAssetAccounts, type AccountRole } from "@/lib/finance-accounts"

// ---------------------------------------------------------------------------
// Fixed Assets accounting engine (Phase 3, server-only).
//
// A dedicated module — richer than the generic register — that turns each
// lifecycle event of an asset into a balanced voucher through the SHARED
// posting engine (lib/finance-posting.postLines). Nothing here writes to the
// General Ledger directly: every posting goes Journal → GL through postLines,
// so the Trial Balance, Balance Sheet and the "Fixed Assets Register" report
// (which reads the posted GL) all reflect it automatically.
//
// Lifecycle: Create (Draft, no posting) → Capitalise (Dr Asset / Cr funding) →
// Depreciate (Dr Dep Expense / Cr Accumulated Depreciation, monthly) →
// Transfer (custodian / location move, no posting) → Dispose or Scrap (remove
// the asset at cost, unwind accumulated depreciation, book gain / loss) →
// Archive (soft close, no posting).
// ---------------------------------------------------------------------------

export const round2 = (n: number) => Math.round((Number(n) + Number.EPSILON) * 100) / 100
const num = (v: any) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}
const today = () => new Date().toISOString().slice(0, 10)
const dateOf = (v: any) => String(v || today()).slice(0, 10)
const monthOf = (v: any) => dateOf(v).slice(0, 7)

export const ASSET_CATEGORIES = [
  "Plant & Machinery",
  "Buildings",
  "Vehicles",
  "Furniture & Fixtures",
  "Computers & IT",
  "Office Equipment",
  "Intangible Assets",
  "Land",
  "Other",
]

export const DEPRECIATION_METHODS = ["Straight Line", "Written Down Value", "None"]
export const FUNDING_SOURCES = ["Bank", "Cash", "Accounts Payable", "Owner Capital"]

/** Statuses in which an asset is live on the books and may be depreciated. */
export const ACTIVE_STATUSES = new Set(["In Use", "Under Repair", "Idle"])
/** Terminal statuses — no further depreciation / posting. */
export const CLOSED_STATUSES = new Set(["Disposed", "Scrapped", "Archived"])

// ---------------------------------------------------------------------------
// Self-healing schema. The base `fixed_assets` table is created by
// lib/finance-ensure.ensureRegisterModuleTables; here we add the richer Phase-3
// columns and the depreciation-schedule / transfer-history side tables. MySQL
// has no "ADD COLUMN IF NOT EXISTS", so we probe information_schema first.
// Runs once per process.
// ---------------------------------------------------------------------------
let schemaEnsured = false

async function ensureColumn(table: string, column: string, definition: string) {
  const rows = (await query(
    `SELECT 1 FROM information_schema.columns
       WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ? LIMIT 1`,
    [table, column],
  )) as any[]
  if (rows.length === 0) {
    await query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`)
  }
}

export async function ensureFixedAssetSchema(): Promise<void> {
  if (schemaEnsured) return

  // The base table (asset_id, asset_name, asset_category, acquisition_date,
  // cost, funding_source, depreciation_method, useful_life_years, salvage_value,
  // accumulated_depreciation, net_book_value, location, custodian, status,
  // notes, posting columns) must exist before we extend it.
  const [baseTable] = (await query(
    `SELECT 1 FROM information_schema.tables
       WHERE table_schema = DATABASE() AND table_name = 'fixed_assets' LIMIT 1`,
  )) as any[]
  if (!baseTable) {
    const { ensureRegisterModuleTables } = await import("@/lib/finance-ensure")
    await ensureRegisterModuleTables()
  }

  const additions: Array<[string, string]> = [
    ["asset_type", "VARCHAR(80) DEFAULT NULL"],
    ["vendor", "VARCHAR(190) DEFAULT NULL"],
    ["purchase_bill", "VARCHAR(60) DEFAULT NULL"],
    ["purchase_date", "DATE DEFAULT NULL"],
    ["put_to_use_date", "DATE DEFAULT NULL"],
    ["quantity", "DECIMAL(14,2) NOT NULL DEFAULT 1"],
    ["gross_cost", "DECIMAL(16,2) NOT NULL DEFAULT 0"],
    ["gst_amount", "DECIMAL(16,2) NOT NULL DEFAULT 0"],
    ["capitalised_cost", "DECIMAL(16,2) NOT NULL DEFAULT 0"],
    ["department", "VARCHAR(120) DEFAULT NULL"],
    ["project", "VARCHAR(120) DEFAULT NULL"],
    ["cost_centre", "VARCHAR(120) DEFAULT NULL"],
    ["depreciation_rate", "DECIMAL(6,2) NOT NULL DEFAULT 0"],
    ["residual_value", "DECIMAL(16,2) NOT NULL DEFAULT 0"],
    ["asset_account", "VARCHAR(40) DEFAULT NULL"],
    ["accumulated_depreciation_account", "VARCHAR(40) DEFAULT NULL"],
    ["depreciation_expense_account", "VARCHAR(40) DEFAULT NULL"],
    ["documents", "TEXT DEFAULT NULL"],
    ["capitalised_at", "DATETIME DEFAULT NULL"],
    ["depreciation_start_date", "DATE DEFAULT NULL"],
    ["last_depreciation_date", "DATE DEFAULT NULL"],
    ["disposal_date", "DATE DEFAULT NULL"],
    ["disposal_proceeds", "DECIMAL(16,2) NOT NULL DEFAULT 0"],
    ["disposal_mode", "VARCHAR(40) DEFAULT NULL"],
    ["disposal_voucher_no", "VARCHAR(40) DEFAULT NULL"],
    ["disposal_result", "DECIMAL(16,2) NOT NULL DEFAULT 0"],
    ["archived_at", "DATETIME DEFAULT NULL"],
  ]
  for (const [col, def] of additions) await ensureColumn("fixed_assets", col, def)

  // Per-period depreciation schedule. One row per asset + accounting month makes
  // the monthly run idempotent (a repeat run for the same month is a no-op) and
  // gives the asset a full depreciation history keyed to its posted voucher.
  await query(`CREATE TABLE IF NOT EXISTS fixed_asset_depreciation (
    id               INT AUTO_INCREMENT PRIMARY KEY,
    asset_id         VARCHAR(30) NOT NULL,
    period           VARCHAR(7) NOT NULL,
    depreciation_date DATE DEFAULT NULL,
    amount           DECIMAL(16,2) NOT NULL DEFAULT 0,
    method           VARCHAR(40) DEFAULT NULL,
    opening_nbv      DECIMAL(16,2) NOT NULL DEFAULT 0,
    closing_nbv      DECIMAL(16,2) NOT NULL DEFAULT 0,
    voucher_no       VARCHAR(40) DEFAULT NULL,
    financial_year   VARCHAR(12) DEFAULT NULL,
    created_by       INT DEFAULT NULL,
    created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_fad (asset_id, period),
    KEY idx_fad_asset (asset_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

  // Custodian / location / cost-centre transfer history (no accounting impact).
  await query(`CREATE TABLE IF NOT EXISTS fixed_asset_transfers (
    id                INT AUTO_INCREMENT PRIMARY KEY,
    asset_id          VARCHAR(30) NOT NULL,
    transfer_date     DATE DEFAULT NULL,
    from_location     VARCHAR(190) DEFAULT NULL,
    to_location       VARCHAR(190) DEFAULT NULL,
    from_department   VARCHAR(120) DEFAULT NULL,
    to_department     VARCHAR(120) DEFAULT NULL,
    from_cost_centre  VARCHAR(120) DEFAULT NULL,
    to_cost_centre    VARCHAR(120) DEFAULT NULL,
    from_custodian    VARCHAR(190) DEFAULT NULL,
    to_custodian      VARCHAR(190) DEFAULT NULL,
    notes             TEXT DEFAULT NULL,
    created_by        INT DEFAULT NULL,
    created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY idx_fat_asset (asset_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

  schemaEnsured = true
}

// ---------------------------------------------------------------------------
// Ids and derived values.
// ---------------------------------------------------------------------------

/** FY-scoped, concurrency-safe asset id, e.g. FA-2026-000001 (restarts per FY). */
export async function nextFixedAssetId(dateStr?: string | null): Promise<string> {
  const fy = financialYearFor(dateStr) || financialYearFor(today())
  const startYear = fy.split("-")[0] || String(new Date().getFullYear())
  const seq = await nextRecordId(`FA${startYear}`, { digits: 6, allowCustom: true })
  const number = seq.split("-")[1] ?? "000001"
  return `FA-${startYear}-${number}`
}

/** Capitalised cost = gross cost + non-creditable GST, unless explicitly set. */
export function computeCapitalisedCost(row: Record<string, any>): number {
  if (row.capitalised_cost !== undefined && row.capitalised_cost !== null && row.capitalised_cost !== "") {
    return round2(num(row.capitalised_cost))
  }
  return round2(num(row.gross_cost) + num(row.gst_amount))
}

/**
 * Depreciation for a single month on the current book value.
 *   - Straight Line: (capitalised cost − residual) / (useful life in months),
 *     flat every month.
 *   - Written Down Value: opening NBV × (annual rate / 12). If no rate is set
 *     it is derived from the useful life so a WDV asset still depreciates.
 * The amount is always capped so accumulated depreciation never drives the net
 * book value below the residual value (a partial final month is exact).
 */
export function monthlyDepreciation(row: Record<string, any>): number {
  const method = String(row.depreciation_method || "").trim()
  if (method === "None" || !method) return 0

  const cost = round2(num(row.capitalised_cost) || num(row.cost))
  const residual = round2(num(row.residual_value) || num(row.salvage_value))
  const accumulated = round2(num(row.accumulated_depreciation))
  const depreciableRemaining = round2(cost - residual - accumulated)
  if (depreciableRemaining <= 0) return 0

  let raw = 0
  if (method === "Written Down Value") {
    const life = num(row.useful_life_years)
    const rate = num(row.depreciation_rate) || (life > 0 ? (1 - Math.pow(residual > 0 ? residual / cost : 0.05, 1 / life)) * 100 : 0)
    const openingNbv = round2(cost - accumulated)
    raw = (openingNbv * (rate / 100)) / 12
  } else {
    // Straight Line (default).
    const months = num(row.useful_life_years) * 12
    if (months <= 0) return 0
    raw = (cost - residual) / months
  }

  return round2(Math.min(round2(raw), depreciableRemaining))
}

// ---------------------------------------------------------------------------
// Posting helpers. Every posting flows through postLines (Journal → GL).
// ---------------------------------------------------------------------------

function contraRole(source: string | null | undefined): AccountRole {
  switch (String(source || "").trim().toLowerCase()) {
    case "cash":
      return "cash"
    case "accounts payable":
    case "payable":
    case "on credit":
      return "payable"
    case "owner capital":
    case "capital":
    case "equity":
      return "share_capital"
    default:
      return "bank"
  }
}

async function loadAsset(assetId: string): Promise<Record<string, any> | null> {
  const [row] = (await query(`SELECT * FROM fixed_assets WHERE asset_id = ? LIMIT 1`, [assetId])) as any[]
  return row ?? null
}

// ---------------------------------------------------------------------------
// Lifecycle actions.
// ---------------------------------------------------------------------------

/**
 * Capitalise an asset: recognise it on the books and post the acquisition
 * voucher (Dr Fixed Asset at capitalised cost, Cr the funding contra). Only a
 * Draft / uncapitalised asset with a positive cost capitalises; it is
 * idempotent — an already-capitalised asset with the same cost is a no-op.
 */
export async function capitaliseAsset(
  assetId: string,
  opts: { putToUseDate?: string | null; createdBy?: number | null } = {},
): Promise<{ ok: boolean; voucherNo?: string; error?: string }> {
  await ensureFixedAssetSchema()
  await ensureFixedAssetAccounts()
  const row = await loadAsset(assetId)
  if (!row) return { ok: false, error: "Asset not found" }

  const capitalised = computeCapitalisedCost(row)
  if (capitalised <= 0) return { ok: false, error: "Capitalised cost must be greater than zero" }
  if (row.voucher_no && String(row.posting_status) === "Posted" && Math.abs(num(row.posted_amount) - capitalised) <= 0.01) {
    return { ok: true, voucherNo: String(row.voucher_no) }
  }
  if (CLOSED_STATUSES.has(String(row.status))) return { ok: false, error: `A ${row.status} asset cannot be capitalised` }

  const putToUse = dateOf(opts.putToUseDate || row.put_to_use_date || row.acquisition_date)
  const lines: PostingLine[] = [
    { role: "fixed_asset", accountId: row.asset_account || null, debit: capitalised, credit: 0 },
    { role: contraRole(row.funding_source), debit: 0, credit: capitalised },
  ]

  try {
    const result = await postLines(lines, {
      entityType: "fixed_asset",
      entityId: Number(row.id),
      entityRef: assetId,
      date: putToUse,
      financialYear: row.financial_year ?? financialYearFor(putToUse),
      partyName: row.vendor || row.custodian || null,
      projectName: row.project || null,
      voucherType: "Fixed Asset",
      narration: `Capitalisation of fixed asset ${assetId}${row.asset_name ? ` — ${row.asset_name}` : ""}`,
      sourceModule: "Fixed Assets",
      createdBy: opts.createdBy ?? null,
    })
    await query(
      `UPDATE fixed_assets
          SET status = CASE WHEN status IN ('Draft','') OR status IS NULL THEN 'In Use' ELSE status END,
              cost = ?, capitalised_cost = ?, net_book_value = ? - accumulated_depreciation,
              put_to_use_date = ?, depreciation_start_date = COALESCE(depreciation_start_date, ?),
              capitalised_at = NOW(), voucher_no = ?, posting_status = 'Posted', posted_at = NOW(),
              posted_amount = ?, posted_snapshot = ?
        WHERE id = ?`,
      [capitalised, capitalised, capitalised, putToUse, putToUse, result.voucherNo, capitalised, JSON.stringify(row), row.id],
    )
    return { ok: true, voucherNo: result.voucherNo }
  } catch (error) {
    await query(`UPDATE fixed_assets SET posting_status = 'Unposted' WHERE id = ?`, [row.id]).catch(() => {})
    return { ok: false, error: (error as Error).message }
  }
}

/**
 * Post one period of depreciation for a single asset. Idempotent per accounting
 * month via the unique (asset_id, period) row in fixed_asset_depreciation.
 */
export async function depreciateAsset(
  assetId: string,
  opts: { period?: string | null; date?: string | null; createdBy?: number | null } = {},
): Promise<{ ok: boolean; amount?: number; voucherNo?: string; skipped?: string; error?: string }> {
  await ensureFixedAssetSchema()
  await ensureFixedAssetAccounts()
  const row = await loadAsset(assetId)
  if (!row) return { ok: false, error: "Asset not found" }
  if (!row.voucher_no || String(row.posting_status) !== "Posted") return { ok: false, skipped: "Asset is not capitalised" }
  if (!ACTIVE_STATUSES.has(String(row.status))) return { ok: false, skipped: `Status ${row.status} is not depreciable` }

  const depDate = dateOf(opts.date || `${opts.period || monthOf(today())}-28`)
  const period = opts.period || monthOf(depDate)

  const [already] = (await query(
    `SELECT id FROM fixed_asset_depreciation WHERE asset_id = ? AND period = ? LIMIT 1`,
    [assetId, period],
  )) as any[]
  if (already) return { ok: false, skipped: `Already depreciated for ${period}` }

  const amount = monthlyDepreciation(row)
  if (amount <= 0) return { ok: false, skipped: "Fully depreciated" }

  const openingNbv = round2((num(row.capitalised_cost) || num(row.cost)) - num(row.accumulated_depreciation))
  const closingNbv = round2(openingNbv - amount)

  const lines: PostingLine[] = [
    { role: "depreciation_expense", accountId: row.depreciation_expense_account || null, debit: amount, credit: 0 },
    { role: "accumulated_depreciation", accountId: row.accumulated_depreciation_account || null, debit: 0, credit: amount },
  ]

  try {
    const result = await postLines(lines, {
      entityType: "fixed_asset_depreciation",
      idempotencyKey: `asset-depreciation:${row.id}:${period}`,
      afterPosting: async (connection, posting) => {
        await connection.query(
          `INSERT INTO fixed_asset_depreciation
           (asset_id, period, depreciation_date, amount, method, opening_nbv, closing_nbv, voucher_no, financial_year, created_by)
           VALUES (?,?,?,?,?,?,?,?,?,?)`,
          [assetId, period, depDate, amount, row.depreciation_method || "Straight Line", openingNbv, closingNbv, posting.voucherNo, financialYearFor(depDate), opts.createdBy ?? null],
        )
        await connection.query(
          `UPDATE fixed_assets SET accumulated_depreciation=accumulated_depreciation+?,
           net_book_value=(CASE WHEN capitalised_cost>0 THEN capitalised_cost ELSE cost END)-accumulated_depreciation,
           last_depreciation_date=? WHERE id=?`, [amount, depDate, row.id],
        )
      },
      entityId: Number(row.id),
      entityRef: assetId,
      date: depDate,
      financialYear: financialYearFor(depDate),
      projectName: row.project || null,
      voucherType: "Depreciation",
      narration: `Depreciation ${period} for ${assetId}${row.asset_name ? ` — ${row.asset_name}` : ""}`,
      sourceModule: "Fixed Assets",
      createdBy: opts.createdBy ?? null,
    })
    return { ok: true, amount, voucherNo: result.voucherNo }
  } catch (error) {
    return { ok: false, error: (error as Error).message }
  }
}

/** Record a custodian / location / department / cost-centre transfer (no GL). */
export async function transferAsset(
  assetId: string,
  payload: {
    transferDate?: string | null
    toLocation?: string | null
    toDepartment?: string | null
    toCostCentre?: string | null
    toCustodian?: string | null
    notes?: string | null
    createdBy?: number | null
  },
): Promise<{ ok: boolean; error?: string }> {
  await ensureFixedAssetSchema()
  const row = await loadAsset(assetId)
  if (!row) return { ok: false, error: "Asset not found" }
  if (CLOSED_STATUSES.has(String(row.status))) return { ok: false, error: `A ${row.status} asset cannot be transferred` }

  const to = {
    location: payload.toLocation ?? row.location,
    department: payload.toDepartment ?? row.department,
    costCentre: payload.toCostCentre ?? row.cost_centre,
    custodian: payload.toCustodian ?? row.custodian,
  }
  await query(
    `INSERT INTO fixed_asset_transfers
       (asset_id, transfer_date, from_location, to_location, from_department, to_department,
        from_cost_centre, to_cost_centre, from_custodian, to_custodian, notes, created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      assetId, dateOf(payload.transferDate), row.location ?? null, to.location ?? null,
      row.department ?? null, to.department ?? null, row.cost_centre ?? null, to.costCentre ?? null,
      row.custodian ?? null, to.custodian ?? null, payload.notes ?? null, payload.createdBy ?? null,
    ],
  )
  await query(
    `UPDATE fixed_assets SET location = ?, department = ?, cost_centre = ?, custodian = ? WHERE id = ?`,
    [to.location ?? null, to.department ?? null, to.costCentre ?? null, to.custodian ?? null, row.id],
  )
  return { ok: true }
}

/**
 * Dispose (sale) or scrap an asset. Both remove the asset at cost and unwind
 * accumulated depreciation; the difference against the proceeds is booked as a
 * gain (income) or loss (expense). Scrap is a disposal with zero proceeds.
 *
 *   Cr Fixed Asset                 capitalised cost
 *   Dr Accumulated Depreciation    accumulated to date
 *   Dr Bank / Cash                 proceeds            (disposal only)
 *   Dr Loss on Sale                (NBV − proceeds)    when proceeds < NBV
 *   Cr Gain on Sale                (proceeds − NBV)    when proceeds > NBV
 */
export async function disposeAsset(
  assetId: string,
  payload: {
    scrap?: boolean
    disposalDate?: string | null
    proceeds?: number | null
    mode?: string | null
    notes?: string | null
    createdBy?: number | null
  },
): Promise<{ ok: boolean; voucherNo?: string; result?: number; error?: string }> {
  await ensureFixedAssetSchema()
  await ensureFixedAssetAccounts()
  const row = await loadAsset(assetId)
  if (!row) return { ok: false, error: "Asset not found" }
  if (CLOSED_STATUSES.has(String(row.status))) return { ok: false, error: `Asset is already ${row.status}` }
  if (!row.voucher_no || String(row.posting_status) !== "Posted") {
    return { ok: false, error: "Capitalise the asset before disposing it" }
  }

  const cost = round2(num(row.capitalised_cost) || num(row.cost))
  const accumulated = round2(num(row.accumulated_depreciation))
  const nbv = round2(cost - accumulated)
  const proceeds = payload.scrap ? 0 : round2(num(payload.proceeds))
  const disposalDate = dateOf(payload.disposalDate)
  const gainLoss = round2(proceeds - nbv) // >0 gain, <0 loss
  const mode = payload.scrap ? "Scrap" : payload.mode || "Bank"

  const lines: PostingLine[] = []
  if (cost > 0) lines.push({ role: "fixed_asset", accountId: row.asset_account || null, debit: 0, credit: cost })
  if (accumulated > 0) lines.push({ role: "accumulated_depreciation", accountId: row.accumulated_depreciation_account || null, debit: accumulated, credit: 0 })
  if (proceeds > 0) lines.push({ role: contraRole(mode), debit: proceeds, credit: 0 })
  if (gainLoss < 0) lines.push({ role: "disposal_loss", debit: round2(-gainLoss), credit: 0 })
  if (gainLoss > 0) lines.push({ role: "disposal_gain", debit: 0, credit: round2(gainLoss) })

  try {
    const result = await postLines(lines, {
      entityType: "fixed_asset_disposal",
      entityId: Number(row.id),
      entityRef: assetId,
      date: disposalDate,
      financialYear: financialYearFor(disposalDate),
      partyName: row.vendor || row.custodian || null,
      projectName: row.project || null,
      voucherType: payload.scrap ? "Asset Scrap" : "Asset Disposal",
      narration: `${payload.scrap ? "Scrap" : "Disposal"} of fixed asset ${assetId}${row.asset_name ? ` — ${row.asset_name}` : ""}`,
      sourceModule: "Fixed Assets",
      createdBy: payload.createdBy ?? null,
    })
    await query(
      `UPDATE fixed_assets
          SET status = ?, disposal_date = ?, disposal_proceeds = ?, disposal_mode = ?,
              disposal_voucher_no = ?, disposal_result = ?, net_book_value = 0,
              notes = CASE WHEN ? <> '' THEN CONCAT(COALESCE(notes,''), CASE WHEN notes IS NULL OR notes = '' THEN '' ELSE '\n' END, ?) ELSE notes END
        WHERE id = ?`,
      [
        payload.scrap ? "Scrapped" : "Disposed", disposalDate, proceeds, mode,
        result.voucherNo, gainLoss, String(payload.notes || ""), String(payload.notes || ""), row.id,
      ],
    )
    return { ok: true, voucherNo: result.voucherNo, result: gainLoss }
  } catch (error) {
    return { ok: false, error: (error as Error).message }
  }
}

/** Soft close a disposed / scrapped asset so it drops off the active register. */
export async function archiveAsset(assetId: string): Promise<{ ok: boolean; error?: string }> {
  await ensureFixedAssetSchema()
  const row = await loadAsset(assetId)
  if (!row) return { ok: false, error: "Asset not found" }
  await query(`UPDATE fixed_assets SET status = 'Archived', archived_at = NOW() WHERE id = ?`, [row.id])
  return { ok: true }
}

/**
 * Post one accounting month of depreciation across every eligible asset. Used
 * by the monthly cron and the "Run depreciation" button. Idempotent — assets
 * already depreciated for the period are skipped.
 */
export async function runMonthlyDepreciation(
  opts: { period?: string | null; createdBy?: number | null } = {},
): Promise<{ period: string; posted: number; skipped: number; totalAmount: number; errors: number }> {
  await ensureFixedAssetSchema()
  const period = opts.period || monthOf(today())
  const rows = (await query(
    `SELECT asset_id FROM fixed_assets
      WHERE posting_status = 'Posted' AND status IN ('In Use','Under Repair','Idle')
        AND (depreciation_method IS NOT NULL AND depreciation_method <> 'None' AND depreciation_method <> '')
      ORDER BY id ASC`,
  )) as any[]

  let posted = 0
  let skipped = 0
  let errors = 0
  let totalAmount = 0
  for (const r of rows) {
    const res = await depreciateAsset(String(r.asset_id), { period, createdBy: opts.createdBy ?? null })
    if (res.ok) {
      posted += 1
      totalAmount = round2(totalAmount + (res.amount ?? 0))
    } else if (res.error) {
      errors += 1
    } else {
      skipped += 1
    }
  }
  return { period, posted, skipped, totalAmount, errors }
}

// ---------------------------------------------------------------------------
// Create / edit. A new asset is always born a Draft (no posting) and is
// capitalised as a separate, explicit step. Only a Draft asset is fully
// editable; once capitalised the cost / accounts are locked and only the
// descriptive fields (name, location, custodian, notes, documents) may change.
// ---------------------------------------------------------------------------

/** Columns a create / edit may write (never the server-owned posting columns). */
const WRITABLE = [
  "asset_name", "asset_category", "asset_type", "vendor", "purchase_bill",
  "purchase_date", "put_to_use_date", "acquisition_date", "financial_year",
  "quantity", "gross_cost", "gst_amount", "capitalised_cost", "funding_source",
  "location", "department", "project", "cost_centre", "useful_life_years",
  "depreciation_method", "depreciation_rate", "residual_value", "salvage_value",
  "asset_account", "accumulated_depreciation_account", "depreciation_expense_account",
  "documents", "status", "notes",
] as const

/** Descriptive fields still editable after an asset is capitalised. */
const POST_CAPITALISE_EDITABLE = new Set([
  "asset_name", "asset_category", "asset_type", "vendor", "location", "department",
  "project", "cost_centre", "custodian", "documents", "notes",
])

function sanitize(body: Record<string, any>, keys: Iterable<string>): Record<string, any> {
  const out: Record<string, any> = {}
  for (const k of keys) {
    if (k in body) out[k] = body[k] === "" ? null : body[k]
  }
  return out
}

export async function createAsset(
  body: Record<string, any>,
  opts: { createdBy?: number | null } = {},
): Promise<Record<string, any>> {
  await ensureFixedAssetSchema()
  const data = sanitize(body, WRITABLE)
  const acqDate = dateOf(data.acquisition_date || data.purchase_date)
  const assetId = await nextFixedAssetId(acqDate)
  const fy = data.financial_year || financialYearFor(acqDate)
  const grossCost = round2(num(data.gross_cost) || num(data.capitalised_cost))
  const gst = round2(num(data.gst_amount))
  const capitalised = computeCapitalisedCost({ ...data, gross_cost: grossCost, gst_amount: gst })
  const residual = round2(num(data.residual_value) || num(data.salvage_value))

  await query(
    `INSERT INTO fixed_assets
       (asset_id, asset_name, asset_category, asset_type, vendor, purchase_bill, purchase_date,
        put_to_use_date, acquisition_date, financial_year, quantity, gross_cost, gst_amount,
        capitalised_cost, cost, funding_source, location, department, project, cost_centre, custodian,
        useful_life_years, depreciation_method, depreciation_rate, residual_value, salvage_value,
        accumulated_depreciation, net_book_value, asset_account, accumulated_depreciation_account,
        depreciation_expense_account, documents, status, notes, posting_status, created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      assetId, data.asset_name ?? null, data.asset_category ?? null, data.asset_type ?? null,
      data.vendor ?? null, data.purchase_bill ?? null, data.purchase_date ?? null,
      data.put_to_use_date ?? null, acqDate, fy, round2(num(data.quantity) || 1), grossCost, gst,
      capitalised, capitalised, data.funding_source ?? null, data.location ?? null, data.department ?? null,
      data.project ?? null, data.cost_centre ?? null, body.custodian ?? null,
      round2(num(data.useful_life_years)), data.depreciation_method ?? null, round2(num(data.depreciation_rate)),
      residual, residual, 0, capitalised, data.asset_account ?? null, data.accumulated_depreciation_account ?? null,
      data.depreciation_expense_account ?? null, data.documents ?? null, "Draft", data.notes ?? null,
      "Unposted", opts.createdBy ?? null,
    ],
  )
  return (await loadAsset(assetId)) as Record<string, any>
}

export async function updateAsset(assetId: string, body: Record<string, any>): Promise<Record<string, any> | null> {
  await ensureFixedAssetSchema()
  const row = await loadAsset(assetId)
  if (!row) return null

  const isCapitalised = Boolean(row.voucher_no) && String(row.posting_status) === "Posted"
  const allowed = isCapitalised ? POST_CAPITALISE_EDITABLE : new Set<string>([...WRITABLE, "custodian"])
  const data = sanitize(body, allowed)
  if (Object.keys(data).length === 0) return row

  // Recompute capitalised cost / NBV only while the asset is still a Draft.
  if (!isCapitalised) {
    const merged = { ...row, ...data }
    const grossCost = round2(num(merged.gross_cost) || num(merged.capitalised_cost))
    const gst = round2(num(merged.gst_amount))
    const capitalised = computeCapitalisedCost({ ...merged, gross_cost: grossCost, gst_amount: gst })
    const residual = round2(num(merged.residual_value) || num(merged.salvage_value))
    data.gross_cost = grossCost
    data.gst_amount = gst
    data.capitalised_cost = capitalised
    data.cost = capitalised
    data.residual_value = residual
    data.salvage_value = residual
    data.net_book_value = round2(capitalised - num(merged.accumulated_depreciation))
  }

  const cols = Object.keys(data)
  await query(
    `UPDATE fixed_assets SET ${cols.map((c) => `\`${c}\` = ?`).join(", ")} WHERE id = ?`,
    [...cols.map((c) => data[c]), row.id],
  )
  return await loadAsset(assetId)
}

// ---------------------------------------------------------------------------
// Reads used by the API / UI.
// ---------------------------------------------------------------------------

export async function getAssetDetail(assetId: string) {
  await ensureFixedAssetSchema()
  const asset = await loadAsset(assetId)
  if (!asset) return null
  const depreciation = (await query(
    `SELECT period, depreciation_date, amount, method, opening_nbv, closing_nbv, voucher_no, created_at
       FROM fixed_asset_depreciation WHERE asset_id = ? ORDER BY period DESC`,
    [assetId],
  )) as any[]
  const transfers = (await query(
    `SELECT transfer_date, from_location, to_location, from_department, to_department,
            from_cost_centre, to_cost_centre, from_custodian, to_custodian, notes, created_at
       FROM fixed_asset_transfers WHERE asset_id = ? ORDER BY id DESC`,
    [assetId],
  )) as any[]
  return { asset, depreciation, transfers }
}

export async function listAssets(params: URLSearchParams) {
  await ensureFixedAssetSchema()
  const where: string[] = []
  const args: any[] = []
  const status = params.get("status")
  const category = params.get("asset_category")
  const fy = params.get("financial_year")
  const search = params.get("search")
  if (status) { where.push("status = ?"); args.push(status) }
  if (category) { where.push("asset_category = ?"); args.push(category) }
  if (fy) { where.push("financial_year = ?"); args.push(fy) }
  if (params.get("date_from")) { where.push("acquisition_date >= ?"); args.push(params.get("date_from")) }
  if (params.get("date_to")) { where.push("acquisition_date <= ?"); args.push(params.get("date_to")) }
  if (search) {
    where.push("(asset_id LIKE ? OR asset_name LIKE ? OR asset_category LIKE ? OR location LIKE ? OR custodian LIKE ? OR vendor LIKE ?)")
    const like = `%${search}%`
    for (let i = 0; i < 6; i++) args.push(like)
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : ""

  const rows = (await query(`SELECT * FROM fixed_assets ${clause} ORDER BY id DESC LIMIT 1000`, args)) as any[]
  const [summary] = (await query(
    `SELECT COALESCE(SUM(CASE WHEN capitalised_cost > 0 THEN capitalised_cost ELSE cost END),0) total_cost,
            COALESCE(SUM(accumulated_depreciation),0) total_depr,
            COALESCE(SUM(net_book_value),0) total_nbv,
            COUNT(*) total_rows
       FROM fixed_assets ${clause}`,
    args,
  )) as any[]
  return { rows, summary }
}

/** Delete an asset. Draft-only guard is enforced in the route. */
export async function deleteAsset(assetId: string): Promise<void> {
  await ensureFixedAssetSchema()
  await query(`DELETE FROM fixed_asset_depreciation WHERE asset_id = ?`, [assetId])
  await query(`DELETE FROM fixed_asset_transfers WHERE asset_id = ?`, [assetId])
  await query(`DELETE FROM fixed_assets WHERE asset_id = ?`, [assetId])
}

export { loadAsset, pool }
