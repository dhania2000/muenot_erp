/**
 * Tenant scheduled jobs — pure model (Spec12, requirements #22-29).
 *
 * Shared by the server store, API routes and the admin UI (live preview of
 * next runs). No I/O. Everything a tenant can schedule is a REVIEWED action
 * from TENANT_JOB_ACTIONS; the database stores only the action key, validated
 * parameters and schedule — never code, SQL or URLs.
 *
 * DST policy (documented in the UI):
 *  - Spring-forward gap: a wall time that does not exist that day (e.g. 02:30
 *    in New York on the March change) runs once, shifted forward by the gap.
 *  - Fall-back overlap: a repeated wall time (e.g. 01:30 in November) runs
 *    ONCE at its first occurrence, unless the hour field is `*` — hourly jobs
 *    keep a steady cadence and run for both occurrences.
 */
import { cronCalendarMatches, parseCron, validateCronExpression, type ParsedCron } from "@/lib/cron-expression"
import { EXPORT_FORMATS } from "@/lib/data-export-model"
import { getOffsetMinutes, isValidTimeZone, utcToZonedParts, wallStringToUtc } from "@/lib/timezone"

export const TENANT_JOB_ACTION_KEYS = ["notification.reminder", "data_export.run", "report_schedule.deliver"] as const
export type TenantJobActionKey = (typeof TENANT_JOB_ACTION_KEYS)[number]

export type TenantJobActionMeta = {
  key: TenantJobActionKey
  label: string
  description: string
  /**
   * Whether an unexpected failure may be retried automatically. Actions with
   * external side effects that could have partially happened (email delivery)
   * are not auto-retried; they dead-letter for a reviewed manual retry.
   */
  retrySafe: boolean
}

export const TENANT_JOB_ACTIONS: Record<TenantJobActionKey, TenantJobActionMeta> = {
  "notification.reminder": {
    key: "notification.reminder",
    label: "In-app reminder",
    description: "Posts an in-app notification to the job owner.",
    retrySafe: true,
  },
  "data_export.run": {
    key: "data_export.run",
    label: "Run data export",
    description: "Generates an export from the Export center catalog.",
    retrySafe: true,
  },
  "report_schedule.deliver": {
    key: "report_schedule.deliver",
    label: "Deliver saved report schedule",
    description: "Runs an existing report schedule and delivers it to its recipients.",
    retrySafe: false,
  },
}

export type TenantJobPreset = { key: string; label: string; expression: string | null }
export const TENANT_JOB_PRESETS: readonly TenantJobPreset[] = [
  { key: "hourly", label: "Every hour", expression: "0 * * * *" },
  { key: "daily_0900", label: "Daily at 09:00", expression: "0 9 * * *" },
  { key: "weekdays_0900", label: "Weekdays at 09:00", expression: "0 9 * * 1-5" },
  { key: "weekly_mon_0900", label: "Mondays at 09:00", expression: "0 9 * * 1" },
  { key: "monthly_1st_0900", label: "1st of the month at 09:00", expression: "0 9 1 * *" },
  { key: "custom", label: "Custom cron expression", expression: null },
]

export const TENANT_JOB_LIMITS = {
  maxSchedulesPerTenant: 50,
  /** Shared queue concurrency slots per tenant across all its scheduled jobs. */
  concurrencyPerTenant: 2,
  /** Max runs one tenant can dispatch in a single scheduler tick. */
  dispatchPerTenantPerTick: 20,
  minIntervalMinutes: 5,
  maxAttempts: 5,
  maxNotifyEmails: 10,
} as const

export type TenantJobParams =
  | { title: string; body: string }
  | { datasetKey: string; format: (typeof EXPORT_FORMATS)[number] }
  | { reportScheduleId: number }

export type TenantJobInput = {
  name: string
  actionKey: TenantJobActionKey
  actionParams: TenantJobParams
  presetKey: string
  cronExpression: string
  timezone: string
  /** UTC instants derived from wall-clock strings in `timezone`. */
  startAt: Date | null
  endAt: Date | null
  enabled: boolean
  maxAttempts: number
  notifyOnFailure: boolean
  notifyOnSuccess: boolean
  notifyEmails: string[]
}

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; errors: Record<string, string> }

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

export function isTenantJobActionKey(value: unknown): value is TenantJobActionKey {
  return typeof value === "string" && (TENANT_JOB_ACTION_KEYS as readonly string[]).includes(value)
}

