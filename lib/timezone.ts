/**
 * SPEC 158 — TIMEZONE ENGINE
 * ---------------------------------------------------------------------------
 * The single source of truth for making the ERP timezone-aware. Pure,
 * dependency-free (no DB, no `server-only`, no React) so it runs on the server,
 * in client components, in cron/report workers, and directly under Vitest.
 *
 * PHASE 1 — AUDIT (why this module exists)
 *   Date/time handling was previously scattered:
 *     • `app.timezone` (company_settings, tenant-scoped) drove display via
 *       lib/settings/format.ts.
 *     • `lib/calendar/datetime.ts` hard-coded IST (+05:30) for calendar sync.
 *     • Cron jobs (`platform_cron_jobs.timezone`) and report schedules
 *       (`report_schedules.timezone`) each re-validated an IANA zone with their
 *       own inline `new Intl.DateTimeFormat(...)` try/catch.
 *     • Several modules re-declared `DEFAULT_TIME_ZONE = "Asia/Kolkata"`.
 *   There was no DST-safe wall-clock <-> instant conversion and no defined
 *   precedence when more than one timezone applies to the same value.
 *
 * PHASE 2 — STANDARDIZE STORAGE & CONVERSION
 *   Storage contract: persist instants in UTC (or an unambiguous offset), and
 *   carry the IANA zone that a value should be *presented* in separately.
 *   Never store a naked wall-clock string and assume a zone at read time.
 *   `zonedTimeToUtc` / `utcToZonedParts` do the DST-correct conversion here.
 *
 * PHASE 3 — RESOLUTION HIERARCHY (tenant / user / entity / job / report)
 *   A value can carry several candidate zones. `resolveTimeZone` applies a
 *   fixed precedence (most specific wins) so UI, jobs and reports all agree on
 *   which zone renders a given instant.
 *
 * PHASE 4 — TESTS
 *   DST spring-forward gaps, fall-back overlaps and multi-country offsets are
 *   covered in test/timezone-engine.test.ts.
 */

/** The ERP's home zone. India-based deployment; used as the ultimate fallback. */
export const DEFAULT_TIME_ZONE = "Asia/Kolkata"
export const UTC = "UTC"

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

// Validated zones are cached — Intl construction is comparatively expensive and
// the same handful of zones are checked on every request.
const validityCache = new Map<string, boolean>()

/**
 * True when `tz` is an IANA zone the host's Intl database accepts
 * (e.g. "Asia/Kolkata", "UTC", "America/New_York"). Non-strings, empty strings
 * and fixed offsets like "+05:30" are rejected — the engine deals in named
 * zones so DST rules are available.
 */
export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== "string") return false
  const key = tz.trim()
  if (!key) return false
  // Reject fixed-offset forms ("+05:30", "-08:00", "GMT+5", "UTC+5"). Recent
  // engines accept these via Intl, but an offset carries no DST rules, so the
  // engine deals only in named IANA zones. "UTC" (no sign) stays valid.
  if (/^[+-]/.test(key) || /^(GMT|UTC)[+-]/i.test(key)) return false
  const cached = validityCache.get(key)
  if (cached !== undefined) return cached
  let ok = false
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: key })
    ok = true
  } catch {
    ok = false
  }
  validityCache.set(key, ok)
  return ok
}

/**
 * Return `tz` when it is a valid IANA zone, otherwise `fallback`. Non-throwing —
 * use this at read time so a stale or hand-edited value never crashes a render.
 */
export function normalizeTimeZone(tz: unknown, fallback: string = DEFAULT_TIME_ZONE): string {
  if (isValidTimeZone(tz)) return tz.trim()
  return isValidTimeZone(fallback) ? fallback.trim() : UTC
}

/**
 * Assert `tz` is a valid IANA zone and return it, otherwise throw. Use this at
 * the write boundary (saving a cron job / report schedule / tenant setting) so
 * invalid input is rejected before it is stored.
 */
export function assertTimeZone(tz: unknown): string {
  if (isValidTimeZone(tz)) return tz.trim()
  throw new Error("Invalid IANA timezone.")
}

// ---------------------------------------------------------------------------
// Offsets & conversion (DST-aware)
// ---------------------------------------------------------------------------

const pad = (n: number) => String(n).padStart(2, "0")

export type ZonedParts = {
  year: number
  month: number // 1-12
  day: number // 1-31
  hour: number // 0-23
  minute: number // 0-59
  second: number // 0-59
}

/**
 * The offset (minutes east of UTC) that `zone` is at for the given instant.
 * Positive means ahead of UTC (Asia/Kolkata => +330). DST-aware because it is
 * evaluated at a specific instant, not for the zone in the abstract.
 */
export function getOffsetMinutes(instant: Date, zone: string): number {
  const tz = normalizeTimeZone(zone)
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  })
  const parts = dtf.formatToParts(instant)
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value)
  let hour = get("hour")
  if (hour === 24) hour = 0 // some engines emit "24" at midnight
  // Interpret the zone's wall-clock reading of this instant AS IF it were UTC,
  // then the difference from the real instant is the zone's offset.
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), hour, get("minute"), get("second"))
  return Math.round((asUtc - instant.getTime()) / 60000)
}

