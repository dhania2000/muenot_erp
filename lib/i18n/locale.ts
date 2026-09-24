/**
 * SPEC 160 — Localization formatting core.
 *
 * Pure, client-safe, `Intl`-based helpers for locale-aware formatting of dates,
 * times, numbers, currency, percentages and relative time, plus text direction
 * (RTL/LTR). No server-only imports and no network calls, so these run on the
 * server, in client components, and under Vitest identically.
 *
 * The single source of truth for *which* languages exist and their direction is
 * `./languages`; this module maps each language to a BCP-47 locale and wraps
 * `Intl` with defensive fallbacks (older/ICU-limited runtimes never throw).
 */
import { DEFAULT_LANGUAGE, getLanguage } from './languages'

/**
 * Maps each supported UI language code to a concrete BCP-47 locale used for
 * `Intl` formatting. A bare language (e.g. `fr`) formats inconsistently across
 * runtimes, so we pin a representative region for stable grouping/date order.
 */
export const LANGUAGE_LOCALE: Record<string, string> = {
  en: 'en-US',
  hi: 'hi-IN',
  es: 'es-ES',
  pt: 'pt-BR',
  fr: 'fr-FR',
  de: 'de-DE',
  it: 'it-IT',
  nl: 'nl-NL',
  ru: 'ru-RU',
  uk: 'uk-UA',
  pl: 'pl-PL',
  tr: 'tr-TR',
  ar: 'ar',
  he: 'he-IL',
  fa: 'fa-IR',
  ur: 'ur-PK',
  zh: 'zh-CN',
  ja: 'ja-JP',
  ko: 'ko-KR',
  vi: 'vi-VN',
  th: 'th-TH',
  id: 'id-ID',
  ms: 'ms-MY',
  bn: 'bn-BD',
  ta: 'ta-IN',
  te: 'te-IN',
  mr: 'mr-IN',
  gu: 'gu-IN',
  pa: 'pa-IN',
  sw: 'sw-KE',
  el: 'el-GR',
  sv: 'sv-SE',
  fi: 'fi-FI',
  cs: 'cs-CZ',
  ro: 'ro-RO',
  hu: 'hu-HU',
}

/** BCP-47 locale for a UI language code, falling back to the default language. */
export function localeForLanguage(code?: string | null): string {
  if (code && LANGUAGE_LOCALE[code]) return LANGUAGE_LOCALE[code]
  return LANGUAGE_LOCALE[DEFAULT_LANGUAGE] ?? 'en-US'
}

/** Text direction for a UI language code (`rtl` for Arabic/Hebrew/Persian/Urdu). */
export function directionForLanguage(code?: string | null): 'ltr' | 'rtl' {
  return getLanguage(code ?? undefined)?.dir ?? 'ltr'
}

/** Whether a UI language is written right-to-left. */
export function isRtlLanguage(code?: string | null): boolean {
  return directionForLanguage(code) === 'rtl'
}

export type LocaleOptions = { locale?: string; timeZone?: string }

/** Coerce loosely-typed date inputs (ISO strings, epoch ms, Date) to a Date. */
function toDate(value: Date | string | number | null | undefined): Date | null {
  if (value == null || value === '') return null
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value
  // Accept "YYYY-MM-DD HH:MM:SS" (space) as well as ISO "T" separators.
  const d = new Date(typeof value === 'string' ? value.replace(' ', 'T') : value)
  return Number.isNaN(d.getTime()) ? null : d
}

function toNumber(value: number | string | null | undefined): number {
  const n = typeof value === 'string' ? Number(value) : (value ?? 0)
  return Number.isFinite(n) ? (n as number) : 0
}

/**
 * Localized date. Defaults to a medium date style; pass explicit
 * `Intl.DateTimeFormatOptions` to override. Honors `timeZone` so the same
 * instant renders correctly for a user's configured zone.
 */
export function formatDateLocalized(
  value: Date | string | number | null | undefined,
  opts: LocaleOptions & Intl.DateTimeFormatOptions = {},
): string {
  const d = toDate(value)
  if (!d) return value == null ? '' : String(value)
  const { locale, timeZone, ...dtf } = opts
  const options: Intl.DateTimeFormatOptions =
    Object.keys(dtf).length > 0 ? dtf : { year: 'numeric', month: 'short', day: '2-digit' }
  if (timeZone) options.timeZone = timeZone
  try {
    return new Intl.DateTimeFormat(locale || undefined, options).format(d)
  } catch {
    return d.toISOString().slice(0, 10)
  }
}

