/**
 * Spec16 — Integration sync & conflict resolution: PURE model (#90-91).
 * ---------------------------------------------------------------------------
 * DB-free, network-free core so every rule below is unit-testable in isolation:
 *
 *   • stable fingerprinting used to detect real changes (order-independent);
 *   • opaque, versioned CURSORS + stale-cursor detection so a resumed or
 *     replayed run never silently skips or reprocesses a window;
 *   • bounded RETRY + exponential BACKOFF with jitter caps;
 *   • three-way CHANGE CLASSIFICATION (external-only / local-only / both) that
 *     is the heart of conflict detection, plus the ERP-wins / external-wins /
 *     manual-merge RESOLUTION function;
 *   • deterministic idempotency / replay keys so the same provider record can
 *     be applied at-most-once even across duplicated runs.
 *
 * The store (lib/integration-sync/store.ts) persists these decisions; the
 * provider registry (lib/integration-sync/providers.ts) turns raw provider
 * payloads into the NormalizedRecord shape these rules operate on.
 */

// ---------------------------------------------------------------------------
// Shared shapes
// ---------------------------------------------------------------------------

export type SyncMode = "initial" | "incremental"
export type RunStatus = "pending" | "running" | "succeeded" | "failed" | "partial"
export type ConflictResolution = "erp_wins" | "external_wins" | "manual"
export type MappingStatus = "active" | "conflict" | "archived"

/** A raw record as returned by a provider page, after light shaping. */
export type ProviderRecord = {
  /** Stable id in the provider's namespace. Required. */
  externalId: string
  /** Provider version marker (etag / updatedAt / rev). Optional. */
  version?: string | number | null
  /** The normalized business fields (already mapped to a master shape). */
  normalized: NormalizedRecord
  /** Provider tombstone — the record was deleted upstream. */
  deleted?: boolean
}

/** The normalized master shape written into tenant master data. */
export type NormalizedRecord = {
  code: string
  name: string
  active: boolean
  parent?: string | null
  meta?: Record<string, unknown>
}

/** One page returned by a provider fetch. */
export type ProviderPage = {
  records: ProviderRecord[]
  /** Opaque provider position to resume after this page; null when exhausted. */
  nextCursor: string | null
  hasMore: boolean
}

export const SYNC_LIMITS = {
  /** Total attempts (initial try + retries) for one run. */
  maxAttempts: 5,
  baseBackoffSeconds: 30,
  maxBackoffSeconds: 3600,
  defaultPageSize: 100,
  maxPageSize: 500,
  /** Hard cap on pages processed in a single run so a run always terminates. */
  maxPagesPerRun: 5000,
} as const

export class SyncError extends Error {
  constructor(
    message: string,
    readonly kind: "outage" | "stale_cursor" | "validation" | "config" = "validation",
  ) {
    super(message)
    this.name = "SyncError"
  }
}

// ---------------------------------------------------------------------------
// Fingerprinting (order-independent, stable)
// ---------------------------------------------------------------------------

/** Canonical JSON with object keys sorted recursively, so key order never
 * changes the fingerprint. Arrays keep their order (it is significant). */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null"
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`
  const keys = Object.keys(value as Record<string, unknown>).sort()
  const body = keys
    .map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`)
    .join(",")
  return `{${body}}`
}

/** FNV-1a 32-bit over the canonical string, hex-encoded. Deterministic and
 * dependency-free — enough to detect a changed record, not a security hash. */
export function fingerprint(value: unknown): string {
  const str = stableStringify(value)
  let hash = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, "0")
}

/** Fingerprint only the business-meaningful fields of a normalized record, so
 * cosmetic differences in unrelated meta ordering do not create false diffs. */
export function fingerprintNormalized(record: NormalizedRecord): string {
  return fingerprint({
    code: record.code,
    name: record.name,
    active: record.active,
    parent: record.parent ?? null,
    meta: record.meta ?? {},
  })
}

// ---------------------------------------------------------------------------
// Cursors + stale detection
// ---------------------------------------------------------------------------

