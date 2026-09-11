/** Shared display helpers for the Leave Quota History ledger UI. */

export type EventMeta = { label: string; className: string; sign: "positive" | "negative" | "neutral" }

/**
 * Presentation for each stored event_type. Keys match the values written by the
 * leave engine — never rename them, historical rows depend on them.
 */
export const EVENT_META: Record<string, EventMeta> = {
  opening: { label: "Opening Balance", className: "bg-sky-500/15 text-sky-600 border-sky-500/30", sign: "positive" },
  accrual: { label: "Accrual", className: "bg-emerald-500/15 text-emerald-600 border-emerald-500/30", sign: "positive" },
  carry_forward: { label: "Carry Forward", className: "bg-teal-500/15 text-teal-600 border-teal-500/30", sign: "positive" },
  adjustment: { label: "Adjustment", className: "bg-violet-500/15 text-violet-600 border-violet-500/30", sign: "neutral" },
  leave_approved: { label: "Leave Used", className: "bg-orange-500/15 text-orange-600 border-orange-500/30", sign: "negative" },
  leave_reversed: { label: "Leave Reversal", className: "bg-amber-500/15 text-amber-600 border-amber-500/30", sign: "positive" },
  expiry: { label: "Expiry / Lapse", className: "bg-rose-500/15 text-rose-600 border-rose-500/30", sign: "negative" },
  reversal: { label: "Reversal", className: "bg-fuchsia-500/15 text-fuchsia-600 border-fuchsia-500/30", sign: "neutral" },
}

export const EVENT_FILTERS: { value: string; label: string }[] = [
  { value: "all", label: "All events" },
  { value: "leave_used", label: "Leave Used" },
  { value: "accrual", label: "Accrual" },
  { value: "adjustment", label: "Adjustment" },
  { value: "carry_forward", label: "Carry Forward" },
  { value: "expiry", label: "Expiry / Lapse" },
  { value: "reversal", label: "Reversal" },
  { value: "opening", label: "Opening Balance" },
]

export function formatDays(value: any): string {
  const n = Number(value || 0)
  const rounded = Math.round(n * 100) / 100
  return `${rounded > 0 ? "+" : ""}${rounded}`
}

export function formatDateTime(value: any): string {
  if (!value) return "—"
  return String(value).slice(0, 16).replace("T", " ")
}
