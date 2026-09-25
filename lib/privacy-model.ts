/**
 * Spec24 — Privacy, consent and safe deletion (pure, testable model).
 * ---------------------------------------------------------------------------
 * The DB-free core shared by the three privacy subsystems:
 *
 *   1. CONSENT & NOTICE — explicit opt-in / notice records for marketing,
 *      recruitment and screen-capture purposes, with withdrawal.
 *   2. DATA-SUBJECT REQUESTS (DSAR) — export, anonymization and erasure of one
 *      person's personal data, gated by retention obligations and legal holds.
 *   3. TENANT DELETION — a full-tenant offboarding lifecycle with a cooling
 *      period, a mandatory export step and a final approval, blocked while a
 *      legal hold is active.
 *
 * Everything here is pure (no `server-only`, Node or DB import) so the
 * validation, lifecycle and conflict logic can be unit-tested directly and
 * (type-only) shared with the settings UI — mirroring lib/retention-model.ts
 * and lib/legal-hold-model.ts. The DB stores that persist and audit these
 * decisions live in lib/privacy-*-store.ts and lib/tenant-deletion-store.ts.
 */

// ===========================================================================
// Consent & notice
// ===========================================================================

/**
 * The purposes a tenant records consent/notice for. Deliberately small and
 * closed: each maps to a real processing activity in the ERP.
 *   - marketing        — sending marketing/promotional communications.
 *   - recruitment      — retaining a candidate's data beyond a single role.
 *   - screen_capture   — HR screen-activity monitoring (see lib/screen-monitoring.ts).
 */
export const CONSENT_PURPOSES = ["marketing", "recruitment", "screen_capture"] as const
export type ConsentPurpose = (typeof CONSENT_PURPOSES)[number]

export const CONSENT_PURPOSE_LABELS: Record<ConsentPurpose, string> = {
  marketing: "Marketing communications",
  recruitment: "Recruitment data retention",
  screen_capture: "Screen-activity monitoring",
}

export function isConsentPurpose(value: unknown): value is ConsentPurpose {
  return typeof value === "string" && (CONSENT_PURPOSES as readonly string[]).includes(value)
}

/**
 * How the lawful basis was captured.
 *   - explicit_optin — the subject actively opted in (a ticked box, signature).
 *   - notice         — the subject was notified of processing under legitimate
 *                      interest / contract (recorded, not a positive opt-in).
 */
export const CONSENT_METHODS = ["explicit_optin", "notice"] as const
export type ConsentMethod = (typeof CONSENT_METHODS)[number]

export function isConsentMethod(value: unknown): value is ConsentMethod {
  return typeof value === "string" && (CONSENT_METHODS as readonly string[]).includes(value)
}

export function toConsentMethod(value: unknown): ConsentMethod {
  return isConsentMethod(value) ? value : "explicit_optin"
}

/** A consent record's current standing. */
export const CONSENT_STATUSES = ["granted", "withdrawn"] as const
export type ConsentStatus = (typeof CONSENT_STATUSES)[number]

export function isConsentStatus(value: unknown): value is ConsentStatus {
  return typeof value === "string" && (CONSENT_STATUSES as readonly string[]).includes(value)
}

/**
 * A subject is identified within a tenant by a lower-cased, trimmed email. This
 * is the single normalization used everywhere so a consent record, a DSAR and
 * a personal-data row are matched consistently regardless of input casing.
 */
