import "server-only"
/**
 * Login protection & security alerts (Spec22 · #37, #215).
 * ---------------------------------------------------------------------------
 * A tenant-scoped correlation + alerting layer that sits ON TOP of the existing
 * primitives — it does NOT re-implement them:
 *   - progressive lockout uses `users.locked_until` (lib/password-policy.ts)
 *   - session revocation uses `revokeAllSessionsForUser` (lib/session-store.ts)
 *   - admin notifications use the notification engine (lib/notification-engine)
 *   - immutable audit rows use `recordSecurityEvent` (lib/security-audit-store.ts)
 *
 * Responsibilities unique to this module:
 *   1. Turn raw signals (failed logins, new admins, role escalations, API-key
 *      creation, breached passwords) into deduplicated, actionable alerts.
 *   2. Correlate a burst of failed logins with a sensitive account change to
 *      declare a "critical compromise" and enforce progressive lockout +
 *      session revocation.
 *   3. Notify tenant security admins, deduplicated and rate-limited so an
 *      attack (or a provider flapping) cannot fan out into an alert storm.
 *
 * Every read and write is tenant-scoped via an explicit `tenantId` argument
 * (never async-local context) so it is safe to call from the pre-auth login
 * path, where no tenant context is established yet.
 */
import { query, pool, withTransaction } from "@/lib/db"
import { checkRateLimit } from "@/lib/rate-limit"
import { revokeAllSessionsForUser } from "@/lib/session-store"
import { recordSecurityEvent } from "@/lib/security-audit-store"

export type SecurityAlertType =
  | "failed_login_burst"
  | "new_admin"
  | "role_escalation"
  | "api_key_created"
  | "breached_password"
  | "critical_compromise"
  | "bulk_export"

export type SecuritySeverity = "info" | "warning" | "critical"
export type SecurityAlertStatus = "open" | "acknowledged" | "resolved"

const SEVERITY_RANK: Record<SecuritySeverity, number> = { info: 1, warning: 2, critical: 3 }

// --- correlation / enforcement tuning ---------------------------------------
/** Failed-login attempts (for one account) that promote the burst to critical. */
const FAILED_LOGIN_CRITICAL_THRESHOLD = 5
/** How long an open burst alert keeps accumulating before a new one is opened. */
const DEDUPE_WINDOW_MS = 60 * 60 * 1000 // 1h
/** A sensitive change within this window of a critical burst = compromise. */
const CORRELATION_WINDOW_MS = 15 * 60 * 1000 // 15m
/** Progressive lockout base and ceiling (doubles per repeated compromise). */
const BASE_LOCKOUT_MINUTES = 15
const MAX_LOCKOUT_MINUTES = 24 * 60
/** Per-tenant cap on alert notifications, to survive an alert storm. */
const NOTIFY_MAX = 20
const NOTIFY_WINDOW_MS = 60 * 60 * 1000 // 1h

export type SecurityAlertRow = {
  id: number
  tenant_id: number
  alert_type: SecurityAlertType
  severity: SecuritySeverity
  status: SecurityAlertStatus
  dedupe_key: string
  title: string
  detail: string | null
  subject_user_id: number | null
  subject_label: string | null
  source_ip: string | null
  occurrence_count: number
  notified: number
  first_seen: string
  last_seen: string
  acknowledged_by: number | null
  acknowledged_at: string | null
  resolved_by: number | null
  resolved_at: string | null
}

export type SecurityAlert = {
  id: number
  tenantId: number
  type: SecurityAlertType
  severity: SecuritySeverity
  status: SecurityAlertStatus
  dedupeKey: string
  title: string
  detail: Record<string, unknown> | null
  subjectUserId: number | null
  subjectLabel: string | null
  sourceIp: string | null
  occurrenceCount: number
  notified: boolean
  firstSeen: string
  lastSeen: string
  acknowledgedBy: number | null
  acknowledgedAt: string | null
  resolvedBy: number | null
  resolvedAt: string | null
}

let ensured: Promise<void> | null = null

