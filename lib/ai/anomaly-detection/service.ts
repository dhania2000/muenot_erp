import "server-only"
/**
 * SPEC 20 (req #75) — AI Anomaly Detection orchestration.
 * ---------------------------------------------------------------------------
 * Ties the pure layers (collectors → detectors → optional model scoring) to the
 * tenant-scoped store, the audit log, the security-audit trail and the
 * notification engine. This is the ONLY layer that decides *when* to run and
 * *who* to tell — it never decides a financial or access outcome. Every alert is
 * born "open" and can only be resolved by a human through `reviewAlert`.
 *
 * Guarantees:
 *   - Tenant scope: all persistence is via the store (tenant_id predicated).
 *   - Idempotency: re-running a scan collapses onto existing alerts by signature.
 *   - Explainable-first: rules always run; model scoring only ENRICHES and only
 *     when both the caller asks for it AND flag.ai_anomaly_model_scoring is on.
 *   - Human-in-the-loop: no automatic remediation; reviews are validated,
 *     audited and (for owners) notified.
 */

import { getConfigValue } from "@/lib/config/service"
import { recordAuditLog } from "@/lib/audit-log-store"
import { recordSecurityEvent } from "@/lib/security-audit-store"
import { withTransaction } from "@/lib/db"
import { query } from "@/lib/db"
import { enqueueNotification } from "@/lib/notification-engine/service"
import { ensureNotificationEngineSchema } from "@/lib/notification-engine/schema"
import {
  normalizeSeverity,
  round,
  severityFromScore,
  validateReview,
  type AlertStatus,
  type AnomalyCategory,
  type Finding,
  type Severity,
} from "./model"
import {
  detectAmountOutliers,
  detectDuplicateAmounts,
  detectSeriesSpike,
} from "./detectors"
import { collectObservations, privilegeEvents, type AccessEvent } from "./collectors"
import { scoreFindings } from "./scoring"
import { ensureAnomalyDetectionSchema } from "./schema"
import {
  applyReview,
  createScan,
  finishScan,
  getAlert,
  logAlertAudit,
  upsertAlertFromFinding,
  type AlertRow,
} from "./store"

export type Actor = { userId: number; role: string; isAdmin: boolean }

export const MODEL_SCORING_FLAG = "flag.ai_anomaly_model_scoring"

/** Severities that warrant proactively notifying tenant admins of a NEW alert. */
const NOTIFY_SEVERITIES: Severity[] = ["high", "critical"]

export type ServiceError = { error: string; status: number }

export function isServiceError(v: unknown): v is ServiceError {
  return !!v && typeof v === "object" && "error" in v && "status" in v
}

// ---------------------------------------------------------------------------
// Feature flag
// ---------------------------------------------------------------------------

