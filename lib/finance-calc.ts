/**
 * Pure, client-safe money helpers shared by the Finance module configs,
 * the server CRUD factory, and the live totals shown in the form dialogs.
 * Keep this file free of server-only imports (db / auth / node builtins).
 */

import { formatCurrency, type SettingsMap } from "@/lib/settings/format"

export const num = (v: any) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

export const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100

// Runtime currency config, populated from company settings by the
// SettingsProvider on the client (and can be set on the server if needed).
// Defaults to an empty map so formatCurrency falls back to INR (₹).
let currencyConfig: SettingsMap = {}

export function configureCurrency(settings: SettingsMap) {
  currencyConfig = settings || {}
}

const MONTH_INDEX: Record<string, number> = { January: 0, April: 3, July: 6, October: 9 }
let fyStartMonth = 3 // April by default

/** Set the financial-year start month from the "Financial Year Start Month" setting. */
export function configureFinancialYear(startMonthName?: string) {
  if (startMonthName && startMonthName in MONTH_INDEX) fyStartMonth = MONTH_INDEX[startMonthName]
}

/**
 * Financial year label derived from a date, honouring the configured start
 * month (defaults to April for the Indian financial year).
 */
export function financialYearFor(dateStr?: string | null, startMonth: number = fyStartMonth) {
  if (!dateStr) return ""
  const d = new Date(dateStr)
  if (Number.isNaN(d.getTime())) return ""
  const y = d.getFullYear()
  const start = d.getMonth() >= startMonth ? y : y - 1
  return `${start}-${String((start + 1) % 100).padStart(2, "0")}`
}

/** Derive a payment status when the user has not chosen one explicitly. */
export function autoPaymentStatus(net: number, paid: number, current?: string) {
  if (current) return current
  if (paid <= 0) return "Unpaid"
  if (paid >= net) return "Paid"
  return "Partially Paid"
}

// Currency display now honours the configured currency settings (symbol,
// position, decimals, separators) via the shared formatter. Falls back to
// ₹ / 2 decimals until configureCurrency() runs.
export const inr = (n: any) => formatCurrency(Number(n) || 0, currencyConfig)

export const inr0 = (n: any) =>
  formatCurrency(Number(n) || 0, { ...currencyConfig, "currency.decimals": "0" })
