/**
 * SPEC 109 — Activity Timeline: centralized activity/event model (Phase 1 & 2).
 * ---------------------------------------------------------------------------
 * PHASE 1 AUDIT — before this module, "what happened to X" was scattered across
 * dozens of module-private, mutually-incompatible logs. There was no single
 * cross-module timeline: to reconstruct the history of a customer you had to
 * union many tables, each with its own column names, actor convention and time
 * column. A representative (non-exhaustive) inventory of the fragments:
 *
 *   Calls          -> internal_call_events
 *   Emails         -> sales_email_events, tenant_email_events, marketing_campaign_events
 *   Meetings       -> calendar_events + event_participants
 *   Notes          -> marketing_contact_activity, recruitment_candidate_activities
 *   Tasks          -> sales_lead_followups, recruitment_reminder_log
 *   Status changes -> sales_lead_stage_history, hr_leave_timeline, org_unit_change_log,
 *                     md_gov_history, product_price_history, subscription_audit
 *   Approvals      -> sod_audit, notice_audit, legal_contract_events
 *   Payments       -> billing_gateway_events, usage_events, saas_subscription_events
 *   Documents      -> dms_audit, kb_audit, hr_letter_events, legal_esign_events
 *   System events  -> erp_business_events, platform_background_job_events, mobile_api_audit
 *
 * PHASE 2 — this module defines the ONE normalized activity event. Every module
 * emits into a single `activity_events` stream keyed by the *subject* the
 * activity is about (subject_type + subject_id), classified by one of the ten
 * spec `kind`s, attributed to an actor, ordered by `occurred_at`, and gated by a
 * visibility level + a per-kind permission. A subject's timeline is then a
 * single indexed, tenant-scoped, keyset-paginated read.
 *
 * This file is PURE and DB-free (no "server-only"): the SAME taxonomy,
 * validation, ordering and permission rules run in the browser (optimistic
 * rendering, filtering) and authoritatively on the server, and are exhaustively
 * unit-tested (see test/activity-model.test.ts). The data layer lives in db.ts
 * and the per-module emit helpers in integrations.ts.
 */

// ---------------------------------------------------------------------------
// Taxonomy
// ---------------------------------------------------------------------------

/** The ten activity categories the spec enumerates. Order is display order. */
export const ACTIVITY_KINDS = [
  "call",
  "email",
  "meeting",
  "note",
  "task",
  "status_change",
  "approval",
  "payment",
  "document",
  "system",
  "whatsapp",
] as const
export type ActivityKind = (typeof ACTIVITY_KINDS)[number]

export function isActivityKind(value: unknown): value is ActivityKind {
  return typeof value === "string" && (ACTIVITY_KINDS as readonly string[]).includes(value)
}

/** Who performed the activity. */
export const ACTOR_TYPES = ["user", "system", "integration"] as const
export type ActorType = (typeof ACTOR_TYPES)[number]

/**
 * Visibility ladder (least -> most restricted):
 *   - "timeline": anyone who can view the subject / owning module.
 *   - "internal": staff only; hidden from portal / customer-facing viewers.
 *   - "private":  only the actor and explicitly named watchers.
 */
export const ACTIVITY_VISIBILITIES = ["timeline", "internal", "private"] as const
export type ActivityVisibility = (typeof ACTIVITY_VISIBILITIES)[number]

const VISIBILITY_RANK: Record<ActivityVisibility, number> = {
  timeline: 0,
  internal: 1,
  private: 2,
}

/**
 * Some kinds carry sensitive information and additionally require a module
 * feature to be read, regardless of visibility. Admins bypass this. Kinds not
 * listed have no extra gate beyond visibility + subject access.
 */
export const ACTIVITY_KIND_FEATURE: Partial<Record<ActivityKind, string>> = {
  payment: "finance.view_payments",
  approval: "approvals.view",
}

export const ACTIVITY_TITLE_MAX = 200
export const ACTIVITY_BODY_MAX = 5000
export const TIMELINE_MAX_LIMIT = 100
export const TIMELINE_DEFAULT_LIMIT = 25

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class ActivityValidationError extends Error {
  fields: Record<string, string>
  constructor(fields: Record<string, string>, message = "Invalid activity event") {
    super(message)
    this.name = "ActivityValidationError"
    this.fields = fields
  }
}

// ---------------------------------------------------------------------------
// The normalized event
// ---------------------------------------------------------------------------

