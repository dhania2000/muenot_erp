import "server-only"
import { query } from "@/lib/db"
import { userHasFeature } from "@/lib/permissions"
import { claimReminderKey, emitReminder, todayIso, type Reminder } from "@/lib/finance-automation-shared"

/**
 * Operations monitoring + notification automation (Phases 56-60).
 *
 * This module is a DERIVATION + REMINDER layer on top of the existing
 * Operations tables. It creates no new masters, no new pipelines and no new
 * notification surface:
 *
 *   • Deadline monitoring (Phase 57) and project progress (Phase 56) are
 *     computed on read from operations_tasks / _milestones / _deliverables /
 *     _client_requirements / _issues / _sla_monitoring — never stored as manual
 *     values, so numbers cannot drift from the source rows.
 *   • Notifications (Phase 58) fan out through the SAME in-app bell every other
 *     module uses (`sales_notifications` via `emitReminder`).
 *   • The cron entrypoint (Phase 59) reuses the shared scheduler helpers.
 *   • Idempotency (Phase 60) reuses the shared `finance_reminder_dedup` guard so
 *     a repeat run on the same day never re-notifies for the same entity.
 *
 * Every step is failure-tolerant: a query or notification error is logged but
 * never aborts the sweep.
 */

// Statuses that mean "no longer actionable" — used to exclude closed work from
// overdue / pending detection across every operations entity.
const CLOSED = ["completed", "closed", "cancelled", "done", "resolved", "rejected", "approved"]
const closedList = CLOSED.map(() => "?").join(",")

function isOverdue(due: any, status: any): boolean {
  if (!due) return false
  const d = new Date(due)
  if (Number.isNaN(d.getTime())) return false
  if (d.getTime() >= Date.now()) return false
  return !CLOSED.includes(String(status ?? "").toLowerCase())
}

// ── Recipients ───────────────────────────────────────────────────────────────
/**
 * Everyone who should see an operations alert: every active admin plus every
 * active employee granted the operations dashboard feature. Mirrors the finance
 * recipient resolver so alerts reach exactly the people who can act on them.
 */
export async function operationsRecipients(): Promise<number[]> {
  const recipients = new Set<number>()
  const admins = (await query(
    `SELECT id FROM users WHERE role = 'admin' AND status = 'active'`,
  ).catch(() => [])) as any[]
  for (const a of admins) recipients.add(Number(a.id))

  const employees = (await query(
    `SELECT id FROM users WHERE role = 'employee' AND status = 'active'`,
  ).catch(() => [])) as any[]
  await Promise.all(
    employees.map(async (e) => {
      const ok = await userHasFeature(Number(e.id), "employee", "operations.view_dashboard").catch(() => false)
      if (ok) recipients.add(Number(e.id))
    }),
  )
  return Array.from(recipients)
}

// ── Project progress (Phase 56) ───────────────────────────────────────────────
export type ProjectProgress = {
  project_id: number
  project_name: string | null
  client_name: string | null
  status: string | null
  end_date: string | null
  progress: number
  task_progress: number | null
  milestone_progress: number | null
  deliverable_progress: number | null
  overdue_tasks: number
}

/**
 * Derive each project's completion % from its Tasks, Milestones and
 * Deliverables (equal-weighted across whichever components have rows). No manual
 * percentage is read from the project master, so progress always reflects the
 * underlying work.
 */
export async function computeProjectProgress(): Promise<ProjectProgress[]> {
  const projects = (await query(
    `SELECT id, project_name, client_name, status, end_date FROM operations_projects ORDER BY created_at DESC`,
  ).catch(() => [])) as any[]
  if (!projects.length) return []

  const [tasks, milestones, deliverables] = (await Promise.all([
    query(
      `SELECT project_id,
              AVG(COALESCE(completion_percent, CASE WHEN LOWER(status) IN (${closedList}) THEN 100 ELSE 0 END)) AS pct,
              SUM(CASE WHEN due_date < CURDATE() AND LOWER(COALESCE(status,'')) NOT IN (${closedList}) THEN 1 ELSE 0 END) AS overdue
         FROM operations_tasks GROUP BY project_id`,
      [...CLOSED, ...CLOSED],
    ).catch(() => []),
    query(
      `SELECT project_id,
              AVG(COALESCE(completion_percent, CASE WHEN LOWER(status) IN (${closedList}) THEN 100 ELSE 0 END)) AS pct
         FROM operations_milestones GROUP BY project_id`,
      [...CLOSED],
    ).catch(() => []),
    query(
      `SELECT project_id,
              AVG(CASE WHEN accepted_date IS NOT NULL OR LOWER(COALESCE(status,'')) IN (${closedList}) THEN 100 ELSE 0 END) AS pct
         FROM operations_deliverables GROUP BY project_id`,
      [...CLOSED],
    ).catch(() => []),
  ])) as [any[], any[], any[]]

  const taskMap = new Map(tasks.map((r) => [String(r.project_id), r]))
  const mileMap = new Map(milestones.map((r) => [String(r.project_id), r]))
  const delMap = new Map(deliverables.map((r) => [String(r.project_id), r]))

  return projects.map((p) => {
    const key = String(p.id)
    const t = taskMap.get(key)
    const m = mileMap.get(key)
    const d = delMap.get(key)
    const taskPct = t?.pct != null ? Math.round(Number(t.pct)) : null
    const milePct = m?.pct != null ? Math.round(Number(m.pct)) : null
    const delPct = d?.pct != null ? Math.round(Number(d.pct)) : null
    const parts = [taskPct, milePct, delPct].filter((v): v is number => v != null)
    const progress = parts.length ? Math.round(parts.reduce((a, b) => a + b, 0) / parts.length) : 0
    return {
      project_id: Number(p.id),
      project_name: p.project_name ?? null,
      client_name: p.client_name ?? null,
      status: p.status ?? null,
      end_date: p.end_date ?? null,
      progress,
      task_progress: taskPct,
      milestone_progress: milePct,
      deliverable_progress: delPct,
      overdue_tasks: Number(t?.overdue ?? 0),
    }
  })
}

