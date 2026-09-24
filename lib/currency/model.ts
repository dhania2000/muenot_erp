import "server-only"
/**
 * SPEC 159 — Multi-Currency: server model.
 * ---------------------------------------------------------------------------
 * The tenant-scoped store and business logic behind multi-currency support:
 *
 *   - Base currency        : the tenant's reporting currency, taken from the
 *                            `currency.default_code` setting (fallback INR), or
 *                            a legal entity's own `base_currency`.
 *   - Transaction currency : the currency a document is denominated in.
 *   - Exchange rates        : `currency_exchange_rates` — one row per
 *                            (quote -> base, date). Convention QUOTE->BASE, i.e.
 *                            amount_in_base = amount_in_quote * rate.
 *   - Historical rates      : selection is always "as of" a date — the most
 *                            recent rate on or before it (see pickRateAsOf).
 *   - Conversion            : direct / inverse / triangulated through the base
 *                            currency, rounded to the target currency precision.
 *   - Gain / loss           : `currency_fx_gain_loss` — realized/unrealized FX
 *                            differences recorded per source document.
 *
 * Isolation: both tables are registered tenant-owned (lib/tenant-tables.ts) and
 * all access flows through the tenant-scoped helpers.
 */
import { pool, query } from "@/lib/db"
import {
  currentTenantId,
  tenantSelect,
  tenantInsert,
  tenantUpdate,
  tenantDelete,
} from "@/lib/tenant-scope"
import { getSettings } from "@/lib/settings/server"
import {
  decimalsFor,
  pickRateAsOf,
  resolveRate,
  convertWithRate,
  computeGainLoss,
  type DirectedRate,
  type GainLossResult,
} from "@/lib/currency/math"

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------
export class CurrencyValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "CurrencyValidationError"
  }
}
export class RateNotFoundError extends Error {
  constructor(message = "No exchange rate available for the requested conversion") {
    super(message)
    this.name = "RateNotFoundError"
  }
}

export type Actor = { userId: number | null; name: string | null }

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export type ExchangeRate = {
  id: number
  tenant_id: number
  base_currency: string
  quote_currency: string
  rate_date: string
  rate: number
  source: "manual" | "api" | "system"
  note: string | null
  created_by: number | null
  created_at: string
  updated_at: string
}

export type FxGainLoss = {
  id: number
  tenant_id: number
  entity_id: number | null
  source_module: string
  source_ref: string | null
  quote_currency: string
  base_currency: string
  txn_amount: number
  booked_rate: number
  settle_rate: number
  base_booked: number
  base_settled: number
  gain_loss: number
  kind: "realized" | "unrealized"
  as_of_date: string
  notes: string | null
  created_by: number | null
  created_at: string
}

// ---------------------------------------------------------------------------
// Schema self-heal (mirrors database/migrations/2026-12-29-spec159-multi-currency.sql)
// ---------------------------------------------------------------------------
let ensured: Promise<void> | null = null

export function ensureCurrencySchema(): Promise<void> {
  if (!ensured) {
    ensured = runEnsure().catch((err) => {
      ensured = null
      throw err
    })
  }
  return ensured
}

