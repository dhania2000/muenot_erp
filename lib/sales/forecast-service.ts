import "server-only"
import { pool, query } from "@/lib/db"
import { nextRecordId } from "@/lib/record-ids"
import { getSettings } from "@/lib/settings/server"
import { recordAudit, ensureLeadLifecycleSchema } from "@/lib/sales/lead-lifecycle"
import { ensureQuotationSchema } from "@/lib/sales/quotation-service"
import { ensureContractSchema } from "@/lib/sales/contract-service"
import {
  classifyCategory,
  currentFyStartYear,
  fiscalPositionFor,
  forecastHealth,
  fyLabel,
  fyStartMonthIndex,
  quarterRange,
  resolveProbability,
  scoreRisk,
  type AdjustmentType,
  type ForecastCategory,
  type ForecastSource,
  type RiskLevel,
} from "@/lib/sales/forecast-model"

/**
 * Central Sales Forecast service.
 *
 * The forecast is a REPORTING layer computed on demand from real Sales records
 * (leads → quotations → contracts) plus Finance actuals (invoices). It never
 * stores a duplicate copy of pipeline data. The only rows it persists are
 * manager *manual adjustments / targets* in `sales_forecast_adjustments`, kept
 * separate from the system-calculated numbers and always carrying a reason +
 * audit trail.
 *
 * A single commercial opportunity is counted ONCE. Each lead resolves to one
 * canonical value using the source-priority ladder:
 *   Active/signed Contract  >  current Quotation  >  Lead estimated value
 * The originating quotation and contract of a counted lead are marked "used" so
 * they are never also counted as standalone deals.
 */

// ---------------------------------------------------------------------------
// Schema self-heal for the adjustments table
// ---------------------------------------------------------------------------

let adjustmentsSchemaReady = false

