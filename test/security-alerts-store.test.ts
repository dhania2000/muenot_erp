import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * Exercises the Spec22 correlation + alerting layer against an in-memory
 * simulation of the `security_alerts` + `users` tables (row lock / FOR UPDATE
 * transaction), covering: deduplicated folding, severity escalation, per-tenant
 * notification rate limiting, failed-login-burst -> sensitive-change correlation
 * driving a critical compromise (progressive lockout + session revocation), and
 * cross-tenant scoping on triage.
 */
const mock = vi.hoisted(() => ({
  query: vi.fn(),
  connQuery: vi.fn(),
  begin: vi.fn(),
  commit: vi.fn(),
  rollback: vi.fn(),
  release: vi.fn(),
  withTransaction: vi.fn(),
  checkRateLimit: vi.fn(),
  revokeAllSessionsForUser: vi.fn(),
  recordSecurityEvent: vi.fn(),
  enqueueNotification: vi.fn(),
  ensureNotificationEngineSchema: vi.fn(),
}))

vi.mock("server-only", () => ({}))
vi.mock("@/lib/db", () => ({
  query: mock.query,
  withTransaction: mock.withTransaction,
  pool: {
    getConnection: async () => ({
      query: mock.connQuery,
      beginTransaction: mock.begin,
      commit: mock.commit,
      rollback: mock.rollback,
      release: mock.release,
    }),
  },
}))
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: mock.checkRateLimit }))
vi.mock("@/lib/session-store", () => ({ revokeAllSessionsForUser: mock.revokeAllSessionsForUser }))
vi.mock("@/lib/security-audit-store", () => ({ recordSecurityEvent: mock.recordSecurityEvent }))
vi.mock("@/lib/notification-engine/schema", () => ({
  ensureNotificationEngineSchema: mock.ensureNotificationEngineSchema,
}))
vi.mock("@/lib/notification-engine/service", () => ({ enqueueNotification: mock.enqueueNotification }))

import {
  raiseSecurityAlert,
  onFailedLogin,
  onSuccessfulLogin,
  onApiKeyCreated,
  updateAlertStatus,
  listSecurityAlerts,
} from "@/lib/security-alerts-store"