async function runEnsure(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS \`security_alerts\` (
      \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      \`tenant_id\` INT UNSIGNED NOT NULL,
      \`alert_type\` VARCHAR(48) NOT NULL,
      \`severity\` ENUM('info','warning','critical') NOT NULL DEFAULT 'warning',
      \`status\` ENUM('open','acknowledged','resolved') NOT NULL DEFAULT 'open',
      \`dedupe_key\` VARCHAR(190) NOT NULL,
      \`title\` VARCHAR(255) NOT NULL,
      \`detail\` JSON DEFAULT NULL,
      \`subject_user_id\` INT UNSIGNED DEFAULT NULL,
      \`subject_label\` VARCHAR(190) DEFAULT NULL,
      \`source_ip\` VARCHAR(64) DEFAULT NULL,
      \`occurrence_count\` INT UNSIGNED NOT NULL DEFAULT 1,
      \`notified\` TINYINT(1) NOT NULL DEFAULT 0,
      \`first_seen\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      \`last_seen\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      \`acknowledged_by\` INT UNSIGNED DEFAULT NULL,
      \`acknowledged_at\` DATETIME DEFAULT NULL,
      \`resolved_by\` INT UNSIGNED DEFAULT NULL,
      \`resolved_at\` DATETIME DEFAULT NULL,
      PRIMARY KEY (\`id\`),
      KEY \`idx_sa_tenant_status\` (\`tenant_id\`, \`status\`),
      KEY \`idx_sa_dedupe\` (\`tenant_id\`, \`dedupe_key\`, \`status\`),
      KEY \`idx_sa_type\` (\`tenant_id\`, \`alert_type\`),
      KEY \`idx_sa_last_seen\` (\`last_seen\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)
}

export function ensureSecurityAlertsSchema(): Promise<void> {
  if (!ensured) {
    ensured = runEnsure().catch((err) => {
      ensured = null
      throw err
    })
  }
  return ensured
}

function toPublic(row: SecurityAlertRow): SecurityAlert {
  let detail: Record<string, unknown> | null = null
  if (row.detail) {
    try {
      detail = typeof row.detail === "string" ? JSON.parse(row.detail) : (row.detail as Record<string, unknown>)
    } catch {
      detail = null
    }
  }
  return {
    id: Number(row.id),
    tenantId: Number(row.tenant_id),
    type: row.alert_type,
    severity: row.severity,
    status: row.status,
    dedupeKey: row.dedupe_key,
    title: row.title,
    detail,
    subjectUserId: row.subject_user_id != null ? Number(row.subject_user_id) : null,
    subjectLabel: row.subject_label,
    sourceIp: row.source_ip,
    occurrenceCount: Number(row.occurrence_count),
    notified: Boolean(row.notified),
    firstSeen: row.first_seen,
    lastSeen: row.last_seen,
    acknowledgedBy: row.acknowledged_by != null ? Number(row.acknowledged_by) : null,
    acknowledgedAt: row.acknowledged_at,
    resolvedBy: row.resolved_by != null ? Number(row.resolved_by) : null,
    resolvedAt: row.resolved_at,
  }
}

export type RaiseAlertInput = {
  tenantId: number
  type: SecurityAlertType
  severity?: SecuritySeverity
  /** Stable key used to fold repeat signals into one open alert. */
  dedupeKey: string
  title: string
  detail?: Record<string, unknown> | null
  subjectUserId?: number | null
  subjectLabel?: string | null
  sourceIp?: string | null
  /** Reuse an open/ack alert with the same key seen within this window. */
  windowMs?: number
  /** Notify admins again even when folding into an existing alert (critical paths). */
  notifyOnRepeat?: boolean
}

export type RaisedAlert = {
  id: number
  isNew: boolean
  occurrenceCount: number
  severity: SecuritySeverity
  notified: boolean
}

/**
 * Raise (or fold into) a deduplicated security alert. When an open/acknowledged
 * alert with the same `dedupeKey` was seen within `windowMs`, its occurrence
 * counter and last-seen advance and its severity is raised to the max of the
 * two — no duplicate row, and (by default) no repeat notification. Otherwise a
 * new alert is inserted. Uses a row lock so concurrent signals converge on one
 * counter (mirrors the pre-auth rate-limit store).
 */
export async function raiseSecurityAlert(input: RaiseAlertInput): Promise<RaisedAlert> {
  await ensureSecurityAlertsSchema()
  const severity = input.severity ?? "warning"
  const windowMs = input.windowMs ?? DEDUPE_WINDOW_MS
  const detailJson = input.detail ? JSON.stringify(input.detail) : null

  const conn = await pool.getConnection()
  let result: RaisedAlert
  try {
    await conn.beginTransaction()
    const [existingRows] = (await conn.query(
      `SELECT \`id\`, \`occurrence_count\`, \`severity\`
         FROM \`security_alerts\`
        WHERE \`tenant_id\` = ? AND \`dedupe_key\` = ? AND \`status\` IN ('open','acknowledged')
          AND \`last_seen\` >= (NOW() - INTERVAL ? SECOND)
        ORDER BY \`id\` DESC LIMIT 1 FOR UPDATE`,
      [input.tenantId, input.dedupeKey, Math.ceil(windowMs / 1000)],
    )) as [Array<{ id: number; occurrence_count: number; severity: SecuritySeverity }>, unknown]

    const existing = existingRows[0]
    if (existing) {
      const nextSeverity =
        SEVERITY_RANK[severity] > SEVERITY_RANK[existing.severity] ? severity : existing.severity
      const nextCount = Number(existing.occurrence_count) + 1
      await conn.query(
        `UPDATE \`security_alerts\`
            SET \`occurrence_count\` = ?, \`severity\` = ?, \`last_seen\` = NOW(),
                \`detail\` = COALESCE(?, \`detail\`), \`source_ip\` = COALESCE(?, \`source_ip\`)
          WHERE \`id\` = ?`,
        [nextCount, nextSeverity, detailJson, input.sourceIp ?? null, existing.id],
      )
      result = {
        id: Number(existing.id),
        isNew: false,
        occurrenceCount: nextCount,
        severity: nextSeverity,
        notified: false,
      }
    } else {
      const [insert] = (await conn.query(
        `INSERT INTO \`security_alerts\`
           (\`tenant_id\`, \`alert_type\`, \`severity\`, \`status\`, \`dedupe_key\`, \`title\`, \`detail\`,
            \`subject_user_id\`, \`subject_label\`, \`source_ip\`, \`occurrence_count\`)
         VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, 1)`,
        [
          input.tenantId,
          input.type,
          severity,
          input.dedupeKey,
          input.title.slice(0, 255),
          detailJson,
          input.subjectUserId ?? null,
          input.subjectLabel ? input.subjectLabel.slice(0, 190) : null,
          input.sourceIp ?? null,
        ],
      )) as [{ insertId: number }, unknown]
      result = {
        id: Number(insert.insertId),
        isNew: true,
        occurrenceCount: 1,
        severity,
        notified: false,
      }
    }
    await conn.commit()
  } catch (err) {
    await conn.rollback().catch(() => {})
    throw err
  } finally {
    conn.release()
  }

  // Mirror into the immutable security audit trail (best-effort, never throws).
  void recordSecurityEvent({
    tenantId: input.tenantId,
    category: "access_policy",
    action: `alert_${input.type}`,
    outcome: result.isNew ? "created" : "info",
    subjectEmail: input.subjectLabel ?? null,
    ipAddress: input.sourceIp ?? null,
    detail: { severity: result.severity, occurrenceCount: result.occurrenceCount, dedupeKey: input.dedupeKey },
  })

  if (result.isNew || input.notifyOnRepeat) {
    const notified = await notifySecurityAdmins(input.tenantId, {
      alertId: result.id,
      title: input.title,
      severity: result.severity,
      subjectLabel: input.subjectLabel ?? null,
    })
    result.notified = notified
  }
  return result
}

