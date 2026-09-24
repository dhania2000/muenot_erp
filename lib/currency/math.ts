/**
 * SPEC 159 — Multi-Currency: pure, client-safe money/FX math.
 * ---------------------------------------------------------------------------
 * Deliberately free of any server-only import (db / auth / node builtins) so it
 * can be reused by form dialogs on the client, by the server model, and unit
 * tested directly under Vitest.
 *
 * Rate convention (single source of truth for the whole module):
 *
 *   A stored rate is expressed as QUOTE -> BASE, meaning "how many units of the
 *   BASE (reporting) currency one unit of the QUOTE (foreign) currency is
 *   worth". Therefore:
 *
 *       amount_in_base = amount_in_quote * rate
 *
 *   e.g. quote=USD, base=INR, rate=83.25  =>  100 USD = 8325 INR.
 */

// ---------------------------------------------------------------------------
// Currency precision
// ---------------------------------------------------------------------------

/**
 * Minor-unit (decimal place) count for the well-known currencies that do NOT
 * use 2 decimals. Everything else defaults to 2. The tenant catalogue
 * (`md_currencies.decimals`) always wins when a value is supplied to the
 * functions below; this table is only the offline fallback.
 */
export const CURRENCY_DECIMALS: Record<string, number> = {
  // zero-decimal currencies
  JPY: 0,
  KRW: 0,
  VND: 0,
  CLP: 0,
  ISK: 0,
  XOF: 0,
  XAF: 0,
  // three-decimal currencies
  BHD: 3,
  KWD: 3,
  OMR: 3,
  TND: 3,
  IQD: 3,
  JOD: 3,
}

/** Decimals for a currency code, honouring an explicit override first. */
export function decimalsFor(code: string | null | undefined, override?: number | null): number {
  if (override != null && Number.isFinite(override) && override >= 0) return Math.trunc(override)
  if (!code) return 2
  const d = CURRENCY_DECIMALS[code.toUpperCase()]
  return d == null ? 2 : d
}

// ---------------------------------------------------------------------------
// Rounding
// ---------------------------------------------------------------------------

/**
 * Round to a fixed number of decimals using "round half away from zero" — the
 * conventional accounting rounding, applied symmetrically so a gain and an
 * equal-magnitude loss round to the same absolute value. Uses an EPSILON nudge
 * to defeat binary-float artefacts (e.g. 1.005 -> 1.01, not 1.00).
 */
export function roundToDecimals(value: number, decimals = 2): number {
  if (!Number.isFinite(value)) return 0
  const places = Math.max(0, Math.trunc(decimals))
  // Shift the decimal point via exponential-string notation rather than a
  // float multiply. Parsing "1.005e2" yields exactly 100.5, so a decimal half
  // rounds the way an accountant expects instead of being lost to a binary
  // artefact (1.005 * 100 === 100.49999999999999). Round the magnitude and
  // reapply the sign so gains and losses round half AWAY from zero symmetrically.
  const sign = value < 0 ? -1 : 1
  const abs = Math.abs(value)
  const rounded = Number(`${Math.round(Number(`${abs}e${places}`))}e-${places}`)
  const result = sign * rounded
  // Normalise -0 to 0.
  return Object.is(result, -0) ? 0 : result
}

// ---------------------------------------------------------------------------
// Conversion
// ---------------------------------------------------------------------------

/**
 * Convert an amount using an already-resolved QUOTE->BASE rate, rounding the
 * result to the target (base) currency's precision.
 */
export function convertWithRate(amount: number, rate: number, baseDecimals = 2): number {
  const a = Number(amount)
  const r = Number(rate)
  if (!Number.isFinite(a) || !Number.isFinite(r)) return 0
  return roundToDecimals(a * r, baseDecimals)
}

export type RatePoint = { rate_date: string; rate: number | string }

/**
 * Historical rate selection: given a set of rate points for one currency pair,
 * return the rate effective on `asOf` — i.e. the most recent point dated on or
 * before `asOf`. Returns null when no point is early enough (the pair had no
 * published rate yet on that date).
 *
 * Dates are compared lexicographically on their YYYY-MM-DD prefix, which is
 * correct for ISO dates and avoids any timezone drift from `new Date()`.
 */
