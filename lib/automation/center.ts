import "server-only"
import { query } from "@/lib/db"
import { ensureWorkflowSchema } from "@/lib/workflows/schema"
import { validateWorkflow } from "@/lib/workflows/model"
import { ensureNotificationsSchema } from "@/lib/notifications"
import { isEmailConfigured, hydrateDepartmentSMTP } from "@/lib/email"

// ---------------------------------------------------------------------------
// Automation Center — read-only aggregation over the ALREADY-BUILT automation
// subsystems. Nothing here creates a second engine: it observes the existing
// workflow engine (erp_workflow_*), the global notifications table and the
// per-module email tables so tenant admins get one place to monitor everything.
// ---------------------------------------------------------------------------

const parse = (v: unknown) => {
  try {
    return typeof v === "string" ? JSON.parse(v) : v
  } catch {
    return null
  }
}

// A run of the workflow engine IS an automation event instance. We surface it
// with the vocabulary Spec 48 asks for (event type / module / entity / …).
export type AutomationEvent = {
  id: number
  workflowId: number
  workflowName: string | null
  module: string | null
  trigger: string | null
  recordId: number
  subscriberCount: number
  status: string
  step: number
  error: string | null
  createdAt: string
  processedAt: string | null
}

const TERMINAL = new Set(["completed", "skipped", "failed", "rejected", "cancelled"])

function toEvent(row: any): AutomationEvent {
  const snap = parse(row.snapshot) as { module?: string; trigger?: string; actions?: unknown[] } | null
  const status = String(row.status)
  return {
    id: Number(row.id),
    workflowId: Number(row.workflow_id),
    workflowName: row.name ?? null,
    module: snap?.module ?? null,
    trigger: snap?.trigger ?? null,
    recordId: Number(row.record_id),
    subscriberCount: Array.isArray(snap?.actions) ? snap!.actions!.length : 0,
    status,
    step: Number(row.cursor) + 1,
    error: row.error_code ?? null,
    createdAt: String(row.created_at),
    processedAt: TERMINAL.has(status) ? String(row.updated_at) : null,
  }
}

export type EventFilters = {
  module?: string
  status?: string
  from?: string
  to?: string
  search?: string
}