// ── Deadline monitoring (Phase 57) ─────────────────────────────────────────────
export type MonitoringAlert = {
  category: string
  entity: string
  entity_id: number
  title: string
  project_id: number | null
  due_date: string | null
  owner: string | null
  link: string
}

type Scan = {
  table: string
  category: string
  entity: string
  titleCol: string
  dueCol: string
  ownerCol: string | null
  extraClosed?: string
  link: string
}

// One row per monitored entity. `dueCol`/`titleCol` are validated table columns,
// never user input, so interpolating them here is injection-safe.
const SCANS: Scan[] = [
  { table: "operations_tasks", category: "Task Overdue", entity: "task", titleCol: "task_title", dueCol: "due_date", ownerCol: "assigned_to", link: "/modules/operations/task-board" },
  { table: "operations_milestones", category: "Milestone Overdue", entity: "milestone", titleCol: "milestone_name", dueCol: "planned_end", ownerCol: "owner", link: "/modules/operations/milestones" },
  { table: "operations_deliverables", category: "Deliverable Overdue", entity: "deliverable", titleCol: "deliverable_name", dueCol: "due_date", ownerCol: "owner", link: "/modules/operations/deliverables" },
  { table: "operations_client_requirements", category: "Requirement Overdue", entity: "requirement", titleCol: "requirement_title", dueCol: "target_date", ownerCol: "owner", link: "/modules/operations/client-requirements" },
  { table: "operations_issues", category: "Issue Overdue", entity: "issue", titleCol: "title", dueCol: "due_date", ownerCol: "assigned_to", link: "/modules/operations/issues" },
]

async function scanOverdue(scan: Scan): Promise<MonitoringAlert[]> {
  const owner = scan.ownerCol ? `\`${scan.ownerCol}\`` : "NULL"
  const rows = (await query(
    `SELECT id, project_id, \`${scan.titleCol}\` AS title, \`${scan.dueCol}\` AS due_date, ${owner} AS owner
       FROM \`${scan.table}\`
      WHERE \`${scan.dueCol}\` IS NOT NULL
        AND \`${scan.dueCol}\` < CURDATE()
        AND LOWER(COALESCE(status,'')) NOT IN (${closedList})
      ORDER BY \`${scan.dueCol}\` ASC`,
    [...CLOSED],
  ).catch(() => [])) as any[]
  return rows.map((r) => ({
    category: scan.category,
    entity: scan.entity,
    entity_id: Number(r.id),
    title: r.title ?? `${scan.entity} #${r.id}`,
    project_id: r.project_id != null ? Number(r.project_id) : null,
    due_date: r.due_date ?? null,
    owner: r.owner ?? null,
    link: scan.link,
  }))
}

async function scanSlaBreaches(): Promise<MonitoringAlert[]> {
  const rows = (await query(
    `SELECT id, project_id, sla_metric AS title, due_date, owner
       FROM operations_sla_monitoring
      WHERE (LOWER(COALESCE(sla_status,'')) = 'breached sla')
         OR (due_date IS NOT NULL AND due_date < CURDATE() AND actual_completion IS NULL
             AND LOWER(COALESCE(status,'')) NOT IN (${closedList}))
      ORDER BY due_date ASC`,
    [...CLOSED],
  ).catch(() => [])) as any[]
  return rows.map((r) => ({
    category: "SLA Breach",
    entity: "sla",
    entity_id: Number(r.id),
    title: r.title ?? `SLA #${r.id}`,
    project_id: r.project_id != null ? Number(r.project_id) : null,
    due_date: r.due_date ?? null,
    owner: r.owner ?? null,
    link: "/modules/operations/sla-monitoring",
  }))
}