export type ActivityEventInput = {
  kind: ActivityKind | string
  /** The entity this activity is ABOUT (e.g. "contact", "lead", "invoice"). */
  subject_type: string
  subject_id: string | number
  subject_label?: string | null
  /** Free verb describing the action, e.g. "created", "completed", "sent". */
  action?: string | null
  title?: string | null
  body?: string | null
  /** The module that emitted the event, e.g. "sales", "finance", "dms". */
  source_module?: string | null
  actor_id?: number | null
  actor_type?: ActorType | string | null
  /** Link back to the originating record, e.g. ("payment", 42). */
  ref_type?: string | null
  ref_id?: string | number | null
  occurred_at?: string | Date | null
  visibility?: ActivityVisibility | string | null
  importance?: number | null
  /** Actor ids allowed to see a "private" event, in addition to actor_id. */
  watchers?: Array<number | string> | null
  meta?: Record<string, any> | null
}

/** A normalized event as stored / returned by the timeline. */
export type ActivityEvent = {
  id?: number
  activity_code?: string
  kind: ActivityKind
  subject_type: string
  subject_id: string
  subject_label: string | null
  action: string | null
  title: string
  body: string | null
  source_module: string | null
  actor_id: number | null
  actor_type: ActorType
  ref_type: string | null
  ref_id: string | null
  occurred_at: string
  visibility: ActivityVisibility
  importance: number
  watchers: number[]
  meta: Record<string, any> | null
}

// ---------------------------------------------------------------------------
// Normalization helpers
// ---------------------------------------------------------------------------

function str(value: unknown, max: number): string | null {
  const s = String(value ?? "").trim()
  if (!s) return null
  return s.length > max ? s.slice(0, max) : s
}

function subjectKey(value: unknown): string {
  return String(value ?? "").trim()
}

/** Coerce to a `YYYY-MM-DD HH:MM:SS`(.mmm) UTC timestamp for stable ordering. */
export function toTimestamp(value: unknown, now: Date = new Date()): string {
  let d: Date
  if (value instanceof Date) d = value
  else if (value == null || value === "") d = now
  else {
    const parsed = new Date(String(value))
    d = Number.isNaN(parsed.getTime()) ? now : parsed
  }
  return d.toISOString().slice(0, 23).replace("T", " ")
}

function normalizeActorType(value: unknown): ActorType {
  const v = String(value ?? "").trim().toLowerCase()
  return (ACTOR_TYPES as readonly string[]).includes(v) ? (v as ActorType) : "user"
}

function normalizeVisibility(value: unknown): ActivityVisibility {
  const v = String(value ?? "").trim().toLowerCase()
  return (ACTIVITY_VISIBILITIES as readonly string[]).includes(v) ? (v as ActivityVisibility) : "timeline"
}

function normalizeWatchers(value: unknown): number[] {
  if (!Array.isArray(value)) return []
  const out = new Set<number>()
  for (const item of value) {
    const n = Number(item)
    if (Number.isSafeInteger(n) && n > 0) out.add(n)
  }
  return [...out]
}

function normalizeImportance(value: unknown): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return 0
  return Math.max(0, Math.min(3, Math.trunc(n)))
}

function intOrNull(value: unknown): number | null {
  const n = Number(value)
  return Number.isSafeInteger(n) && n > 0 ? n : null
}