export function validateActionParams(actionKey: TenantJobActionKey, raw: unknown): { ok: true; value: TenantJobParams } | { ok: false; error: string } {
  const p = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  if (actionKey === "notification.reminder") {
    const title = str(p.title)
    const body = str(p.body)
    if (!title || title.length > 120) return { ok: false, error: "Reminder title must contain 1 to 120 characters" }
    if (body.length > 1000) return { ok: false, error: "Reminder message must be 1000 characters or fewer" }
    return { ok: true, value: { title, body } }
  }
  if (actionKey === "data_export.run") {
    const datasetKey = str(p.datasetKey)
    const format = str(p.format)
    if (!/^[a-z0-9_.-]{1,80}$/.test(datasetKey)) return { ok: false, error: "Choose a dataset from the Export center catalog" }
    if (!(EXPORT_FORMATS as readonly string[]).includes(format)) return { ok: false, error: "Choose a supported export format" }
    return { ok: true, value: { datasetKey, format: format as (typeof EXPORT_FORMATS)[number] } }
  }
  const reportScheduleId = Number(p.reportScheduleId)
  if (!Number.isSafeInteger(reportScheduleId) || reportScheduleId <= 0) return { ok: false, error: "Choose a saved report schedule" }
  return { ok: true, value: { reportScheduleId } }
}

/** Smallest gap between consecutive runs, in minutes (conservative). */
export function minimumIntervalMinutes(cron: ParsedCron): number {
  let min = Infinity
  for (let i = 1; i < cron.minutes.length; i++) min = Math.min(min, cron.minutes[i] - cron.minutes[i - 1])
  if (cron.hours.length > 1) {
    const hourGaps = cron.hours.slice(1).map((h, i) => h - cron.hours[i])
    const consecutive = hourGaps.includes(1) || (cron.hours[0] === 0 && cron.hours.at(-1) === 23)
    const wrap = 60 - cron.minutes.at(-1)! + cron.minutes[0]
    min = Math.min(min, consecutive ? wrap : wrap + 60 * (Math.min(...hourGaps) - 1))
  }
  return min === Infinity ? 24 * 60 : min
}

export function validateTenantCron(expression: string): { ok: true; cron: ParsedCron } | { ok: false; error: string } {
  const check = validateCronExpression(expression)
  if (!check.ok) return check
  const cron = parseCron(expression)!
  if (minimumIntervalMinutes(cron) < TENANT_JOB_LIMITS.minIntervalMinutes) {
    return { ok: false, error: `Jobs may run at most every ${TENANT_JOB_LIMITS.minIntervalMinutes} minutes` }
  }
  return { ok: true, cron }
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE

/**
 * Real instants for a wall-clock time in `zone`: 0 → gap (returns shifted
 * instant with gap=true), 1 → normal, 2 → fall-back overlap.
 */
export function instantsForWallTime(
  wall: { year: number; month: number; day: number; hour: number; minute: number },
  zone: string,
): { instants: number[]; gap: boolean } {
  const naive = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute)
  const offsets = new Set([
    getOffsetMinutes(new Date(naive - 14 * HOUR), zone),
    getOffsetMinutes(new Date(naive), zone),
    getOffsetMinutes(new Date(naive + 14 * HOUR), zone),
  ])
  const instants: number[] = []
  for (const offset of offsets) {
    const candidate = naive - offset * MINUTE
    const p = utcToZonedParts(new Date(candidate), zone)
    if (p.year === wall.year && p.month === wall.month && p.day === wall.day && p.hour === wall.hour && p.minute === wall.minute) {
      if (!instants.includes(candidate)) instants.push(candidate)
    }
  }
  if (instants.length) return { instants: instants.sort((a, b) => a - b), gap: false }
  // Wall time skipped by spring-forward: interpret with the pre-transition offset,
  // which lands the same distance past the transition as the gap length.
  return { instants: [naive - getOffsetMinutes(new Date(naive - 14 * HOUR), zone) * MINUTE], gap: true }
}

/**
 * First scheduled instant strictly after `after` (and >= startAt, <= endAt)
 * for `expression` interpreted in `zone`. Returns null when none within ~4 years.
 */