export type Cursor = {
  /** Opaque provider position (page token, high-water timestamp, id…). */
  position: string | null
  /** Monotonic page counter within the current sync sequence. */
  page: number
  /** Generation tag bumped whenever the connection resets its baseline. Lets us
   * reject a cursor minted before a reset (a "stale" cursor). */
  generation: number
}

export function emptyCursor(generation = 0): Cursor {
  return { position: null, page: 0, generation }
}

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url")
}

export function decodeCursor(raw: string | null | undefined): Cursor | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"))
    if (typeof parsed !== "object" || parsed === null) return null
    const page = Number((parsed as any).page)
    const generation = Number((parsed as any).generation)
    if (!Number.isFinite(page) || page < 0) return null
    return {
      position: (parsed as any).position ?? null,
      page: Math.floor(page),
      generation: Number.isFinite(generation) ? Math.floor(generation) : 0,
    }
  } catch {
    return null
  }
}

export function advanceCursor(cursor: Cursor, page: ProviderPage): Cursor {
  return { position: page.nextCursor, page: cursor.page + 1, generation: cursor.generation }
}

/**
 * A requested cursor is STALE when it cannot be trusted to resume the current
 * baseline: it fails to decode, or it belongs to an older generation than the
 * connection's. A stale cursor must trigger a safe restart from the connection
 * baseline rather than blindly resuming — otherwise a window is skipped.
 */
export function isStaleCursor(requested: string | null | undefined, currentGeneration: number): boolean {
  if (requested == null || requested === "") return false // no cursor = fresh start, not stale
  const decoded = decodeCursor(requested)
  if (!decoded) return true
  return decoded.generation !== currentGeneration
}

// ---------------------------------------------------------------------------
// Retry + backoff
// ---------------------------------------------------------------------------

export function shouldRetry(attempt: number, maxAttempts = SYNC_LIMITS.maxAttempts): boolean {
  return attempt < maxAttempts
}

/** Exponential backoff (base * 2^(attempt-1)) capped, with deterministic
 * +/-10% jitter derived from the attempt so tests stay reproducible. */
export function backoffSeconds(
  attempt: number,
  base = SYNC_LIMITS.baseBackoffSeconds,
  max = SYNC_LIMITS.maxBackoffSeconds,
): number {
  const raw = base * Math.pow(2, Math.max(0, attempt - 1))
  const capped = Math.min(raw, max)
  const jitterFactor = 1 + ((attempt % 3) - 1) * 0.1 // -10%, 0, +10% cycling
  return Math.max(1, Math.round(capped * jitterFactor))
}

export function clampPageSize(requested: unknown): number {
  const n = Number(requested)
  if (!Number.isFinite(n) || n <= 0) return SYNC_LIMITS.defaultPageSize
  return Math.min(SYNC_LIMITS.maxPageSize, Math.max(1, Math.floor(n)))
}

// ---------------------------------------------------------------------------
// Change classification (conflict detection core)
// ---------------------------------------------------------------------------

/** The baseline we recorded the last time this record was successfully synced. */
export type SyncBaseline = {
  externalFingerprint: string | null
  localFingerprint: string | null
}

export type ChangeClass =
  | "new" // never mapped before
  | "unchanged" // neither side moved since baseline
  | "external_only" // only the provider changed → safe to apply
  | "local_only" // only the ERP changed → keep ERP, refresh baseline
  | "both" // both moved → CONFLICT, needs resolution

/**
 * Compare the incoming external record and the current local record against the
 * recorded baseline to decide what kind of change (if any) occurred. This is a
 * pure three-way diff and is the single source of truth for conflict detection.
 *
 *   baseline == null                      → "new"
 *   ext moved && local moved              → "both"   (conflict)
 *   ext moved only                        → "external_only"
 *   local moved only                      → "local_only"
 *   neither moved                         → "unchanged"
 */