type Row = {
  id: number
  tenant_id: number
  alert_type: string
  severity: string
  status: string
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

let alerts: Row[] = []
let autoId = 0
let admins: { id: number }[] = []
const lockedUsers: { userId: number; tenantId: number; lockedUntil: string }[] = []

function installStore() {
  mock.connQuery.mockImplementation(async (sql: string, params: unknown[] = []) => {
    const s = sql.trim()
    if (s.includes("FOR UPDATE")) {
      const [tenantId, dedupeKey] = params as [number, string]
      const match = alerts
        .filter(
          (a) =>
            a.tenant_id === tenantId &&
            a.dedupe_key === dedupeKey &&
            (a.status === "open" || a.status === "acknowledged"),
        )
        .sort((a, b) => b.id - a.id)[0]
      return [
        match ? [{ id: match.id, occurrence_count: match.occurrence_count, severity: match.severity }] : [],
      ]
    }
    if (s.startsWith("UPDATE")) {
      const [nextCount, nextSeverity, detailJson, sourceIp, id] = params as [
        number,
        string,
        string | null,
        string | null,
        number,
      ]
      const a = alerts.find((r) => r.id === id)
      if (a) {
        a.occurrence_count = nextCount
        a.severity = nextSeverity
        if (detailJson != null) a.detail = detailJson
        if (sourceIp != null) a.source_ip = sourceIp
        a.last_seen = new Date().toISOString()
      }
      return [{ affectedRows: a ? 1 : 0 }]
    }
    if (s.startsWith("INSERT")) {
      const [tenantId, type, severity, dedupeKey, title, detailJson, subjectUserId, subjectLabel, sourceIp] =
        params as [number, string, string, string, string, string | null, number | null, string | null, string | null]
      const now = new Date().toISOString()
      const id = ++autoId
      alerts.push({
        id,
        tenant_id: tenantId,
        alert_type: type,
        severity,
        status: "open",
        dedupe_key: dedupeKey,
        title,
        detail: detailJson,
        subject_user_id: subjectUserId,
        subject_label: subjectLabel,
        source_ip: sourceIp,
        occurrence_count: 1,
        notified: 0,
        first_seen: now,
        last_seen: now,
        acknowledged_by: null,
        acknowledged_at: null,
        resolved_by: null,
        resolved_at: null,
      })
      return [{ insertId: id }]
    }
    return [[]]
  })

  mock.query.mockImplementation(async (sql: string, params: unknown[] = []) => {
    const s = sql.trim()
    if (s.startsWith("CREATE TABLE")) return []
    if (s.startsWith("SELECT")) {
      if (s.includes("FROM `users`")) return admins
      if (s.includes("failed_login_burst") && s.includes("'critical'")) {
        const [tenantId, dedupeKey] = params as [number, string]
        return alerts
          .filter(
            (a) =>
              a.tenant_id === tenantId &&
              a.dedupe_key === dedupeKey &&
              a.alert_type === "failed_login_burst" &&
              a.severity === "critical" &&
              (a.status === "open" || a.status === "acknowledged"),
          )
          .sort((a, b) => b.id - a.id)
          .slice(0, 1)
          .map((a) => ({ id: a.id, occurrence_count: a.occurrence_count }))
      }
      if (s.includes("`occurrence_count`") && s.includes("FROM `security_alerts`")) {
        const [tenantId, dedupeKey] = params as [number, string]
        return alerts
          .filter(
            (a) =>
              a.tenant_id === tenantId &&
              a.dedupe_key === dedupeKey &&
              (a.status === "open" || a.status === "acknowledged"),
          )
          .sort((a, b) => b.id - a.id)
          .slice(0, 1)
          .map((a) => ({ occurrence_count: a.occurrence_count }))
      }
      if (s.includes("SELECT * FROM `security_alerts`")) {
        const tenantId = params[0] as number
        return alerts.filter((a) => a.tenant_id === tenantId)
      }
      return []
    }
    if (s.startsWith("UPDATE")) {
      if (s.includes("`security_alerts`") && s.includes("'resolved'") && s.includes("dedupe_key")) {
        const [tenantId, dedupeKey] = params as [number, string]
        let n = 0
        for (const a of alerts) {
          if (
            a.tenant_id === tenantId &&
            a.dedupe_key === dedupeKey &&
            (a.status === "open" || a.status === "acknowledged")
          ) {
            a.status = "resolved"
            a.resolved_at = new Date().toISOString()
            n++
          }
        }
        return { affectedRows: n }
      }
      if (s.includes("`notified` = 1")) {
        const id = params[0] as number
        const a = alerts.find((r) => r.id === id)
        if (a) a.notified = 1
        return { affectedRows: a ? 1 : 0 }
      }
      if (s.includes("`users`")) {
        const [lockedUntil, userId, tenantId] = params as [string, number, number]
        lockedUsers.push({ userId, tenantId, lockedUntil })
        return { affectedRows: 1 }
      }
      if (s.includes("`security_alerts`") && s.includes("_by`")) {
        const [status, actorUserId, alertId, tenantId] = params as [string, number, number, number]
        const a = alerts.find((r) => r.id === alertId && r.tenant_id === tenantId && r.status !== "resolved")
        if (a) {
          a.status = status
          return { affectedRows: 1 }
        }
        return { affectedRows: 0 }
      }
    }
    return []
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  alerts = []
  autoId = 0
  admins = [{ id: 99 }]
  lockedUsers.length = 0
  mock.begin.mockResolvedValue(undefined)
  mock.commit.mockResolvedValue(undefined)
  mock.rollback.mockResolvedValue(undefined)
  mock.withTransaction.mockImplementation(async (fn: (c: unknown) => unknown) => fn({}))
  mock.checkRateLimit.mockResolvedValue({ allowed: true, remaining: 19, retryAfter: 0 })
  mock.revokeAllSessionsForUser.mockResolvedValue(3)
  mock.recordSecurityEvent.mockResolvedValue(undefined)
  mock.enqueueNotification.mockResolvedValue(undefined)
  mock.ensureNotificationEngineSchema.mockResolvedValue(undefined)
  installStore()
})

describe("security-alerts store", () => {
  it("inserts a new alert and notifies the tenant's security admins once", async () => {
    const res = await raiseSecurityAlert({
      tenantId: 7,
      type: "new_admin",
      dedupeKey: "new-admin:42",
      title: "New administrator",
      subjectUserId: 42,
    })
    expect(res.isNew).toBe(true)
    expect(res.occurrenceCount).toBe(1)
    expect(res.notified).toBe(true)
    expect(mock.enqueueNotification).toHaveBeenCalledTimes(1)
    expect(alerts).toHaveLength(1)
    expect(alerts[0].notified).toBe(1)
  })

  it("folds repeat signals into one alert without re-notifying by default", async () => {
    const input = { tenantId: 7, type: "api_key_created" as const, dedupeKey: "api-key:1", title: "API key created" }
    await raiseSecurityAlert(input)
    const second = await raiseSecurityAlert(input)
    expect(second.isNew).toBe(false)
    expect(second.occurrenceCount).toBe(2)
    expect(second.notified).toBe(false)
    expect(alerts).toHaveLength(1)
    // Only the first (new) alert notified.
    expect(mock.enqueueNotification).toHaveBeenCalledTimes(1)
  })

  it("raises severity to the max when folding (never downgrades)", async () => {
    await raiseSecurityAlert({ tenantId: 7, type: "failed_login_burst", dedupeKey: "k", title: "t", severity: "warning" })
    await raiseSecurityAlert({ tenantId: 7, type: "failed_login_burst", dedupeKey: "k", title: "t", severity: "critical" })
    await raiseSecurityAlert({ tenantId: 7, type: "failed_login_burst", dedupeKey: "k", title: "t", severity: "info" })
    expect(alerts[0].severity).toBe("critical")
  })

  it("suppresses the notification when the per-tenant alert-notify cap is hit", async () => {
    mock.checkRateLimit.mockResolvedValue({ allowed: false, remaining: 0, retryAfter: 60 })
    const res = await raiseSecurityAlert({ tenantId: 7, type: "new_admin", dedupeKey: "new-admin:9", title: "New admin" })
    expect(res.isNew).toBe(true)
    expect(res.notified).toBe(false)
    expect(mock.enqueueNotification).not.toHaveBeenCalled()
  })

  it("does not notify when the tenant has no active security admins", async () => {
    admins = []
    const res = await raiseSecurityAlert({ tenantId: 7, type: "new_admin", dedupeKey: "new-admin:9", title: "New admin" })
    expect(res.notified).toBe(false)
    expect(mock.enqueueNotification).not.toHaveBeenCalled()
  })

  it("promotes a failed-login burst to critical after the threshold", async () => {
    for (let i = 0; i < 5; i++) {
      await onFailedLogin({ tenantId: 7, userId: 42, email: "user@example.test", ip: "1.1.1.1" })
    }
    const burst = alerts.find((a) => a.dedupe_key === "failed-login:42")
    expect(burst?.occurrence_count).toBe(5)
    expect(burst?.severity).toBe("critical")
  })

  it("correlates a critical burst with a follow-on API-key creation into a compromise (lockout + session revocation)", async () => {
    for (let i = 0; i < 5; i++) {
      await onFailedLogin({ tenantId: 7, userId: 42, email: "user@example.test", ip: "1.1.1.1" })
    }
    await onApiKeyCreated({ tenantId: 7, keyId: 500, keyName: "ci-token", actorUserId: 42, ip: "1.1.1.1" })

    const compromise = alerts.find((a) => a.alert_type === "critical_compromise")
    expect(compromise).toBeTruthy()
    expect(compromise?.severity).toBe("critical")
    // Progressive lockout applied to the compromised account, scoped to its tenant.
    expect(lockedUsers).toHaveLength(1)
    expect(lockedUsers[0]).toMatchObject({ userId: 42, tenantId: 7 })
    // Every active session revoked.
    expect(mock.revokeAllSessionsForUser).toHaveBeenCalledWith(42, expect.objectContaining({ reason: expect.stringContaining("security_compromise") }))
  })

  it("does NOT escalate when a sensitive change has no correlated critical burst", async () => {
    await onApiKeyCreated({ tenantId: 7, keyId: 501, keyName: "safe-token", actorUserId: 77, ip: "2.2.2.2" })
    expect(alerts.find((a) => a.alert_type === "critical_compromise")).toBeUndefined()
    expect(mock.revokeAllSessionsForUser).not.toHaveBeenCalled()
    expect(lockedUsers).toHaveLength(0)
  })

  it("resolves the open failed-login burst on a successful login", async () => {
    await onFailedLogin({ tenantId: 7, userId: 42, email: "user@example.test" })
    await onSuccessfulLogin({ tenantId: 7, userId: 42 })
    const burst = alerts.find((a) => a.dedupe_key === "failed-login:42")
    expect(burst?.status).toBe("resolved")
  })

  it("skips alerting entirely for a pre-auth failed login with no resolvable tenant", async () => {
    await onFailedLogin({ tenantId: null, userId: 42, email: "user@example.test" })
    expect(alerts).toHaveLength(0)
    expect(mock.connQuery).not.toHaveBeenCalled()
  })
})

describe("security-alerts triage tenant scoping", () => {
  it("refuses to acknowledge/resolve an alert owned by another tenant", async () => {
    await raiseSecurityAlert({ tenantId: 7, type: "new_admin", dedupeKey: "new-admin:1", title: "t" })
    const alertId = alerts[0].id
    // Wrong tenant → no row updated.
    const cross = await updateAlertStatus(999, alertId, "resolved", 1)
    expect(cross).toBe(false)
    expect(alerts[0].status).toBe("open")
    // Correct tenant → updated.
    const own = await updateAlertStatus(7, alertId, "resolved", 1)
    expect(own).toBe(true)
    expect(alerts[0].status).toBe("resolved")
  })

  it("lists only the requesting tenant's alerts", async () => {
    await raiseSecurityAlert({ tenantId: 7, type: "new_admin", dedupeKey: "a", title: "t" })
    await raiseSecurityAlert({ tenantId: 8, type: "new_admin", dedupeKey: "b", title: "t" })
    const list = await listSecurityAlerts(7)
    expect(list).toHaveLength(1)
    expect(list[0].tenantId).toBe(7)
  })
})