async function runEnsure(): Promise<void> {
  const conn = await pool.getConnection()
  try {
    await conn.query(`
      CREATE TABLE IF NOT EXISTS \`currency_exchange_rates\` (
        \`id\`             INT UNSIGNED NOT NULL AUTO_INCREMENT,
        \`tenant_id\`      INT UNSIGNED DEFAULT NULL,
        \`base_currency\`  VARCHAR(3)   NOT NULL,
        \`quote_currency\` VARCHAR(3)   NOT NULL,
        \`rate_date\`      DATE         NOT NULL,
        \`rate\`           DECIMAL(20,10) NOT NULL,
        \`source\`         ENUM('manual','api','system') NOT NULL DEFAULT 'manual',
        \`note\`           VARCHAR(255) DEFAULT NULL,
        \`created_by\`     INT UNSIGNED DEFAULT NULL,
        \`created_at\`     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        \`updated_at\`     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (\`id\`),
        UNIQUE KEY \`uq_fx_rate\` (\`tenant_id\`, \`quote_currency\`, \`base_currency\`, \`rate_date\`),
        KEY \`idx_fx_rate_lookup\` (\`tenant_id\`, \`quote_currency\`, \`base_currency\`, \`rate_date\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `)
    await conn.query(`
      CREATE TABLE IF NOT EXISTS \`currency_fx_gain_loss\` (
        \`id\`             INT UNSIGNED NOT NULL AUTO_INCREMENT,
        \`tenant_id\`      INT UNSIGNED DEFAULT NULL,
        \`entity_id\`      INT UNSIGNED DEFAULT NULL,
        \`source_module\`  VARCHAR(40)  NOT NULL,
        \`source_ref\`     VARCHAR(64)  DEFAULT NULL,
        \`quote_currency\` VARCHAR(3)   NOT NULL,
        \`base_currency\`  VARCHAR(3)   NOT NULL,
        \`txn_amount\`     DECIMAL(20,4)  NOT NULL DEFAULT 0,
        \`booked_rate\`    DECIMAL(20,10) NOT NULL DEFAULT 0,
        \`settle_rate\`    DECIMAL(20,10) NOT NULL DEFAULT 0,
        \`base_booked\`    DECIMAL(20,4)  NOT NULL DEFAULT 0,
        \`base_settled\`   DECIMAL(20,4)  NOT NULL DEFAULT 0,
        \`gain_loss\`      DECIMAL(20,4)  NOT NULL DEFAULT 0,
        \`kind\`           ENUM('realized','unrealized') NOT NULL DEFAULT 'realized',
        \`as_of_date\`     DATE         NOT NULL,
        \`notes\`          VARCHAR(255) DEFAULT NULL,
        \`created_by\`     INT UNSIGNED DEFAULT NULL,
        \`created_at\`     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (\`id\`),
        KEY \`idx_fx_gl_source\` (\`tenant_id\`, \`source_module\`, \`source_ref\`),
        KEY \`idx_fx_gl_date\` (\`tenant_id\`, \`as_of_date\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `)
  } finally {
    conn.release()
  }
}

// ---------------------------------------------------------------------------
// Currency helpers
// ---------------------------------------------------------------------------
function norm(code: string | null | undefined): string {
  return String(code ?? "").trim().toUpperCase()
}

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

/** The tenant's base / reporting currency (currency.default_code, fallback INR). */
export async function getBaseCurrency(): Promise<string> {
  const settings = await getSettings()
  return norm(settings["currency.default_code"]) || "INR"
}

// Per-process cache of the global currency catalogue precision, so conversions
// don't re-query md_currencies on every call.
let decimalsCache: Map<string, number> | null = null

async function loadDecimalsMap(): Promise<Map<string, number>> {
  if (decimalsCache) return decimalsCache
  const map = new Map<string, number>()
  try {
    const rows = await query<any[]>(
      "SELECT code, decimals FROM md_currencies WHERE is_active = 1",
    )
    for (const r of rows) map.set(norm(r.code), Number(r.decimals))
  } catch {
    // Catalogue not present on this install — fall back to the offline table.
  }
  decimalsCache = map
  return map
}

/** Decimal precision for a currency, catalogue-first then the offline fallback. */
export async function getCurrencyDecimals(code: string): Promise<number> {
  const map = await loadDecimalsMap()
  return decimalsFor(code, map.get(norm(code)))
}

// ---------------------------------------------------------------------------
// Exchange-rate reads
// ---------------------------------------------------------------------------
export type ListRatesFilter = {
  quoteCurrency?: string
  baseCurrency?: string
  from?: string
  to?: string
  limit?: number
}

