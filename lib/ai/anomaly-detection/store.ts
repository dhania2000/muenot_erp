import "server-only"
/**
 * SPEC 20 (req #75) — tenant-scoped persistence for AI Anomaly Detection.
 * ---------------------------------------------------------------------------
 * The single place anomaly alerts, their review audit and scan runs are read
 * and written. Every statement goes through the tenant-scope helpers so it
 * carries a `tenant_id` predicate and satisfies the fail-closed guard — a
 * forged id can never reach another tenant's alert.
 *
 * Idempotency: a Finding's deterministic signature (model.deriveSignature) is
 * unique per (tenant, day-bucket). `upsertAlertFromFinding` therefore collapses
 * a repeated detection onto the existing row (bumping occurrence_count and, for
 * a still-open alert, refreshing the score/severity/evidence) instead of
 * creating a duplicate. It NEVER resurrects a human-triaged (dismissed/resolved)
 * alert — that would undo a person's decision automatically.
 */

import { query } from "@/lib/db"
import {
  currentTenantId,
  tenantInsert,
  tenantSelect,
  tenantUpdate,
  tenantFindById,
} from "@/lib/tenant-scope"
import {
  deriveSignature,
  isTerminal,
  normalizeSeverity,
  normalizeStatus,
  type AlertStatus,
  type AnomalyCategory,
  type AnomalySignal,
  type DetectionMethod,
  type Finding,
  type Severity,
} from "./model"

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

export type AlertRow = {
  id: number
  tenantId: number
  signal: AnomalySignal
  category: AnomalyCategory
  entityType: string
  entityId: string
  entityLabel: string | null
  severity: Severity
  score: number
  method: DetectionMethod
  status: AlertStatus
  title: string
  summary: string | null
  evidence: Record<string, unknown> | null
  occurredAt: string | null
  signature: string
  occurrenceCount: number
  firstSeenAt: string | null
  lastSeenAt: string | null
  ownerId: number | null
  resolutionNote: string | null
  reviewedBy: number | null
  reviewedAt: string | null
  createdAt: string | null
  updatedAt: string | null
}

export type ScanRow = {
  id: number
  tenantId: number
  status: "running" | "completed" | "failed"
  windowDays: number
  categories: string | null
  modelScoring: boolean
  findingsCount: number
  createdCount: number
  dedupedCount: number
  error: string | null
  triggeredBy: number | null
  startedAt: string | null
  finishedAt: string | null
}

