/**
 * SPEC 92 — Numbering Engine: pure format + sequence rules (Phase 1 & 2).
 * ---------------------------------------------------------------------------
 * This module holds ZERO database access. It encodes everything that decides
 * what a generated number LOOKS like and WHICH counter it draws from, so the
 * rules stay deterministic and unit-testable without a live DB (see
 * test/numbering-engine.test.ts) and can also render a live preview in the
 * browser (it is deliberately client-safe — no "server-only", no db import).
 *
 * A generated id is produced from a per-tenant, per-entity NumberingRule:
 *   - a custom `format` template with tokens ({PREFIX}, {YYYY}, {FY}, {SEQ}…)
 *   - a zero-padded running `sequence`
 *   - a `reset` policy that decides how the sequence is bucketed over time
 *
 * Examples the spec asks for:
 *   EMP-2026-000001   → format "{PREFIX}-{YYYY}-{SEQ}", prefix EMP, pad 6, yearly
 *   INV-2026-000001   → format "{PREFIX}-{YYYY}-{SEQ}", prefix INV, pad 6, yearly
 *   VEN-000001        → format "{PREFIX}-{SEQ}",        prefix VEN, pad 6, never
 */

/**
 * How a sequence is bucketed over time. Each distinct bucket gets its own
 * counter, so "reset" is really "start a fresh counter when the period rolls
 * over" — the old period's numbers are never reused.
 *   never   — one ever-growing counter (VEN-000001, VEN-000002…)
 *   yearly  — resets on the calendar year (…-2026-…, then …-2027-000001)
 *   fiscal  — resets on the fiscal year (configurable start month, e.g. Apr)
 *   monthly — resets every calendar month
 *   daily   — resets every calendar day
 */
export type ResetPolicy = "never" | "yearly" | "fiscal" | "monthly" | "daily"

export const RESET_POLICIES: readonly ResetPolicy[] = [
  "never",
  "yearly",
  "fiscal",
  "monthly",
  "daily",
] as const

/** A tenant + entity numbering rule. `entity` is the stable key (EMP, INV…). */
export type NumberingRule = {
  entity: string
  prefix: string
  suffix: string
  /** Zero-pad width for the running sequence (1–12). */
  padding: number
  reset: ResetPolicy
  /** Template with tokens; must contain {SEQ}. */
  format: string
  /** Fiscal-year start month 1–12 (drives {FY} and the `fiscal` reset). */
  fiscalStartMonth: number
  /** First number allocated in a fresh period (usually 1). */
  startNumber: number
}

/** Tokens a format template may use. Anything else is copied verbatim. */
export const NUMBERING_TOKENS: { token: string; description: string }[] = [
  { token: "{PREFIX}", description: "The configured prefix" },
  { token: "{SUFFIX}", description: "The configured suffix" },
  { token: "{SEQ}", description: "Zero-padded running sequence (required)" },
  { token: "{YYYY}", description: "4-digit calendar year" },
  { token: "{YY}", description: "2-digit calendar year" },
  { token: "{MM}", description: "2-digit month" },
  { token: "{DD}", description: "2-digit day" },
  { token: "{FY}", description: "Fiscal-year label, e.g. 2026-27" },
]

export const DEFAULT_FORMAT = "{PREFIX}-{SEQ}"
export const DEFAULT_FISCAL_START_MONTH = 4 // April (Indian fiscal year)

function pad2(n: number): string {
  return String(n).padStart(2, "0")
}

/** Clamp padding into a sane, storage-safe range. */
export function clampPadding(padding: number): number {
  if (!Number.isFinite(padding)) return 6
  return Math.max(1, Math.min(12, Math.trunc(padding)))
}

/** Clamp a fiscal start month into 1–12, defaulting to April. */
export function clampFiscalMonth(month: number): number {
  if (!Number.isFinite(month)) return DEFAULT_FISCAL_START_MONTH
  const m = Math.trunc(month)
  return m >= 1 && m <= 12 ? m : DEFAULT_FISCAL_START_MONTH
}

/** Normalize an entity key: uppercase, alphanumerics/underscore only. */
export function normalizeEntity(entity: string): string {
  return String(entity ?? "").toUpperCase().replace(/[^A-Z0-9_]/g, "")
}

// ---------------------------------------------------------------------------
// Fiscal year
// ---------------------------------------------------------------------------

