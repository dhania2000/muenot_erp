/**
 * Client-safe, pure formatting helpers driven by company settings.
 *
 * Every function takes a plain settings map (the merged skey -> svalue object
 * produced by the settings service / public settings API) so it can run on the
 * server, in client components, or in isolation. No server-only imports here.
 */

export type SettingsMap = Record<string, string>

function numSetting(s: SettingsMap, key: string, def: number) {
  const v = Number(s[key])
  return Number.isFinite(v) ? v : def
}

/** Group the integer part with the configured thousands separator. */
function groupThousands(intPart: string, separator: string) {
  return intPart.replace(/\B(?=(\d{3})+(?!\d))/g, "\u0001").replace(/\u0001/g, separator)
}

/** Format a bare number using the currency decimal/separator settings. */
export function formatNumber(value: number | string, s: SettingsMap = {}): string {
  const raw = Number(value)
  const safe = Number.isFinite(raw) ? raw : 0
  const decimals = Math.max(0, Math.min(6, numSetting(s, "currency.decimals", 2)))
  const thousand = s["currency.thousand_separator"] ?? ","
  const decimal = s["currency.decimal_separator"] ?? "."
  const fixed = Math.abs(safe).toFixed(decimals)
  const [intPart, fracPart] = fixed.split(".")
  let out = groupThousands(intPart, thousand)
  if (fracPart) out += decimal + fracPart
  return (safe < 0 ? "-" : "") + out
}

/** Format a monetary value with the configured symbol and position. */
export function formatCurrency(value: number | string, s: SettingsMap = {}): string {
  const raw = Number(value)
  const safe = Number.isFinite(raw) ? raw : 0
  const symbol = s["currency.symbol"] || "\u20B9"
  const position = s["currency.symbol_position"] || "Left"
  const body = formatNumber(Math.abs(safe), s)
  let out: string
  switch (position) {
    case "Right":
      out = `${body}${symbol}`
      break
    case "Left with space":
      out = `${symbol} ${body}`
      break
    case "Right with space":
      out = `${body} ${symbol}`
      break
    default:
      out = `${symbol}${body}`
  }
  return safe < 0 ? `-${out}` : out
}

type DateParts = { d: string; m: string; y: string }

function dateParts(date: Date, timeZone?: string): DateParts {
  try {
    const fmt = new Intl.DateTimeFormat("en-GB", {
      timeZone: timeZone || undefined,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
    const parts = fmt.formatToParts(date)
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? ""
    return { d: get("day"), m: get("month"), y: get("year") }
  } catch {
    return {
      d: String(date.getDate()).padStart(2, "0"),
      m: String(date.getMonth() + 1).padStart(2, "0"),
      y: String(date.getFullYear()),
    }
  }
}

function toDate(value: Date | string | number | null | undefined): Date | null {
  if (value == null || value === "") return null
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value
  const d = new Date(typeof value === "string" ? value.replace(" ", "T") : value)
  return Number.isNaN(d.getTime()) ? null : d
}

/** Format a date using the configured app.date_format and app.timezone. */
export function formatDate(value: Date | string | number | null | undefined, s: SettingsMap = {}): string {
  const d = toDate(value)
  if (!d) return value == null ? "" : String(value)
  const format = s["app.date_format"] || "DD-MM-YYYY"
  const p = dateParts(d, s["app.timezone"])
  return format
    .replace(/YYYY/g, p.y)
    .replace(/DD/g, p.d)
    .replace(/MM/g, p.m)
}

/** Format a time (accepts "HH:MM" or a full datetime) per app.time_format. */
export function formatTime(value: Date | string | number | null | undefined, s: SettingsMap = {}): string {
  if (value == null || value === "") return ""
  const twelveHour = (s["app.time_format"] || "12 Hours").startsWith("12")
  const isClockOnly = typeof value === "string" && /^\d{1,2}:\d{2}(:\d{2})?$/.test(value.trim())
  const d = isClockOnly ? new Date(`1970-01-01T${value}`) : toDate(value)
  if (!d) return String(value)
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: isClockOnly ? undefined : s["app.timezone"] || undefined,
      hour: "2-digit",
      minute: "2-digit",
      hour12: twelveHour,
    }).format(d)
  } catch {
    return String(value)
  }
}

/** Format a date and time together. */
export function formatDateTime(value: Date | string | number | null | undefined, s: SettingsMap = {}): string {
  const d = toDate(value)
  if (!d) return value == null ? "" : String(value)
  return `${formatDate(d, s)} ${formatTime(d, s)}`.trim()
}