function toIso(v: unknown): string | null {
  if (v == null) return null
  const d = v instanceof Date ? v : new Date(v as string)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

function parseJson(v: unknown): Record<string, unknown> | null {
  if (v == null) return null
  if (typeof v === "object") return v as Record<string, unknown>
  try {
    return JSON.parse(String(v))
  } catch {
    return null
  }
}

function mapAlert(r: any): AlertRow {
  return {
    id: Number(r.id),
    tenantId: Number(r.tenant_id),
    signal: r.signal,
    category: r.category,
    entityType: r.entity_type,
    entityId: String(r.entity_id),
    entityLabel: r.entity_label ?? null,
    severity: normalizeSeverity(r.severity),
    score: Number(r.score ?? 0),
    method: r.method === "model" ? "model" : "rule",
    status: normalizeStatus(r.status),
    title: r.title,
    summary: r.summary ?? null,
    evidence: parseJson(r.evidence_json),
    occurredAt: toIso(r.occurred_at),
    signature: r.signature,
    occurrenceCount: Number(r.occurrence_count ?? 1),
    firstSeenAt: toIso(r.first_seen_at),
    lastSeenAt: toIso(r.last_seen_at),
    ownerId: r.owner_id == null ? null : Number(r.owner_id),
    resolutionNote: r.resolution_note ?? null,
    reviewedBy: r.reviewed_by == null ? null : Number(r.reviewed_by),
    reviewedAt: toIso(r.reviewed_at),
    createdAt: toIso(r.created_at),
    updatedAt: toIso(r.updated_at),
  }
}

function mapScan(r: any): ScanRow {
  return {
    id: Number(r.id),
    tenantId: Number(r.tenant_id),
    status: r.status,
    windowDays: Number(r.window_days ?? 0),
    categories: r.categories ?? null,
    modelScoring: Boolean(r.model_scoring),
    findingsCount: Number(r.findings_count ?? 0),
    createdCount: Number(r.created_count ?? 0),
    dedupedCount: Number(r.deduped_count ?? 0),
    error: r.error ?? null,
    triggeredBy: r.triggered_by == null ? null : Number(r.triggered_by),
    startedAt: toIso(r.started_at),
    finishedAt: toIso(r.finished_at),
  }
}

/** Convert a business datetime string to a MySQL DATETIME (UTC) or null. */
function toMysqlDate(iso: string | null | undefined): string | null {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  return d.toISOString().slice(0, 19).replace("T", " ")
}

// ---------------------------------------------------------------------------
// Alerts — upsert (idempotent), list, get
// ---------------------------------------------------------------------------

export type UpsertResult = { alert: AlertRow; created: boolean; deduped: boolean }

/**
 * Persist a Finding as an alert, idempotently. Re-detecting the same anomaly
 * (same signature) bumps occurrence_count and refreshes the score/severity/
 * evidence for a still-open alert; a human-triaged (dismissed/resolved) alert
 * is left untouched apart from its occurrence bookkeeping.
 */
export async function upsertAlertFromFinding(finding: Finding): Promise<UpsertResult> {
  const tenantId = currentTenantId()
  const signature = deriveSignature({
    tenantId,
    signal: finding.signal,
    entityType: finding.entityType,
    entityId: finding.entityId,
    occurredAt: finding.occurredAt,
  })

  const existing = await findBySignature(signature)
  const occurredAt = toMysqlDate(finding.occurredAt)

  if (!existing) {
    const res = await tenantInsert("ai_anomaly_alerts", {
      signal: finding.signal,
      category: finding.category,
      entity_type: finding.entityType.slice(0, 60),
      entity_id: finding.entityId.slice(0, 120),
      entity_label: finding.entityLabel ? finding.entityLabel.slice(0, 255) : null,
      severity: finding.severity,
      score: finding.score,
      method: finding.method,
      status: "open",
      title: finding.title.slice(0, 255),
      summary: finding.summary ? finding.summary.slice(0, 1000) : null,
      evidence_json: JSON.stringify(finding.evidence ?? {}),
      occurred_at: occurredAt,
      signature,
      occurrence_count: 1,
    })
    const alert = await tenantFindById<any>("ai_anomaly_alerts", res.insertId)
    return { alert: mapAlert(alert), created: true, deduped: false }
  }

  // Re-detection. Always record we saw it again; refresh scoring only when the
  // alert has NOT been triaged by a human (never override a person's decision).
  const set: Record<string, any> = {
    occurrence_count: existing.occurrenceCount + 1,
    last_seen_at: new Date().toISOString().slice(0, 19).replace("T", " "),
  }
  if (!isTerminal(existing.status)) {
    set.score = finding.score
    set.severity = finding.severity
    set.method = finding.method
    set.title = finding.title.slice(0, 255)
    set.summary = finding.summary ? finding.summary.slice(0, 1000) : null
    set.evidence_json = JSON.stringify(finding.evidence ?? {})
  }
  await tenantUpdate("ai_anomaly_alerts", set, "`id` = ?", [existing.id])
  const alert = await tenantFindById<any>("ai_anomaly_alerts", existing.id)
  return { alert: mapAlert(alert), created: false, deduped: true }
}

export async function findBySignature(signature: string): Promise<AlertRow | null> {
  const rows = await tenantSelect<any[]>("ai_anomaly_alerts", {
    where: "`signature` = ?",
    params: [signature],
    tail: "LIMIT 1",
  })
  return rows[0] ? mapAlert(rows[0]) : null
}

export type AlertFilters = {
  status?: AlertStatus
  severity?: Severity
  category?: AnomalyCategory
  ownerId?: number
  limit?: number
  offset?: number
}

export async function listAlerts(filters: AlertFilters = {}): Promise<AlertRow[]> {
  const clauses: string[] = []
  const params: any[] = []
  if (filters.status) {
    clauses.push("`status` = ?")
    params.push(filters.status)
  }
  if (filters.severity) {
    clauses.push("`severity` = ?")
    params.push(filters.severity)
  }
  if (filters.category) {
    clauses.push("`category` = ?")
    params.push(filters.category)
  }
  if (filters.ownerId != null) {
    clauses.push("`owner_id` = ?")
    params.push(filters.ownerId)
  }
  const limit = Math.min(Math.max(Number(filters.limit ?? 100), 1), 200)
  const offset = Math.max(Number(filters.offset ?? 0), 0)
  const rows = await tenantSelect<any[]>("ai_anomaly_alerts", {
    where: clauses.join(" AND "),
    params,
    // Highest-risk, most-recent first; a stable secondary key keeps paging sane.
    tail: `ORDER BY FIELD(severity,'critical','high','medium','low'), score DESC, last_seen_at DESC, id DESC LIMIT ${limit} OFFSET ${offset}`,
  })
  return rows.map(mapAlert)
}

export async function countAlertsByStatus(): Promise<Record<string, number>> {
  const rows = await tenantSelect<any[]>("ai_anomaly_alerts", {
    columns: "status, COUNT(*) AS n",
    tail: "GROUP BY status",
  })
  const out: Record<string, number> = {}
  for (const r of rows) out[r.status] = Number(r.n ?? 0)
  return out
}

export async function getAlert(id: number): Promise<AlertRow | null> {
  const row = await tenantFindById<any>("ai_anomaly_alerts", id)
  return row ? mapAlert(row) : null
}

/**
 * Apply a human review decision. The status transition is validated by the
 * caller (service.reviewAlert via model.validateReview); this only persists it.
 */
export async function applyReview(
  id: number,
  patch: {
    status: AlertStatus
    ownerId?: number | null
    resolutionNote?: string | null
    reviewedBy: number
  },
): Promise<AlertRow | null> {
  const set: Record<string, any> = {
    status: patch.status,
    reviewed_by: patch.reviewedBy,
    reviewed_at: new Date().toISOString().slice(0, 19).replace("T", " "),
  }
  if (patch.ownerId !== undefined) set.owner_id = patch.ownerId
  if (patch.resolutionNote !== undefined) {
    set.resolution_note = patch.resolutionNote ? patch.resolutionNote.slice(0, 1000) : null
  }
  const affected = await tenantUpdate("ai_anomaly_alerts", set, "`id` = ?", [id])
  if (affected === 0) return null
  const row = await tenantFindById<any>("ai_anomaly_alerts", id)
  return row ? mapAlert(row) : null
}

// ---------------------------------------------------------------------------
// Audit — append only
// ---------------------------------------------------------------------------

export async function logAlertAudit(input: {
  alertId: number
  action: string
  detail?: string | null
  fromStatus?: AlertStatus | null
  toStatus?: AlertStatus | null
  userId?: number | null
}): Promise<void> {
  await tenantInsert("ai_anomaly_alert_audit", {
    alert_id: input.alertId,
    action: input.action.slice(0, 40),
    detail: input.detail ? String(input.detail).slice(0, 1000) : null,
    from_status: input.fromStatus ?? null,
    to_status: input.toStatus ?? null,
    user_id: input.userId ?? null,
  })
}

export async function listAlertAudit(alertId: number): Promise<
  { id: number; action: string; detail: string | null; fromStatus: string | null; toStatus: string | null; userId: number | null; createdAt: string | null }[]
> {
  const rows = await tenantSelect<any[]>("ai_anomaly_alert_audit", {
    where: "`alert_id` = ?",
    params: [alertId],
    tail: "ORDER BY id ASC",
  })
  return rows.map((r) => ({
    id: Number(r.id),
    action: r.action,
    detail: r.detail ?? null,
    fromStatus: r.from_status ?? null,
    toStatus: r.to_status ?? null,
    userId: r.user_id == null ? null : Number(r.user_id),
    createdAt: toIso(r.created_at),
  }))
}

// ---------------------------------------------------------------------------
// Scans
// ---------------------------------------------------------------------------

export async function createScan(input: {
  windowDays: number
  categories: string | null
  modelScoring: boolean
  triggeredBy: number | null
}): Promise<number> {
  const res = await tenantInsert("ai_anomaly_scans", {
    status: "running",
    window_days: input.windowDays,
    categories: input.categories,
    model_scoring: input.modelScoring ? 1 : 0,
    triggered_by: input.triggeredBy,
  })
  return res.insertId
}

export async function finishScan(
  id: number,
  patch: {
    status: "completed" | "failed"
    findingsCount?: number
    createdCount?: number
    dedupedCount?: number
    error?: string | null
  },
): Promise<void> {
  await tenantUpdate(
    "ai_anomaly_scans",
    {
      status: patch.status,
      findings_count: patch.findingsCount ?? 0,
      created_count: patch.createdCount ?? 0,
      deduped_count: patch.dedupedCount ?? 0,
      error: patch.error ? String(patch.error).slice(0, 1000) : null,
      finished_at: new Date().toISOString().slice(0, 19).replace("T", " "),
    },
    "`id` = ?",
    [id],
  )
}

export async function getScan(id: number): Promise<ScanRow | null> {
  const row = await tenantFindById<any>("ai_anomaly_scans", id)
  return row ? mapScan(row) : null
}

export async function listScans(limit = 20): Promise<ScanRow[]> {
  const capped = Math.min(Math.max(Number(limit), 1), 100)
  const rows = await tenantSelect<any[]>("ai_anomaly_scans", {
    tail: `ORDER BY id DESC LIMIT ${capped}`,
  })
  return rows.map(mapScan)
}