export function normalizeSubjectEmail(value: unknown): string {
  return String(value ?? "").trim().toLowerCase()
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function isValidSubjectEmail(value: unknown): boolean {
  const email = normalizeSubjectEmail(value)
  return email.length > 0 && email.length <= 190 && EMAIL_RE.test(email)
}

export type NormalizedConsentInput = {
  subjectEmail: string
  subjectName: string | null
  purpose: ConsentPurpose
  method: ConsentMethod
  channel: string | null
  notes: string | null
}

/**
 * Coerce arbitrary request input into a valid consent record. Throws a
 * user-facing message on the two hard requirements (a valid subject email and
 * a known purpose) — the API turns that into a 400.
 */
export function normalizeConsentInput(input: {
  subjectEmail?: unknown
  subjectName?: unknown
  purpose?: unknown
  method?: unknown
  channel?: unknown
  notes?: unknown
}): NormalizedConsentInput {
  const subjectEmail = normalizeSubjectEmail(input.subjectEmail)
  if (!isValidSubjectEmail(subjectEmail)) throw new Error("A valid subject email is required")
  if (!isConsentPurpose(input.purpose)) throw new Error("A valid consent purpose is required")
  const name = String(input.subjectName ?? "").trim()
  const channel = String(input.channel ?? "").trim()
  const notes = String(input.notes ?? "").trim()
  return {
    subjectEmail: subjectEmail.slice(0, 190),
    subjectName: name ? name.slice(0, 160) : null,
    purpose: input.purpose,
    method: toConsentMethod(input.method),
    channel: channel ? channel.slice(0, 96) : null,
    notes: notes ? notes.slice(0, 1000) : null,
  }
}

/**
 * Reduce a subject+purpose's chronological consent events into the CURRENT
 * effective state. The latest event wins, so a withdrawal after a grant means
 * "withdrawn" and a fresh grant after a withdrawal re-establishes consent.
 * Pure over the supplied list; the store sorts by created_at before calling.
 */
export function effectiveConsent(
  events: { status: ConsentStatus; at: string | Date }[],
): ConsentStatus | null {
  if (events.length === 0) return null
  const sorted = [...events].sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime())
  return sorted[sorted.length - 1].status
}

/** Whether processing for a purpose is currently permitted for a subject. */
export function isProcessingAllowed(state: ConsentStatus | null): boolean {
  return state === "granted"
}

// ===========================================================================
// Data-subject requests (DSAR)
// ===========================================================================

/**
 * The three subject-rights workflows.
 *   - export    — produce a machine-readable copy of the subject's data.
 *   - anonymize — irreversibly scrub direct identifiers but KEEP the rows
 *                 (satisfies erasure while preserving records under a
 *                 retention obligation, e.g. posted invoices).
 *   - erase     — delete the subject's rows outright.
 */
export const SUBJECT_REQUEST_KINDS = ["export", "anonymize", "erase"] as const
export type SubjectRequestKind = (typeof SUBJECT_REQUEST_KINDS)[number]

export const SUBJECT_REQUEST_KIND_LABELS: Record<SubjectRequestKind, string> = {
  export: "Data export",
  anonymize: "Anonymization",
  erase: "Erasure",
}

export function isSubjectRequestKind(value: unknown): value is SubjectRequestKind {
  return typeof value === "string" && (SUBJECT_REQUEST_KINDS as readonly string[]).includes(value)
}

/**
 * DSAR lifecycle.
 *   pending   → awaiting an admin's approval (export needs none; erase/anonymize do).
 *   approved  → approved, not yet executed.
 *   completed → executed successfully.
 *   rejected  → an admin declined the request.
 *   failed    → execution errored (safe to retry).
 */
export const SUBJECT_REQUEST_STATUSES = ["pending", "approved", "completed", "rejected", "failed"] as const
export type SubjectRequestStatus = (typeof SUBJECT_REQUEST_STATUSES)[number]

export function isSubjectRequestStatus(value: unknown): value is SubjectRequestStatus {
  return typeof value === "string" && (SUBJECT_REQUEST_STATUSES as readonly string[]).includes(value)
}

/** A destructive DSAR (erase/anonymize) requires an explicit approval step. */
export function requiresApproval(kind: SubjectRequestKind): boolean {
  return kind === "erase" || kind === "anonymize"
}

/** Terminal states never transition again. */
export function isTerminalRequestStatus(status: SubjectRequestStatus): boolean {
  return status === "completed" || status === "rejected"
}

/**
 * May a request in `status` be executed (run) now? Export runs straight from
 * pending; destructive kinds must be approved first. `failed` may always be
 * retried. Pure decision the store and route both consult.
 */