export function nextRunAt(
  expression: string,
  zone: string,
  after: Date,
  bounds: { startAt?: Date | null; endAt?: Date | null } = {},
): Date | null {
  const cron = parseCron(expression)
  if (!cron || !isValidTimeZone(zone)) return null
  const floor = Math.max(after.getTime(), bounds.startAt ? bounds.startAt.getTime() - 1 : -Infinity)
  const endMs = bounds.endAt ? bounds.endAt.getTime() : Infinity
  if (floor >= endMs) return null
  const start = utcToZonedParts(new Date(floor), zone)
  const floorNaive = Date.UTC(start.year, start.month - 1, start.day, start.hour, start.minute)
  const baseDay = Date.UTC(start.year, start.month - 1, start.day)

  for (let dayIndex = 0; dayIndex < 1500; dayIndex++) {
    const dayMs = baseDay + dayIndex * 24 * HOUR
    const date = new Date(dayMs)
    const year = date.getUTCFullYear()
    const month = date.getUTCMonth() + 1
    const day = date.getUTCDate()
    if (!cronCalendarMatches(cron, month, day, date.getUTCDay())) continue
    let best: number | null = null
    let bestNaive = 0
    for (const hour of cron.hours) {
      for (const minute of cron.minutes) {
        const naive = dayMs + hour * HOUR + minute * MINUTE
        // Wall→instant shifts are bounded by a few hours; skip clearly-past
        // candidates and stop once later candidates cannot beat `best`.
        if (naive < floorNaive - 3 * HOUR) continue
        if (best != null && naive > bestNaive + 3 * HOUR) break
        const { instants } = instantsForWallTime({ year, month, day, hour, minute }, zone)
        const usable = cron.everyHour ? instants : instants.slice(0, 1)
        for (const instant of usable) {
          if (instant > floor && (best == null || instant < best)) {
            best = instant
            bestNaive = naive
          }
        }
      }
    }
    if (best != null) return best <= endMs ? new Date(best) : null
    if (dayMs > endMs + 24 * HOUR) return null
  }
  return null
}

export function nextRunTimes(expression: string, zone: string, after: Date, count: number, bounds: { startAt?: Date | null; endAt?: Date | null } = {}): Date[] {
  const out: Date[] = []
  let cursor = after
  for (let i = 0; i < Math.min(Math.max(count, 0), 20); i++) {
    const next = nextRunAt(expression, zone, cursor, bounds)
    if (!next) break
    out.push(next)
    cursor = next
  }
  return out
}

export function validateTenantJobInput(raw: unknown, now: Date = new Date()): ValidationResult<TenantJobInput> {
  const errors: Record<string, string> = {}
  const b = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}

  const name = str(b.name)
  if (!name || name.length > 120) errors.name = "Name must contain 1 to 120 characters"

  const actionKey = b.actionKey
  let actionParams: TenantJobParams | null = null
  if (!isTenantJobActionKey(actionKey)) errors.actionKey = "Choose a reviewed action"
  else {
    const params = validateActionParams(actionKey, b.actionParams)
    if (params.ok) actionParams = params.value
    else errors.actionParams = params.error
  }

  const timezone = str(b.timezone)
  if (!isValidTimeZone(timezone)) errors.timezone = "Choose a valid IANA timezone"

  const presetKey = str(b.presetKey) || "custom"
  const preset = TENANT_JOB_PRESETS.find((p) => p.key === presetKey)
  let cronExpression = ""
  if (!preset) errors.presetKey = "Unknown schedule preset"
  else {
    cronExpression = preset.expression ?? str(b.cronExpression).replace(/\s+/g, " ")
    const cron = validateTenantCron(cronExpression)
    if (!cron.ok) errors.cronExpression = cron.error
  }

  let startAt: Date | null = null
  let endAt: Date | null = null
  if (!errors.timezone) {
    const startRaw = str(b.startAt)
    const endRaw = str(b.endAt)
    if (startRaw) {
      startAt = wallStringToUtc(startRaw, timezone)
      if (!startAt) errors.startAt = "Start must be a valid date and time"
    }
    if (endRaw) {
      endAt = wallStringToUtc(endRaw, timezone)
      if (!endAt) errors.endAt = "End must be a valid date and time"
      else if (endAt.getTime() <= now.getTime()) errors.endAt = "End must be in the future"
      else if (startAt && endAt.getTime() <= startAt.getTime()) errors.endAt = "End must be after start"
    }
  }

  const maxAttempts = b.maxAttempts == null ? 3 : Number(b.maxAttempts)
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > TENANT_JOB_LIMITS.maxAttempts) {
    errors.maxAttempts = `Attempts must be between 1 and ${TENANT_JOB_LIMITS.maxAttempts}`
  }

  const emailsRaw = Array.isArray(b.notifyEmails) ? b.notifyEmails : typeof b.notifyEmails === "string" ? b.notifyEmails.split(/[,;\s]+/) : []
  const notifyEmails = [...new Set(emailsRaw.map((e) => str(e).toLowerCase()).filter(Boolean))]
  if (notifyEmails.length > TENANT_JOB_LIMITS.maxNotifyEmails) errors.notifyEmails = `At most ${TENANT_JOB_LIMITS.maxNotifyEmails} notification emails`
  else if (notifyEmails.some((e) => !EMAIL_RE.test(e) || e.length > 254)) errors.notifyEmails = "Notification emails must be valid addresses"

  if (!Object.keys(errors).length && !nextRunAt(cronExpression, timezone, now, { startAt, endAt })) {
    errors.cronExpression = "This schedule has no future runs within the start/end window"
  }
  if (Object.keys(errors).length) return { ok: false, errors }

  return {
    ok: true,
    value: {
      name,
      actionKey: actionKey as TenantJobActionKey,
      actionParams: actionParams!,
      presetKey,
      cronExpression,
      timezone,
      startAt,
      endAt,
      enabled: b.enabled !== false,
      maxAttempts,
      notifyOnFailure: b.notifyOnFailure !== false,
      notifyOnSuccess: b.notifyOnSuccess === true,
      notifyEmails,
    },
  }
}