/** A default human title when a caller only supplies an action/subject. */
export function defaultActivityTitle(input: {
  kind?: unknown
  action?: unknown
  subject_type?: unknown
  subject_label?: unknown
}): string {
  const kind = isActivityKind(input.kind) ? input.kind : "system"
  const label = String(input.subject_label ?? "").trim() || String(input.subject_type ?? "record").trim()
  const action = String(input.action ?? "").trim()
  const kindWord = kind.replace(/_/g, " ")
  if (action) return `${label}: ${action}`.slice(0, ACTIVITY_TITLE_MAX)
  return `${kindWord} on ${label}`.slice(0, ACTIVITY_TITLE_MAX)
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Return a map of field -> message. Empty means valid. */
export function validateActivity(input: ActivityEventInput): Record<string, string> {
  const errors: Record<string, string> = {}
  if (!isActivityKind(input.kind)) errors.kind = "Unknown activity kind"
  if (!subjectKey(input.subject_type)) errors.subject_type = "subject_type is required"
  if (!subjectKey(input.subject_id)) errors.subject_id = "subject_id is required"
  if (!str(input.title, ACTIVITY_TITLE_MAX) && !str(input.action, ACTIVITY_TITLE_MAX)) {
    errors.title = "A title or action is required"
  }
  if (input.meta != null && !isPlainSerializable(input.meta)) {
    errors.meta = "meta must be a JSON object"
  }
  return errors
}

function isPlainSerializable(value: unknown): boolean {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return false
  try {
    JSON.stringify(value)
    return true
  } catch {
    return false
  }
}

/**
 * Build a fully-normalized event from arbitrary input. Throws
 * ActivityValidationError when invalid so callers never persist garbage. The
 * derived title and occurred_at are computed here so they can never be spoofed.
 */
export function buildActivityEvent(input: ActivityEventInput, now: Date = new Date()): ActivityEvent {
  const errors = validateActivity(input)
  if (Object.keys(errors).length > 0) throw new ActivityValidationError(errors)

  const action = str(input.action, ACTIVITY_TITLE_MAX)
  const title =
    str(input.title, ACTIVITY_TITLE_MAX) ??
    defaultActivityTitle({
      kind: input.kind,
      action,
      subject_type: input.subject_type,
      subject_label: input.subject_label,
    })

  return {
    kind: input.kind as ActivityKind,
    subject_type: subjectKey(input.subject_type).slice(0, 60),
    subject_id: subjectKey(input.subject_id).slice(0, 64),
    subject_label: str(input.subject_label, 190),
    action,
    title,
    body: str(input.body, ACTIVITY_BODY_MAX),
    source_module: str(input.source_module, 60),
    actor_id: intOrNull(input.actor_id),
    actor_type: normalizeActorType(input.actor_type),
    ref_type: str(input.ref_type, 60),
    ref_id: input.ref_id == null ? null : subjectKey(input.ref_id).slice(0, 64),
    occurred_at: toTimestamp(input.occurred_at, now),
    visibility: normalizeVisibility(input.visibility),
    importance: normalizeImportance(input.importance),
    watchers: normalizeWatchers(input.watchers),
    meta: input.meta && isPlainSerializable(input.meta) ? input.meta : null,
  }
}

// ---------------------------------------------------------------------------
// Ordering (Phase 4: deterministic newest-first ordering)
// ---------------------------------------------------------------------------

/**
 * Compare two events for a newest-first timeline. Primary key is occurred_at
 * (descending); ties break on id (descending) so ordering is TOTAL and STABLE
 * even when many events share a timestamp — this is exactly the (occurred_at,
 * id) keyset the DB index and cursor use, so client and server agree.
 */
export function compareActivityDesc(
  a: Pick<ActivityEvent, "occurred_at" | "id">,
  b: Pick<ActivityEvent, "occurred_at" | "id">,
): number {
  if (a.occurred_at < b.occurred_at) return 1
  if (a.occurred_at > b.occurred_at) return -1
  const ai = a.id ?? 0
  const bi = b.id ?? 0
  if (ai < bi) return 1
  if (ai > bi) return -1
  return 0
}

export function sortTimeline<T extends Pick<ActivityEvent, "occurred_at" | "id">>(events: readonly T[]): T[] {
  return [...events].sort(compareActivityDesc)
}

// ---------------------------------------------------------------------------
// Keyset pagination (Phase 4: performance — no OFFSET scans)
// ---------------------------------------------------------------------------

export type TimelineCursor = { occurredAt: string; id: number }

/** Opaque, URL-safe cursor encoding the last (occurred_at, id) seen. */
export function encodeCursor(cursor: TimelineCursor): string {
  const json = JSON.stringify([cursor.occurredAt, cursor.id])
  return Buffer.from(json, "utf8").toString("base64url")
}

export function decodeCursor(value: unknown): TimelineCursor | null {
  const raw = String(value ?? "").trim()
  if (!raw) return null
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"))
    if (!Array.isArray(parsed) || parsed.length !== 2) return null
    const occurredAt = String(parsed[0])
    const id = Number(parsed[1])
    if (!occurredAt || !Number.isSafeInteger(id) || id < 0) return null
    return { occurredAt, id }
  } catch {
    return null
  }
}