export function canRunRequest(kind: SubjectRequestKind, status: SubjectRequestStatus): boolean {
  if (status === "failed") return true
  if (requiresApproval(kind)) return status === "approved"
  return status === "pending"
}

// ---------------------------------------------------------------------------
// Retention-conflict assessment
// ---------------------------------------------------------------------------

/**
 * A single personal-data location and whether it can be honored for a given
 * erase/anonymize request. `retained` means a retention obligation forbids
 * deletion of the row; such a location must be ANONYMIZED rather than erased.
 * `held` means an active legal hold blocks any change at all.
 */
export type SubjectLocationAssessment = {
  /** Catalog key of the personal-data location. */
  key: string
  /** Human label for UI / audit. */
  label: string
  /** Estimated matching row count (0 = the subject has no data there). */
  matches: number
  /** A retention policy requires these rows be kept (erasure not permitted). */
  retained: boolean
  /** A legal hold blocks any modification of these rows. */
  held: boolean
  /** Whether this location supports anonymization (has scrubable identifier columns). */
  anonymizable: boolean
}

/**
 * The resolved plan for a destructive DSAR: what will happen at each location
 * plus the aggregate blockers. This is the evidence surface the UI shows before
 * approval and the audit log records after execution.
 */
export type SubjectRequestPlan = {
  kind: SubjectRequestKind
  /** Locations that will actually be erased. */
  eraseLocations: SubjectLocationAssessment[]
  /** Locations that will be anonymized instead of erased (retention conflict). */
  anonymizeLocations: SubjectLocationAssessment[]
  /** Locations blocked entirely by a legal hold. */
  blockedLocations: SubjectLocationAssessment[]
  /** Locations with no matching rows (skipped). */
  emptyLocations: SubjectLocationAssessment[]
  /** True when a legal hold blocks at least one location — the request cannot fully complete. */
  hasLegalHoldConflict: boolean
  /** True when a retention obligation downgraded at least one erase to anonymize. */
  hasRetentionConflict: boolean
}

/**
 * Build the execution plan for a destructive DSAR from the per-location
 * assessments. The precedence at each location is:
 *   1. legal hold        → BLOCKED (never touched, regardless of anything else)
 *   2. no matching rows  → EMPTY (skipped)
 *   3. erase + retention → downgraded to ANONYMIZE (keep the row, scrub PII)
 *   4. erase, no retention, anonymizable-or-not → ERASE
 *   5. anonymize kind    → ANONYMIZE where possible, else treated as retained/erase
 *
 * A legal hold ALWAYS wins — matching the absolute guarantee in
 * lib/legal-hold-model.ts. Pure over its inputs.
 */
export function buildSubjectRequestPlan(
  kind: SubjectRequestKind,
  locations: SubjectLocationAssessment[],
): SubjectRequestPlan {
  const eraseLocations: SubjectLocationAssessment[] = []
  const anonymizeLocations: SubjectLocationAssessment[] = []
  const blockedLocations: SubjectLocationAssessment[] = []
  const emptyLocations: SubjectLocationAssessment[] = []

  for (const loc of locations) {
    if (loc.held) {
      blockedLocations.push(loc)
      continue
    }
    if (loc.matches <= 0) {
      emptyLocations.push(loc)
      continue
    }
    if (kind === "anonymize") {
      // Explicit anonymize: scrub where we can, otherwise there is nothing safe
      // to do without deleting — treat a non-anonymizable location as retained.
      if (loc.anonymizable) anonymizeLocations.push(loc)
      else eraseLocations.push({ ...loc, matches: 0 }) // nothing actionable
      continue
    }
    // kind === "erase"
    if (loc.retained) {
      // Retention obligation: keep the row but scrub identifiers when possible.
      if (loc.anonymizable) anonymizeLocations.push(loc)
      else blockedLocations.push({ ...loc }) // cannot erase, cannot anonymize
    } else {
      eraseLocations.push(loc)
    }
  }

  return {
    kind,
    eraseLocations,
    anonymizeLocations,
    blockedLocations,
    emptyLocations,
    hasLegalHoldConflict: blockedLocations.some((l) => l.held),
    hasRetentionConflict: kind === "erase" && anonymizeLocations.length > 0,
  }
}

