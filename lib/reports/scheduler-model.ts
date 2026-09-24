/**
 * SPEC 98 — Report Scheduler (pure model).
 *
 * This module is deliberately free of any database, `server-only`, or Node
 * runtime dependency so the scheduling rules can be unit-tested in isolation
 * (see `test/reports-scheduler-model.test.ts`). It owns:
 *
 *   • the vocabulary of frequencies, delivery formats and channels,
 *   • translating a friendly cadence (daily / weekly / monthly) into a
 *     validated 5-field cron expression the platform dispatcher understands,
 *   • validating a custom cron expression,
 *   • normalising + permission-checking the recipient list, and
 *   • the deterministic "slot key" used to make each run idempotent.
 *
 * The DB-backed store (`scheduler-store.ts`) and the cron runner build on top
 * of these primitives; the cron matching itself is shared with the platform
 * scheduler via `lib/cron-jobs`.
 */

// --- Vocabulary --------------------------------------------------------------

export const SCHEDULE_FREQUENCIES = ["daily", "weekly", "monthly", "custom"] as const
export type ScheduleFrequency = (typeof SCHEDULE_FREQUENCIES)[number]

export const FREQUENCY_LABELS: Record<ScheduleFrequency, string> = {
  daily: "Daily",
  weekly: "Weekly",
  monthly: "Monthly",
  custom: "Custom (cron)",
}

/** Delivered artifact formats. "Excel/CSV" from the spec is xlsx + csv. */
export const DELIVERY_FORMATS = ["pdf", "xlsx", "csv"] as const
export type DeliveryFormat = (typeof DELIVERY_FORMATS)[number]

export const FORMAT_LABELS: Record<DeliveryFormat, string> = {
  pdf: "PDF",
  xlsx: "Excel (.xlsx)",
  csv: "CSV",
}

export const FORMAT_CONTENT_TYPE: Record<DeliveryFormat, string> = {
  pdf: "application/pdf",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  csv: "text/csv; charset=utf-8",
}

export const FORMAT_EXTENSION: Record<DeliveryFormat, string> = {
  pdf: "pdf",
  xlsx: "xlsx",
  csv: "csv",
}

/** How the finished report reaches its audience. */
export const DELIVERY_CHANNELS = ["email", "storage"] as const
export type DeliveryChannel = (typeof DELIVERY_CHANNELS)[number]

export const CHANNEL_LABELS: Record<DeliveryChannel, string> = {
  email: "Email delivery",
  storage: "Storage (secure download link)",
}

export const SCHEDULE_STATUSES = ["active", "paused"] as const
export type ScheduleStatus = (typeof SCHEDULE_STATUSES)[number]

export const RUN_STATUSES = ["success", "failed", "skipped"] as const
export type RunStatus = (typeof RUN_STATUSES)[number]

// --- Caps --------------------------------------------------------------------

export const SCHEDULER_CAPS = {
  /** Maximum e-mail recipients per schedule. */
  maxRecipients: 25,
  /** Maximum stored artifact size (bytes) before a run is failed as too large. */
  maxArtifactBytes: 15 * 1024 * 1024, // 15 MB — safely under a typical 16 MB packet/blob limit.
  /** How long a storage-delivery download link stays valid. */
  downloadTtlMs: 7 * 24 * 60 * 60 * 1000, // 7 days
  /** Retained run-history rows per schedule. */
  maxRunHistory: 50,
} as const

// --- Type guards -------------------------------------------------------------

export function isScheduleFrequency(v: unknown): v is ScheduleFrequency {
  return typeof v === "string" && (SCHEDULE_FREQUENCIES as readonly string[]).includes(v)
}
export function isDeliveryFormat(v: unknown): v is DeliveryFormat {
  return typeof v === "string" && (DELIVERY_FORMATS as readonly string[]).includes(v)
}
export function isDeliveryChannel(v: unknown): v is DeliveryChannel {
  return typeof v === "string" && (DELIVERY_CHANNELS as readonly string[]).includes(v)
}

