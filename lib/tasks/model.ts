import "server-only"
import { randomUUID } from "node:crypto"
import { query, withTransaction } from "@/lib/db"
import { getCurrentActor } from "@/lib/actor-context"
import { currentTenantId, currentTenantIdOrNull } from "@/lib/tenant-scope"
import { ensureTaskSchema } from "./schema"

// ---------------------------------------------------------------------------
// Enums / constants
// ---------------------------------------------------------------------------

export const TASK_STATUSES = ["To Do", "In Progress", "Blocked", "In Review", "Done", "Cancelled"] as const
export const TASK_PRIORITIES = ["Low", "Medium", "High", "Urgent"] as const
export const TASK_TYPES = ["Task", "Bug", "Feature", "Approval", "Chore"] as const
export const RECURRENCE_OPTIONS = ["none", "daily", "weekly", "monthly"] as const
export const APPROVAL_STATUSES = ["none", "pending", "approved", "rejected"] as const

export type TaskStatus = (typeof TASK_STATUSES)[number]
export type TaskPriority = (typeof TASK_PRIORITIES)[number]
export type Recurrence = (typeof RECURRENCE_OPTIONS)[number]

export type TaskRow = {
  id: number
  title: string
  description: string | null
  task_type: string
  status: string
  priority: string
  assignee_id: number | null
  assignee_name: string | null
  team_id: number | null
  team_name: string | null
  reporter_id: number | null
  reporter_name: string | null
  start_date: string | null
  due_date: string | null
  completed_at: string | null
  progress: number
  recurrence: string
  recurrence_interval: number
  recurrence_until: string | null
  recurrence_parent_id: number | null
  approval_required: number
  approval_status: string
  approver_id: number | null
  approver_name: string | null
  approval_note: string | null
  approval_at: string | null
  source_module: string | null
  source_entity: string | null
  source_entity_id: string | null
  created_by: number | null
  created_by_name: string | null
  created_at: string
  updated_at: string
}

export class TaskError extends Error {
  status: number
  constructor(message: string, status = 400) {
    super(message)
    this.name = "TaskError"
    this.status = status
  }
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function str(v: unknown, max: number): string {
  return typeof v === "string" ? v.slice(0, max) : ""
}
function reqStr(v: unknown, max: number, field: string): string {
  const s = str(v, max).trim()
  if (!s) throw new TaskError(`${field} is required`)
  return s
}
function oneOf<T extends readonly string[]>(v: unknown, allowed: T, fallback: T[number]): T[number] {
  return typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T[number]) : fallback
}
function posIntOrNull(v: unknown): number | null {
  const n = Number(v)
  return Number.isSafeInteger(n) && n > 0 ? n : null
}
function dateOrNull(v: unknown): string | null {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null
  return v
}

// ---------------------------------------------------------------------------
// Notifications — direct, per-user in-app notification via the engine
// ---------------------------------------------------------------------------

async function notifyUser(userId: number | null | undefined, title: string, body: string, taskId: number) {
  const tenantId = currentTenantIdOrNull()
  const actor = getCurrentActor()
  if (tenantId == null || !userId || userId === actor?.userId) return
  try {
    const { ensureNotificationEngineSchema } = await import("@/lib/notification-engine/schema")
    const { enqueueNotification } = await import("@/lib/notification-engine/service")
    await ensureNotificationEngineSchema()
    await withTransaction(async (c) =>
      enqueueNotification(c, {
        tenantId,
        userId,
        channel: "in_app",
        key: `task:${randomUUID()}`,
        title: title.slice(0, 255),
        body: body.slice(0, 4000),
        link: `/modules/tasks?task=${taskId}`,
        context: { taskId, actorId: actor?.userId, actorName: actor?.name },
      }),
    )
  } catch (err) {
    console.error("[v0] task notifyUser failed:", err)
  }
}

async function logActivity(taskId: number, action: string, detail: string | null) {
  const tenantId = currentTenantIdOrNull()
  const actor = getCurrentActor()
  if (tenantId == null) return
  try {
    await query(
      `INSERT INTO task_activity (tenant_id, task_id, actor_id, actor_name, action, detail) VALUES (?, ?, ?, ?, ?, ?)`,
      [tenantId, taskId, actor?.userId ?? null, actor?.name ?? null, action.slice(0, 60), detail?.slice(0, 500) ?? null],
    )
  } catch (err) {
    console.error("[v0] task logActivity failed:", err)
  }
}