export async function automationEvents(tenant: number, filters: EventFilters = {}) {
  await ensureWorkflowSchema()
  const where: string[] = ["r.tenant_id = ?"]
  const args: unknown[] = [tenant]
  if (filters.status && filters.status !== "all") {
    where.push("r.status = ?")
    args.push(filters.status)
  }
  if (filters.from) {
    where.push("r.created_at >= ?")
    args.push(filters.from)
  }
  if (filters.to) {
    where.push("r.created_at <= ?")
    args.push(filters.to)
  }
  if (filters.search && /^\d+$/.test(filters.search)) {
    where.push("(r.id = ? OR r.record_id = ?)")
    args.push(Number(filters.search), Number(filters.search))
  }
  const clause = where.join(" AND ")

  const [runs, statusRows, subscribers, history] = await Promise.all([
    query<any[]>(
      `SELECT r.id, r.workflow_id, r.snapshot, r.record_id, r.status, r.cursor, r.error_code, r.created_at, r.updated_at, w.name
       FROM erp_workflow_runs r LEFT JOIN erp_workflows w ON w.id = r.workflow_id AND w.tenant_id = r.tenant_id
       WHERE ${clause} ORDER BY r.id DESC LIMIT 300`,
      args,
    ),
    query<{ status: string; n: number }[]>(
      "SELECT status, COUNT(*) AS n FROM erp_workflow_runs WHERE tenant_id = ? GROUP BY status",
      [tenant],
    ),
    query<any[]>(
      `SELECT w.id, w.name, w.definition, w.enabled, w.created_at,
        (SELECT COUNT(*) FROM erp_workflow_runs r WHERE r.tenant_id = w.tenant_id AND r.workflow_id = w.id) AS run_count
       FROM erp_workflows w WHERE w.tenant_id = ? ORDER BY w.id DESC LIMIT 200`,
      [tenant],
    ),
    query<any[]>(
      `SELECT e.id, e.run_id, e.step, e.event_type, e.actor_id, e.created_at
       FROM erp_workflow_events e WHERE e.tenant_id = ? ORDER BY e.id DESC LIMIT 200`,
      [tenant],
    ),
  ])

  let events = runs.map(toEvent)
  if (filters.module && filters.module !== "all") {
    events = events.filter((e) => e.module === filters.module)
  }

  const statusSummary: Record<string, number> = {}
  for (const r of statusRows) statusSummary[r.status] = Number(r.n)

  const moduleSummary: Record<string, number> = {}
  for (const e of events) {
    const key = e.module ?? "unknown"
    moduleSummary[key] = (moduleSummary[key] ?? 0) + 1
  }

  const subscriberRows = subscribers.map((row) => {
    const snap = parse(row.definition) as { module?: string; trigger?: string; actions?: unknown[] } | null
    return {
      id: Number(row.id),
      name: row.name as string,
      module: snap?.module ?? null,
      trigger: snap?.trigger ?? null,
      actionCount: Array.isArray(snap?.actions) ? snap!.actions!.length : 0,
      enabled: Boolean(row.enabled),
      runCount: Number(row.run_count),
      createdAt: String(row.created_at),
    }
  })

  return {
    events,
    subscribers: subscriberRows,
    history: history.map((h) => ({
      id: Number(h.id),
      runId: Number(h.run_id),
      step: Number(h.step) + 1,
      type: String(h.event_type),
      actorId: h.actor_id == null ? null : Number(h.actor_id),
      createdAt: String(h.created_at),
    })),
    failed: events.filter((e) => e.status === "failed"),
    statusSummary,
    moduleSummary,
    total: events.length,
  }
}

export async function automationEventDetail(tenant: number, runId: number) {
  await ensureWorkflowSchema()
  const [run] = await query<any[]>(
    `SELECT r.*, w.name FROM erp_workflow_runs r LEFT JOIN erp_workflows w ON w.id = r.workflow_id AND w.tenant_id = r.tenant_id
     WHERE r.tenant_id = ? AND r.id = ?`,
    [tenant, runId],
  )
  if (!run) return null
  const timeline = await query<any[]>(
    "SELECT step, event_type, actor_id, created_at FROM erp_workflow_events WHERE tenant_id = ? AND run_id = ? ORDER BY id ASC",
    [tenant, runId],
  )
  const snapshot = parse(run.snapshot)
  let definition: unknown = snapshot
  try {
    definition = validateWorkflow(snapshot)
  } catch {
    /* Keep raw snapshot if it predates current validation. */
  }
  return {
    event: toEvent(run),
    requestedBy: run.requested_by == null ? null : Number(run.requested_by),
    availableAt: run.available_at ? String(run.available_at) : null,
    definition,
    timeline: timeline.map((t) => ({
      step: Number(t.step) + 1,
      type: String(t.event_type),
      actorId: t.actor_id == null ? null : Number(t.actor_id),
      createdAt: String(t.created_at),
    })),
  }
}

// ---------------------------------------------------------------------------
// Notification Center (admin) — the delivery/monitoring view over the global
// `notifications` table plus workflow approval/notice deliveries. This is NOT
// the per-user notification bell; it is the administration engine.
// ---------------------------------------------------------------------------
export type NotificationFilters = {
  module?: string
  action?: string
  read?: string
  from?: string
  to?: string
  search?: string
}