/**
 * Fan a new alert out to the tenant's security admins as an in-app
 * notification, deduplicated per (alert, user) and rate-limited per tenant so a
 * burst of alerts can never become an unbounded notification storm.
 */
async function notifySecurityAdmins(
  tenantId: number,
  alert: { alertId: number; title: string; severity: SecuritySeverity; subjectLabel: string | null },
): Promise<boolean> {
  try {
    const rl = await checkRateLimit(`secalert-notify:${tenantId}`, { max: NOTIFY_MAX, windowMs: NOTIFY_WINDOW_MS })
    if (!rl.allowed) return false

    // Security admins = tenant admins/owners (or the legacy coarse admin role).
    const admins = await query<{ id: number }[]>(
      `SELECT \`id\` FROM \`users\`
        WHERE \`tenant_id\` = ? AND \`status\` = 'active'
          AND (\`role\` = 'admin' OR \`tenant_role\` IN ('tenant_admin','tenant_owner'))`,
      [tenantId],
    )
    if (admins.length === 0) return false

    const { ensureNotificationEngineSchema } = await import("@/lib/notification-engine/schema")
    const { enqueueNotification } = await import("@/lib/notification-engine/service")
    await ensureNotificationEngineSchema()
    const body = alert.subjectLabel ? `${alert.severity.toUpperCase()} · ${alert.subjectLabel}` : alert.severity.toUpperCase()
    await withTransaction(async (c) => {
      for (const a of admins) {
        await enqueueNotification(c, {
          tenantId,
          userId: a.id,
          channel: "in_app",
          // Idempotency: the engine ignores a duplicate (alert,user) key, so a
          // retried signal never double-notifies.
          key: `secalert:${alert.alertId}:${a.id}`,
          title: alert.title.slice(0, 255),
          body,
          link: "/admin/security/alerts",
          context: { kind: "security_alert", alertId: alert.alertId, severity: alert.severity },
        })
      }
    })
    await query(`UPDATE \`security_alerts\` SET \`notified\` = 1 WHERE \`id\` = ?`, [alert.alertId])
    return true
  } catch (err) {
    console.error("[v0] security alert notify failed (ignored):", err)
    return false
  }
}