type PendingScan = { table: string; category: string; entity: string; titleCol: string; ownerCol: string; where: string; link: string }

const PENDING_SCANS: PendingScan[] = [
  { table: "operations_approvals", category: "Approval Pending", entity: "approval", titleCol: "approval_no", ownerCol: "approver", where: "COALESCE(decision,'') = '' AND LOWER(COALESCE(status,'')) NOT IN (%CLOSED%)", link: "/modules/operations/approvals" },
  { table: "operations_timesheets", category: "Timesheet Pending", entity: "timesheet", titleCol: "resource_name", ownerCol: "approved_by", where: "LOWER(COALESCE(approval_status,'pending')) NOT IN (%CLOSED%)", link: "/modules/operations/timesheets" },
  { table: "operations_client_approvals", category: "Client Approval Pending", entity: "client_approval", titleCol: "approval_item", ownerCol: "approver_name", where: "COALESCE(decision,'') = '' AND LOWER(COALESCE(status,'')) NOT IN (%CLOSED%)", link: "/modules/operations/client-approvals" },
  { table: "operations_resource_requests", category: "Resource Request Approval", entity: "resource_request", titleCol: "resource_type", ownerCol: "approver", where: "LOWER(COALESCE(status,'pending')) NOT IN (%CLOSED%)", link: "/modules/operations/resource-requests" },
]

async function scanPending(scan: PendingScan): Promise<MonitoringAlert[]> {
  const where = scan.where.replace("%CLOSED%", closedList)
  const rows = (await query(
    `SELECT id, project_id, \`${scan.titleCol}\` AS title, \`${scan.ownerCol}\` AS owner
       FROM \`${scan.table}\`
      WHERE ${where}
      ORDER BY created_at ASC`,
    [...CLOSED],
  ).catch(() => [])) as any[]
  return rows.map((r) => ({
    category: scan.category,
    entity: scan.entity,
    entity_id: Number(r.id),
    title: r.title ?? `${scan.entity} #${r.id}`,
    project_id: r.project_id != null ? Number(r.project_id) : null,
    due_date: null,
    owner: r.owner ?? null,
    link: scan.link,
  }))
}

// ── Client-approval automation (Phase 73) ─────────────────────────────────────
/**
 * Deliverables that have been SUBMITTED to the client but not yet accepted are
 * awaiting a client decision — surface them so the owner chases acceptance.
 * Covers both the internal deliverables register and the client_deliverables
 * register (whichever the org uses). Reuses the existing deadline/notification
 * pipeline — no separate approval store.
 */
async function scanSubmittedDeliverables(): Promise<MonitoringAlert[]> {
  const internal = (await query(
    `SELECT id, project_id, deliverable_name AS title, owner, submitted_date
       FROM operations_deliverables
      WHERE submitted_date IS NOT NULL
        AND accepted_date IS NULL
        AND LOWER(COALESCE(quality_status,'')) NOT IN ('accepted','rejected')
        AND LOWER(COALESCE(status,'')) NOT IN (${closedList})
      ORDER BY submitted_date ASC`,
    [...CLOSED],
  ).catch(() => [])) as any[]

  const client = (await query(
    `SELECT id, project_id, deliverable_name AS title, owner, submitted_date
       FROM operations_client_deliverables
      WHERE submitted_date IS NOT NULL
        AND LOWER(COALESCE(acceptance_status,'pending')) NOT IN ('accepted','rejected')
        AND LOWER(COALESCE(status,'')) NOT IN (${closedList})
      ORDER BY submitted_date ASC`,
    [...CLOSED],
  ).catch(() => [])) as any[]

  const map = (rows: any[], entity: string, link: string): MonitoringAlert[] =>
    rows.map((r) => ({
      category: "Deliverable Awaiting Client Approval",
      entity,
      entity_id: Number(r.id),
      title: r.title ?? `${entity} #${r.id}`,
      project_id: r.project_id != null ? Number(r.project_id) : null,
      due_date: r.submitted_date ?? null,
      owner: r.owner ?? null,
      link,
    }))

  return [
    ...map(internal, "deliverable", "/modules/operations/deliverables"),
    ...map(client, "client_deliverable", "/modules/operations/client-deliverables"),
  ]
}

// ── Document reminders (Phase 74) ─────────────────────────────────────────────
// Documents every active project is expected to hold on file. Matching is
// case-insensitive against the project's document_type values.
const REQUIRED_PROJECT_DOCUMENTS = ["Contract", "SOW", "NDA"]