/** Localized time (hours/minutes by default). Respects the locale's 12/24h convention. */
export function formatTimeLocalized(
  value: Date | string | number | null | undefined,
  opts: LocaleOptions & Intl.DateTimeFormatOptions = {},
): string {
  const isClockOnly = typeof value === 'string' && /^\d{1,2}:\d{2}(:\d{2})?$/.test(value.trim())
  const d = isClockOnly ? toDate(`1970-01-01T${value}`) : toDate(value)
  if (!d) return value == null ? '' : String(value)
  const { locale, timeZone, ...dtf } = opts
  const options: Intl.DateTimeFormatOptions =
    Object.keys(dtf).length > 0 ? dtf : { hour: '2-digit', minute: '2-digit' }
  // A bare clock string has no date, so applying a zone offset would be wrong.
  if (timeZone && !isClockOnly) options.timeZone = timeZone
  try {
    return new Intl.DateTimeFormat(locale || undefined, options).format(d)
  } catch {
    return String(value)
  }
}

/** Localized date + time together. */
export function formatDateTimeLocalized(
  value: Date | string | number | null | undefined,
  opts: LocaleOptions & Intl.DateTimeFormatOptions = {},
): string {
  const d = toDate(value)
  if (!d) return value == null ? '' : String(value)
  const { locale, timeZone, ...dtf } = opts
  const options: Intl.DateTimeFormatOptions =
    Object.keys(dtf).length > 0
      ? dtf
      : { year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' }
  if (timeZone) options.timeZone = timeZone
  try {
    return new Intl.DateTimeFormat(locale || undefined, options).format(d)
  } catch {
    return d.toISOString()
  }
}

/** Localized number with the locale's grouping and decimal separators. */
export function formatNumberLocalized(
  value: number | string | null | undefined,
  opts: { locale?: string } & Intl.NumberFormatOptions = {},
): string {
  const n = toNumber(value)
  const { locale, ...nf } = opts
  try {
    return new Intl.NumberFormat(locale || undefined, nf).format(n)
  } catch {
    return String(n)
  }
}

/**
 * Localized currency. The `currency` ISO code drives both the symbol and the
 * currency-specific default fraction digits (JPY→0, USD→2, BHD→3), while the
 * locale drives symbol position and grouping.
 */
export function formatCurrencyLocalized(
  value: number | string | null | undefined,
  currency: string,
  opts: { locale?: string } & Intl.NumberFormatOptions = {},
): string {
  const n = toNumber(value)
  const { locale, ...nf } = opts
  try {
    return new Intl.NumberFormat(locale || undefined, {
      style: 'currency',
      currency: currency || 'USD',
      ...nf,
    }).format(n)
  } catch {
    return `${currency} ${n.toFixed(2)}`
  }
}

/** Localized percentage. Input is a ratio: `0.125` → `12.5%` (locale-styled). */
export function formatPercentLocalized(
  value: number | string | null | undefined,
  opts: { locale?: string } & Intl.NumberFormatOptions = {},
): string {
  const n = toNumber(value)
  const { locale, ...nf } = opts
  try {
    return new Intl.NumberFormat(locale || undefined, {
      style: 'percent',
      maximumFractionDigits: 2,
      ...nf,
    }).format(n)
  } catch {
    return `${(n * 100).toFixed(2)}%`
  }
}

/** Localized compact number: `1200` → `1.2K` (locale-styled). */
export function formatCompactNumberLocalized(
  value: number | string | null | undefined,
  opts: { locale?: string } & Intl.NumberFormatOptions = {},
): string {
  return formatNumberLocalized(value, { notation: 'compact', ...opts })
}

const RELATIVE_UNITS: Array<{ unit: Intl.RelativeTimeFormatUnit; ms: number }> = [
  { unit: 'year', ms: 1000 * 60 * 60 * 24 * 365 },
  { unit: 'month', ms: 1000 * 60 * 60 * 24 * 30 },
  { unit: 'week', ms: 1000 * 60 * 60 * 24 * 7 },
  { unit: 'day', ms: 1000 * 60 * 60 * 24 },
  { unit: 'hour', ms: 1000 * 60 * 60 },
  { unit: 'minute', ms: 1000 * 60 },
  { unit: 'second', ms: 1000 },
]

/**
 * Localized relative time such as "3 days ago" / "in 2 hours", auto-selecting
 * the largest sensible unit. `from` defaults to now.
 */
export function formatRelativeTimeLocalized(
  value: Date | string | number | null | undefined,
  opts: { locale?: string; from?: Date | string | number } = {},
): string {
  const d = toDate(value)
  if (!d) return value == null ? '' : String(value)
  const from = toDate(opts.from) ?? new Date()
  const diffMs = d.getTime() - from.getTime()
  const abs = Math.abs(diffMs)
  const chosen = RELATIVE_UNITS.find((u) => abs >= u.ms) ?? RELATIVE_UNITS[RELATIVE_UNITS.length - 1]
  const amount = Math.round(diffMs / chosen.ms)
  try {
    return new Intl.RelativeTimeFormat(opts.locale || undefined, { numeric: 'auto' }).format(
      amount,
      chosen.unit,
    )
  } catch {
    return formatDateLocalized(d, { locale: opts.locale })
  }
}
