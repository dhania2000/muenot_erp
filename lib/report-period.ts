// Report period model shared by the Financial Reports UI. All presets resolve
// to a plain { from, to } date range (YYYY-MM-DD) so they plug straight into
// the existing date-range filter on the reports API. Indian financial year
// conventions apply: a financial year runs 1 April → 31 March, and quarters are
// Q1 Apr–Jun, Q2 Jul–Sep, Q3 Oct–Dec, Q4 Jan–Mar.

import type { PeriodMode } from "@/lib/finance-reports"
import { formatIndianDate } from "@/lib/report-tally"

export type PeriodPreset = "all" | "fy" | "quarter" | "month" | "custom"

export type PeriodState = {
  preset: PeriodPreset
  /** Financial-year start year, e.g. "2026" ⇒ FY 2026-27. */
  fy: string
  quarter: string // "1".."4"
  month: string // "YYYY-MM"
  from: string
  to: string
  asOn: string
}

type Option = { value: string; label: string }

const pad = (n: number) => String(n).padStart(2, "0")
const ymd = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`
// Last calendar day of a 1-based month.
const lastDay = (y: number, m: number) => new Date(y, m, 0).getDate()

export function currentFyStartYear(d = new Date()): number {
  return d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1
}

export function fyLabel(startYear: number): string {
  return `FY ${startYear}-${pad((startYear + 1) % 100)}`
}

export function fyOptions(count = 7): Option[] {
  const start = currentFyStartYear()
  return Array.from({ length: count }, (_, i) => {
    const y = start - i
    return { value: String(y), label: fyLabel(y) }
  })
}

export const QUARTER_OPTIONS: Option[] = [
  { value: "1", label: "Q1 (Apr–Jun)" },
  { value: "2", label: "Q2 (Jul–Sep)" },
  { value: "3", label: "Q3 (Oct–Dec)" },
  { value: "4", label: "Q4 (Jan–Mar)" },
]

export function monthOptions(count = 24): Option[] {
  const now = new Date()
  return Array.from({ length: count }, (_, i) => {
    const dt = new Date(now.getFullYear(), now.getMonth() - i, 1)
    return {
      value: `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}`,
      label: dt.toLocaleString("en-IN", { month: "long", year: "numeric" }),
    }
  })
}

export function defaultPeriod(): PeriodState {
  return {
    preset: "all",
    fy: String(currentFyStartYear()),
    quarter: "1",
    month: monthOptions(1)[0].value,
    from: "",
    to: "",
    asOn: "",
  }
}

// Resolve the selected period to a concrete { from, to }. `asOn` reports read
// cumulatively up to a single date (from is left empty); `none` reports carry
// no time filter at all.
export function resolveRange(mode: PeriodMode, s: PeriodState): { from: string; to: string } {
  if (mode === "none") return { from: "", to: "" }
  if (mode === "asOn") return { from: "", to: s.asOn }

  switch (s.preset) {
    case "custom":
      return { from: s.from, to: s.to }
    case "fy": {
      const y = Number(s.fy)
      return { from: ymd(y, 4, 1), to: ymd(y + 1, 3, 31) }
    }
    case "quarter": {
      const y = Number(s.fy)
      const q = Number(s.quarter)
      const starts: Record<number, [number, number]> = {
        1: [y, 4],
        2: [y, 7],
        3: [y, 10],
        4: [y + 1, 1],
      }
      const [sy, sm] = starts[q] ?? [y, 4]
      const em = sm + 2
      return { from: ymd(sy, sm, 1), to: ymd(sy, em, lastDay(sy, em)) }
    }
    case "month": {
      const [my, mm] = s.month.split("-").map(Number)
      return { from: ymd(my, mm, 1), to: ymd(my, mm, lastDay(my, mm)) }
    }
    case "all":
    default:
      return { from: "", to: "" }
  }
}

// Indian numeric convention dd-mm-yyyy, consistent across the reports UI,
// PDF and Excel/CSV exports.
const fmtDate = (iso: string) => (iso ? formatIndianDate(iso) : "")

// A human label describing the active period, shown in the header and embedded
// into CSV / PDF exports.
export function periodLabel(mode: PeriodMode, s: PeriodState): string {
  if (mode === "none") return ""
  if (mode === "asOn") return s.asOn ? `As on ${fmtDate(s.asOn)}` : "As on — all data"
  switch (s.preset) {
    case "all":
      return "All time"
    case "fy":
      return fyLabel(Number(s.fy))
    case "quarter": {
      const q = QUARTER_OPTIONS.find((o) => o.value === s.quarter)?.label ?? `Q${s.quarter}`
      return `${q} · ${fyLabel(Number(s.fy))}`
    }
    case "month":
      return monthOptions(1)
        ? new Date(s.month + "-01T00:00:00").toLocaleString("en-IN", { month: "long", year: "numeric" })
        : s.month
    case "custom": {
      const { from, to } = resolveRange(mode, s)
      if (!from && !to) return "All time"
      return `${from ? fmtDate(from) : "…"} – ${to ? fmtDate(to) : "…"}`
    }
    default:
      return ""
  }
}