// ---------------------------------------------------------------------------
// Signal handlers (correlation entry points)
// ---------------------------------------------------------------------------

/**
 * Record a failed login for a known account. The single burst alert accumulates
 * every failed attempt; once it crosses the critical threshold the severity is
 * promoted so downstream correlation treats a follow-on sensitive change as a
 * compromise. Best-effort — never throws into the login path.
 */
export async function onFailedLogin(params: {
  tenantId: number | null
  userId: number
  email: string
  ip?: string | null
}): Promise<void> {
  if (params.tenantId == null) return
  try {
    // Peek at the current count to decide severity for this occurrence.
    const openRows = await query<{ occurrence_count: number }[]>(
      `SELECT \`occurrence_count\` FROM \`security_alerts\`
        WHERE \`tenant_id\` = ? AND \`dedupe_key\` = ? AND \`status\` IN ('open','acknowledged')
        ORDER BY \`id\` DESC LIMIT 1`,
      [params.tenantId, `failed-login:${params.userId}`],
    ).catch(() => [] as { occurrence_count: number }[])
    const nextCount = (Number(openRows[0]?.occurrence_count) || 0) + 1
    const severity: SecuritySeverity = nextCount >= FAILED_LOGIN_CRITICAL_THRESHOLD ? "critical" : "warning"
    await raiseSecurityAlert({
      tenantId: params.tenantId,
      type: "failed_login_burst",
      severity,
      dedupeKey: `failed-login:${params.userId}`,
      title: `Repeated failed sign-ins for ${params.email}`,
      subjectUserId: params.userId,
      subjectLabel: params.email,
      sourceIp: params.ip ?? null,
      detail: { attempts: nextCount },
    })
  } catch (err) {
    console.error("[v0] onFailedLogin alert failed (ignored):", err)
  }
}

/** Clear the open failed-login burst once the account authenticates fully. */
export async function onSuccessfulLogin(params: { tenantId: number | null; userId: number }): Promise<void> {
  if (params.tenantId == null) return
  try {
    await query(
      `UPDATE \`security_alerts\` SET \`status\` = 'resolved', \`resolved_at\` = NOW()
        WHERE \`tenant_id\` = ? AND \`dedupe_key\` = ? AND \`status\` IN ('open','acknowledged')`,
      [params.tenantId, `failed-login:${params.userId}`],
    )
  } catch {
    // best-effort
  }
}

/**
 * A data export completed (Spec25 · #216). Assess it for BULK or UNUSUAL
 * characteristics and, when warranted, raise a deduplicated `bulk_export` alert
 * that captures the actor, scope and destination metadata. Best-effort — never
 * throws into the export path. The `recentExportCount` is supplied by the
 * export store from a tenant-scoped count of the actor's recent exports.
 */