export async function listRates(filter: ListRatesFilter = {}): Promise<ExchangeRate[]> {
  await ensureCurrencySchema()
  const clauses: string[] = []
  const params: any[] = []
  if (filter.quoteCurrency) {
    clauses.push("quote_currency = ?")
    params.push(norm(filter.quoteCurrency))
  }
  if (filter.baseCurrency) {
    clauses.push("base_currency = ?")
    params.push(norm(filter.baseCurrency))
  }
  if (filter.from) {
    clauses.push("rate_date >= ?")
    params.push(filter.from.slice(0, 10))
  }
  if (filter.to) {
    clauses.push("rate_date <= ?")
    params.push(filter.to.slice(0, 10))
  }
  const limit = Math.min(1000, Math.max(1, Math.trunc(filter.limit ?? 500)))
  const rows = await tenantSelect<any[]>("currency_exchange_rates", {
    where: clauses.join(" AND "),
    params,
    tail: `ORDER BY rate_date DESC, quote_currency ASC LIMIT ${limit}`,
  })
  return rows.map(mapRate)
}

/**
 * All directed rate points for the tenant effective on or before `asOf`,
 * collapsed to the single most-recent rate per (quote -> base) pair. This is the
 * flat rate table conversion resolution runs against.
 */
async function directedRatesAsOf(asOf: string): Promise<DirectedRate[]> {
  await ensureCurrencySchema()
  const rows = await tenantSelect<any[]>("currency_exchange_rates", {
    columns: "quote_currency, base_currency, rate, rate_date",
    where: "rate_date <= ?",
    params: [asOf.slice(0, 10)],
    tail: "ORDER BY rate_date ASC",
  })
  // Grouping by pair and applying pickRateAsOf keeps the historical-selection
  // rule in exactly one place (the pure math module).
  const byPair = new Map<string, { quote: string; base: string; points: any[] }>()
  for (const r of rows) {
    const key = `${norm(r.quote_currency)}>${norm(r.base_currency)}`
    let g = byPair.get(key)
    if (!g) {
      g = { quote: norm(r.quote_currency), base: norm(r.base_currency), points: [] }
      byPair.set(key, g)
    }
    g.points.push({ rate_date: r.rate_date, rate: r.rate })
  }
  const out: DirectedRate[] = []
  for (const g of byPair.values()) {
    const rate = pickRateAsOf(g.points, asOf)
    if (rate != null) out.push({ quote: g.quote, base: g.base, rate })
  }
  return out
}

/**
 * The QUOTE->BASE rate for one pair effective on `asOf`, or null when the pair
 * has no rate on or before that date.
 */
export async function getRateAsOf(
  quoteCurrency: string,
  baseCurrency: string,
  asOf: string = today(),
): Promise<number | null> {
  await ensureCurrencySchema()
  const rows = await tenantSelect<any[]>("currency_exchange_rates", {
    columns: "rate, rate_date",
    where: "quote_currency = ? AND base_currency = ? AND rate_date <= ?",
    params: [norm(quoteCurrency), norm(baseCurrency), asOf.slice(0, 10)],
    tail: "ORDER BY rate_date DESC LIMIT 1",
  })
  return rows.length ? Number(rows[0].rate) : null
}

// ---------------------------------------------------------------------------
// Conversion
// ---------------------------------------------------------------------------
export type ConversionResult = {
  amount: number
  from: string
  to: string
  rate: number
  converted: number
  asOf: string
}

/**
 * Convert `amount` from one currency to another as of a date, resolving the rate
 * directly, by inverse, or by triangulation through the tenant base currency,
 * and rounding to the target currency's precision. Throws RateNotFoundError when
 * no rate path exists.
 */
export async function convert(
  amount: number,
  from: string,
  to: string,
  asOf: string = today(),
): Promise<ConversionResult> {
  const f = norm(from)
  const t = norm(to)
  const day = asOf.slice(0, 10)
  const toDecimals = await getCurrencyDecimals(t)

  if (f === t) {
    const converted = convertWithRate(amount, 1, toDecimals)
    return { amount: Number(amount) || 0, from: f, to: t, rate: 1, converted, asOf: day }
  }

  const base = await getBaseCurrency()
  const rates = await directedRatesAsOf(day)
  const rate = resolveRate(f, t, rates, base)
  if (rate == null) {
    throw new RateNotFoundError(`No exchange rate to convert ${f} -> ${t} as of ${day}`)
  }
  const converted = convertWithRate(amount, rate, toDecimals)
  return { amount: Number(amount) || 0, from: f, to: t, rate, converted, asOf: day }
}