// --- Cron construction / validation -----------------------------------------

export type CadenceInput = {
  /** 0-59; defaults to 0. */
  minute?: number
  /** 0-23; defaults to 6 (06:00). */
  hour?: number
  /** 0 (Sun) – 6 (Sat); used by weekly, defaults to 1 (Mon). */
  weekday?: number
  /** 1-31; used by monthly, defaults to 1. */
  dayOfMonth?: number
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = Math.floor(Number(value))
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

/**
 * A tiny, self-contained 5-field cron validator. It mirrors the semantics of
 * `lib/cron-jobs.validateCronExpression` but lives here so the model stays
 * dependency-free and testable. `lib/cron-jobs` remains the single matcher used
 * at dispatch time.
 */
export function isValidCronExpression(expression: string): boolean {
  const fields = String(expression).trim().split(/\s+/)
  if (fields.length !== 5) return false
  const ranges: [number, number][] = [
    [0, 59],
    [0, 23],
    [1, 31],
    [1, 12],
    [0, 6],
  ]
  const partOk = (part: string, min: number, max: number): boolean => {
    const [base, stepRaw] = part.split("/")
    if (stepRaw !== undefined) {
      const step = Number(stepRaw)
      if (!Number.isInteger(step) || step < 1) return false
    }
    if (base === "*") return true
    const range = base.split("-")
    if (range.length > 2) return false
    const start = Number(range[0])
    const end = range.length === 2 ? Number(range[1]) : start
    if (!Number.isInteger(start) || !Number.isInteger(end)) return false
    if (start < min || end > max || start > end) return false
    return true
  }
  return fields.every((field, i) => {
    if (!field) return false
    return field.split(",").every((part) => partOk(part, ranges[i][0], ranges[i][1]))
  })
}

/**
 * Turn a friendly cadence into a validated 5-field cron expression. For
 * `custom`, the caller-supplied expression is validated and returned verbatim.
 * Throws a user-facing `Error` on invalid input.
 */
export function buildCronExpression(
  frequency: ScheduleFrequency,
  cadence: CadenceInput = {},
  customExpression?: string | null,
): string {
  if (frequency === "custom") {
    const expr = String(customExpression ?? "").trim()
    if (!expr) throw new Error("A custom schedule requires a cron expression.")
    if (!isValidCronExpression(expr)) throw new Error("The cron expression is not valid. Use 5 space-separated fields.")
    return expr
  }
  const minute = clampInt(cadence.minute, 0, 59, 0)
  const hour = clampInt(cadence.hour, 0, 23, 6)
  switch (frequency) {
    case "daily":
      return `${minute} ${hour} * * *`
    case "weekly": {
      const weekday = clampInt(cadence.weekday, 0, 6, 1)
      return `${minute} ${hour} * * ${weekday}`
    }
    case "monthly": {
      const dom = clampInt(cadence.dayOfMonth, 1, 31, 1)
      return `${minute} ${hour} ${dom} * *`
    }
    default:
      throw new Error("Unsupported frequency.")
  }
}

const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]

/** A short human description of a schedule, for lists and audit labels. */
export function describeSchedule(frequency: ScheduleFrequency, cronExpression: string): string {
  if (frequency === "custom") return `Custom · ${cronExpression}`
  const [minute, hour, dom, , weekday] = cronExpression.trim().split(/\s+/)
  const time = `${String(Number(hour) % 24).padStart(2, "0")}:${String(Number(minute) % 60).padStart(2, "0")}`
  if (frequency === "daily") return `Daily at ${time}`
  if (frequency === "weekly") return `Weekly on ${WEEKDAY_NAMES[Number(weekday) % 7] ?? "Monday"} at ${time}`
  if (frequency === "monthly") return `Monthly on day ${Number(dom) || 1} at ${time}`
  return `${FREQUENCY_LABELS[frequency]} · ${cronExpression}`
}

