/**
 * Pure, client-safe money helpers shared by the Finance module configs,
 * the server CRUD factory, and the live totals shown in the form dialogs.
 * Keep this file free of server-only imports (db / auth / node builtins).
 */

export const num = (v: any) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

export const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100

/** Indian financial year (April–March) derived from a date string. */
export function financialYearFor(dateStr?: string | null) {
  if (!dateStr) return ""
  const d = new Date(dateStr)
  if (Number.isNaN(d.getTime())) return ""
  const y = d.getFullYear()
  const start = d.getMonth() >= 3 ? y : y - 1
  return `${start}-${String((start + 1) % 100).padStart(2, "0")}`
}

/** Derive a payment status when the user has not chosen one explicitly. */
export function autoPaymentStatus(net: number, paid: number, current?: string) {
  if (current) return current
  if (paid <= 0) return "Unpaid"
  if (paid >= net) return "Paid"
  return "Partially Paid"
}

export const inr = (n: any) =>
  new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 2,
  }).format(Number(n) || 0)

export const inr0 = (n: any) =>
  new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
  }).format(Number(n) || 0)