async function ensureAdjustmentsSchema(): Promise<void> {
  if (adjustmentsSchemaReady) return
  await query(`CREATE TABLE IF NOT EXISTS \`sales_forecast_adjustments\` (
    \`id\` INT UNSIGNED NOT NULL AUTO_INCREMENT,
    \`adjustment_code\` VARCHAR(30) NOT NULL,
    \`fy_start_year\` SMALLINT UNSIGNED NOT NULL,
    \`quarter\` TINYINT UNSIGNED NOT NULL,
    \`adjustment_type\` ENUM('Expected','Best Case','Worst Case','Target') NOT NULL,
    \`amount\` DECIMAL(14,2) NOT NULL DEFAULT 0,
    \`owner_id\` INT UNSIGNED DEFAULT NULL,
    \`reason\` VARCHAR(500) NOT NULL,
    \`created_by\` INT UNSIGNED DEFAULT NULL,
    \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    \`updated_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (\`id\`),
    UNIQUE KEY \`uniq_forecast_adj_code\` (\`adjustment_code\`),
    KEY \`idx_forecast_adj_period\` (\`fy_start_year\`, \`quarter\`)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`).catch((e) => {
    console.error("[forecast-service] ensureAdjustmentsSchema failed", e)
  })
  adjustmentsSchemaReady = true
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ForecastOpportunity = {
  key: string
  leadId: number | null
  leadCode: string | null
  companyId: number | null
  companyName: string | null
  ownerId: number | null
  ownerName: string | null
  stage: string | null
  leadStatus: string | null
  probability: number
  source: ForecastSource
  quotationId: number | null
  quotationCode: string | null
  quotationStatus: string | null
  contractId: number | null
  contractCode: string | null
  contractStatus: string | null
  currency: string
  originalValue: number
  value: number
  weightedValue: number
  committed: boolean
  category: ForecastCategory
  closeDate: string | null
  fyStartYear: number | null
  quarter: number | null
  risk: RiskLevel
  riskReasons: string[]
}

export type QuarterForecast = {
  quarter: number
  label: string
  start: string
  end: string
  pipelineValue: number
  weightedPipeline: number
  committed: number
  systemExpected: number
  expected: number
  bestCase: number
  worstCase: number
  target: number
  gap: number
  coverage: number | null
  actualInvoiced: number
  actualCollected: number
  variance: number
  accuracy: number | null
  health: string
  dealCount: number
  atRiskValue: number
  adjustments: { expected: number; bestCase: number; worstCase: number; target: number }
}

export type OwnerForecast = {
  ownerId: number | null
  ownerName: string
  expected: number
  committed: number
  weightedPipeline: number
  dealCount: number
}

export type AdjustmentRecord = {
  id: number
  adjustment_code: string
  fy_start_year: number
  quarter: number
  adjustment_type: AdjustmentType
  amount: number
  owner_id: number | null
  owner_name: string | null
  reason: string
  created_by_name: string | null
  created_at: string
}

export type ForecastResult = {
  fyStartYear: number
  fyLabel: string
  startMonthName: string
  baseCurrency: string
  quarters: QuarterForecast[]
  summary: QuarterForecast
  ownerBreakdown: OwnerForecast[]
  adjustments: AdjustmentRecord[]
  fyOptions: number[]
  unscheduledCount: number
  generatedAt: string
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const n = (v: unknown) => {
  const x = Number(v)
  return Number.isFinite(x) ? x : 0
}

const round2 = (x: number) => Math.round((x + Number.EPSILON) * 100) / 100

function isoDate(v: unknown): string | null {
  if (!v) return null
  const d = new Date(v as string)
  if (Number.isNaN(d.getTime())) return null
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, "0")
  const day = String(d.getDate()).padStart(2, "0")
  return `${y}-${m}-${day}`
}

const USABLE_QUOTE_STATUSES = new Set(["Draft", "Sent", "Accepted"])
const COMMITTED_CONTRACT_STATUSES = new Set(["Active", "Pending Signature", "Renewed"])

// ---------------------------------------------------------------------------
// Opportunity extraction (the dedup engine)
// ---------------------------------------------------------------------------

async function loadOpportunities(): Promise<ForecastOpportunity[]> {
  await Promise.all([ensureLeadLifecycleSchema(), ensureQuotationSchema(), ensureContractSchema()])

  const [leads, quotes, contracts] = await Promise.all([
    query<any[]>(
      `SELECT l.id, l.lead_code, l.company_name, l.company_id, l.status, l.lead_status,
              l.assigned_to, u.name AS owner_name, l.estimated_value, l.currency, l.probability,
              l.expected_close_date, l.won_at, l.won_value, l.last_contact_date, l.updated_at
       FROM sales_leads l
       LEFT JOIN users u ON u.id = l.assigned_to
       WHERE l.archived_at IS NULL`,
    ).catch(() => []),
    query<any[]>(
      `SELECT q.id, q.quote_code, q.lead_id, q.company_id, q.company_name, q.owner_id,
              u.name AS owner_name, q.grand_total, q.total_amount, q.currency, q.exchange_rate,
              q.status, q.valid_until, q.is_current, q.converted_contract_id
       FROM sales_quotations q
       LEFT JOIN users u ON u.id = q.owner_id
       WHERE q.archived_at IS NULL`,
    ).catch(() => []),
    query<any[]>(
      `SELECT id, contract_code, company_id, company_name, source_quotation_id, value, status,
              start_date, end_date, contract_date
       FROM sales_contracts
       WHERE archived_at IS NULL`,
    ).catch(() => []),
  ])

  const quotesByLead = new Map<number, any[]>()
  const quotesById = new Map<number, any>()
  for (const q of quotes) {
    quotesById.set(Number(q.id), q)
    if (q.lead_id != null) {
      const arr = quotesByLead.get(Number(q.lead_id)) ?? []
      arr.push(q)
      quotesByLead.set(Number(q.lead_id), arr)
    }
  }

  const contractsByQuoteId = new Map<number, any[]>()
  for (const c of contracts) {
    if (c.source_quotation_id != null) {
      const arr = contractsByQuoteId.get(Number(c.source_quotation_id)) ?? []
      arr.push(c)
      contractsByQuoteId.set(Number(c.source_quotation_id), arr)
    }
  }

  const quoteBase = (q: any): number => {
    const raw = n(q.grand_total) || n(q.total_amount)
    const rate = n(q.exchange_rate) || 1
    return round2(raw * rate)
  }

  const usedQuoteIds = new Set<number>()
  const usedContractIds = new Set<number>()
  const opps: ForecastOpportunity[] = []

  // ---- Lead-anchored opportunities (the canonical path) ----
  for (const l of leads) {
    const leadId = Number(l.id)
    const leadStatus: string = l.lead_status ?? "Open"
    const stage: string = l.status ?? "New"
    const eligible = leadStatus !== "Lost" && stage !== "Lost"

    const leadQuotes = (quotesByLead.get(leadId) ?? []).slice().sort((a, b) => Number(b.id) - Number(a.id))
    // Current, usable quotation (prefer is_current then latest).
    const usableQuote =
      leadQuotes.find((q) => (q.is_current === 1 || q.is_current == null) && USABLE_QUOTE_STATUSES.has(q.status)) ??
      leadQuotes.find((q) => USABLE_QUOTE_STATUSES.has(q.status)) ??
      null

    // A signed/active contract descending from any of this lead's quotations.
    let contract: any = null
    for (const q of leadQuotes) {
      const cs = contractsByQuoteId.get(Number(q.id)) ?? []
      const active = cs.find((c) => COMMITTED_CONTRACT_STATUSES.has(c.status))
      if (active) {
        contract = active
        break
      }
      if (!contract && cs.length) contract = cs[0]
    }

    const committed = leadStatus === "Won" || (contract != null && COMMITTED_CONTRACT_STATUSES.has(contract.status))

    let source: ForecastSource
    let value: number
    let currency: string = l.currency || ""
    let originalValue: number
    if (contract && COMMITTED_CONTRACT_STATUSES.has(contract.status)) {
      source = "Contract"
      value = n(contract.value)
      originalValue = value
      currency = ""
      usedContractIds.add(Number(contract.id))
      if (usableQuote) usedQuoteIds.add(Number(usableQuote.id))
    } else if (usableQuote) {
      source = "Quotation"
      value = quoteBase(usableQuote)
      originalValue = n(usableQuote.grand_total) || n(usableQuote.total_amount)
      currency = usableQuote.currency || currency
      usedQuoteIds.add(Number(usableQuote.id))
    } else {
      source = "Lead"
      value = committed && n(l.won_value) > 0 ? n(l.won_value) : n(l.estimated_value)
      originalValue = value
    }

    const probability = resolveProbability({ stage, leadStatus, probability: l.probability })
    const closeDate = committed
      ? isoDate(contract?.start_date) ?? isoDate(l.won_at) ?? isoDate(l.expected_close_date)
      : isoDate(l.expected_close_date)

    const category = classifyCategory({ eligible, committed, probability })
    const risk = scoreRisk({
      committed,
      probability,
      expectedCloseDate: isoDate(l.expected_close_date),
      lastActivityAt: isoDate(l.last_contact_date) ?? isoDate(l.updated_at),
      quoteValidUntil: isoDate(usableQuote?.valid_until),
    })

    opps.push({
      key: `lead-${leadId}`,
      leadId,
      leadCode: l.lead_code ?? null,
      companyId: l.company_id != null ? Number(l.company_id) : null,
      companyName: l.company_name ?? contract?.company_name ?? usableQuote?.company_name ?? null,
      ownerId: l.assigned_to != null ? Number(l.assigned_to) : null,
      ownerName: l.owner_name ?? null,
      stage,
      leadStatus,
      probability,
      source,
      quotationId: usableQuote ? Number(usableQuote.id) : null,
      quotationCode: usableQuote?.quote_code ?? null,
      quotationStatus: usableQuote?.status ?? null,
      contractId: contract ? Number(contract.id) : null,
      contractCode: contract?.contract_code ?? null,
      contractStatus: contract?.status ?? null,
      currency: currency || "",
      originalValue: round2(originalValue),
      value: round2(value),
      weightedValue: round2((value * probability) / 100),
      committed,
      category,
      closeDate,
      ...placeInFy(closeDate),
      risk: risk.level,
      riskReasons: risk.reasons,
    })
  }

  // ---- Orphan active contracts (no counted lead behind them) ----
  for (const c of contracts) {
    const id = Number(c.id)
    if (usedContractIds.has(id)) continue
    if (!COMMITTED_CONTRACT_STATUSES.has(c.status)) continue
    // Skip if its source quotation belongs to a lead we already counted.
    const srcQuote = c.source_quotation_id != null ? quotesById.get(Number(c.source_quotation_id)) : null
    if (srcQuote?.lead_id != null && leads.some((l) => Number(l.id) === Number(srcQuote.lead_id))) continue
    if (c.source_quotation_id != null) usedQuoteIds.add(Number(c.source_quotation_id))

    const value = n(c.value)
    const closeDate = isoDate(c.start_date) ?? isoDate(c.contract_date)
    opps.push({
      key: `contract-${id}`,
      leadId: null,
      leadCode: null,
      companyId: c.company_id != null ? Number(c.company_id) : null,
      companyName: c.company_name ?? null,
      ownerId: null,
      ownerName: null,
      stage: null,
      leadStatus: null,
      probability: 100,
      source: "Contract",
      quotationId: c.source_quotation_id != null ? Number(c.source_quotation_id) : null,
      quotationCode: srcQuote?.quote_code ?? null,
      quotationStatus: srcQuote?.status ?? null,
      contractId: id,
      contractCode: c.contract_code ?? null,
      contractStatus: c.status,
      currency: "",
      originalValue: round2(value),
      value: round2(value),
      weightedValue: round2(value),
      committed: true,
      category: "Commit",
      closeDate,
      ...placeInFy(closeDate),
      risk: "Low",
      riskReasons: [],
    })
  }

  // ---- Orphan current quotations (no lead, not converted to a counted contract) ----
  for (const q of quotes) {
    const id = Number(q.id)
    if (usedQuoteIds.has(id)) continue
    if (q.lead_id != null && leads.some((l) => Number(l.id) === Number(q.lead_id))) continue
    if (!(q.is_current === 1 || q.is_current == null)) continue
    if (!USABLE_QUOTE_STATUSES.has(q.status)) continue

    const value = quoteBase(q)
    const probability = q.status === "Accepted" ? 90 : q.status === "Sent" ? 60 : 30
    const closeDate = isoDate(q.valid_until)
    const risk = scoreRisk({
      committed: false,
      probability,
      expectedCloseDate: closeDate,
      quoteValidUntil: closeDate,
    })
    opps.push({
      key: `quote-${id}`,
      leadId: null,
      leadCode: null,
      companyId: q.company_id != null ? Number(q.company_id) : null,
      companyName: q.company_name ?? null,
      ownerId: q.owner_id != null ? Number(q.owner_id) : null,
      ownerName: q.owner_name ?? null,
      stage: null,
      leadStatus: null,
      probability,
      source: "Quotation",
      quotationId: id,
      quotationCode: q.quote_code ?? null,
      quotationStatus: q.status,
      contractId: null,
      contractCode: null,
      contractStatus: null,
      currency: q.currency || "",
      originalValue: round2(n(q.grand_total) || n(q.total_amount)),
      value: round2(value),
      weightedValue: round2((value * probability) / 100),
      committed: false,
      category: classifyCategory({ eligible: true, committed: false, probability }),
      closeDate,
      ...placeInFy(closeDate),
      risk: risk.level,
      riskReasons: risk.reasons,
    })
  }

  return opps
}

// placeInFy is closure-configured per request via module-level start month.
let currentStartMonth = 3
function placeInFy(closeDate: string | null): { fyStartYear: number | null; quarter: number | null } {
  if (!closeDate) return { fyStartYear: null, quarter: null }
  const d = new Date(closeDate)
  if (Number.isNaN(d.getTime())) return { fyStartYear: null, quarter: null }
  const pos = fiscalPositionFor(d, currentStartMonth)
  return { fyStartYear: pos.fyStartYear, quarter: pos.quarter }
}

// ---------------------------------------------------------------------------
// Finance actuals
// ---------------------------------------------------------------------------

async function loadActuals(start: string, end: string): Promise<{ invoiced: number; collected: number }> {
  const rows = await query<any[]>(
    `SELECT COALESCE(SUM(invoice_total), 0) AS invoiced,
            COALESCE(SUM(amount_received), 0) AS collected
     FROM sales_invoices
     WHERE invoice_date BETWEEN ? AND ?
       AND (invoice_status IS NULL OR invoice_status <> 'Cancelled')`,
    [start, end],
  ).catch(() => [])
  return { invoiced: n(rows?.[0]?.invoiced), collected: n(rows?.[0]?.collected) }
}

// ---------------------------------------------------------------------------
// Adjustments CRUD
// ---------------------------------------------------------------------------

export async function listAdjustments(fyStartYear: number): Promise<AdjustmentRecord[]> {
  await ensureAdjustmentsSchema()
  const rows = await query<any[]>(
    `SELECT a.*, o.name AS owner_name, c.name AS created_by_name
     FROM sales_forecast_adjustments a
     LEFT JOIN users o ON o.id = a.owner_id
     LEFT JOIN users c ON c.id = a.created_by
     WHERE a.fy_start_year = ?
     ORDER BY a.quarter ASC, a.created_at DESC`,
    [fyStartYear],
  ).catch(() => [])
  return rows.map((r) => ({
    id: Number(r.id),
    adjustment_code: r.adjustment_code,
    fy_start_year: Number(r.fy_start_year),
    quarter: Number(r.quarter),
    adjustment_type: r.adjustment_type,
    amount: n(r.amount),
    owner_id: r.owner_id != null ? Number(r.owner_id) : null,
    owner_name: r.owner_name ?? null,
    reason: r.reason,
    created_by_name: r.created_by_name ?? null,
    created_at: r.created_at,
  }))
}

async function nextAdjustmentCode(): Promise<string> {
  return nextRecordId("FA", { digits: 4, allowCustom: true })
}

export async function createAdjustment(
  input: {
    fy_start_year: number
    quarter: number
    adjustment_type: AdjustmentType
    amount: number
    owner_id?: number | null
    reason: string
  },
  actorId: number | null,
): Promise<{ id: number; adjustment_code: string }> {
  await ensureAdjustmentsSchema()
  const code = await nextAdjustmentCode()
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    const [res] = await conn.query<any>(
      `INSERT INTO sales_forecast_adjustments
       (adjustment_code, fy_start_year, quarter, adjustment_type, amount, owner_id, reason, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        code,
        input.fy_start_year,
        input.quarter,
        input.adjustment_type,
        input.amount,
        input.owner_id ?? null,
        input.reason,
        actorId,
      ],
    )
    await conn.commit()
    const id = Number(res.insertId)
    await recordAudit(null, {
      entityType: "forecast_adjustment",
      entityId: id,
      action: "created",
      summary: `${input.adjustment_type} adjustment ${code} for FY${input.fy_start_year} Q${input.quarter}`,
      meta: { amount: input.amount, reason: input.reason, ownerId: input.owner_id ?? null },
      actorId,
    })
    return { id, adjustment_code: code }
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    conn.release()
  }
}

export async function updateAdjustment(
  id: number,
  input: { amount?: number; reason?: string; adjustment_type?: AdjustmentType; owner_id?: number | null; quarter?: number },
  actorId: number | null,
): Promise<void> {
  await ensureAdjustmentsSchema()
  const fields: string[] = []
  const values: any[] = []
  for (const key of ["amount", "reason", "adjustment_type", "owner_id", "quarter"] as const) {
    if (key in input && input[key] !== undefined) {
      fields.push(`${key} = ?`)
      values.push(input[key] === "" ? null : input[key])
    }
  }
  if (!fields.length) return
  await query(`UPDATE sales_forecast_adjustments SET ${fields.join(", ")} WHERE id = ?`, [...values, id])
  await recordAudit(null, {
    entityType: "forecast_adjustment",
    entityId: id,
    action: "updated",
    summary: `Forecast adjustment ${id} updated`,
    meta: input as Record<string, unknown>,
    actorId,
  })
}

export async function deleteAdjustment(id: number, actorId: number | null): Promise<void> {
  await ensureAdjustmentsSchema()
  await query(`DELETE FROM sales_forecast_adjustments WHERE id = ?`, [id])
  await recordAudit(null, {
    entityType: "forecast_adjustment",
    entityId: id,
    action: "deleted",
    summary: `Forecast adjustment ${id} deleted`,
    actorId,
  })
}

// ---------------------------------------------------------------------------
// Main computation
// ---------------------------------------------------------------------------

function emptyQuarter(quarter: number, label: string, start: string, end: string): QuarterForecast {
  return {
    quarter,
    label,
    start,
    end,
    pipelineValue: 0,
    weightedPipeline: 0,
    committed: 0,
    systemExpected: 0,
    expected: 0,
    bestCase: 0,
    worstCase: 0,
    target: 0,
    gap: 0,
    coverage: null,
    actualInvoiced: 0,
    actualCollected: 0,
    variance: 0,
    accuracy: null,
    health: "No Target",
    dealCount: 0,
    atRiskValue: 0,
    adjustments: { expected: 0, bestCase: 0, worstCase: 0, target: 0 },
  }
}

export async function computeForecast(opts: {
  fyStartYear?: number
  ownerId?: number | null
}): Promise<ForecastResult> {
  const settings = await getSettings()
  const startMonth = fyStartMonthIndex(settings["app.financial_year_start"])
  currentStartMonth = startMonth
  const startMonthName = settings["app.financial_year_start"] || "April"
  const baseCurrency = settings["currency.default_code"] || "INR"

  const fyStartYear = opts.fyStartYear ?? currentFyStartYear(startMonth)
  const ownerId = opts.ownerId ?? null

  const [allOpps, adjustments] = await Promise.all([loadOpportunities(), listAdjustments(fyStartYear)])

  const opps = ownerId != null ? allOpps.filter((o) => o.ownerId === ownerId) : allOpps

  // Quarter buckets
  const quarters: QuarterForecast[] = []
  for (let q = 1; q <= 4; q++) {
    const range = quarterRange(fyStartYear, q, startMonth)
    quarters.push(emptyQuarter(q, `Q${q}`, range.start, range.end))
  }

  let unscheduledCount = 0
  const ownerAgg = new Map<string, OwnerForecast>()

  for (const o of opps) {
    if (o.category === "Omitted") continue
    if (o.fyStartYear !== fyStartYear || o.quarter == null) {
      if (o.quarter == null) unscheduledCount++
      continue
    }
    const bucket = quarters[o.quarter - 1]
    if (!bucket) continue
    bucket.dealCount++

    if (o.committed) {
      bucket.committed += o.value
    } else {
      bucket.pipelineValue += o.value
      bucket.weightedPipeline += o.weightedValue
      if (o.risk === "High") bucket.atRiskValue += o.value
    }

    // Owner rollup (company-wide view only, so it stays meaningful)
    if (ownerId == null) {
      const key = o.ownerId != null ? `u-${o.ownerId}` : "unassigned"
      const cur = ownerAgg.get(key) ?? {
        ownerId: o.ownerId,
        ownerName: o.ownerName ?? "Unassigned",
        expected: 0,
        committed: 0,
        weightedPipeline: 0,
        dealCount: 0,
      }
      cur.dealCount++
      if (o.committed) {
        cur.committed += o.value
        cur.expected += o.value
      } else {
        cur.weightedPipeline += o.weightedValue
        cur.expected += o.weightedValue
      }
      ownerAgg.set(key, cur)
    }
  }

  // Apply manual adjustments per quarter (scoped to the owner view when filtering).
  for (const adj of adjustments) {
    if (ownerId != null && adj.owner_id != null && adj.owner_id !== ownerId) continue
    if (ownerId == null && adj.owner_id != null) continue // owner-scoped adj only shows in that owner's view
    const bucket = quarters[adj.quarter - 1]
    if (!bucket) continue
    if (adj.adjustment_type === "Target") bucket.adjustments.target += adj.amount
    else if (adj.adjustment_type === "Expected") bucket.adjustments.expected += adj.amount
    else if (adj.adjustment_type === "Best Case") bucket.adjustments.bestCase += adj.amount
    else if (adj.adjustment_type === "Worst Case") bucket.adjustments.worstCase += adj.amount
  }

  // Load actuals in parallel then finalise metrics.
  await Promise.all(
    quarters.map(async (qf) => {
      const actuals = await loadActuals(qf.start, qf.end)
      qf.actualInvoiced = round2(actuals.invoiced)
      qf.actualCollected = round2(actuals.collected)
    }),
  )

  for (const qf of quarters) finaliseQuarter(qf)

  const summary = summariseQuarters(fyStartYear, startMonth, quarters)

  const ownerBreakdown = [...ownerAgg.values()]
    .map((o) => ({
      ...o,
      expected: round2(o.expected),
      committed: round2(o.committed),
      weightedPipeline: round2(o.weightedPipeline),
    }))
    .sort((a, b) => b.expected - a.expected)

  const fyOptions = buildFyOptions(fyStartYear, allOpps)

  return {
    fyStartYear,
    fyLabel: fyLabel(fyStartYear, startMonth),
    startMonthName,
    baseCurrency,
    quarters,
    summary,
    ownerBreakdown,
    adjustments,
    fyOptions,
    unscheduledCount,
    generatedAt: new Date().toISOString(),
  }
}

function finaliseQuarter(qf: QuarterForecast) {
  qf.pipelineValue = round2(qf.pipelineValue)
  qf.weightedPipeline = round2(qf.weightedPipeline)
  qf.committed = round2(qf.committed)
  qf.atRiskValue = round2(qf.atRiskValue)

  qf.systemExpected = round2(qf.committed + qf.weightedPipeline)
  qf.expected = round2(qf.systemExpected + qf.adjustments.expected)
  // Best case = committed + full open pipeline value + upside adjustments.
  qf.bestCase = round2(qf.committed + qf.pipelineValue + qf.adjustments.bestCase)
  // Worst case = only near-certain (committed), floored by any negative adj.
  qf.worstCase = round2(Math.max(0, qf.committed + qf.adjustments.worstCase))
  qf.target = round2(qf.adjustments.target)
  qf.gap = round2(qf.target - qf.expected)
  qf.coverage = qf.target > 0 ? round2((qf.pipelineValue + qf.committed) / qf.target) : null
  qf.variance = round2(qf.actualInvoiced - qf.expected)
  qf.accuracy = qf.expected > 0 ? round2((qf.actualInvoiced / qf.expected) * 100) : null
  qf.health = forecastHealth(qf.expected, qf.target)
}

function summariseQuarters(fyStartYear: number, startMonth: number, quarters: QuarterForecast[]): QuarterForecast {
  const s = emptyQuarter(0, fyLabel(fyStartYear, startMonth), quarters[0]?.start ?? "", quarters[3]?.end ?? "")
  for (const q of quarters) {
    s.pipelineValue += q.pipelineValue
    s.weightedPipeline += q.weightedPipeline
    s.committed += q.committed
    s.actualInvoiced += q.actualInvoiced
    s.actualCollected += q.actualCollected
    s.atRiskValue += q.atRiskValue
    s.dealCount += q.dealCount
    s.adjustments.expected += q.adjustments.expected
    s.adjustments.bestCase += q.adjustments.bestCase
    s.adjustments.worstCase += q.adjustments.worstCase
    s.adjustments.target += q.adjustments.target
  }
  finaliseQuarter(s)
  return s
}

function buildFyOptions(current: number, opps: ForecastOpportunity[]): number[] {
  const set = new Set<number>([current, current - 1, current + 1])
  for (const o of opps) if (o.fyStartYear != null) set.add(o.fyStartYear)
  return [...set].sort((a, b) => b - a)
}

// ---------------------------------------------------------------------------
// Quarter drill-down (traceability)
// ---------------------------------------------------------------------------

export async function computeQuarterContributors(opts: {
  fyStartYear: number
  quarter: number
  ownerId?: number | null
}): Promise<{ contributors: ForecastOpportunity[]; unscheduled: ForecastOpportunity[] }> {
  const settings = await getSettings()
  const startMonth = fyStartMonthIndex(settings["app.financial_year_start"])
  currentStartMonth = startMonth

  const all = await loadOpportunities()
  const scoped = opts.ownerId != null ? all.filter((o) => o.ownerId === opts.ownerId) : all

  const contributors = scoped
    .filter((o) => o.category !== "Omitted" && o.fyStartYear === opts.fyStartYear && o.quarter === opts.quarter)
    .sort((a, b) => b.value - a.value)

  const unscheduled = scoped
    .filter((o) => o.category !== "Omitted" && o.quarter == null)
    .sort((a, b) => b.value - a.value)

  return { contributors, unscheduled }
}
