import type { SessionPayload } from "@/lib/auth"

/**
 * SPEC 85 — Generic bulk-action engine.
 * ---------------------------------------------------------------------------
 * A single reusable framework any module can register a resource with to gain
 * multi-record operations (edit, assign, approve/reject, archive, delete,
 * export, email, tag, change status) with a uniform contract:
 *   - per-record permission validation (RBAC scope + ABAC restriction)
 *   - confirmation for destructive actions (enforced in the UI layer)
 *   - background processing + progress for large batches
 *   - partial-success reporting with a per-record error report
 *   - immutable audit-log entries
 *   - idempotent replays (a retried submission never double-applies)
 *
 * This module is deliberately DB-agnostic: the engine operates purely on a
 * resource definition, so its batching / permission / partial-failure logic is
 * unit-testable with an in-memory resource. All persistence (runs, idempotency,
 * audit, background enqueue) lives in service.ts / runs-store.ts.
 */

/** The catalog of first-class bulk operations a resource may support. */
export const BULK_ACTION_KINDS = [
  "edit",
  "assign",
  "approve",
  "reject",
  "archive",
  "restore",
  "delete",
  "export",
  "email",
  "tag",
  "set_status",
] as const

export type BulkActionKind = (typeof BULK_ACTION_KINDS)[number]

/** Actor + tenant context resolved once per request and threaded through. */
export type BulkActorContext = {
  tenantId: number
  session: SessionPayload
}

export type BulkRecordOutcome = "succeeded" | "failed" | "skipped"

/** The result of applying an action to one record. */
export type BulkRecordResult = {
  id: number
  outcome: BulkRecordOutcome
  label: string | null
  /** Human-readable reason a record was skipped or failed. */
  reason: string | null
}

/** Optional artifact produced by an action (currently only export). */
export type BulkExportArtifact = {
  filename: string
  mimeType: string
  content: string
}

/** The full outcome of a bulk run. */
export type BulkActionReport = {
  resource: string
  action: BulkActionKind
  total: number
  succeeded: number
  failed: number
  skipped: number
  results: BulkRecordResult[]
  export?: BulkExportArtifact | null
}

/**
 * The value payload an action operates with — e.g. `{ status: "Qualified" }`
 * for set_status, `{ assignee: 42 }` for assign, `{ tags: ["vip"] }` for tag.
 * Validated per-action by `parseValue`.
 */
export type BulkActionValue = Record<string, unknown>

/**
 * A single record's permission verdict. `true` allows the action; a string is
 * the reason the record is skipped (surfaced in the report / error export).
 */
export type PermitResult = true | string

export type BulkActionDef<Rec = Record<string, unknown>, Value = BulkActionValue> = {
  kind: BulkActionKind
  /** Short imperative label shown in the action menu, e.g. "Change status". */
  label: string
  /** Destructive actions require an explicit confirmation in the UI. */
  destructive?: boolean
  /** Whether the action needs a value (assignee, status, tag, ...). */
  requiresValue?: boolean
  /** Parse & validate the raw client value; throw on invalid input. */
  parseValue?: (raw: unknown) => Value
  /**
   * Per-record permission check. Runs AFTER the coarse feature gate and record
   * load, so the record is guaranteed to be visible to the actor. Return a
   * string to skip the record with that reason.
   */
  permit?: (record: Rec, ctx: BulkActorContext, value: Value) => Promise<PermitResult> | PermitResult
  /** Apply the action to a single record. Throw to mark the record failed. */
  apply: (record: Rec, ctx: BulkActorContext, value: Value) => Promise<void>
  /** Contribute a row to the export artifact instead of mutating (export only). */
  toExportRow?: (record: Rec) => Record<string, unknown>
}

export type BulkResourceDef<Rec = Record<string, unknown>> = {
  /** Stable registry key used in the API path, e.g. "sales.companies". */
  key: string
  label: string
  singular: string
  plural: string
  /** Feature slug the actor must hold to invoke ANY bulk action here. */
  feature: string
  /**
   * Load the requested records, already scoped to what the actor is allowed to
   * SEE (tenant + record-level scope). Ids the actor cannot see are simply
   * absent from the result and reported as skipped by the engine.
   */
  load: (ids: number[], ctx: BulkActorContext) => Promise<Rec[]>
  idOf: (record: Rec) => number
  labelOf: (record: Rec) => string
  actions: Partial<Record<BulkActionKind, BulkActionDef<Rec, any>>>
}

/** A submission handed to the engine/service. */
export type BulkActionRequest = {
  action: BulkActionKind
  ids: number[]
  value?: unknown
  /** Idempotency key so a retried submission returns the original outcome. */
  idempotencyKey?: string
}

/** Batches larger than this run in the durable background queue. */
export const BULK_SYNC_THRESHOLD = 50
/** Hard ceiling on ids accepted in a single submission. */
export const BULK_MAX_IDS = 10_000
/** Concurrency used while applying an action across a batch. */
export const BULK_CONCURRENCY = 8