export type TickScheduleState = {
  enabled: boolean
  nextRunAt: Date | null
  endAt: Date | null
  startAt: Date | null
  cronExpression: string
  timezone: string
  tenantStatus: string
}

export type TickPlan =
  | { kind: "wait" }
  | { kind: "dispatch" | "skip"; slot: Date; skipReason?: "tenant_disabled"; nextRunAt: Date | null }

/**
 * Decide what one scheduler tick does for a locked schedule row. A slot is
 * consumed exactly once: the caller persists `nextRunAt` in the same
 * transaction, so a duplicate tick sees a future next_run_at and waits.
 * Missed slots (scheduler outage) collapse into ONE run; the next run is then
 * computed from `now` rather than replaying every missed slot.
 */
export function planTenantJobTick(state: TickScheduleState, now: Date): TickPlan {
  if (!state.enabled || !state.nextRunAt || state.nextRunAt.getTime() > now.getTime()) return { kind: "wait" }
  const slot = state.nextRunAt
  const following = nextRunAt(state.cronExpression, state.timezone, new Date(Math.max(now.getTime(), slot.getTime())), {
    startAt: state.startAt,
    endAt: state.endAt,
  })
  if (state.endAt && slot.getTime() > state.endAt.getTime()) return { kind: "skip", slot, nextRunAt: null }
  if (state.tenantStatus !== "active") return { kind: "skip", slot, skipReason: "tenant_disabled", nextRunAt: following }
  return { kind: "dispatch", slot, nextRunAt: following }
}

export const TENANT_JOB_RUN_STATUSES = ["pending", "queued", "running", "retrying", "succeeded", "failed", "dead_letter", "skipped", "cancelled"] as const
export type TenantJobRunDisplayStatus = (typeof TENANT_JOB_RUN_STATUSES)[number]

/** Combine the run row with its shared-queue job into one tenant-facing status. */
export function displayRunStatus(runStatus: string, jobStatus: string | null, attempts: number): TenantJobRunDisplayStatus {
  if (runStatus === "skipped") return "skipped"
  if (runStatus === "succeeded") return "succeeded"
  if (!jobStatus) return runStatus === "failed" ? "failed" : "pending"
  if (jobStatus === "queued") return attempts > 0 ? "retrying" : "queued"
  if (jobStatus === "running") return "running"
  if (jobStatus === "completed") return "succeeded"
  if (jobStatus === "dead_letter") return "dead_letter"
  if (jobStatus === "cancelled") return "cancelled"
  return "failed"
}

/**
 * Error raised by reviewed tenant actions. `message` is safe to show to the
 * tenant. `status` feeds the shared queue's classifyJobFailure: 503 is
 * retried (transient), 400 dead-letters immediately (permanent).
 */
export class TenantJobError extends Error {
  readonly status: number
  constructor(message: string, readonly kind: "transient" | "permanent" = "permanent") {
    super(message)
    this.name = "TenantJobError"
    this.status = kind === "transient" ? 503 : 400
  }
}