// ---------------------------------------------------------------------------
// Ownership + fetch
// ---------------------------------------------------------------------------

async function getTaskOrThrow(id: number): Promise<TaskRow> {
  const tenantId = currentTenantId()
  const rows = await query<TaskRow[]>(`SELECT * FROM tasks WHERE tenant_id = ? AND id = ? LIMIT 1`, [tenantId, id])
  if (!rows[0]) throw new TaskError("Task not found", 404)
  return rows[0]
}

/** True when a task has at least one dependency that is not yet Done/Cancelled. */
async function isBlockedByDeps(taskId: number): Promise<boolean> {
  const tenantId = currentTenantId()
  const rows = await query<any[]>(
    `SELECT COUNT(*) AS blocking
       FROM task_dependencies d
       JOIN tasks t ON t.id = d.depends_on_id AND t.tenant_id = d.tenant_id
      WHERE d.tenant_id = ? AND d.task_id = ?
        AND t.status NOT IN ('Done', 'Cancelled')`,
    [tenantId, taskId],
  )
  return Number(rows[0]?.blocking ?? 0) > 0
}

// ---------------------------------------------------------------------------
// List / detail
// ---------------------------------------------------------------------------

export type TaskFilters = {
  status?: string
  priority?: string
  assigneeId?: number
  q?: string
  view?: "all" | "mine" | "reported"
  overdue?: boolean
}

export async function listTasks(filters: TaskFilters): Promise<Array<TaskRow & { blocked: boolean }>> {
  await ensureTaskSchema()
  const tenantId = currentTenantId()
  const actor = getCurrentActor()
  const where: string[] = ["tenant_id = ?"]
  const params: any[] = [tenantId]

  if (filters.status && (TASK_STATUSES as readonly string[]).includes(filters.status)) {
    where.push("status = ?")
    params.push(filters.status)
  }
  if (filters.priority && (TASK_PRIORITIES as readonly string[]).includes(filters.priority)) {
    where.push("priority = ?")
    params.push(filters.priority)
  }
  if (filters.assigneeId) {
    where.push("assignee_id = ?")
    params.push(filters.assigneeId)
  }
  if (filters.view === "mine" && actor?.userId) {
    where.push("assignee_id = ?")
    params.push(actor.userId)
  }
  if (filters.view === "reported" && actor?.userId) {
    where.push("reporter_id = ?")
    params.push(actor.userId)
  }
  if (filters.q) {
    where.push("(title LIKE ? OR description LIKE ?)")
    const like = `%${filters.q.slice(0, 120)}%`
    params.push(like, like)
  }
  if (filters.overdue) {
    where.push("due_date IS NOT NULL AND due_date < CURDATE() AND status NOT IN ('Done', 'Cancelled')")
  }

  const rows = await query<TaskRow[]>(
    `SELECT * FROM tasks WHERE ${where.join(" AND ")} ORDER BY
       FIELD(status, 'Blocked','To Do','In Progress','In Review','Done','Cancelled'),
       FIELD(priority, 'Urgent','High','Medium','Low'),
       (due_date IS NULL), due_date ASC, id DESC
     LIMIT 500`,
    params,
  )
  if (rows.length === 0) return []

  // Batch-resolve which listed tasks are blocked by an incomplete dependency.
  const ids = rows.map((r) => r.id)
  const placeholders = ids.map(() => "?").join(", ")
  const blockedRows = await query<any[]>(
    `SELECT DISTINCT d.task_id
       FROM task_dependencies d
       JOIN tasks t ON t.id = d.depends_on_id AND t.tenant_id = d.tenant_id
      WHERE d.tenant_id = ? AND d.task_id IN (${placeholders})
        AND t.status NOT IN ('Done', 'Cancelled')`,
    [tenantId, ...ids],
  )
  const blockedSet = new Set(blockedRows.map((r) => Number(r.task_id)))
  return rows.map((r) => ({ ...r, blocked: blockedSet.has(Number(r.id)) }))
}