export function pickRateAsOf(points: RatePoint[], asOf: string): number | null {
  const cutoff = isoDate(asOf)
  let best: { date: string; rate: number } | null = null
  for (const p of points) {
    const d = isoDate(p.rate_date)
    if (d > cutoff) continue
    const r = Number(p.rate)
    if (!Number.isFinite(r)) continue
    if (!best || d > best.date) best = { date: d, rate: r }
  }
  return best ? best.rate : null
}

function isoDate(value: string): string {
  return String(value ?? "").slice(0, 10)
}

// ---------------------------------------------------------------------------
// Rate resolution (direct / inverse / triangulation)
// ---------------------------------------------------------------------------

/** A directional rate keyed QUOTE->BASE. */
export type DirectedRate = { quote: string; base: string; rate: number }

/**
 * Resolve the QUOTE->BASE conversion rate for an arbitrary `from`/`to` pair from
 * a flat set of directed rates, trying in order:
 *   1. identity        (from === to  -> 1)
 *   2. direct          (from -> to)
 *   3. inverse         (to -> from   -> 1 / rate)
 *   4. triangulation   (from -> pivot and to -> pivot  -> rFrom / rTo)
 *
 * `pivot` is normally the tenant's base/reporting currency, through which most
 * rates are published. Returns null when no path exists.
 */
export function resolveRate(
  from: string,
  to: string,
  rates: DirectedRate[],
  pivot?: string | null,
): number | null {
  const f = norm(from)
  const t = norm(to)
  if (!f || !t) return null
  if (f === t) return 1

  const index = new Map<string, number>()
  for (const r of rates) {
    const rate = Number(r.rate)
    if (!Number.isFinite(rate) || rate <= 0) continue
    index.set(`${norm(r.quote)}>${norm(r.base)}`, rate)
  }

  const direct = index.get(`${f}>${t}`)
  if (direct != null) return direct

  const inverse = index.get(`${t}>${f}`)
  if (inverse != null && inverse !== 0) return 1 / inverse

  const pivots = new Set<string>()
  if (pivot) pivots.add(norm(pivot))
  // Also try any currency reachable from both f and t.
  for (const key of index.keys()) pivots.add(key.split(">")[1])

  for (const p of pivots) {
    if (!p || p === f || p === t) continue
    const rFrom = index.get(`${f}>${p}`) ?? inv(index.get(`${p}>${f}`))
    const rTo = index.get(`${t}>${p}`) ?? inv(index.get(`${p}>${t}`))
    if (rFrom != null && rTo != null && rTo !== 0) return rFrom / rTo
  }

  return null
}

function inv(rate: number | undefined): number | undefined {
  if (rate == null || rate === 0) return undefined
  return 1 / rate
}

function norm(code: string | null | undefined): string {
  return String(code ?? "").trim().toUpperCase()
}

// ---------------------------------------------------------------------------
// FX gain / loss
// ---------------------------------------------------------------------------

export type GainLossInput = {
  /** Amount in the transaction (quote) currency. */
  amount: number
  /** QUOTE->BASE rate at which the item was originally booked. */
  bookedRate: number
  /** QUOTE->BASE rate at settlement / revaluation. */
  settleRate: number
  /** Decimals of the base (reporting) currency. Defaults to 2. */
  baseDecimals?: number
}

export type GainLossResult = {
  baseBooked: number
  baseSettled: number
  /** Positive = gain, negative = loss, expressed in the base currency. */
  gainLoss: number
}

/**
 * FX gain/loss when a foreign-currency item booked at `bookedRate` is settled or
 * revalued at `settleRate`. All three output figures are rounded to the base
 * currency precision so they reconcile exactly with what is posted to the ledger
 * (baseSettled - baseBooked === gainLoss).
 */
export function computeGainLoss({
  amount,
  bookedRate,
  settleRate,
  baseDecimals = 2,
}: GainLossInput): GainLossResult {
  const baseBooked = convertWithRate(amount, bookedRate, baseDecimals)
  const baseSettled = convertWithRate(amount, settleRate, baseDecimals)
  const gainLoss = roundToDecimals(baseSettled - baseBooked, baseDecimals)
  return { baseBooked, baseSettled, gainLoss }
}