export function classifyChange(
  baseline: SyncBaseline | null,
  incomingExternalFp: string,
  currentLocalFp: string | null,
): ChangeClass {
  if (!baseline) return "new"
  const externalMoved = incomingExternalFp !== baseline.externalFingerprint
  const localMoved = currentLocalFp !== baseline.localFingerprint
  if (externalMoved && localMoved) return "both"
  if (externalMoved) return "external_only"
  if (localMoved) return "local_only"
  return "unchanged"
}

// ---------------------------------------------------------------------------
// Conflict resolution
// ---------------------------------------------------------------------------

export type ResolutionOutcome = {
  /** Whether the winning record must be written into master data. */
  writeMaster: boolean
  /** The record to persist (null when nothing is written, e.g. erp_wins). */
  record: NormalizedRecord | null
  /** The external fingerprint to store as the new baseline. */
  externalFingerprint: string
  /** The local fingerprint to store as the new baseline. */
  localFingerprint: string
}

/**
 * Apply a resolution strategy to a detected conflict and compute the resulting
 * master record plus the new baseline fingerprints. Pure: callers persist the
 * outcome.
 *
 *   erp_wins      → keep local unchanged; adopt the external fingerprint as the
 *                   new baseline so the same external edit does not re-conflict.
 *   external_wins → overwrite local with the external record.
 *   manual        → deep-merge local <- external <- caller patch; the patch is
 *                   the human decision and always wins field-by-field.
 */
export function resolveConflict(
  resolution: ConflictResolution,
  external: NormalizedRecord,
  local: NormalizedRecord | null,
  mergePatch?: Partial<NormalizedRecord> | null,
): ResolutionOutcome {
  const externalFp = fingerprintNormalized(external)

  if (resolution === "erp_wins") {
    if (!local) {
      // No local row to keep — degrade to accepting external so data is not lost.
      return { writeMaster: true, record: external, externalFingerprint: externalFp, localFingerprint: externalFp }
    }
    return {
      writeMaster: false,
      record: local,
      externalFingerprint: externalFp,
      localFingerprint: fingerprintNormalized(local),
    }
  }

  if (resolution === "external_wins") {
    return { writeMaster: true, record: external, externalFingerprint: externalFp, localFingerprint: externalFp }
  }

  // manual merge
  const base = local ?? external
  const merged: NormalizedRecord = {
    code: mergePatch?.code ?? base.code ?? external.code,
    name: mergePatch?.name ?? external.name,
    active: mergePatch?.active ?? external.active,
    parent: mergePatch?.parent ?? external.parent ?? base.parent ?? null,
    meta: { ...(base.meta ?? {}), ...(external.meta ?? {}), ...(mergePatch?.meta ?? {}) },
  }
  const mergedFp = fingerprintNormalized(merged)
  return { writeMaster: true, record: merged, externalFingerprint: externalFp, localFingerprint: mergedFp }
}

export function isValidResolution(value: unknown): value is ConflictResolution {
  return value === "erp_wins" || value === "external_wins" || value === "manual"
}

// ---------------------------------------------------------------------------
// Idempotency / replay keys
// ---------------------------------------------------------------------------

/** Deterministic key that collapses duplicate run requests for the same slot. */
export function runIdempotencyKey(input: {
  tenantId: number
  connectionId: number
  mode: SyncMode
  slot: string
}): string {
  return `sync-run:${input.tenantId}:${input.connectionId}:${input.mode}:${input.slot}`
}

/**
 * Per-record event key used to make the immutable sync log (and therefore
 * master writes) idempotent under replay. The external fingerprint is part of
 * the key so REPLAYING the same run applies each record at-most-once, while a
 * genuinely changed record (new fingerprint) is a distinct event.
 */
export function recordEventKey(input: {
  connectionId: number
  externalId: string
  externalFingerprint: string
}): string {
  return `${input.connectionId}:${input.externalId}:${input.externalFingerprint}`
}

/** Normalize a run status from per-record outcomes. */
export function summarizeRunStatus(counts: {
  errors: number
  conflicts: number
  processed: number
}): RunStatus {
  if (counts.errors > 0 && counts.processed === 0) return "failed"
  if (counts.errors > 0 || counts.conflicts > 0) return "partial"
  return "succeeded"
}
