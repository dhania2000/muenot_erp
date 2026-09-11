// Client-safe attendance formatting + display helpers. Kept separate from
// lib/hr-attendance.ts (which imports the DB layer and is server-only) so these
// pure functions can be used inside client components.

/** Decimal hours -> "8h 30m". Returns "0h 0m" for empty/negative. */
export function formatHours(hours: number | null | undefined): string {
  const h = Number(hours || 0)
  if (h <= 0) return "0h 0m"
  const totalMinutes = Math.round(h * 60)
  return `${Math.floor(totalMinutes / 60)}h ${totalMinutes % 60}m`
}

/** Minute count -> "25 min" or "1h 30m". */
export function formatMinutes(minutes: number | null | undefined): string {
  const total = Math.round(Number(minutes || 0))
  if (total <= 0) return "0 min"
  if (total < 60) return `${total} min`
  return `${Math.floor(total / 60)}h ${total % 60}m`
}

/** Time portion of a DATETIME string ("2026-09-11 09:04:00" -> "09:04"). */
export function formatTime(value: string | null | undefined): string {
  if (!value) return "—"
  const m = String(value).match(/(\d{2}):(\d{2})/)
  return m ? `${m[1]}:${m[2]}` : "—"
}

/** Short date ("2026-09-11" -> "11 Sep 2026"). */
export function formatDate(value: string | null | undefined): string {
  if (!value) return "—"
  const iso = String(value).slice(0, 10)
  const [y, m, d] = iso.split("-").map(Number)
  if (!y || !m || !d) return iso
  const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][m - 1]
  return `${d} ${month} ${y}`
}

export type BadgeVariant = "default" | "secondary" | "destructive" | "outline" | "ghost"

/** Map an attendance status to a Badge variant so the list is scannable. */
export function statusVariant(status: string | null | undefined): BadgeVariant {
  switch (status) {
    case "Present":
    case "Holiday Worked":
    case "Weekly Off Worked":
      return "default"
    case "Absent":
    case "Missed Checkout":
      return "destructive"
    case "On Leave":
    case "Half Day":
      return "secondary"
    case "Holiday":
    case "Weekly Off":
    case "Upcoming":
      return "outline"
    default:
      return "secondary"
  }
}

/** Map an exception flag to a Badge variant. */
export function flagVariant(flag: string): BadgeVariant {
  if (flag === "Overtime" || flag === "Holiday Worked") return "default"
  if (flag === "Late" || flag === "Early Out") return "destructive"
  return "outline"
}

/** Selectable attendance statuses for filters and manual entry. */
export const ATTENDANCE_STATUSES = [
  "Present",
  "Absent",
  "Half Day",
  "On Leave",
  "Holiday",
  "Weekly Off",
  "Holiday Worked",
  "Weekly Off Worked",
  "Missed Checkout",
]

/** Attendance sources — system-generated; admin entry is "Admin Manual". */
export const ATTENDANCE_SOURCES = ["Portal", "Mobile", "API", "Biometric", "Import", "Admin Manual", "Manual"]