/** Convenience: convert a transaction amount into the tenant base currency. */
export async function convertToBase(
  amount: number,
  from: string,
  asOf: string = today(),
): Promise<ConversionResult> {
  const base = await getBaseCurrency()
  return convert(amount, from, base, asOf)
}

// ---------------------------------------------------------------------------
// Exchange-rate writes
// ---------------------------------------------------------------------------
export type UpsertRateInput = {
  quoteCurrency: string
  baseCurrency?: string
  rate: number
  rateDate?: string
  source?: "manual" | "api" | "system"
  note?: string | null
}

/**
 * Insert or update the rate for a (quote -> base, date) key. Re-supplying the
 * same key overwrites the rate, so a corrected figure never creates a duplicate
 * historical point.
 */
export async function upsertRate(input: UpsertRateInput, actor: Actor): Promise<ExchangeRate> {
  await ensureCurrencySchema()
  const quote = norm(input.quoteCurrency)
  const base = norm(input.baseCurrency) || (await getBaseCurrency())
  const rate = Number(input.rate)
  const rateDate = (input.rateDate || today()).slice(0, 10)

  if (!/^[A-Z]{3}$/.test(quote)) throw new CurrencyValidationError("quoteCurrency must be a 3-letter code")
  if (!/^[A-Z]{3}$/.test(base)) throw new CurrencyValidationError("baseCurrency must be a 3-letter code")
  if (quote === base) throw new CurrencyValidationError("quoteCurrency and baseCurrency must differ")
  if (!Number.isFinite(rate) || rate <= 0) throw new CurrencyValidationError("rate must be a positive number")
  if (Number.isNaN(new Date(rateDate).getTime())) throw new CurrencyValidationError("rateDate is invalid")

  const source = input.source ?? "manual"
  const note = input.note ? String(input.note).slice(0, 255) : null

  const existing = await tenantSelect<any[]>("currency_exchange_rates", {
    columns: "id",
    where: "quote_currency = ? AND base_currency = ? AND rate_date = ?",
    params: [quote, base, rateDate],
    tail: "LIMIT 1",
  })

  if (existing.length) {
    await tenantUpdate(
      "currency_exchange_rates",
      { rate, source, note, created_by: actor.userId ?? null },
      "id = ?",
      [existing[0].id],
    )
    return (await getRateById(existing[0].id))!
  }

  const { insertId } = await tenantInsert("currency_exchange_rates", {
    quote_currency: quote,
    base_currency: base,
    rate_date: rateDate,
    rate,
    source,
    note,
    created_by: actor.userId ?? null,
  })
  return (await getRateById(insertId))!
}

export async function getRateById(id: number): Promise<ExchangeRate | null> {
  await ensureCurrencySchema()
  const rows = await tenantSelect<any[]>("currency_exchange_rates", {
    where: "id = ?",
    params: [id],
    tail: "LIMIT 1",
  })
  return rows.length ? mapRate(rows[0]) : null
}

export async function deleteRate(id: number): Promise<boolean> {
  await ensureCurrencySchema()
  const affected = await tenantDelete("currency_exchange_rates", "id = ?", [id])
  return affected > 0
}

// ---------------------------------------------------------------------------
// FX gain / loss
// ---------------------------------------------------------------------------
export type GainLossParams = {
  amount: number
  quoteCurrency: string
  baseCurrency?: string
  bookedRate: number
  settleRate: number
  kind?: "realized" | "unrealized"
  sourceModule: string
  sourceRef?: string | null
  entityId?: number | null
  asOfDate?: string
  notes?: string | null
}

/**
 * Compute FX gain/loss for a foreign-currency item and persist it to the
 * gain/loss ledger. Returns both the persisted row and the computed figures.
 */