export async function notificationCenter(filters: NotificationFilters = {}) {
  await ensureNotificationsSchema()
  const where: string[] = []
  const args: unknown[] = []
  if (filters.module && filters.module !== "all") {
    where.push("n.module_key = ?")
    args.push(filters.module)
  }
  if (filters.action && filters.action !== "all") {
    where.push("n.action = ?")
    args.push(filters.action)
  }
  if (filters.read === "read") where.push("n.is_read = 1")
  if (filters.read === "unread") where.push("n.is_read = 0")
  if (filters.from) {
    where.push("n.created_at >= ?")
    args.push(filters.from)
  }
  if (filters.to) {
    where.push("n.created_at <= ?")
    args.push(filters.to)
  }
  if (filters.search) {
    where.push("(n.title LIKE ? OR n.body LIKE ? OR u.name LIKE ?)")
    const like = `%${filters.search}%`
    args.push(like, like, like)
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : ""

  const [deliveries, summaryRows, moduleRows, actionRows] = await Promise.all([
    query<any[]>(
      `SELECT n.id, n.user_id, u.name AS recipient, n.actor_name, n.module_key, n.action, n.title, n.body, n.link, n.is_read, n.created_at
       FROM notifications n LEFT JOIN users u ON u.id = n.user_id ${clause} ORDER BY n.id DESC LIMIT 300`,
      args,
    ),
    query<{ total: number; unread: number }[]>(
      "SELECT COUNT(*) AS total, SUM(is_read = 0) AS unread FROM notifications",
    ),
    query<{ module_key: string | null; n: number }[]>(
      "SELECT module_key, COUNT(*) AS n FROM notifications GROUP BY module_key ORDER BY n DESC LIMIT 20",
    ),
    query<{ action: string; n: number }[]>(
      "SELECT action, COUNT(*) AS n FROM notifications GROUP BY action ORDER BY n DESC",
    ),
  ])

  const summary = summaryRows[0] ?? { total: 0, unread: 0 }
  return {
    deliveries: deliveries.map((d) => ({
      id: Number(d.id),
      userId: Number(d.user_id),
      recipient: d.recipient ?? `User #${d.user_id}`,
      actorName: d.actor_name ?? null,
      module: d.module_key ?? null,
      action: String(d.action),
      title: String(d.title),
      body: d.body ?? null,
      link: d.link ?? null,
      read: Boolean(d.is_read),
      createdAt: String(d.created_at),
    })),
    summary: { total: Number(summary.total ?? 0), unread: Number(summary.unread ?? 0) },
    modules: moduleRows.map((m) => ({ module: m.module_key ?? "system", count: Number(m.n) })),
    actions: actionRows.map((a) => ({ action: a.action, count: Number(a.n) })),
  }
}

// ---------------------------------------------------------------------------
// Email Center (admin) — a centralized monitor that READS the existing
// per-module email tables. It never replaces the module email pages and never
// sends mail itself. Each source is queried defensively so a module whose
// table has not been created yet is simply skipped.
// ---------------------------------------------------------------------------
type EmailSource = {
  module: string
  table: string
  sql: string
}

const EMAIL_SOURCES: EmailSource[] = [
  {
    module: "Sales",
    table: "sales_emails",
    sql: "SELECT id, to_email, to_name, subject, status, sent_at AS ts FROM sales_emails ORDER BY id DESC LIMIT 200",
  },
  {
    module: "Finance",
    table: "finance_emails",
    sql: "SELECT id, to_email, subject, status, COALESCE(sent_at, created_at) AS ts FROM finance_emails ORDER BY id DESC LIMIT 200",
  },
  {
    module: "HR",
    table: "hr_emails",
    sql: "SELECT id, to_email, to_name, subject, status, sent_at AS ts FROM hr_emails ORDER BY id DESC LIMIT 200",
  },
  {
    module: "Recruitment",
    table: "recruit_emails",
    sql: "SELECT id, to_email, to_name, subject, status, sent_at AS ts FROM recruit_emails ORDER BY id DESC LIMIT 200",
  },
  {
    module: "Operations",
    table: "operations_hub_emails",
    sql: "SELECT id, to_email, subject, status, sent_at AS ts FROM operations_hub_emails ORDER BY id DESC LIMIT 200",
  },
  {
    module: "Recruitment Hub",
    table: "recruit_hub_emails",
    sql: "SELECT id, to_email, subject, status, sent_at AS ts FROM recruit_hub_emails ORDER BY id DESC LIMIT 200",
  },
]

export type EmailFilters = {
  module?: string
  status?: string
  from?: string
  to?: string
  search?: string
}

const DEPARTMENTS = ["sales", "hr", "finance", "operations", "recruit"] as const

export async function emailCenter(filters: EmailFilters = {}) {
  const rowsPerSource = await Promise.all(
    EMAIL_SOURCES.map(async (source) => {
      try {
        const rows = await query<any[]>(source.sql)
        return rows.map((r) => ({
          uid: `${source.module}-${r.id}`,
          module: source.module,
          recipient: String(r.to_email),
          name: r.to_name ?? null,
          subject: String(r.subject),
          status: String(r.status),
          sentAt: r.ts ? String(r.ts) : null,
        }))
      } catch {
        // Table not created yet for this tenant/module — skip silently.
        return []
      }
    }),
  )

  let activity = rowsPerSource.flat()
  activity.sort((a, b) => {
    const ta = a.sentAt ? Date.parse(a.sentAt) : 0
    const tb = b.sentAt ? Date.parse(b.sentAt) : 0
    return tb - ta
  })

  const summary = {
    total: activity.length,
    sent: activity.filter((a) => /sent|opened/i.test(a.status)).length,
    failed: activity.filter((a) => /fail/i.test(a.status)).length,
    draft: activity.filter((a) => /draft|queued|scheduled/i.test(a.status)).length,
  }
  const moduleSummary: Record<string, number> = {}
  for (const a of activity) moduleSummary[a.module] = (moduleSummary[a.module] ?? 0) + 1

  if (filters.module && filters.module !== "all") {
    activity = activity.filter((a) => a.module === filters.module)
  }
  if (filters.status && filters.status !== "all") {
    activity = activity.filter((a) => a.status.toLowerCase() === filters.status!.toLowerCase())
  }
  if (filters.from) {
    const t = Date.parse(filters.from)
    activity = activity.filter((a) => a.sentAt && Date.parse(a.sentAt) >= t)
  }
  if (filters.to) {
    const t = Date.parse(filters.to)
    activity = activity.filter((a) => a.sentAt && Date.parse(a.sentAt) <= t)
  }
  if (filters.search) {
    const q = filters.search.toLowerCase()
    activity = activity.filter(
      (a) =>
        a.recipient.toLowerCase().includes(q) ||
        a.subject.toLowerCase().includes(q) ||
        (a.name ?? "").toLowerCase().includes(q),
    )
  }

  const senders = await Promise.all(
    DEPARTMENTS.map(async (dept) => {
      try {
        await hydrateDepartmentSMTP(dept)
        return { department: dept, configured: isEmailConfigured(dept) }
      } catch {
        return { department: dept, configured: false }
      }
    }),
  )

  return {
    activity: activity.slice(0, 300),
    summary,
    modules: Object.entries(moduleSummary).map(([module, count]) => ({ module, count })),
    senders,
  }
}

export async function automationOverview(tenant: number) {
  const [events, notifications, email] = await Promise.all([
    automationEvents(tenant),
    notificationCenter(),
    emailCenter(),
  ])
  const activeSubscribers = events.subscribers.filter((s) => s.enabled).length
  const pending = ["queued", "waiting", "approval", "external"].reduce(
    (sum, s) => sum + (events.statusSummary[s] ?? 0),
    0,
  )
  const totalRuns = Object.values(events.statusSummary).reduce((a, b) => a + b, 0)
  return {
    workflows: {
      total: events.subscribers.length,
      active: activeSubscribers,
      runs: totalRuns,
      pending,
      failed: events.statusSummary.failed ?? 0,
    },
    events: {
      recent: events.total,
      failed: events.failed.length,
    },
    notifications: {
      total: notifications.summary.total,
      unread: notifications.summary.unread,
    },
    email: {
      total: email.summary.total,
      failed: email.summary.failed,
      sendersConfigured: email.senders.filter((s) => s.configured).length,
      sendersTotal: email.senders.length,
    },
  }
}
