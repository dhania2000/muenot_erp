/**
 * SPEC 85 — bulk-action execution core.
 *
 * Pure with respect to persistence: given a resource definition, a request and
 * an actor context, it loads the records, validates each one's permission,
 * applies the action with bounded concurrency, and produces a partial-success
 * report. It never touches the queue, audit log, or idempotency store — those
 * are the service layer's job — which keeps this logic unit-testable with an
 * in-memory resource.
 */
import {
  BULK_CONCURRENCY,
  type BulkActionDef,
  type BulkActionKind,
  type BulkActorContext,
  type BulkActionReport,
  type BulkExportArtifact,
  type BulkRecordResult,
  type BulkResourceDef,
} from "./types"

export class BulkActionError extends Error {
  constructor(
    message: string,
    readonly status: number = 400,
  ) {
    super(message)
    this.name = "BulkActionError"
  }
}

/** Resolve and validate the action definition for a resource. */
export function resolveAction<Rec>(
  resource: BulkResourceDef<Rec>,
  action: BulkActionKind,
): BulkActionDef<Rec> {
  const def = resource.actions[action]
  if (!def) {
    throw new BulkActionError(
      `Action "${action}" is not supported for ${resource.plural}.`,
      422,
    )
  }
  return def as BulkActionDef<Rec>
}

/** Parse the client value for an action, defaulting to an empty object. */
export function parseActionValue<Rec>(def: BulkActionDef<Rec>, raw: unknown): any {
  if (!def.parseValue) return raw ?? {}
  try {
    return def.parseValue(raw)
  } catch (error) {
    throw new BulkActionError(
      error instanceof Error ? error.message : "Invalid value for this action.",
      422,
    )
  }
}

/** De-duplicate, coerce to positive integers, and preserve submission order. */
export function normalizeIds(ids: unknown): number[] {
  if (!Array.isArray(ids)) return []
  const seen = new Set<number>()
  const out: number[] = []
  for (const raw of ids) {
    const n = Number(raw)
    if (!Number.isInteger(n) || n <= 0 || seen.has(n)) continue
    seen.add(n)
    out.push(n)
  }
  return out
}

async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0
  const size = Math.max(1, Math.min(limit, items.length))
  const runners = Array.from({ length: size }, async () => {
    while (cursor < items.length) {
      const item = items[cursor++]
      await worker(item)
    }
  })
  await Promise.all(runners)
}

export type ExecuteHooks = {
  /** Invoked after each record settles, for progress persistence. */
  onProgress?: (processed: number, total: number) => void | Promise<void>
  /** Cooperative cancellation for long background runs. */
  signal?: AbortSignal
}

/**
 * Execute one bulk action across a batch. Every id yields exactly one result:
 * ids not returned by `load` are skipped ("not found or access denied"),
 * records failing `permit` are skipped with the returned reason, records whose
 * `apply` throws are failed with the error message, and the rest succeed.
 */
export async function executeBulkAction<Rec>(
  resource: BulkResourceDef<Rec>,
  input: { action: BulkActionKind; ids: number[]; value?: unknown },
  ctx: BulkActorContext,
  hooks: ExecuteHooks = {},
): Promise<BulkActionReport> {
  const def = resolveAction(resource, input.action)
  const value = parseActionValue(def, input.value)
  const ids = input.ids

  const records = await resource.load(ids, ctx)
  const byId = new Map<number, Rec>()
  for (const record of records) byId.set(resource.idOf(record), record)

  const results: BulkRecordResult[] = []
  const exportRows: Record<string, unknown>[] = []
  let processed = 0
  const total = ids.length

  const settle = async (result: BulkRecordResult) => {
    results.push(result)
    processed += 1
    if (hooks.onProgress) await hooks.onProgress(processed, total)
  }

  // Ids the actor cannot see never reach `apply`.
  const present: Rec[] = []
  for (const id of ids) {
    const record = byId.get(id)
    if (!record) {
      await settle({ id, outcome: "skipped", label: null, reason: "Not found or access denied" })
      continue
    }
    present.push(record)
  }

  await runWithConcurrency(present, BULK_CONCURRENCY, async (record) => {
    if (hooks.signal?.aborted) {
      await settle({
        id: resource.idOf(record),
        outcome: "skipped",
        label: resource.labelOf(record),
        reason: "Cancelled before processing",
      })
      return
    }
    const id = resource.idOf(record)
    const label = resource.labelOf(record)
    const permit = def.permit ? await def.permit(record, ctx, value) : true
    if (permit !== true) {
      await settle({ id, outcome: "skipped", label, reason: permit })
      return
    }
    if (def.kind === "export" && def.toExportRow) {
      exportRows.push(def.toExportRow(record))
      await settle({ id, outcome: "succeeded", label, reason: null })
      return
    }
    try {
      await def.apply(record, ctx, value)
      await settle({ id, outcome: "succeeded", label, reason: null })
    } catch (error) {
      await settle({
        id,
        outcome: "failed",
        label,
        reason: error instanceof Error ? error.message : "Operation failed",
      })
    }
  })

  const report: BulkActionReport = {
    resource: resource.key,
    action: input.action,
    total,
    succeeded: results.filter((r) => r.outcome === "succeeded").length,
    failed: results.filter((r) => r.outcome === "failed").length,
    skipped: results.filter((r) => r.outcome === "skipped").length,
    results,
  }

  if (def.kind === "export") {
    report.export = buildCsvArtifact(resource, exportRows)
  }
  return report
}

function csvCell(value: unknown): string {
  if (value == null) return ""
  const s = typeof value === "object" ? JSON.stringify(value) : String(value)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

function buildCsvArtifact<Rec>(
  resource: BulkResourceDef<Rec>,
  rows: Record<string, unknown>[],
): BulkExportArtifact {
  const headers = rows.length ? Object.keys(rows[0]) : []
  const lines = [headers.map(csvCell).join(",")]
  for (const row of rows) lines.push(headers.map((h) => csvCell(row[h])).join(","))
  return {
    filename: `${resource.key.replace(/\./g, "-")}-export.csv`,
    mimeType: "text/csv",
    content: lines.join("\n"),
  }
}

/** Compact one-line summary for toasts / audit metadata. */
export function summarizeReport(report: BulkActionReport): string {
  const parts = [`${report.succeeded} succeeded`]
  if (report.failed) parts.push(`${report.failed} failed`)
  if (report.skipped) parts.push(`${report.skipped} skipped`)
  return parts.join(", ")
}