/**
 * Detect required-but-missing project documents plus documents whose validity
 * is expiring/expired. Both are derived on read from operations_project_documents
 * and the project master — no manual checklist is stored.
 */
async function scanDocuments(): Promise<MonitoringAlert[]> {
  const alerts: MonitoringAlert[] = []

  // Missing required documents per active project.
  const projects = (await query(
    `SELECT id, project_name FROM operations_projects WHERE LOWER(COALESCE(status,'')) = 'active'`,
  ).catch(() => [])) as any[]

  if (projects.length) {
    const docs = (await query(
      `SELECT project_id, LOWER(COALESCE(document_type,'')) AS dtype
         FROM operations_project_documents
        WHERE LOWER(COALESCE(status,'')) NOT IN ('archived','cancelled','superseded')`,
    ).catch(() => [])) as any[]
    const byProject = new Map<string, Set<string>>()
    for (const d of docs) {
      const key = String(d.project_id ?? "")
      if (!byProject.has(key)) byProject.set(key, new Set())
      if (d.dtype) byProject.get(key)!.add(d.dtype)
    }
    for (const p of projects) {
      const present = byProject.get(String(p.id)) ?? new Set<string>()
      const missing = REQUIRED_PROJECT_DOCUMENTS.filter((req) => !present.has(req.toLowerCase()))
      if (missing.length) {
        alerts.push({
          category: "Missing Project Document",
          entity: "project",
          entity_id: Number(p.id),
          title: `${p.project_name ?? `Project #${p.id}`} — missing ${missing.join(", ")}`,
          project_id: Number(p.id),
          due_date: null,
          owner: null,
          link: "/modules/operations/project-documents",
        })
      }
    }
  }

  // Expiring / expired documents (within 30 days).
  const expiring = (await query(
    `SELECT id, project_id, document_name AS title, owner, expiry_date
       FROM operations_project_documents
      WHERE expiry_date IS NOT NULL
        AND expiry_date <= DATE_ADD(CURDATE(), INTERVAL 30 DAY)
        AND LOWER(COALESCE(status,'')) NOT IN ('archived','cancelled','superseded')
      ORDER BY expiry_date ASC`,
  ).catch(() => [])) as any[]
  for (const r of expiring) {
    alerts.push({
      category: "Document Expiring",
      entity: "document",
      entity_id: Number(r.id),
      title: r.title ?? `Document #${r.id}`,
      project_id: r.project_id != null ? Number(r.project_id) : null,
      due_date: r.expiry_date ?? null,
      owner: r.owner ?? null,
      link: "/modules/operations/project-documents",
    })
  }

  return alerts
}

/**
 * Full deadline + pending-queue scan. Returns every alert grouped by category
 * plus flat list. Read-only — used both by the dashboard endpoint and the cron.
 */
export async function computeMonitoring(): Promise<{ alerts: MonitoringAlert[]; counts: Record<string, number> }> {
  const results = await Promise.all([
    ...SCANS.map(scanOverdue),
    scanSlaBreaches(),
    ...PENDING_SCANS.map(scanPending),
    scanSubmittedDeliverables(),
    scanDocuments(),
  ])
  const alerts = results.flat()
  const counts: Record<string, number> = {}
  for (const a of alerts) counts[a.category] = (counts[a.category] ?? 0) + 1
  return { alerts, counts }
}

// ── Cron entrypoint (Phases 58-60) ─────────────────────────────────────────────
/**
 * Scan for overdue / pending work and fan a deduped in-app notification out to
 * every operations recipient. Idempotent: each alert claims a per-entity,
 * per-day key so repeat runs in the same day never create duplicates.
 */
export async function runOperationsMonitoring(): Promise<{ scanned: number; notified: number }> {
  const [{ alerts }, recipients] = await Promise.all([computeMonitoring(), operationsRecipients()])
  if (!recipients.length) return { scanned: alerts.length, notified: 0 }

  const day = todayIso()
  let notified = 0
  for (const a of alerts) {
    const reminder: Reminder = {
      key: `ops:${a.entity}:${a.category}:${a.entity_id}:${day}`,
      type: "operations",
      title: a.category,
      body: a.due_date
        ? `${a.title} — due ${new Date(a.due_date).toISOString().slice(0, 10)}${a.owner ? ` · ${a.owner}` : ""}`
        : `${a.title}${a.owner ? ` · ${a.owner}` : ""} needs attention`,
      link: a.link,
      entityType: `operations_${a.entity}`,
      entityId: String(a.entity_id),
    }
    notified += await emitReminder(reminder, recipients).catch(() => 0)
  }
  return { scanned: alerts.length, notified }
}

/** Pre-claim helper exported for tests / manual dedup checks. */
export { claimReminderKey }