export async function recordGainLoss(
  params: GainLossParams,
  actor: Actor,
): Promise<{ result: GainLossResult; row: FxGainLoss }> {
  await ensureCurrencySchema()
  const quote = norm(params.quoteCurrency)
  const base = norm(params.baseCurrency) || (await getBaseCurrency())
  const baseDecimals = await getCurrencyDecimals(base)

  const result = computeGainLoss({
    amount: Number(params.amount),
    bookedRate: Number(params.bookedRate),
    settleRate: Number(params.settleRate),
    baseDecimals,
  })

  const asOf = (params.asOfDate || today()).slice(0, 10)
  const { insertId } = await tenantInsert("currency_fx_gain_loss", {
    entity_id: params.entityId ?? null,
    source_module: String(params.sourceModule).slice(0, 40),
    source_ref: params.sourceRef ? String(params.sourceRef).slice(0, 64) : null,
    quote_currency: quote,
    base_currency: base,
    txn_amount: Number(params.amount) || 0,
    booked_rate: Number(params.bookedRate) || 0,
    settle_rate: Number(params.settleRate) || 0,
    base_booked: result.baseBooked,
    base_settled: result.baseSettled,
    gain_loss: result.gainLoss,
    kind: params.kind ?? "realized",
    as_of_date: asOf,
    notes: params.notes ? String(params.notes).slice(0, 255) : null,
    created_by: actor.userId ?? null,
  })

  const rows = await tenantSelect<any[]>("currency_fx_gain_loss", {
    where: "id = ?",
    params: [insertId],
    tail: "LIMIT 1",
  })
  return { result, row: mapGainLoss(rows[0]) }
}

export async function listGainLoss(
  filter: { sourceModule?: string; from?: string; to?: string; limit?: number } = {},
): Promise<FxGainLoss[]> {
  await ensureCurrencySchema()
  const clauses: string[] = []
  const params: any[] = []
  if (filter.sourceModule) {
    clauses.push("source_module = ?")
    params.push(filter.sourceModule)
  }
  if (filter.from) {
    clauses.push("as_of_date >= ?")
    params.push(filter.from.slice(0, 10))
  }
  if (filter.to) {
    clauses.push("as_of_date <= ?")
    params.push(filter.to.slice(0, 10))
  }
  const limit = Math.min(1000, Math.max(1, Math.trunc(filter.limit ?? 500)))
  const rows = await tenantSelect<any[]>("currency_fx_gain_loss", {
    where: clauses.join(" AND "),
    params,
    tail: `ORDER BY as_of_date DESC, id DESC LIMIT ${limit}`,
  })
  return rows.map(mapGainLoss)
}

// ---------------------------------------------------------------------------
// Row mappers — normalise MySQL DECIMAL strings to numbers.
// ---------------------------------------------------------------------------
function mapRate(r: any): ExchangeRate {
  return {
    id: Number(r.id),
    tenant_id: Number(r.tenant_id),
    base_currency: r.base_currency,
    quote_currency: r.quote_currency,
    rate_date: typeof r.rate_date === "string" ? r.rate_date.slice(0, 10) : toISO(r.rate_date),
    rate: Number(r.rate),
    source: r.source,
    note: r.note ?? null,
    created_by: r.created_by == null ? null : Number(r.created_by),
    created_at: toISO(r.created_at),
    updated_at: toISO(r.updated_at),
  }
}

function mapGainLoss(r: any): FxGainLoss {
  return {
    id: Number(r.id),
    tenant_id: Number(r.tenant_id),
    entity_id: r.entity_id == null ? null : Number(r.entity_id),
    source_module: r.source_module,
    source_ref: r.source_ref ?? null,
    quote_currency: r.quote_currency,
    base_currency: r.base_currency,
    txn_amount: Number(r.txn_amount),
    booked_rate: Number(r.booked_rate),
    settle_rate: Number(r.settle_rate),
    base_booked: Number(r.base_booked),
    base_settled: Number(r.base_settled),
    gain_loss: Number(r.gain_loss),
    kind: r.kind,
    as_of_date: typeof r.as_of_date === "string" ? r.as_of_date.slice(0, 10) : toISO(r.as_of_date),
    notes: r.notes ?? null,
    created_by: r.created_by == null ? null : Number(r.created_by),
    created_at: toISO(r.created_at),
  }
}

function toISO(value: any): string {
  if (!value) return ""
  if (value instanceof Date) return value.toISOString()
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? String(value) : d.toISOString()
}