// --- Recipients + permissions ------------------------------------------------

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export type RecipientValidation = { emails: string[]; invalid: string[] }

/**
 * Normalise a raw recipient input (comma / newline / array) into a deduped,
 * lower-cased, validated email list. Invalid tokens are reported separately so
 * the UI/store can surface them instead of silently dropping addresses.
 */
export function parseRecipients(raw: unknown): RecipientValidation {
  const tokens = Array.isArray(raw)
    ? raw.flatMap((v) => String(v).split(/[,\n;]/))
    : String(raw ?? "").split(/[,\n;]/)
  const emails: string[] = []
  const invalid: string[] = []
  const seen = new Set<string>()
  for (const token of tokens) {
    const value = token.trim()
    if (!value) continue
    const lower = value.toLowerCase()
    if (!EMAIL_RE.test(lower)) {
      invalid.push(value)
      continue
    }
    if (seen.has(lower)) continue
    seen.add(lower)
    emails.push(lower)
  }
  return { emails, invalid }
}

export type RecipientPermissionContext = {
  /**
   * Domains the schedule owner is allowed to send reports to. When provided,
   * every recipient must match one of these domains (case-insensitive). An
   * empty/undefined list means "no domain restriction".
   */
  allowedDomains?: string[]
}

/**
 * Enforce recipient permissions for an email-delivery schedule. Returns the
 * clean recipient list or throws a user-facing `Error`. Storage-only schedules
 * pass an empty list through (the artifact is fetched via a signed link, not
 * pushed to arbitrary addresses).
 */
export function assertRecipientPermission(
  channel: DeliveryChannel,
  raw: unknown,
  ctx: RecipientPermissionContext = {},
): string[] {
  if (channel === "storage") return []
  const { emails, invalid } = parseRecipients(raw)
  if (invalid.length > 0) {
    throw new Error(`These recipient addresses are not valid: ${invalid.slice(0, 5).join(", ")}`)
  }
  if (emails.length === 0) {
    throw new Error("Email delivery needs at least one recipient.")
  }
  if (emails.length > SCHEDULER_CAPS.maxRecipients) {
    throw new Error(`A schedule can have at most ${SCHEDULER_CAPS.maxRecipients} recipients.`)
  }
  const allowed = (ctx.allowedDomains ?? []).map((d) => d.trim().toLowerCase()).filter(Boolean)
  if (allowed.length > 0) {
    const blocked = emails.filter((e) => {
      const domain = e.split("@")[1] ?? ""
      return !allowed.includes(domain)
    })
    if (blocked.length > 0) {
      throw new Error(`You are not permitted to deliver reports to: ${blocked.slice(0, 5).join(", ")}`)
    }
  }
  return emails
}

// --- Idempotency -------------------------------------------------------------

/**
 * A minute-resolution UTC slot key. Two dispatcher ticks inside the same minute
 * produce the same slot, so a `UNIQUE(schedule_id, slot)` run row guarantees a
 * schedule fires at most once per matched minute even across parallel workers.
 */
export function slotKey(at: Date): string {
  return at.toISOString().slice(0, 16) // e.g. "2026-09-24T06:00"
}

// --- File naming -------------------------------------------------------------

/** A safe, human-friendly artifact file name, e.g. "Sales-Summary-2026-09-24.pdf". */
export function reportArtifactFileName(reportName: string, format: DeliveryFormat, at: Date = new Date()): string {
  const stem =
    String(reportName || "report")
      .normalize("NFKD")
      .replace(/[^\w\s-]/g, "")
      .trim()
      .replace(/\s+/g, "-")
      .slice(0, 60) || "report"
  const date = at.toISOString().slice(0, 10)
  return `${stem}-${date}.${FORMAT_EXTENSION[format]}`
}