export type NormalizedSubjectRequestInput = {
  kind: SubjectRequestKind
  subjectEmail: string
  subjectName: string | null
  reason: string | null
}

export function normalizeSubjectRequestInput(input: {
  kind?: unknown
  subjectEmail?: unknown
  subjectName?: unknown
  reason?: unknown
}): NormalizedSubjectRequestInput {
  if (!isSubjectRequestKind(input.kind)) throw new Error("A valid request type is required")
  const subjectEmail = normalizeSubjectEmail(input.subjectEmail)
  if (!isValidSubjectEmail(subjectEmail)) throw new Error("A valid subject email is required")
  const name = String(input.subjectName ?? "").trim()
  const reason = String(input.reason ?? "").trim()
  return {
    kind: input.kind,
    subjectEmail: subjectEmail.slice(0, 190),
    subjectName: name ? name.slice(0, 160) : null,
    reason: reason ? reason.slice(0, 1000) : null,
  }
}

/**
 * Duplicate-request guard. A new DSAR duplicates an existing one when it has the
 * same kind + subject and the existing one is still OPEN (pending/approved).
 * A completed/rejected/failed prior request never blocks a fresh one. Pure so
 * both the store (idempotency) and tests share the exact rule.
 */
export function isDuplicateSubjectRequest(
  incoming: { kind: SubjectRequestKind; subjectEmail: string },
  existing: { kind: SubjectRequestKind; subjectEmail: string; status: SubjectRequestStatus }[],
): boolean {
  const email = normalizeSubjectEmail(incoming.subjectEmail)
  return existing.some(
    (e) =>
      e.kind === incoming.kind &&
      normalizeSubjectEmail(e.subjectEmail) === email &&
      (e.status === "pending" || e.status === "approved"),
  )
}

// ===========================================================================
// Tenant deletion lifecycle
// ===========================================================================

/**
 * Full-tenant deletion lifecycle.
 *   requested       → a tenant owner asked to delete the tenant; cooling period starts.
 *   export_ready    → the mandatory data export has been produced.
 *   approved        → final approval granted (only after cooling + export).
 *   executed        → the tenant's data has been purged.
 *   cancelled       → the request was withdrawn before execution.
 */
export const TENANT_DELETION_STATUSES = [
  "requested",
  "export_ready",
  "approved",
  "executed",
  "cancelled",
] as const
export type TenantDeletionStatus = (typeof TENANT_DELETION_STATUSES)[number]

export function isTenantDeletionStatus(value: unknown): value is TenantDeletionStatus {
  return typeof value === "string" && (TENANT_DELETION_STATUSES as readonly string[]).includes(value)
}

/** Terminal states never transition again. */
export function isTerminalDeletionStatus(status: TenantDeletionStatus): boolean {
  return status === "executed" || status === "cancelled"
}

const DAY_MS = 86_400_000

/**
 * The mandatory cooling-off window between requesting tenant deletion and being
 * allowed to finally approve it. Bounded so a fat-fingered value can neither
 * remove the safety window nor create an absurd one.
 */
export const TENANT_DELETION_COOLING = {
  DEFAULT_DAYS: 30,
  MIN_DAYS: 7,
  MAX_DAYS: 180,
} as const

export function clampCoolingDays(value: unknown): number {
  const n = Math.floor(Number(value))
  if (!Number.isFinite(n)) return TENANT_DELETION_COOLING.DEFAULT_DAYS
  return Math.min(TENANT_DELETION_COOLING.MAX_DAYS, Math.max(TENANT_DELETION_COOLING.MIN_DAYS, n))
}

/** When the cooling period ends, given the request time and window in days. */
export function computeCoolingEndsAt(requestedAt: string | Date, coolingDays: number): Date {
  const start = requestedAt instanceof Date ? requestedAt : new Date(requestedAt)
  return new Date(start.getTime() + clampCoolingDays(coolingDays) * DAY_MS)
}