/** True only when the platform flag enabling optional model scoring is on. */
export async function isModelScoringEnabled(): Promise<boolean> {
  try {
    const value = await getConfigValue(MODEL_SCORING_FLAG)
    return String(value ?? "").toLowerCase() === "enabled"
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------

export type ScanInput = {
  actor: Actor
  windowDays?: number
  categories?: readonly AnomalyCategory[]
  /** Caller opt-in for model scoring; only honored when the flag is on too. */
  useModelScoring?: boolean
  /** Injectable clock for deterministic tests. */
  now?: Date
}

export type ScanSummary = {
  scanId: number
  windowDays: number
  categories: AnomalyCategory[]
  modelScoring: boolean
  findings: number
  created: number
  deduped: number
  alerts: AlertRow[]
}

const DEFAULT_WINDOW_DAYS = 90

/**
 * Run a full anomaly scan for the current tenant. Rules always run; model
 * scoring is layered only when enabled. Persists idempotently, audits, and
 * notifies admins of new high/critical alerts. Never throws for a single broken
 * source — the scan is best-effort per detector.
 */
export async function runAnomalyScan(input: ScanInput): Promise<ScanSummary | ServiceError> {
  const windowDays = clampWindow(input.windowDays)
  const categories = (input.categories && input.categories.length
    ? input.categories
    : (["payment", "invoice", "access", "usage"] as const)) as AnomalyCategory[]

  const flagOn = await isModelScoringEnabled()
  const modelScoring = Boolean(input.useModelScoring) && flagOn

  await ensureAnomalyDetectionSchema()
  const scanId = await createScan({
    windowDays,
    categories: categories.join(","),
    modelScoring,
    triggeredBy: input.actor.userId ?? null,
  })

  try {
    const data = await collectObservations({ windowDays, categories, now: input.now })

    let findings: Finding[] = []
    if (categories.includes("payment")) {
      findings.push(...detectAmountOutliers("payment.amount_outlier", "billing_payment", data.payments))
      findings.push(...detectDuplicateAmounts("billing_payment", data.payments))
      findings.push(
        ...detectSeriesSpike("payment.volume_spike", "payment_volume", "payments", "Payment volume", data.paymentSeries),
      )
    }
    if (categories.includes("invoice")) {
      findings.push(...detectAmountOutliers("invoice.amount_outlier", "sales_invoice", data.invoices))
      findings.push(
        ...detectSeriesSpike("invoice.volume_spike", "invoice_volume", "invoices", "Invoice volume", data.invoiceSeries),
      )
    }
    if (categories.includes("access")) {
      findings.push(
        ...detectSeriesSpike("access.change_spike", "access_activity", "access", "Access changes", data.accessSeries),
      )
      findings.push(...detectPrivilegeChanges(privilegeEvents(data.accessEvents)))
    }
    if (categories.includes("usage")) {
      for (const meter of data.usage) {
        findings.push(
          ...detectSeriesSpike("usage.metric_spike", "usage_meter", meter.meterKey, meter.meterKey, meter.series),
        )
      }
    }

    if (modelScoring && findings.length > 0) {
      findings = scoreFindings(findings)
    }

    let created = 0
    let deduped = 0
    const alerts: AlertRow[] = []
    const newlyCritical: AlertRow[] = []
    for (const finding of findings) {
      const result = await upsertAlertFromFinding(finding)
      alerts.push(result.alert)
      if (result.created) {
        created++
        await logAlertAudit({
          alertId: result.alert.id,
          action: "detected",
          detail: `${finding.signal} (${finding.severity}, score ${round(finding.score, 3)})`,
          toStatus: "open",
          userId: input.actor.userId ?? null,
        })
        if (NOTIFY_SEVERITIES.includes(result.alert.severity)) newlyCritical.push(result.alert)
      } else {
        deduped++
      }
    }

    await finishScan(scanId, {
      status: "completed",
      findingsCount: findings.length,
      createdCount: created,
      dedupedCount: deduped,
    })

    await recordAuditLog({
      action: "ai.anomaly.scan",
      entityType: "ai_anomaly_scan",
      entityId: scanId,
      result: "success",
      metadata: { windowDays, categories, modelScoring, findings: findings.length, created, deduped },
    })

    if (newlyCritical.length > 0) {
      await notifyAdminsOfAlerts(newlyCritical).catch((err) =>
        console.error("[v0] anomaly notify failed (ignored):", err),
      )
    }

    return { scanId, windowDays, categories, modelScoring, findings: findings.length, created, deduped, alerts }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await finishScan(scanId, { status: "failed", error: message }).catch(() => {})
    await recordAuditLog({
      action: "ai.anomaly.scan",
      entityType: "ai_anomaly_scan",
      entityId: scanId,
      result: "failure",
      metadata: { error: message },
    }).catch(() => {})
    console.error("[v0] anomaly scan failed:", err)
    return { error: "Anomaly scan failed", status: 500 }
  }
}

/**
 * Direct rule for privilege grants/elevations. Conservative by design: only
 * emergency-bypass / break-glass style events and explicit admin/role grants
 * become alerts, so routine access noise does not flood the queue.
 */
function detectPrivilegeChanges(events: AccessEvent[]): Finding[] {
  const findings: Finding[] = []
  for (const e of events) {
    const outcome = String(e.outcome ?? "").toLowerCase()
    const action = String(e.action ?? "").toLowerCase()
    const isEmergency = /bypass|break.?glass|emergency/.test(action) || outcome === "bypassed"
    const isPrivilegeGrant = /admin|role|elevat|privileg/.test(action) && /grant|approv|activat/.test(`${action} ${outcome}`)
    if (!isEmergency && !isPrivilegeGrant) continue
    const score = isEmergency ? 0.82 : 0.55
    findings.push({
      signal: "access.privilege_change",
      category: "access",
      entityType: "access_event",
      entityId: String(e.id),
      entityLabel: e.actorLabel,
      observedValue: 1,
      score: round(score, 4),
      severity: severityFromScore(score),
      method: "rule",
      title: isEmergency ? `Emergency access used: ${e.action}` : `Privilege change: ${e.action}`,
      summary: `${e.actorLabel ?? "An actor"} performed "${e.action}" with outcome "${e.outcome}". Confirm this elevation was expected and authorized.`,
      evidence: {
        rule: "access.privilege_change",
        actorId: e.actorId,
        actorLabel: e.actorLabel,
        action: e.action,
        outcome: e.outcome,
        detail: e.detail ?? null,
        emergency: isEmergency,
      },
      occurredAt: e.occurredAt,
    })
  }
  return findings
}

// ---------------------------------------------------------------------------
// Review — the only way an alert changes state; always a human decision.
// ---------------------------------------------------------------------------

export type ReviewInput = {
  actor: Actor
  alertId: number
  toStatus: AlertStatus
  note?: string | null
  ownerId?: number | null
}

export async function reviewAlert(input: ReviewInput): Promise<AlertRow | ServiceError> {
  const alert = await getAlert(input.alertId)
  if (!alert) return { error: "Alert not found", status: 404 }

  const check = validateReview({ from: alert.status, to: input.toStatus, note: input.note })
  if (!check.ok) return { error: check.error, status: 409 }

  // An owner must be a real member of THIS tenant (never trust a forged id).
  if (input.ownerId != null) {
    const ok = await isTenantMember(input.ownerId)
    if (!ok) return { error: "Owner is not a member of this tenant", status: 400 }
  }

  const updated = await applyReview(input.alertId, {
    status: input.toStatus,
    ownerId: input.ownerId ?? undefined,
    resolutionNote: input.note ?? undefined,
    reviewedBy: input.actor.userId,
  })
  if (!updated) return { error: "Alert not found", status: 404 }

  await logAlertAudit({
    alertId: updated.id,
    action: input.ownerId != null ? "reviewed+assigned" : "reviewed",
    detail: input.note ? String(input.note).slice(0, 500) : null,
    fromStatus: alert.status,
    toStatus: updated.status,
    userId: input.actor.userId,
  })

  await recordAuditLog({
    action: "ai.anomaly.review",
    entityType: "ai_anomaly_alert",
    entityId: updated.id,
    result: "success",
    before: { status: alert.status, ownerId: alert.ownerId },
    after: { status: updated.status, ownerId: updated.ownerId },
    metadata: { severity: updated.severity, signal: updated.signal, hasNote: Boolean(input.note) },
  })

  // Terminal decisions on a high/critical alert are security-relevant.
  if ((updated.status === "dismissed" || updated.status === "resolved") && NOTIFY_SEVERITIES.includes(updated.severity)) {
    const { currentTenantIdOrNull } = await import("@/lib/tenant-scope")
    await recordSecurityEvent({
      tenantId: currentTenantIdOrNull(),
      category: "access_policy",
      action: `anomaly.${updated.status}`,
      outcome: "info",
      actorUserId: input.actor.userId,
      detail: { alertId: updated.id, signal: updated.signal, severity: updated.severity },
    }).catch(() => {})
  }

  // Tell the newly-assigned owner they own this (best-effort).
  if (input.ownerId != null && input.ownerId !== alert.ownerId) {
    await notifyOwner(updated, input.ownerId).catch((err) =>
      console.error("[v0] anomaly owner notify failed (ignored):", err),
    )
  }

  return updated
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clampWindow(days: number | undefined): number {
  const n = Number(days ?? DEFAULT_WINDOW_DAYS)
  if (!Number.isFinite(n)) return DEFAULT_WINDOW_DAYS
  return Math.min(Math.max(Math.round(n), 7), 365)
}

/** Verify a user id is an active member of the current tenant. */
async function isTenantMember(userId: number): Promise<boolean> {
  const { currentTenantId } = await import("@/lib/tenant-scope")
  const rows = (await query("SELECT id FROM users WHERE tenant_id = ? AND id = ? AND status = 'active' LIMIT 1", [
    currentTenantId(),
    userId,
  ])) as any[]
  return rows.length > 0
}

async function activeAdminIds(): Promise<number[]> {
  const { currentTenantId } = await import("@/lib/tenant-scope")
  const rows = (await query(
    "SELECT id FROM users WHERE tenant_id = ? AND role = 'admin' AND status = 'active' LIMIT 50",
    [currentTenantId()],
  )) as any[]
  return rows.map((r) => Number(r.id))
}

async function notifyAdminsOfAlerts(alerts: AlertRow[]): Promise<void> {
  const admins = await activeAdminIds()
  if (admins.length === 0) return
  const { currentTenantId } = await import("@/lib/tenant-scope")
  const tenantId = currentTenantId()
  await ensureNotificationEngineSchema()
  const top = alerts
    .slice()
    .sort((a, b) => b.score - a.score)
    .slice(0, 10)
  await withTransaction(async (c) => {
    for (const alert of top) {
      for (const userId of admins) {
        await enqueueNotification(c, {
          tenantId,
          userId,
          channel: "in_app",
          key: `anomaly-alert:${alert.id}:${userId}`,
          title: `${alert.severity.toUpperCase()} risk alert: ${alert.title}`.slice(0, 255),
          body: (alert.summary ?? "A new anomaly requires review.").slice(0, 4000),
          link: `/dashboard/security/anomalies?alert=${alert.id}`,
          priority: alert.severity === "critical" ? 10 : 5,
          context: {
            moduleKey: "security",
            action: "create",
            entityTable: "ai_anomaly_alerts",
            entityId: String(alert.id),
          },
        })
      }
    }
  })
}

async function notifyOwner(alert: AlertRow, ownerId: number): Promise<void> {
  const { currentTenantId } = await import("@/lib/tenant-scope")
  const tenantId = currentTenantId()
  await ensureNotificationEngineSchema()
  await withTransaction(async (c) => {
    await enqueueNotification(c, {
      tenantId,
      userId: ownerId,
      channel: "in_app",
      key: `anomaly-owner:${alert.id}:${ownerId}`,
      title: `You were assigned a risk alert: ${alert.title}`.slice(0, 255),
      body: (alert.summary ?? "You now own this anomaly alert.").slice(0, 4000),
      link: `/dashboard/security/anomalies?alert=${alert.id}`,
      priority: 5,
      context: {
        moduleKey: "security",
        action: "assign",
        entityTable: "ai_anomaly_alerts",
        entityId: String(alert.id),
      },
    })
  })
}