export async function onDataExport(params: {
  tenantId: number | null
  actorUserId: number
  actorLabel: string
  scopeLabel: string
  datasetKey: string
  rowCount: number
  isFullTenant: boolean
  recentExportCount: number
  destination: ExportDestinationKind
  ip?: string | null
}): Promise<{ alerted: boolean; severity: SecuritySeverity } | null> {
  if (params.tenantId == null) return null
  try {
    const assessment = assessExport({
      rowCount: params.rowCount,
      isFullTenant: params.isFullTenant,
      recentExportCount: params.recentExportCount,
      destination: params.destination,
    })
    if (!assessment.alert) return { alerted: false, severity: "info" }

    const raised = await raiseSecurityAlert({
      tenantId: params.tenantId,
      type: "bulk_export",
      severity: assessment.severity,
      // Fold repeat exfiltration signals by the same actor into one open alert.
      dedupeKey: `bulk-export:${params.actorUserId}`,
      title: `Unusual data export by ${params.actorLabel}`,
      subjectUserId: params.actorUserId,
      subjectLabel: params.actorLabel,
      sourceIp: params.ip ?? null,
      // Actor, scope and destination metadata for the responder.
      detail: {
        actorUserId: params.actorUserId,
        scope: params.scopeLabel,
        datasetKey: params.datasetKey,
        rowCount: params.rowCount,
        isFullTenant: params.isFullTenant,
        destination: params.destination,
        recentExportCount: params.recentExportCount,
        reasons: assessment.reasons,
      },
      // Re-notify on a repeat critical signal (active exfiltration).
      notifyOnRepeat: assessment.severity === "critical",
    })
    // Mirror into the immutable audit trail under a dedicated category.
    void recordSecurityEvent({
      tenantId: params.tenantId,
      category: "data_export",
      action: "bulk_export_alert",
      outcome: raised.isNew ? "created" : "info",
      actorUserId: params.actorUserId,
      subjectEmail: params.actorLabel,
      ipAddress: params.ip ?? null,
      detail: {
        scope: params.scopeLabel,
        rowCount: params.rowCount,
        destination: params.destination,
        severity: assessment.severity,
        reasons: assessment.reasons,
      },
    })
    return { alerted: true, severity: assessment.severity }
  } catch (err) {
    console.error("[v0] onDataExport alert failed (ignored):", err)
    return null
  }
}

/**
 * A user was promoted to (or created as) an admin/owner. Raises a `new_admin`
 * alert, then correlates against any recent critical failed-login burst for the
 * actor performing the change.
 */
export async function onNewAdmin(params: {
  tenantId: number
  subjectUserId: number
  subjectLabel: string
  actorUserId?: number | null
  ip?: string | null
}): Promise<void> {
  try {
    await raiseSecurityAlert({
      tenantId: params.tenantId,
      type: "new_admin",
      severity: "warning",
      dedupeKey: `new-admin:${params.subjectUserId}`,
      title: `New administrator: ${params.subjectLabel}`,
      subjectUserId: params.subjectUserId,
      subjectLabel: params.subjectLabel,
      sourceIp: params.ip ?? null,
      detail: { actorUserId: params.actorUserId ?? null },
    })
    await correlateSensitiveChange({
      tenantId: params.tenantId,
      actorUserId: params.actorUserId ?? null,
      ip: params.ip ?? null,
      change: "new_admin",
    })
  } catch (err) {
    console.error("[v0] onNewAdmin alert failed (ignored):", err)
  }
}

/** A user's role was escalated. Raises an alert and correlates for compromise. */
export async function onRoleEscalation(params: {
  tenantId: number
  subjectUserId: number
  subjectLabel: string
  from: string
  to: string
  actorUserId?: number | null
  ip?: string | null
}): Promise<void> {
  try {
    await raiseSecurityAlert({
      tenantId: params.tenantId,
      type: "role_escalation",
      severity: "warning",
      dedupeKey: `role-escalation:${params.subjectUserId}:${params.to}`,
      title: `Role escalated for ${params.subjectLabel}: ${params.from} → ${params.to}`,
      subjectUserId: params.subjectUserId,
      subjectLabel: params.subjectLabel,
      sourceIp: params.ip ?? null,
      detail: { from: params.from, to: params.to, actorUserId: params.actorUserId ?? null },
    })
    await correlateSensitiveChange({
      tenantId: params.tenantId,
      actorUserId: params.actorUserId ?? null,
      ip: params.ip ?? null,
      change: "role_escalation",
    })
  } catch (err) {
    console.error("[v0] onRoleEscalation alert failed (ignored):", err)
  }
}