/** True once the cooling window has elapsed. */
export function isCoolingElapsed(coolingEndsAt: string | Date | null | undefined, now: Date = new Date()): boolean {
  if (!coolingEndsAt) return false
  const d = coolingEndsAt instanceof Date ? coolingEndsAt : new Date(coolingEndsAt)
  if (Number.isNaN(d.getTime())) return false
  return d.getTime() <= now.getTime()
}

/** Whole days remaining in the cooling window (0 once elapsed). */
export function coolingDaysRemaining(coolingEndsAt: string | Date | null | undefined, now: Date = new Date()): number {
  if (!coolingEndsAt) return 0
  const d = coolingEndsAt instanceof Date ? coolingEndsAt : new Date(coolingEndsAt)
  if (Number.isNaN(d.getTime())) return 0
  return Math.max(0, Math.ceil((d.getTime() - now.getTime()) / DAY_MS))
}

/**
 * The set of conditions that must ALL hold before a tenant deletion may be
 * finally approved and executed. Kept as a structured result (not a boolean) so
 * the UI can explain exactly what is still outstanding and the audit log can
 * record the proof that each obligation was satisfied.
 */
export type TenantDeletionReadiness = {
  canApprove: boolean
  canExecute: boolean
  reasons: string[]
  /** Snapshot of the individual checks for the evidence trail. */
  checks: {
    coolingElapsed: boolean
    exportCompleted: boolean
    noLegalHold: boolean
    retentionProven: boolean
  }
}

/**
 * Evaluate whether a tenant deletion is ready to approve / execute. The four
 * obligations, ALL required:
 *   - the cooling window has elapsed,
 *   - the mandatory data export completed (the tenant keeps a copy),
 *   - NO active legal hold covers the tenant (a hold is absolute),
 *   - retention/backup obligations have been acknowledged and proven.
 *
 * Approval requires cooling + export + no-hold + retention proof. Execution
 * additionally requires the request to already be in the `approved` state.
 * Pure over its inputs so the exact gate is unit-tested.
 */
export function evaluateTenantDeletionReadiness(input: {
  status: TenantDeletionStatus
  coolingEndsAt: string | Date | null | undefined
  exportCompleted: boolean
  activeLegalHolds: number
  retentionProven: boolean
  now?: Date
}): TenantDeletionReadiness {
  const now = input.now ?? new Date()
  const coolingElapsed = isCoolingElapsed(input.coolingEndsAt, now)
  const noLegalHold = input.activeLegalHolds <= 0
  const checks = {
    coolingElapsed,
    exportCompleted: input.exportCompleted,
    noLegalHold,
    retentionProven: input.retentionProven,
  }
  const reasons: string[] = []
  if (isTerminalDeletionStatus(input.status)) {
    reasons.push(`Request is already ${input.status}`)
  }
  if (!coolingElapsed) {
    reasons.push(`Cooling-off period has not elapsed (${coolingDaysRemaining(input.coolingEndsAt, now)} day(s) remaining)`)
  }
  if (!input.exportCompleted) reasons.push("A completed data export is required before deletion")
  if (!noLegalHold) reasons.push(`${input.activeLegalHolds} active legal hold(s) block deletion`)
  if (!input.retentionProven) reasons.push("Backup/retention obligations must be proven and acknowledged")

  const obligationsMet = coolingElapsed && input.exportCompleted && noLegalHold && input.retentionProven
  const canApprove = obligationsMet && !isTerminalDeletionStatus(input.status)
  const canExecute = obligationsMet && input.status === "approved"
  return { canApprove, canExecute, reasons, checks }
}

export type NormalizedTenantDeletionInput = {
  reason: string | null
  coolingDays: number
}

export function normalizeTenantDeletionInput(input: {
  reason?: unknown
  coolingDays?: unknown
}): NormalizedTenantDeletionInput {
  const reason = String(input.reason ?? "").trim()
  return {
    reason: reason ? reason.slice(0, 1000) : null,
    coolingDays: input.coolingDays == null || input.coolingDays === "" ? TENANT_DELETION_COOLING.DEFAULT_DAYS : clampCoolingDays(input.coolingDays),
  }
}
