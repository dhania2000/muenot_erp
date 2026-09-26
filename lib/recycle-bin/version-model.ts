/**
 * SPEC 35 — Versioned sensitive edits with approval (pure, testable model).
 * ---------------------------------------------------------------------------
 * Sensitive edits are not applied to the live record directly. Instead a
 * VERSION captures the proposed values and travels through an approval workflow
 * before it can be PUBLISHED onto the record:
 *
 *     draft ──submit──▶ pending ──approve──▶ approved ──publish──▶ published
 *       │                  │
 *       └──────────────────┴── reject ──▶ rejected
 *
 * Two concurrency hazards are handled here, purely and deterministically:
 *
 *   1. STALE EDIT — a draft is created against a `baseVersionNo` (the published
 *      version the author saw). If the live record has advanced past that base
 *      by the time the draft is created OR published, the edit is stale and must
 *      not silently clobber the newer state.
 *
 *   2. CONCURRENT EDIT — two authors branch from the same base. The first to be
 *      published wins; the second is detected as stale at publish time (its base
 *      no longer equals the current published version) and is superseded rather
 *      than overwriting the winner.
 *
 * DB-free so it can be unit-tested in isolation and shared with the UI.
 */

export const RECORD_VERSION_STATUSES = [
  "draft",
  "pending",
  "approved",
  "published",
  "rejected",
  "superseded",
] as const
export type RecordVersionStatus = (typeof RECORD_VERSION_STATUSES)[number]

export function isRecordVersionStatus(value: unknown): value is RecordVersionStatus {
  return typeof value === "string" && (RECORD_VERSION_STATUSES as readonly string[]).includes(value)
}

export const RECORD_VERSION_LIMITS = {
  ENTITY_TYPE: 120,
  ENTITY_PK: 190,
  SUMMARY: 500,
  DECISION_NOTE: 500,
  /** Cap the serialized payload so a single row can't balloon the table. */
  PAYLOAD_BYTES: 256 * 1024,
} as const

function trimTo(value: unknown, max: number): string {
  return String(value ?? "").trim().slice(0, max)
}

// ---------------------------------------------------------------------------
// Sequencing
// ---------------------------------------------------------------------------

/** The next sequential version number for an entity (versions start at 1). */
export function nextVersionNo(currentMax: number | null | undefined): number {
  const n = Math.floor(Number(currentMax ?? 0))
  return (Number.isFinite(n) && n > 0 ? n : 0) + 1
}

// ---------------------------------------------------------------------------
// Draft input normalization
// ---------------------------------------------------------------------------

export type NormalizedVersionInput = {
  entityType: string
  entityPk: string
  baseVersionNo: number
  payload: Record<string, unknown>
  summary: string | null
}

/**
 * Validate and normalize a proposed version. Throws with a user-facing message
 * so the API can return a clean 400.
 */
export function normalizeVersionInput(input: {
  entityType?: unknown
  entityPk?: unknown
  baseVersionNo?: unknown
  payload?: unknown
  summary?: unknown
}): NormalizedVersionInput {
  const entityType = trimTo(input.entityType, RECORD_VERSION_LIMITS.ENTITY_TYPE)
  if (!entityType) throw new Error("An entity type is required")
  const entityPk = trimTo(input.entityPk, RECORD_VERSION_LIMITS.ENTITY_PK)
  if (!entityPk) throw new Error("An entity id is required")

  if (input.payload == null || typeof input.payload !== "object" || Array.isArray(input.payload)) {
    throw new Error("A payload object of proposed changes is required")
  }
  const payload = input.payload as Record<string, unknown>
  if (Object.keys(payload).length === 0) throw new Error("The payload must contain at least one changed field")
  const serialized = JSON.stringify(payload)
  if (serialized.length > RECORD_VERSION_LIMITS.PAYLOAD_BYTES) throw new Error("The proposed changes are too large")

  const baseRaw = Math.floor(Number(input.baseVersionNo ?? 0))
  const baseVersionNo = Number.isFinite(baseRaw) && baseRaw > 0 ? baseRaw : 0

  const summary = trimTo(input.summary, RECORD_VERSION_LIMITS.SUMMARY) || null

  return { entityType, entityPk, baseVersionNo, payload, summary }
}

// ---------------------------------------------------------------------------
// Staleness / concurrency
// ---------------------------------------------------------------------------

/**
 * Is an edit based on `baseVersionNo` stale relative to the current published
 * version? An edit is stale when a newer version has been published since the
 * author branched (currentPublished > base). base 0 means "new record / no
 * published baseline" and is never stale.
 */
export function isEditStale(baseVersionNo: number, currentPublishedVersionNo: number): boolean {
  if (!baseVersionNo || baseVersionNo <= 0) return false
  return currentPublishedVersionNo > baseVersionNo
}

// ---------------------------------------------------------------------------
// Status transitions
// ---------------------------------------------------------------------------

export type VersionTransition = "submit" | "approve" | "reject" | "publish"

const ALLOWED_FROM: Record<VersionTransition, RecordVersionStatus[]> = {
  submit: ["draft"],
  approve: ["pending"],
  reject: ["draft", "pending", "approved"],
  publish: ["approved"],
}

const NEXT_STATUS: Record<VersionTransition, RecordVersionStatus> = {
  submit: "pending",
  approve: "approved",
  reject: "rejected",
  publish: "published",
}

export type TransitionDecision =
  | { ok: true; next: RecordVersionStatus }
  | { ok: false; code: TransitionDenyCode; message: string; status: number }

export type TransitionDenyCode = "WRONG_STATUS" | "STALE" | "SELF_APPROVAL"

export type TransitionContext = {
  /** The current version's own status. */
  status: RecordVersionStatus
  /** The version this edit was based on. */
  baseVersionNo: number
  /** The record's current published version number (live baseline). */
  currentPublishedVersionNo: number
  /** Who authored the version. */
  createdBy: number
  /** Who is performing the transition. */
  actorUserId: number
  /** When true (default), an approver may not approve their own version. */
  enforceSegregation?: boolean
}

/**
 * The single authoritative gate for advancing a version through its workflow.
 *
 * `publish` additionally re-checks staleness against the LIVE published version:
 * this is where a concurrent edit that lost the race is caught and reported as
 * STALE instead of being allowed to clobber the winner.
 */
export function evaluateTransition(t: VersionTransition, ctx: TransitionContext): TransitionDecision {
  if (!ALLOWED_FROM[t].includes(ctx.status)) {
    return {
      ok: false,
      code: "WRONG_STATUS",
      message: `Cannot ${t} a version that is ${ctx.status}`,
      status: 409,
    }
  }
  // Segregation of duties: the author cannot approve their own sensitive edit.
  if (t === "approve" && (ctx.enforceSegregation ?? true) && ctx.actorUserId === ctx.createdBy) {
    return {
      ok: false,
      code: "SELF_APPROVAL",
      message: "You cannot approve your own change; another approver is required",
      status: 403,
    }
  }
  if (t === "publish" && isEditStale(ctx.baseVersionNo, ctx.currentPublishedVersionNo)) {
    return {
      ok: false,
      code: "STALE",
      message: "A newer version has been published since this change was proposed; it is now stale",
      status: 409,
    }
  }
  return { ok: true, next: NEXT_STATUS[t] }
}

/** Normalize a decision note (approve/reject) for storage. */
export function normalizeDecisionNote(value: unknown): string | null {
  return trimTo(value, RECORD_VERSION_LIMITS.DECISION_NOTE) || null
}