export async function getTaskDetail(id: number) {
  await ensureTaskSchema()
  const tenantId = currentTenantId()
  const task = await getTaskOrThrow(id)
  const [checklist, dependencies, dependents, comments, attachments, activity] = await Promise.all([
    query<any[]>(
      `SELECT * FROM task_checklist_items WHERE tenant_id = ? AND task_id = ? ORDER BY sort_order ASC, id ASC`,
      [tenantId, id],
    ),
    query<any[]>(
      `SELECT d.id AS dep_id, t.* FROM task_dependencies d
         JOIN tasks t ON t.id = d.depends_on_id AND t.tenant_id = d.tenant_id
        WHERE d.tenant_id = ? AND d.task_id = ? ORDER BY d.id ASC`,
      [tenantId, id],
    ),
    query<any[]>(
      `SELECT t.id, t.title, t.status FROM task_dependencies d
         JOIN tasks t ON t.id = d.task_id AND t.tenant_id = d.tenant_id
        WHERE d.tenant_id = ? AND d.depends_on_id = ? ORDER BY d.id ASC`,
      [tenantId, id],
    ),
    query<any[]>(`SELECT * FROM task_comments WHERE tenant_id = ? AND task_id = ? ORDER BY id ASC`, [tenantId, id]),
    query<any[]>(`SELECT * FROM task_attachments WHERE tenant_id = ? AND task_id = ? ORDER BY id DESC`, [tenantId, id]),
    query<any[]>(`SELECT * FROM task_activity WHERE tenant_id = ? AND task_id = ? ORDER BY id DESC LIMIT 50`, [
      tenantId,
      id,
    ]),
  ])
  const blocked = await isBlockedByDeps(id)
  return { task: { ...task, blocked }, checklist, dependencies, dependents, comments, attachments, activity }
}

// ---------------------------------------------------------------------------
// Create / update / delete
// ---------------------------------------------------------------------------

function buildWritableFields(body: any) {
  const recurrence = oneOf(body.recurrence, RECURRENCE_OPTIONS, "none")
  return {
    title: reqStr(body.title, 255, "Title"),
    description: body.description != null ? str(body.description, 20000) : null,
    task_type: oneOf(body.task_type, TASK_TYPES, "Task"),
    priority: oneOf(body.priority, TASK_PRIORITIES, "Medium"),
    assignee_id: posIntOrNull(body.assignee_id),
    assignee_name: body.assignee_name != null ? str(body.assignee_name, 150) : null,
    team_id: posIntOrNull(body.team_id),
    team_name: body.team_name != null ? str(body.team_name, 150) : null,
    start_date: dateOrNull(body.start_date),
    due_date: dateOrNull(body.due_date),
    recurrence,
    recurrence_interval: Math.min(Math.max(Number(body.recurrence_interval) || 1, 1), 365),
    recurrence_until: dateOrNull(body.recurrence_until),
    approval_required: body.approval_required ? 1 : 0,
    source_module: body.source_module != null ? str(body.source_module, 60) : null,
    source_entity: body.source_entity != null ? str(body.source_entity, 60) : null,
    source_entity_id: body.source_entity_id != null ? str(body.source_entity_id, 64) : null,
  }
}