/** An API key was created. Raises an alert and correlates for compromise. */
export async function onApiKeyCreated(params: {
  tenantId: number
  keyId: number
  keyName: string
  actorUserId?: number | null
  ip?: string | null
}): Promise<void> {
  try {
    await raiseSecurityAlert({
      tenantId: params.tenantId,
      type: "api_key_created",
      severity: "warning",
      dedupeKey: `api-key:${params.keyId}`,
      title: `API key created: ${params.keyName}`,
      subjectUserId: params.actorUserId ?? null,
      subjectLabel: params.keyName,
      sourceIp: params.ip ?? null,
      detail: { keyId: params.keyId, actorUserId: params.actorUserId ?? null },
    })
    await correlateSensitiveChange({
      tenantId: params.tenantId,
      actorUserId: params.actorUserId ?? null,
      ip: params.ip ?? null,
      change: "api_key_created",
    })
  } catch (err) {
    console.error("[v0] onApiKeyCreated alert failed (ignored):", err)
  }
}

/** A password known to be breached was set/kept. Advisory warning alert. */
export async function onBreachedPassword(params: {
  tenantId: number
  subjectUserId: number
  subjectLabel: string
  count: number
}): Promise<void> {
  try {
    await raiseSecurityAlert({
      tenantId: params.tenantId,
      type: "breached_password",
      severity: "warning",
      dedupeKey: `breached-pw:${params.subjectUserId}`,
      title: `Breached password in use by ${params.subjectLabel}`,
      subjectUserId: params.subjectUserId,
      subjectLabel: params.subjectLabel,
      detail: { seenInBreaches: params.count },
    })
  } catch (err) {
    console.error("[v0] onBreachedPassword alert failed (ignored):", err)
  }
}

/**
 * If the actor of a sensitive change has a recent CRITICAL failed-login burst,
 * the account was likely taken over: declare a critical compromise and enforce
 * progressive lockout + session revocation on that actor.
 */
async function correlateSensitiveChange(params: {
  tenantId: number
  actorUserId: number | null
  ip: string | null
  change: string
}): Promise<void> {
  if (params.actorUserId == null) return
  const burst = await query<{ id: number; occurrence_count: number }[]>(
    `SELECT \`id\`, \`occurrence_count\` FROM \`security_alerts\`
      WHERE \`tenant_id\` = ? AND \`dedupe_key\` = ? AND \`alert_type\` = 'failed_login_burst'
        AND \`severity\` = 'critical'
        AND \`last_seen\` >= (NOW() - INTERVAL ? SECOND)
      ORDER BY \`id\` DESC LIMIT 1`,
    [params.tenantId, `failed-login:${params.actorUserId}`, Math.ceil(CORRELATION_WINDOW_MS / 1000)],
  ).catch(() => [] as { id: number; occurrence_count: number }[])
  if (burst.length === 0) return

  await escalateCompromise({
    tenantId: params.tenantId,
    userId: params.actorUserId,
    reason: `failed_login_burst+${params.change}`,
    ip: params.ip,
    detail: { correlatedChange: params.change, failedAttempts: Number(burst[0].occurrence_count) },
  })
}

export type CompromiseResult = {
  alertId: number
  lockedUntil: Date
  lockoutMinutes: number
  revokedSessions: number
}

/**
 * Enforce a critical compromise on an account: raise/advance the compromise
 * alert (its occurrence count is the progressive step), apply an exponentially
 * increasing lockout on `users.locked_until`, and revoke every active session.
 * Always re-notifies admins (subject to the per-tenant notification cap).
 */