/**
 * The starting calendar year of the fiscal year that `date` falls in. With an
 * April start, 2026-03-31 belongs to FY2025 and 2026-04-01 to FY2026. Uses UTC
 * parts so the bucket is stable regardless of the server's local zone.
 */
export function fiscalYearStart(date: Date, startMonth: number): number {
  const y = date.getUTCFullYear()
  const m = date.getUTCMonth() + 1
  return m >= clampFiscalMonth(startMonth) ? y : y - 1
}

/**
 * Human fiscal-year label. A January start collapses to the plain year
 * ("2026"); any other start spans two years ("2026-27").
 */
export function fiscalYearLabel(date: Date, startMonth: number): string {
  const month = clampFiscalMonth(startMonth)
  const start = fiscalYearStart(date, month)
  if (month === 1) return String(start)
  return `${start}-${pad2((start + 1) % 100)}`
}

// ---------------------------------------------------------------------------
// Counter bucketing
// ---------------------------------------------------------------------------

/**
 * The period key that identifies which counter an allocation draws from under
 * a rule's reset policy. Two allocations share a running sequence iff they map
 * to the same (entity, periodKey) — this is the sole mechanism behind resets.
 */
export function resetPeriodKey(rule: Pick<NumberingRule, "reset" | "fiscalStartMonth">, date: Date): string {
  const y = date.getUTCFullYear()
  switch (rule.reset) {
    case "never":
      return "ALL"
    case "yearly":
      return String(y)
    case "fiscal":
      return `FY${fiscalYearStart(date, rule.fiscalStartMonth)}`
    case "monthly":
      return `${y}-${pad2(date.getUTCMonth() + 1)}`
    case "daily":
      return `${y}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** Render the final id for a rule + concrete sequence at a point in time. */
export function renderNumber(rule: NumberingRule, sequence: number, date: Date = new Date()): string {
  const y = date.getUTCFullYear()
  const values: Record<string, string> = {
    "{PREFIX}": rule.prefix,
    "{SUFFIX}": rule.suffix,
    "{SEQ}": String(Math.max(0, Math.trunc(sequence))).padStart(clampPadding(rule.padding), "0"),
    "{YYYY}": String(y),
    "{YY}": String(y).slice(-2),
    "{MM}": pad2(date.getUTCMonth() + 1),
    "{DD}": pad2(date.getUTCDate()),
    "{FY}": fiscalYearLabel(date, rule.fiscalStartMonth),
  }
  return rule.format.replace(/\{[A-Z]+\}/g, (token) => values[token] ?? token)
}

// ---------------------------------------------------------------------------
// Sequence advance (the pure heart of duplicate prevention)
// ---------------------------------------------------------------------------

/**
 * Given a counter's current stored value (or undefined when the period has no
 * counter yet), return the next sequence to allocate. This mirrors EXACTLY the
 * database's `INSERT … VALUES(startNumber) ON DUPLICATE KEY UPDATE
 * next_number = next_number + 1` semantics, so the engine and this pure helper
 * can never disagree:
 *   - first allocation in a period  → startNumber
 *   - every subsequent allocation   → previous + 1 (strictly monotonic)
 */
export function advanceCounter(current: number | undefined | null, startNumber: number): number {
  const start = Number.isFinite(startNumber) ? Math.max(0, Math.trunc(startNumber)) : 1
  if (current == null) return start
  return Math.trunc(current) + 1
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export type RuleInput = {
  entity: string
  prefix?: string
  suffix?: string
  padding?: number
  reset?: string
  format?: string
  fiscalStartMonth?: number
  startNumber?: number
}

/**
 * Validate and normalize raw rule input into a safe NumberingRule, or return
 * the collected reasons. The API and UI both funnel through here so a bad
 * template (e.g. one missing {SEQ}, which would make every id identical) can
 * never be persisted.
 */
export function validateRuleInput(
  input: RuleInput,
): { ok: true; rule: NumberingRule } | { ok: false; errors: string[] } {
  const errors: string[] = []

  const entity = normalizeEntity(input.entity)
  if (!entity) errors.push("An entity key is required (letters, digits, underscore).")

  const format = (input.format ?? "").trim() || DEFAULT_FORMAT
  if (!format.includes("{SEQ}")) {
    errors.push("Format must include the {SEQ} token so every number is unique.")
  }
  const badTokens = (format.match(/\{[A-Z]+\}/g) ?? []).filter(
    (t) => !NUMBERING_TOKENS.some((k) => k.token === t),
  )
  if (badTokens.length > 0) {
    errors.push(`Unknown token(s): ${[...new Set(badTokens)].join(", ")}.`)
  }

  const reset = (input.reset ?? "never") as ResetPolicy
  if (!RESET_POLICIES.includes(reset)) {
    errors.push(`Reset policy must be one of: ${RESET_POLICIES.join(", ")}.`)
  }

  const startNumber = input.startNumber == null ? 1 : Math.trunc(Number(input.startNumber))
  if (!Number.isFinite(startNumber) || startNumber < 0) {
    errors.push("Start number must be zero or a positive integer.")
  }

  if (errors.length > 0) return { ok: false, errors }

  return {
    ok: true,
    rule: {
      entity,
      prefix: (input.prefix ?? "").trim(),
      suffix: (input.suffix ?? "").trim(),
      padding: clampPadding(Number(input.padding ?? 6)),
      reset,
      format,
      fiscalStartMonth: clampFiscalMonth(Number(input.fiscalStartMonth ?? DEFAULT_FISCAL_START_MONTH)),
      startNumber: Math.max(0, startNumber),
    },
  }
}

// ---------------------------------------------------------------------------
// Phase 1 — entity catalogue (the masters that get centralized numbering)
// ---------------------------------------------------------------------------

/**
 * The catalogue of entities the engine knows how to number, each with a
 * sensible default rule. These defaults reproduce the historical formats the
 * modules already used (so nothing changes until a tenant customizes a rule),
 * while routing every allocation through one race-safe engine.
 */
export type EntityDef = {
  entity: string
  label: string
  module: string
  defaults: Omit<NumberingRule, "entity">
}

function def(
  entity: string,
  label: string,
  module: string,
  defaults: Partial<Omit<NumberingRule, "entity">>,
): EntityDef {
  return {
    entity,
    label,
    module,
    defaults: {
      prefix: entity,
      suffix: "",
      padding: 6,
      reset: "never",
      format: DEFAULT_FORMAT,
      fiscalStartMonth: DEFAULT_FISCAL_START_MONTH,
      startNumber: 1,
      ...defaults,
    },
  }
}

export const NUMBERING_ENTITIES: readonly EntityDef[] = [
  def("EMP", "Employee", "HR", { format: "{PREFIX}-{YYYY}-{SEQ}", reset: "yearly" }),
  def("INV", "Sales invoice", "Finance", { format: "{PREFIX}-{YYYY}-{SEQ}", reset: "yearly" }),
  def("EST", "Estimate / quotation", "Finance", { format: "{PREFIX}-{YYYY}-{SEQ}", reset: "yearly", padding: 4 }),
  def("PMT", "Payment", "Finance", { format: "{PREFIX}-{YYYY}-{SEQ}", reset: "yearly", padding: 4 }),
  def("PO", "Purchase order", "Purchasing", { format: "{PREFIX}-{YYYY}-{SEQ}", reset: "yearly", padding: 4 }),
  def("BILL", "Purchase bill", "Purchasing", { padding: 4 }),
  def("VEN", "Vendor", "Purchasing", {}),
  def("CON", "Contract", "Legal", { format: "{PREFIX}-{YYYY}-{SEQ}", reset: "yearly", padding: 4 }),
  def("TKT", "Support ticket", "Support", { padding: 4 }),
  def("PROJ", "Project", "Projects", { padding: 4 }),
  def("AST", "Asset", "Assets", { padding: 4 }),
  def("JOB", "Recruitment job", "Recruitment", { padding: 4 }),
] as const

const ENTITY_MAP = new Map<string, EntityDef>(NUMBERING_ENTITIES.map((e) => [e.entity, e]))

/** The default rule for an entity — a catalogue default, or a generic fallback. */
export function defaultRuleFor(entity: string): NumberingRule {
  const key = normalizeEntity(entity)
  const known = ENTITY_MAP.get(key)
  if (known) return { entity: key, ...known.defaults }
  return {
    entity: key,
    prefix: key,
    suffix: "",
    padding: 6,
    reset: "never",
    format: DEFAULT_FORMAT,
    fiscalStartMonth: DEFAULT_FISCAL_START_MONTH,
    startNumber: 1,
  }
}

/** Look up a known entity definition (label/module), if any. */
export function getEntityDef(entity: string): EntityDef | undefined {
  return ENTITY_MAP.get(normalizeEntity(entity))
}