/** Render an offset in minutes as "+05:30" / "-08:00" / "+00:00". */
export function formatOffset(minutes: number): string {
  const sign = minutes < 0 ? "-" : "+"
  const abs = Math.abs(minutes)
  return `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
}

/**
 * Convert a wall-clock reading (interpreted IN `zone`) to the corresponding UTC
 * instant. This is the write-side primitive: the UI collects a wall-clock time
 * in the user's zone, this turns it into the UTC instant we store.
 *
 * DST correctness: we make a first-guess offset, then re-check the offset at the
 * candidate instant and refine once. This resolves the two DST edge cases:
 *   • Spring-forward gap (a wall time that does not exist): resolves forward to a
 *     real instant deterministically.
 *   • Fall-back overlap (a wall time that happens twice): resolves consistently
 *     to a single instant.
 */
export function zonedTimeToUtc(parts: ZonedParts, zone: string): Date {
  const tz = normalizeTimeZone(zone)
  const naiveUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second)
  const guessOffset = getOffsetMinutes(new Date(naiveUtc), tz)
  let instant = naiveUtc - guessOffset * 60000
  const refinedOffset = getOffsetMinutes(new Date(instant), tz)
  if (refinedOffset !== guessOffset) {
    instant = naiveUtc - refinedOffset * 60000
    // If the refined instant does not read back as the requested wall time, the
    // wall time falls in a spring-forward gap (it never happened). Resolve it
    // forward using the pre-transition offset so callers get a real instant.
    if (!sameWallClock(utcToZonedParts(new Date(instant), tz), parts)) {
      instant = naiveUtc - guessOffset * 60000
    }
  }
  return new Date(instant)
}

function sameWallClock(a: ZonedParts, b: ZonedParts): boolean {
  return (
    a.year === b.year &&
    a.month === b.month &&
    a.day === b.day &&
    a.hour === b.hour &&
    a.minute === b.minute &&
    a.second === b.second
  )
}

const WALL_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/

/**
 * Parse a wall-clock string ("YYYY-MM-DD HH:MM[:SS]" or ISO without offset) as a
 * time in `zone` and return the UTC instant. Returns null for unparseable input.
 */
export function wallStringToUtc(wall: string, zone: string): Date | null {
  const m = WALL_RE.exec(String(wall).trim())
  if (!m) return null
  return zonedTimeToUtc(
    {
      year: Number(m[1]),
      month: Number(m[2]),
      day: Number(m[3]),
      hour: Number(m[4]),
      minute: Number(m[5]),
      second: m[6] ? Number(m[6]) : 0,
    },
    zone,
  )
}

/** The wall-clock parts an instant reads as in `zone`. Read-side primitive. */
export function utcToZonedParts(instant: Date, zone: string): ZonedParts {
  const tz = normalizeTimeZone(zone)
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(instant)
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value)
  let hour = get("hour")
  if (hour === 24) hour = 0
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour,
    minute: get("minute"),
    second: get("second"),
  }
}

/** Wall-clock string ("YYYY-MM-DDTHH:MM:SS") an instant reads as in `zone`. */
export function utcToWallString(instant: Date, zone: string): string {
  const p = utcToZonedParts(instant, zone)
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}`
}

/** The calendar date ("YYYY-MM-DD") an instant falls on in `zone`. */
export function zonedDateOnly(instant: Date, zone: string): string {
  const p = utcToZonedParts(instant, zone)
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`
}

/** An unambiguous ISO instant with the zone's offset, e.g. "...T09:00:00+05:30". */
export function toZonedIso(instant: Date, zone: string): string {
  return `${utcToWallString(instant, zone)}${formatOffset(getOffsetMinutes(instant, zone))}`
}

// ---------------------------------------------------------------------------
// PHASE 3 — Resolution hierarchy
// ---------------------------------------------------------------------------

/**
 * The layers a timezone can come from, listed MOST specific first. When several
 * are present the earliest non-empty valid one wins:
 *
 *   report  — the zone a scheduled/generated report is rendered in
 *   job     — the zone a background/cron job evaluates its schedule in
 *   entity  — a zone attached to a specific record (e.g. a site/branch/event)
 *   user    — the acting user's personal preference
 *   tenant  — the tenant's configured app.timezone
 *   default — the ERP home zone (Asia/Kolkata)
 */
export const RESOLUTION_ORDER = ["report", "job", "entity", "user", "tenant", "default"] as const
export type TimeZoneLayer = (typeof RESOLUTION_ORDER)[number]

export type TimeZoneLayers = Partial<Record<Exclude<TimeZoneLayer, "default">, string | null | undefined>>

export type ResolvedTimeZone = {
  /** The winning IANA zone, always valid. */
  timeZone: string
  /** Which layer it came from. */
  source: TimeZoneLayer
}

/**
 * Resolve the effective timezone from the available layers using the fixed
 * precedence above. Invalid or empty candidates are skipped, so a malformed
 * per-record zone silently falls through to the tenant/default zone rather than
 * breaking a render. Always returns a valid zone.
 */
export function resolveTimeZone(layers: TimeZoneLayers, fallback: string = DEFAULT_TIME_ZONE): ResolvedTimeZone {
  for (const layer of RESOLUTION_ORDER) {
    if (layer === "default") break
    const candidate = layers[layer]
    if (isValidTimeZone(candidate)) {
      return { timeZone: candidate.trim(), source: layer }
    }
  }
  return { timeZone: normalizeTimeZone(fallback), source: "default" }
}

/**
 * The zone the current runtime believes the user is in. In the browser this is
 * the OS/profile zone; on the server (no Intl runtime zone) it returns null so
 * the caller falls through to the tenant/default layer. Use this to populate the
 * `user` layer of `resolveTimeZone` for a live UI session.
 */
export function detectUserTimeZone(): string | null {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
    return isValidTimeZone(tz) ? tz : null
  } catch {
    return null
  }
}