/** Clamp a caller-supplied page size into the allowed range. */
export function clampLimit(value: unknown): number {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return TIMELINE_DEFAULT_LIMIT
  return Math.min(TIMELINE_MAX_LIMIT, Math.max(1, Math.trunc(n)))
}

/**
 * Pure keyset paginator over an already newest-first-sorted array. Returns a
 * page plus the cursor to fetch the next one (null when exhausted). Used by the
 * data layer and mirrored in tests to prove page boundaries are stable and
 * never drop or duplicate rows.
 */
export function paginateTimeline<T extends Pick<ActivityEvent, "occurred_at" | "id">>(
  sorted: readonly T[],
  limit: number,
  cursor: TimelineCursor | null = null,
): { page: T[]; nextCursor: string | null } {
  const size = clampLimit(limit)
  let start = 0
  if (cursor) {
    start = sorted.findIndex(
      (e) =>
        e.occurred_at < cursor.occurredAt ||
        (e.occurred_at === cursor.occurredAt && (e.id ?? 0) < cursor.id),
    )
    if (start === -1) return { page: [], nextCursor: null }
  }
  const page = sorted.slice(start, start + size)
  const last = page[page.length - 1]
  const hasMore = start + size < sorted.length
  const nextCursor =
    hasMore && last ? encodeCursor({ occurredAt: last.occurred_at, id: last.id ?? 0 }) : null
  return { page, nextCursor }
}

// ---------------------------------------------------------------------------
// Permissions (Phase 4: who may see which events)
// ---------------------------------------------------------------------------

export type ActivityViewer = {
  userId: number
  role: string
  /** Feature slugs granted to the viewer. */
  features?: Iterable<string>
  /** True for external / portal / customer-facing accounts. */
  isPortal?: boolean
}

function viewerFeatures(viewer: ActivityViewer): Set<string> {
  return viewer.features instanceof Set ? viewer.features : new Set(viewer.features ?? [])
}

/**
 * The single authoritative visibility predicate. Applied on the server as the
 * final filter (defense in depth on top of the DB's cheap pre-filters) and in
 * the browser for optimistic rendering, so both agree. Rules, in order:
 *
 *   1. admins see everything;
 *   2. "private" events are visible only to the actor or a named watcher;
 *   3. "internal" events are hidden from portal / customer viewers;
 *   4. sensitive kinds (payment, approval) require their module feature;
 *   5. otherwise visible.
 */
export function canViewActivity(
  event: Pick<ActivityEvent, "kind" | "visibility" | "actor_id" | "watchers">,
  viewer: ActivityViewer,
): boolean {
  if (viewer.role === "admin") return true

  const visibility = normalizeVisibility(event.visibility)
  if (visibility === "private") {
    const watchers = Array.isArray(event.watchers) ? event.watchers : []
    if (event.actor_id !== viewer.userId && !watchers.includes(viewer.userId)) return false
  }
  if (visibility === "internal" && viewer.isPortal) return false

  const required = ACTIVITY_KIND_FEATURE[event.kind as ActivityKind]
  if (required && !viewerFeatures(viewer).has(required)) return false

  return true
}

export function filterVisibleActivities<
  T extends Pick<ActivityEvent, "kind" | "visibility" | "actor_id" | "watchers">,
>(events: readonly T[], viewer: ActivityViewer): T[] {
  return events.filter((e) => canViewActivity(e, viewer))
}

/**
 * Kinds a viewer is categorically allowed to read (before per-event checks).
 * Used by the data layer to push a cheap `kind IN (...)` pre-filter to the DB
 * so restricted kinds never leave the database for viewers who can't see them.
 */
export function allowedKindsFor(viewer: ActivityViewer): ActivityKind[] {
  if (viewer.role === "admin") return [...ACTIVITY_KINDS]
  const features = viewerFeatures(viewer)
  return ACTIVITY_KINDS.filter((kind) => {
    const required = ACTIVITY_KIND_FEATURE[kind]
    return !required || features.has(required)
  })
}

/** Highest visibility level a viewer may read (for the DB pre-filter). */
export function maxVisibilityRankFor(viewer: ActivityViewer): number {
  if (viewer.role === "admin") return VISIBILITY_RANK.private
  return viewer.isPortal ? VISIBILITY_RANK.timeline : VISIBILITY_RANK.internal
}

export function visibilityRank(visibility: ActivityVisibility): number {
  return VISIBILITY_RANK[normalizeVisibility(visibility)]
}
