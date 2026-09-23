import "server-only"
/**
 * SPEC 85 — bulk-action orchestration.
 *
 * Ties the pure engine to the platform: resolves the resource from the
 * registry, enforces the feature gate, records a durable run (with idempotent
 * replay), decides synchronous vs. background execution by batch size, writes
 * an immutable audit entry, and reports progress. Small batches run inline and
 * return the full report; large batches enqueue a `bulk.action` job and return
 * the run id for progress polling.
 */
import type { SessionPayload } from "@/lib/auth"
import { userHasFeature } from "@/lib/permissions"
import { recordAuditLog, type AuditContext } from "@/lib/audit-log-store"
import {
  BULK_MAX_IDS,
  BULK_SYNC_THRESHOLD,
  type BulkActionKind,
  type BulkActionReport,
  type BulkActorContext,
} from "./types"
import { BulkActionError, executeBulkAction, normalizeIds, parseActionValue, resolveAction, summarizeReport } from "./engine"
import { getResource } from "./registry"
import {
  completeBulkRun,
  createBulkRun,
  failBulkRun,
  getBulkRun,
  markBulkRunRunning,
  updateBulkRunProgress,
  type BulkRun,
} from "./runs-store"

export type SubmitBulkActionInput = {
  resourceKey: string
  action: BulkActionKind
  ids: unknown
  value?: unknown
  idempotencyKey?: string
}

export type SubmitBulkActionResult =
  | { mode: "completed"; run: BulkRun; report: BulkActionReport }
  | { mode: "queued"; run: BulkRun }
  | { mode: "replayed"; run: BulkRun; report: BulkActionReport | null }

/**
 * Validate + dispatch a bulk submission. Throws BulkActionError (with an HTTP
 * status) on any client-side problem so the route can respond uniformly.
 */
export async function submitBulkAction(
  input: SubmitBulkActionInput,
  session: SessionPayload,
  auditContext?: AuditContext,
): Promise<SubmitBulkActionResult> {
  const tenantId = session.tenantId ?? 0
  if (!tenantId) throw new BulkActionError("No tenant in context.", 403)

  const resource = getResource(input.resourceKey)
  if (!resource) throw new BulkActionError(`Unknown resource "${input.resourceKey}".`, 404)

  // Coarse feature gate — the resource-wide permission.
  const allowed = await userHasFeature(session.userId, session.role, resource.feature)
  if (!allowed) throw new BulkActionError("You do not have permission for this action.", 403)

  const def = resolveAction(resource, input.action)
  const ids = normalizeIds(input.ids)
  if (ids.length === 0) throw new BulkActionError("Select at least one record.", 422)
  if (ids.length > BULK_MAX_IDS) throw new BulkActionError(`Too many records; the maximum is ${BULK_MAX_IDS}.`, 422)

  // Validate the value up front so a bad request fails before any run is stored.
  const value = parseActionValue(def, input.value)

  const ctx: BulkActorContext = { tenantId, session }
  const actor = {
    userId: session.userId,
    name: session.name ?? null,
    email: session.email ?? null,
    role: session.role,
  }

  // Export always runs inline (it must return the artifact to the caller).
  const runInline = def.kind === "export" || ids.length <= BULK_SYNC_THRESHOLD

  const { run, created } = await createBulkRun({
    tenantId,
    resourceKey: resource.key,
    action: input.action,
    actor,
    ids,
    value: value && typeof value === "object" ? (value as Record<string, unknown>) : null,
    idempotencyKey: input.idempotencyKey,
    status: runInline ? "running" : "queued",
  })

  // Idempotent replay: a prior submission with this key already exists.
  if (!created) {
    return { mode: "replayed", run, report: run.report }
  }

  if (!runInline) {
    const { enqueueBackgroundJob } = await import("@/lib/background-jobs")
    await enqueueBackgroundJob({
      jobType: "bulk.action",
      tenantId,
      payload: { runId: run.id },
      triggerSource: "user_request",
      createdBy: session.userId,
      idempotencyKey: `bulk-run-${run.id}`,
      timeoutSeconds: 900,
    })
    return { mode: "queued", run }
  }

  const report = await runAndFinalize(resource.key, run.id, ctx, auditContext)
  const finalRun = (await getBulkRun(run.id)) ?? run
  return { mode: "completed", run: finalRun, report }
}

/**
 * Execute a stored run to completion and finalize its status + audit entry.
 * Shared by the inline path and the background worker (which reconstructs the
 * actor context from the stored run — there is no live session there).
 */
export async function runAndFinalize(
  resourceKey: string,
  runId: number,
  ctx: BulkActorContext,
  auditContext?: AuditContext,
  signal?: AbortSignal,
): Promise<BulkActionReport> {
  const resource = getResource(resourceKey)
  if (!resource) throw new BulkActionError(`Unknown resource "${resourceKey}".`, 404)

  const run = await getBulkRun(runId)
  if (!run) throw new BulkActionError("Bulk run not found.", 404)
  await markBulkRunRunning(runId)

  // Persist progress at most ~every 2% so a large run doesn't hammer the DB.
  let lastPersistAt = 0
  const running = { succeeded: 0, failed: 0, skipped: 0 }

  try {
    const report = await executeBulkAction(
      resource,
      { action: run.action, ids: run.ids, value: run.value ?? undefined },
      ctx,
      {
        signal,
        onProgress: async (processed, total) => {
          // Recompute running counts from the latest result is expensive; the
          // engine appends sequentially, so re-derive lazily on throttled flush.
          const step = Math.max(1, Math.floor(total / 50))
          if (processed === total || processed - lastPersistAt >= step) {
            lastPersistAt = processed
            await updateBulkRunProgress(runId, {
              processed,
              succeeded: running.succeeded,
              failed: running.failed,
              skipped: running.skipped,
            }).catch(() => {})
          }
        },
      },
    )
    // Fill the running snapshot from the final report for the last flush.
    running.succeeded = report.succeeded
    running.failed = report.failed
    running.skipped = report.skipped

    await completeBulkRun(runId, report)
    await writeAudit(resource.key, run.action, report, run, auditContext)
    return report
  } catch (error) {
    const message = error instanceof Error ? error.message : "Bulk run failed"
    await failBulkRun(runId, message)
    await writeAudit(resource.key, run.action, null, run, auditContext, message)
    throw error
  }
}

async function writeAudit(
  resourceKey: string,
  action: BulkActionKind,
  report: BulkActionReport | null,
  run: BulkRun,
  auditContext: AuditContext | undefined,
  errorMessage?: string,
): Promise<void> {
  await recordAuditLog(
    {
      action: `${resourceKey}.bulk_${action}`,
      result: report ? (report.failed > 0 ? "failure" : "success") : "failure",
      entityType: resourceKey,
      entityId: String(run.id),
      entityLabel: `Bulk ${action} · ${run.total} selected`,
      metadata: report
        ? {
            summary: summarizeReport(report),
            total: report.total,
            succeeded: report.succeeded,
            failed: report.failed,
            skipped: report.skipped,
            runId: run.id,
          }
        : { runId: run.id, error: errorMessage ?? "unknown" },
      context: auditContext
        ? undefined
        : {
            // Background path: no request context — attribute to the stored actor.
            requestId: `bulk-run-${run.id}`,
            tenantId: run.tenantId,
            actorUserId: run.actor.userId,
            actorName: run.actor.name,
            actorEmail: run.actor.email,
            actorRole: run.actor.role,
            sessionId: null,
            ipAddress: null,
            userAgent: null,
          },
    },
    auditContext,
  )
}