export async function createTask(body: any): Promise<{ id: number }> {
  await ensureTaskSchema()
  const tenantId = currentTenantId()
  const actor = getCurrentActor()
  const fields = buildWritableFields(body)
  const status = oneOf(body.status, TASK_STATUSES, "To Do")

  const res = await query<any>(
    `INSERT INTO tasks (
       tenant_id, title, description, task_type, status, priority,
       assignee_id, assignee_name, team_id, team_name,
       reporter_id, reporter_name, start_date, due_date,
       recurrence, recurrence_interval, recurrence_until,
       approval_required, approval_status,
       source_module, source_entity, source_entity_id,
       created_by, created_by_name
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      tenantId,
      fields.title,
      fields.description,
      fields.task_type,
      status,
      fields.priority,
      fields.assignee_id,
      fields.assignee_name,
      fields.team_id,
      fields.team_name,
      actor?.userId ?? null,
      actor?.name ?? null,
      fields.start_date,
      fields.due_date,
      fields.recurrence,
      fields.recurrence_interval,
      fields.recurrence_until,
      fields.approval_required,
      fields.approval_required ? "pending" : "none",
      fields.source_module,
      fields.source_entity,
      fields.source_entity_id,
      actor?.userId ?? null,
      actor?.name ?? null,
    ],
  )
  const id = Number(res?.insertId ?? 0)
  await logActivity(id, "created", `Task "${fields.title}" created`)
  if (fields.assignee_id) {
    await notifyUser(fields.assignee_id, "New task assigned", `You were assigned "${fields.title}"`, id)
  }
  return { id }
}

export async function updateTask(id: number, body: any): Promise<void> {
  await ensureTaskSchema()
  const tenantId = currentTenantId()
  const existing = await getTaskOrThrow(id)
  const fields = buildWritableFields(body)
  const nextStatus = oneOf(body.status, TASK_STATUSES, existing.status as TaskStatus)

  // Guard rails around moving a task to Done.
  if (nextStatus === "Done" && existing.status !== "Done") {
    if (await isBlockedByDeps(id)) {
      throw new TaskError("Cannot complete: this task is blocked by an unfinished dependency")
    }
    if (existing.approval_required && existing.approval_status !== "approved") {
      throw new TaskError("Cannot complete: approval is required and has not been granted")
    }
  }

  const completedAt = nextStatus === "Done" ? existing.completed_at ?? new Date() : null
  const progress =
    nextStatus === "Done" ? 100 : nextStatus === "Cancelled" ? existing.progress : await computeProgress(id, existing.progress)

  await query(
    `UPDATE tasks SET
       title = ?, description = ?, task_type = ?, status = ?, priority = ?,
       assignee_id = ?, assignee_name = ?, team_id = ?, team_name = ?,
       start_date = ?, due_date = ?, completed_at = ?, progress = ?,
       recurrence = ?, recurrence_interval = ?, recurrence_until = ?,
       approval_required = ?,
       source_module = ?, source_entity = ?, source_entity_id = ?
     WHERE tenant_id = ? AND id = ?`,
    [
      fields.title,
      fields.description,
      fields.task_type,
      nextStatus,
      fields.priority,
      fields.assignee_id,
      fields.assignee_name,
      fields.team_id,
      fields.team_name,
      fields.start_date,
      fields.due_date,
      completedAt,
      progress,
      fields.recurrence,
      fields.recurrence_interval,
      fields.recurrence_until,
      fields.approval_required,
      fields.source_module,
      fields.source_entity,
      fields.source_entity_id,
      tenantId,
      id,
    ],
  )

  if (nextStatus !== existing.status) {
    await logActivity(id, "status_changed", `${existing.status} → ${nextStatus}`)
  }
  if (fields.assignee_id && fields.assignee_id !== existing.assignee_id) {
    await notifyUser(fields.assignee_id, "Task assigned to you", `You were assigned "${fields.title}"`, id)
  }

  // Spawn the next occurrence when a recurring task is completed.
  if (nextStatus === "Done" && existing.status !== "Done" && existing.recurrence !== "none") {
    await spawnRecurrence({ ...existing, ...fields, status: nextStatus } as any, id)
  }
}

export async function deleteTask(id: number): Promise<void> {
  await ensureTaskSchema()
  const tenantId = currentTenantId()
  await getTaskOrThrow(id)
  await withTransaction(async (c) => {
    for (const t of ["task_dependencies", "task_checklist_items", "task_comments", "task_attachments", "task_activity"]) {
      await c.query(`DELETE FROM \`${t}\` WHERE tenant_id = ? AND task_id = ?`, [tenantId, id])
    }
    await c.query(`DELETE FROM task_dependencies WHERE tenant_id = ? AND depends_on_id = ?`, [tenantId, id])
    await c.query(`DELETE FROM tasks WHERE tenant_id = ? AND id = ?`, [tenantId, id])
  })
}

// ---------------------------------------------------------------------------
// Recurrence
// ---------------------------------------------------------------------------

function shiftDate(base: string | null, recurrence: string, interval: number): string | null {
  if (!base) return null
  const d = new Date(base + "T00:00:00Z")
  if (Number.isNaN(d.getTime())) return null
  if (recurrence === "daily") d.setUTCDate(d.getUTCDate() + interval)
  else if (recurrence === "weekly") d.setUTCDate(d.getUTCDate() + interval * 7)
  else if (recurrence === "monthly") d.setUTCMonth(d.getUTCMonth() + interval)
  else return null
  return d.toISOString().slice(0, 10)
}