export async function escalateCompromise(params: {
  tenantId: number
  userId: number
  reason: string
  ip?: string | null
  detail?: Record<string, unknown> | null
}): Promise<CompromiseResult> {
  const alert = await raiseSecurityAlert({
    tenantId: params.tenantId,
    type: "critical_compromise",
    severity: "critical",
    dedupeKey: `compromise:${params.userId}`,
    title: `Critical account compromise detected (user #${params.userId})`,
    subjectUserId: params.userId,
    detail: { reason: params.reason, ...(params.detail ?? {}) },
    sourceIp: params.ip ?? null,
    notifyOnRepeat: true,
  })

  // Progressive: 15m, 30m, 60m, … capped at 24h, keyed on how many times this
  // account has been compromised (the alert's occurrence counter).
  const step = Math.max(1, alert.occurrenceCount)
  const lockoutMinutes = Math.min(BASE_LOCKOUT_MINUTES * 2 ** (step - 1), MAX_LOCKOUT_MINUTES)
  const lockedUntil = new Date(Date.now() + lockoutMinutes * 60_000)

  // Tenant-scoped: only lock the account if it truly belongs to this tenant.
  await query(
    `UPDATE \`users\` SET \`locked_until\` = ? WHERE \`id\` = ? AND \`tenant_id\` = ?`,
    [lockedUntil.toISOString().slice(0, 19).replace("T", " "), params.userId, params.tenantId],
  )

  const revokedSessions = await revokeAllSessionsForUser(params.userId, {
    reason: `security_compromise:${params.reason}`.slice(0, 190),
  }).catch(() => 0)

  return { alertId: alert.id, lockedUntil, lockoutMinutes, revokedSessions }
}

// ---------------------------------------------------------------------------
// Read / triage (all tenant-scoped)
// ---------------------------------------------------------------------------

export async function listSecurityAlerts(
  tenantId: number,
  opts: { status?: SecurityAlertStatus; type?: SecurityAlertType; limit?: number } = {},
): Promise<SecurityAlert[]> {
  await ensureSecurityAlertsSchema()
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500)
  const params: unknown[] = [tenantId]
  let sql = `SELECT * FROM \`security_alerts\` WHERE \`tenant_id\` = ?`
  if (opts.status) {
    sql += ` AND \`status\` = ?`
    params.push(opts.status)
  }
  if (opts.type) {
    sql += ` AND \`alert_type\` = ?`
    params.push(opts.type)
  }
  sql += ` ORDER BY (\`status\` = 'open') DESC, FIELD(\`severity\`,'critical','warning','info'), \`last_seen\` DESC, \`id\` DESC LIMIT ?`
  params.push(limit)
  const rows = await query<SecurityAlertRow[]>(sql, params)
  return rows.map(toPublic)
}

export async function getSecurityAlertSummary(
  tenantId: number,
): Promise<{ open: number; critical: number; acknowledged: number }> {
  await ensureSecurityAlertsSchema()
  const rows = await query<{ status: SecurityAlertStatus; severity: SecuritySeverity; n: number }[]>(
    `SELECT \`status\`, \`severity\`, COUNT(*) AS n FROM \`security_alerts\`
      WHERE \`tenant_id\` = ? GROUP BY \`status\`, \`severity\``,
    [tenantId],
  )
  let open = 0
  let critical = 0
  let acknowledged = 0
  for (const r of rows) {
    const n = Number(r.n)
    if (r.status === "open") open += n
    if (r.status === "acknowledged") acknowledged += n
    if (r.status !== "resolved" && r.severity === "critical") critical += n
  }
  return { open, critical, acknowledged }
}

/** Acknowledge or resolve an alert. Tenant-scoped; returns false if not owned. */
export async function updateAlertStatus(
  tenantId: number,
  alertId: number,
  status: "acknowledged" | "resolved",
  actorUserId: number,
): Promise<boolean> {
  await ensureSecurityAlertsSchema()
  const column = status === "acknowledged" ? "acknowledged" : "resolved"
  const res = await query<{ affectedRows: number }>(
    `UPDATE \`security_alerts\`
        SET \`status\` = ?, \`${column}_by\` = ?, \`${column}_at\` = NOW()
      WHERE \`id\` = ? AND \`tenant_id\` = ? AND \`status\` <> 'resolved'`,
    [status, actorUserId, alertId, tenantId],
  )
  return Number((res as any).affectedRows ?? 0) > 0
}
