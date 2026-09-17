/**
 * Timezone helpers for the central calendar.
 *
 * The ERP stores wall-clock date/time values (mysql2 `dateStrings: true`) and
 * the whole app operates in IST (Asia/Kolkata). These helpers convert stored
 * wall-clock values into two shapes:
 *
 *   • A local wall-clock string ("YYYY-MM-DDTHH:MM:SS") — what the Google
 *     Calendar helpers expect alongside an explicit `timeZone`.
 *   • An IST instant ("YYYY-MM-DDTHH:MM:SS+05:30") — an unambiguous instant the
 *     browser can parse with `new Date(...)` and render in any timezone.
 */

export const IST_OFFSET = "+05:30"
export const IST_TZ = "Asia/Kolkata"

const pad = (n: number) => String(n).padStart(2, "0")

/** Normalise a stored DATE (string | Date) into "YYYY-MM-DD". */
export function toDateString(value: unknown): string | null {
  if (!value) return null
  if (value instanceof Date) {
    return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`
  }
  const m = String(value).match(/^(\d{4}-\d{2}-\d{2})/)
  return m ? m[1] : null
}

/** Normalise a free-text / stored TIME into "HH:MM" (24h). Defaults to 09:00. */
export function toTimeString(value: unknown): string {
  const raw = String(value ?? "").trim()
  if (!raw) return "09:00"
  const m = raw.match(/^(\d{1,2})(?::(\d{2}))?\s*([ap]\.?m\.?)?/i)
  if (!m) return "09:00"
  let hh = Number(m[1])
  const mm = m[2] ? Number(m[2]) : 0
  const mer = (m[3] || "").toLowerCase()
  if (mer.startsWith("p") && hh < 12) hh += 12
  if (mer.startsWith("a") && hh === 12) hh = 0
  if (hh > 23 || mm > 59) return "09:00"
  return `${pad(hh)}:${pad(mm)}`
}

/** Build a local wall-clock string ("YYYY-MM-DDTHH:MM:SS") from a date + time. */
export function wallClock(date: string, time?: unknown): string {
  return `${date}T${toTimeString(time)}:00`
}

/**
 * Normalise a stored DATETIME ("YYYY-MM-DD HH:MM:SS" or ISO) into a local
 * wall-clock string ("YYYY-MM-DDTHH:MM:SS").
 */
export function wallClockFromDateTime(value: unknown): string | null {
  if (!value) return null
  if (value instanceof Date) {
    return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}T${pad(
      value.getHours(),
    )}:${pad(value.getMinutes())}:${pad(value.getSeconds())}`
  }
  const s = String(value).trim().replace(" ", "T")
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(s)) return `${s}:00`
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(s)) return s.slice(0, 19)
  const d = toDateString(value)
  return d ? `${d}T09:00:00` : null
}

/** Turn a local wall-clock string into an unambiguous IST instant. */
export function toIstIso(wall: string | null): string | null {
  if (!wall) return null
  return `${wall}${IST_OFFSET}`
}

/** Add minutes to a local wall-clock string, returning a new wall-clock string. */
export function addMinutesWall(wall: string, minutes: number): string {
  const start = new Date(`${wall}${IST_OFFSET}`)
  const end = new Date(start.getTime() + minutes * 60_000)
  // Recompute the IST wall-clock from the shifted instant.
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: IST_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(end)
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00"
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}`
}

/** The IST calendar date ("YYYY-MM-DD") for an ISO instant. */
export function istDateOnly(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10)
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: IST_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d)
}