async function spawnRecurrence(task: TaskRow, sourceId: number): Promise<void> {
  const tenantId = currentTenantId()
  const nextDue = shiftDate(task.due_date, task.recurrence, task.recurrence_interval)
  const nextStart = shiftDate(task.start_date, task.recurrence, task.recurrence_interval)
  if (!nextDue) return
  if (task.recurrence_until && nextDue > task.recurrence_until) return

  const rootId = task.recurrence_parent_id ?? sourceId
  const res = await query<any>(
    `INSERT INTO tasks (
       tenant_id, title, description, task_type, status, priority,
       assignee_id, assignee_name, team_id, team_name, reporter_id, reporter_name,
       start_date, due_date, recurrence, recurrence_interval, recurrence_until,
       recurrence_parent_id, approval_required, approval_status,
       source_module, source_entity, source_entity_id, created_by, created_by_name
     ) VALUES (?, ?, ?, ?, 'To Do', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      tenantId,
      task.title,
      task.description,
      task.task_type,
      task.priority,
      task.assignee_id,
      task.assignee_name,
      task.team_id,
      task.team_name,
      task.reporter_id,
      task.reporter_name,
      nextStart,
      nextDue,
      task.recurrence,
      task.recurrence_interval,
      task.recurrence_until,
      rootId,
      task.approval_required,
      task.approval_required ? "pending" : "none",
      task.source_module,
      task.source_entity,
      task.source_entity_id,
      task.created_by,
      task.created_by_name,
    ],
  )
  const newId = Number(res?.insertId ?? 0)
  await logActivity(newId, "recurrence_spawned", `Recurring occurrence created from task #${sourceId}`)
  if (task.assignee_id) {
    await notifyUser(task.assignee_id, "Recurring task", `Next occurrence of "${task.title}" is due ${nextDue}`, newId)
  }
}

// ---------------------------------------------------------------------------
// Checklist
// ---------------------------------------------------------------------------

async function computeProgress(taskId: number, fallback: number): Promise<number> {
  const tenantId = currentTenantId()
  const rows = await query<any[]>(
    `SELECT COUNT(*) AS total, SUM(is_done) AS done FROM task_checklist_items WHERE tenant_id = ? AND task_id = ?`,
    [tenantId, taskId],
  )
  const total = Number(rows[0]?.total ?? 0)
  if (total === 0) return fallback
  const done = Number(rows[0]?.done ?? 0)
  return Math.round((done / total) * 100)
}

async function syncProgressFromChecklist(taskId: number): Promise<void> {
  const tenantId = currentTenantId()
  const task = await getTaskOrThrow(taskId)
  if (task.status === "Done" || task.status === "Cancelled") return
  const progress = await computeProgress(taskId, task.progress)
  await query(`UPDATE tasks SET progress = ? WHERE tenant_id = ? AND id = ?`, [progress, tenantId, taskId])
}

export async function addChecklistItem(taskId: number, text: string): Promise<void> {
  await ensureTaskSchema()
  const tenantId = currentTenantId()
  await getTaskOrThrow(taskId)
  const item = reqStr(text, 500, "Item")
  const orderRow = await query<any[]>(
    `SELECT COALESCE(MAX(sort_order), 0) + 1 AS next FROM task_checklist_items WHERE tenant_id = ? AND task_id = ?`,
    [tenantId, taskId],
  )
  await query(
    `INSERT INTO task_checklist_items (tenant_id, task_id, item_text, sort_order) VALUES (?, ?, ?, ?)`,
    [tenantId, taskId, item, Number(orderRow[0]?.next ?? 1)],
  )
  await syncProgressFromChecklist(taskId)
}

export async function toggleChecklistItem(taskId: number, itemId: number, isDone: boolean): Promise<void> {
  await ensureTaskSchema()
  const tenantId = currentTenantId()
  const actor = getCurrentActor()
  await query(
    `UPDATE task_checklist_items
        SET is_done = ?, completed_by_name = ?, completed_at = ?
      WHERE tenant_id = ? AND task_id = ? AND id = ?`,
    [isDone ? 1 : 0, isDone ? actor?.name ?? null : null, isDone ? new Date() : null, tenantId, taskId, itemId],
  )
  await syncProgressFromChecklist(taskId)
}

export async function deleteChecklistItem(taskId: number, itemId: number): Promise<void> {
  await ensureTaskSchema()
  const tenantId = currentTenantId()
  await query(`DELETE FROM task_checklist_items WHERE tenant_id = ? AND task_id = ? AND id = ?`, [
    tenantId,
    taskId,
    itemId,
  ])
  await syncProgressFromChecklist(taskId)
}

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

/** Would adding task_id -> depends_on_id create a cycle? Walk the dependency graph. */
async function wouldCreateCycle(taskId: number, dependsOnId: number): Promise<boolean> {
  if (taskId === dependsOnId) return true
  const tenantId = currentTenantId()
  const visited = new Set<number>()
  let frontier = [dependsOnId]
  while (frontier.length) {
    const placeholders = frontier.map(() => "?").join(", ")
    const rows = await query<any[]>(
      `SELECT depends_on_id FROM task_dependencies WHERE tenant_id = ? AND task_id IN (${placeholders})`,
      [tenantId, ...frontier],
    )
    const next: number[] = []
    for (const r of rows) {
      const dep = Number(r.depends_on_id)
      if (dep === taskId) return true
      if (!visited.has(dep)) {
        visited.add(dep)
        next.push(dep)
      }
    }
    frontier = next
  }
  return false
}

export async function addDependency(taskId: number, dependsOnId: number): Promise<void> {
  await ensureTaskSchema()
  const tenantId = currentTenantId()
  await getTaskOrThrow(taskId)
  await getTaskOrThrow(dependsOnId) // ensures same tenant
  if (await wouldCreateCycle(taskId, dependsOnId)) {
    throw new TaskError("That dependency would create a circular reference")
  }
  await query(
    `INSERT IGNORE INTO task_dependencies (tenant_id, task_id, depends_on_id) VALUES (?, ?, ?)`,
    [tenantId, taskId, dependsOnId],
  )
  await refreshBlockedStatus(taskId)
  await logActivity(taskId, "dependency_added", `Now depends on task #${dependsOnId}`)
}

export async function removeDependency(taskId: number, dependsOnId: number): Promise<void> {
  await ensureTaskSchema()
  const tenantId = currentTenantId()
  await query(`DELETE FROM task_dependencies WHERE tenant_id = ? AND task_id = ? AND depends_on_id = ?`, [
    tenantId,
    taskId,
    dependsOnId,
  ])
  await refreshBlockedStatus(taskId)
}

/**
 * Reconcile a task's Blocked status with its dependency state. A pending task
 * gains "Blocked" when a dependency is unfinished; a Blocked task returns to
 * "To Do" once every dependency is resolved.
 */
async function refreshBlockedStatus(taskId: number): Promise<void> {
  const tenantId = currentTenantId()
  const task = await getTaskOrThrow(taskId)
  if (task.status === "Done" || task.status === "Cancelled" || task.status === "In Review") return
  const blocked = await isBlockedByDeps(taskId)
  const target = blocked ? "Blocked" : task.status === "Blocked" ? "To Do" : task.status
  if (target !== task.status) {
    await query(`UPDATE tasks SET status = ? WHERE tenant_id = ? AND id = ?`, [target, tenantId, taskId])
  }
}

/** When a task completes, unblock any dependents that are now clear. */
export async function propagateUnblock(taskId: number): Promise<void> {
  const tenantId = currentTenantId()
  const dependents = await query<any[]>(
    `SELECT task_id FROM task_dependencies WHERE tenant_id = ? AND depends_on_id = ?`,
    [tenantId, taskId],
  )
  for (const d of dependents) await refreshBlockedStatus(Number(d.task_id))
}

// ---------------------------------------------------------------------------
// Comments
// ---------------------------------------------------------------------------

export async function addComment(taskId: number, body: string): Promise<void> {
  await ensureTaskSchema()
  const tenantId = currentTenantId()
  const actor = getCurrentActor()
  const task = await getTaskOrThrow(taskId)
  const text = reqStr(body, 4000, "Comment")
  await query(
    `INSERT INTO task_comments (tenant_id, task_id, author_id, author_name, body) VALUES (?, ?, ?, ?, ?)`,
    [tenantId, taskId, actor?.userId ?? null, actor?.name ?? null, text],
  )
  // Notify the assignee and reporter (excluding the comment author) of new discussion.
  await notifyUser(task.assignee_id, "New comment on task", `${actor?.name ?? "Someone"} commented on "${task.title}"`, taskId)
  if (task.reporter_id && task.reporter_id !== task.assignee_id) {
    await notifyUser(task.reporter_id, "New comment on task", `${actor?.name ?? "Someone"} commented on "${task.title}"`, taskId)
  }
}

export async function deleteComment(taskId: number, commentId: number): Promise<void> {
  await ensureTaskSchema()
  const tenantId = currentTenantId()
  await query(`DELETE FROM task_comments WHERE tenant_id = ? AND task_id = ? AND id = ?`, [tenantId, taskId, commentId])
}

// ---------------------------------------------------------------------------
// Attachments (metadata — file bytes live in the tenant's storage layer)
// ---------------------------------------------------------------------------

export async function addAttachment(
  taskId: number,
  data: { file_name: string; file_url: string; file_size?: number; content_type?: string },
): Promise<void> {
  await ensureTaskSchema()
  const tenantId = currentTenantId()
  const actor = getCurrentActor()
  await getTaskOrThrow(taskId)
  const name = reqStr(data.file_name, 255, "File name")
  const url = reqStr(data.file_url, 1024, "File URL")
  await query(
    `INSERT INTO task_attachments (tenant_id, task_id, file_name, file_url, file_size, content_type, uploaded_by_id, uploaded_by_name)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      tenantId,
      taskId,
      name,
      url,
      Number.isFinite(Number(data.file_size)) ? Number(data.file_size) : null,
      data.content_type ? str(data.content_type, 150) : null,
      actor?.userId ?? null,
      actor?.name ?? null,
    ],
  )
}

export async function deleteAttachment(taskId: number, attachmentId: number): Promise<void> {
  await ensureTaskSchema()
  const tenantId = currentTenantId()
  await query(`DELETE FROM task_attachments WHERE tenant_id = ? AND task_id = ? AND id = ?`, [
    tenantId,
    taskId,
    attachmentId,
  ])
}

// ---------------------------------------------------------------------------
// Approval workflow
// ---------------------------------------------------------------------------

export async function submitForApproval(taskId: number, approverId: number, approverName: string | null): Promise<void> {
  await ensureTaskSchema()
  const tenantId = currentTenantId()
  const task = await getTaskOrThrow(taskId)
  const approver = posIntOrNull(approverId)
  if (!approver) throw new TaskError("Select an approver")
  await query(
    `UPDATE tasks SET approval_required = 1, approval_status = 'pending', approver_id = ?, approver_name = ?, approval_note = NULL, approval_at = NULL, status = CASE WHEN status = 'Done' THEN 'In Review' ELSE status END
      WHERE tenant_id = ? AND id = ?`,
    [approver, approverName ? str(approverName, 150) : null, tenantId, taskId],
  )
  await logActivity(taskId, "approval_requested", `Approval requested from ${approverName ?? `user #${approver}`}`)
  await notifyUser(approver, "Approval requested", `Your approval is requested for "${task.title}"`, taskId)
}

export async function decideApproval(
  taskId: number,
  decision: "approved" | "rejected",
  note: string | null,
): Promise<void> {
  await ensureTaskSchema()
  const tenantId = currentTenantId()
  const actor = getCurrentActor()
  const task = await getTaskOrThrow(taskId)
  if (task.approval_status !== "pending") throw new TaskError("This task has no pending approval")
  // Separation of duties: the requester cannot approve their own task.
  if (actor?.userId && task.reporter_id && actor.userId === task.reporter_id && decision === "approved") {
    throw new TaskError("You cannot approve a task you created")
  }
  await query(
    `UPDATE tasks SET approval_status = ?, approval_note = ?, approval_at = ?, approver_id = COALESCE(approver_id, ?), approver_name = COALESCE(approver_name, ?)
      WHERE tenant_id = ? AND id = ?`,
    [decision, note ? str(note, 500) : null, new Date(), actor?.userId ?? null, actor?.name ?? null, tenantId, taskId],
  )
  await logActivity(taskId, `approval_${decision}`, note ?? null)
  if (task.reporter_id) {
    await notifyUser(
      task.reporter_id,
      `Task ${decision}`,
      `"${task.title}" was ${decision}${note ? `: ${note}` : ""}`,
      taskId,
    )
  }
}
