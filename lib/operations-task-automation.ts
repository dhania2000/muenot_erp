import "server-only"
import { query, tableColumns } from "@/lib/db"

/**
 * Phase 71 — Operations Task Automation.
 *
 * When a Project, Milestone, Deliverable or Issue is CREATED (and when an SLA
 * row goes into breach), spawn the linked follow-up tasks into the EXISTING
 * `operations_tasks` pipeline. This creates no new task store and no parallel
 * board — the generated rows are ordinary tasks that show up in the Tasks table
 * and the Kanban board like any other.
 *
 * Idempotency: every generated group carries a stable marker in `remarks`
 * (`[auto:<TAG>]`). Before spawning a group we check whether any task already
 * carries that marker, so a repeated save (or an Updated hook firing) never
 * stacks duplicates.
 *
 * Failure-tolerant: any error is logged and swallowed so automation never
 * blocks the user's primary create/update.
 */

type TaskSeed = {
  task_title: string
  task_type: string
  description?: string | null
  priority?: string | null
  due_offset_days?: number | null
}

const TASK_STATUS = "To Do"
const BOARD_STAGE = "To Do"

function isoInDays(days: number | null | undefined): string | null {
  if (days == null) return null
  const d = new Date()
  d.setDate(d.getDate() + days)
  return d.toISOString().slice(0, 10)
}

function normalisePriority(value: unknown): string {
  const p = String(value ?? "").trim().toLowerCase()
  if (p === "critical") return "Critical"
  if (p === "high") return "High"
  if (p === "low") return "Low"
  return "Medium"
}

/** True when the group marker already exists on any task (already spawned). */
async function groupExists(tag: string): Promise<boolean> {
  const rows = await query<any[]>(
    `SELECT id FROM operations_tasks WHERE remarks LIKE ? LIMIT 1`,
    [`%[auto:${tag}]%`],
  ).catch(() => [] as any[])
  return rows.length > 0
}

async function spawnGroup(
  tag: string,
  base: Record<string, unknown>,
  seeds: TaskSeed[],
): Promise<void> {
  if (!seeds.length) return
  const cols = await tableColumns("operations_tasks")
  if (!cols.size) return
  if (await groupExists(tag)) return

  for (const seed of seeds) {
    const data: Record<string, unknown> = {
      ...base,
      task_title: seed.task_title,
      task_type: seed.task_type,
      description: seed.description ?? null,
      priority: seed.priority ?? "Medium",
      start_date: isoInDays(0),
      due_date: isoInDays(seed.due_offset_days ?? null),
      completion_percent: 0,
      board_stage: BOARD_STAGE,
      status: TASK_STATUS,
      remarks: `Auto-generated (Phase 71) [auto:${tag}]`,
    }
    const keys = Object.keys(data).filter((k) => cols.has(k) && data[k] !== undefined)
    if (!keys.length) continue
    const values = keys.map((k) => (data[k] === "" ? null : data[k]))
    const placeholders = keys.map(() => "?").join(",")
    await query(`INSERT INTO operations_tasks (${keys.join(",")}) VALUES (${placeholders})`, values).catch(
      (error) => {
        console.log("[v0] operations-task-automation insert failed:", (error as Error).message)
      },
    )
  }
}

// ── Project Created → project setup tasks ──────────────────────────────────
async function spawnProjectTasks(row: Record<string, any>): Promise<void> {
  const projectId = row.id
  if (projectId == null) return
  const priority = normalisePriority(row.priority)
  const manager = row.project_manager ?? row.operations_manager ?? null
  const base: Record<string, unknown> = {
    project_id: projectId,
    project_name: row.project_name ?? null,
    client_name: row.client_name ?? null,
    assigned_to: manager,
    reporter: row.operations_manager ?? row.project_manager ?? null,
  }
  await spawnGroup(`PRJ-${projectId}`, base, [
    { task_title: "Project kickoff & onboarding", task_type: "Setup", priority, due_offset_days: 3, description: "Kick off the project, align the team and confirm the delivery plan." },
    { task_title: "Confirm scope, SOW & requirements", task_type: "Planning", priority, due_offset_days: 5, description: "Validate the agreed scope and capture client requirements." },
    { task_title: "Build project plan & milestones", task_type: "Planning", priority, due_offset_days: 7, description: "Define milestones, deliverables and the schedule." },
    { task_title: "Allocate resources & confirm capacity", task_type: "Resourcing", priority, due_offset_days: 7, description: "Assign resources and confirm allocation against capacity." },
  ])
}

// ── Milestone Created → milestone execution task ───────────────────────────
async function spawnMilestoneTasks(row: Record<string, any>): Promise<void> {
  const milestoneId = row.id
  if (milestoneId == null) return
  const name = row.milestone_name ?? `Milestone #${milestoneId}`
  const base: Record<string, unknown> = {
    project_id: row.project_id ?? null,
    project_name: row.project_name ?? null,
    assigned_to: row.owner ?? null,
    milestone_id: milestoneId,
    milestone_name: row.milestone_name ?? null,
  }
  await spawnGroup(`MS-${milestoneId}`, base, [
    {
      task_title: `Plan & track milestone: ${name}`,
      task_type: "Milestone",
      priority: normalisePriority(row.priority),
      description: `Coordinate the work required to reach milestone "${name}".`,
    },
  ])
}

// ── Deliverable Created → prepare/submit task ──────────────────────────────
async function spawnDeliverableTasks(row: Record<string, any>): Promise<void> {
  const deliverableId = row.id
  if (deliverableId == null) return
  const name = row.deliverable_name ?? `Deliverable #${deliverableId}`
  const base: Record<string, unknown> = {
    project_id: row.project_id ?? null,
    project_name: row.project_name ?? null,
    assigned_to: row.owner ?? null,
    milestone_id: row.milestone_id ?? null,
  }
  await spawnGroup(`DL-${deliverableId}`, base, [
    {
      task_title: `Prepare & submit deliverable: ${name}`,
      task_type: "Delivery",
      priority: "Medium",
      description: `Produce, review and submit the "${name}" deliverable for client acceptance.`,
    },
  ])
}

// ── Issue Created → investigation task ─────────────────────────────────────
async function spawnIssueTasks(row: Record<string, any>): Promise<void> {
  const issueId = row.id
  if (issueId == null) return
  const status = String(row.status ?? "").toLowerCase()
  if (["resolved", "closed"].includes(status)) return
  const title = row.title ?? `Issue #${issueId}`
  const base: Record<string, unknown> = {
    project_id: row.project_id ?? null,
    client_name: row.client_name ?? null,
    assigned_to: row.assigned_to ?? row.reported_by ?? null,
  }
  await spawnGroup(`ISS-${issueId}`, base, [
    {
      task_title: `Investigate issue: ${title}`,
      task_type: "Investigation",
      priority: normalisePriority(row.priority),
      due_offset_days: 3,
      description: `Investigate root cause and drive resolution for issue "${title}".`,
    },
  ])
}

// ── SLA Breach → escalation task ───────────────────────────────────────────
async function spawnSlaEscalationTask(row: Record<string, any>): Promise<void> {
  const slaId = row.id
  if (slaId == null) return
  const status = String(row.sla_status ?? "").toLowerCase()
  if (status !== "breached sla") return
  const metric = row.sla_metric ?? `SLA #${slaId}`
  const base: Record<string, unknown> = {
    project_id: row.project_id ?? null,
    client_name: row.client_name ?? null,
    assigned_to: row.owner ?? null,
  }
  await spawnGroup(`SLA-${slaId}`, base, [
    {
      task_title: `Escalate & remediate SLA breach: ${metric}`,
      task_type: "Escalation",
      priority: "High",
      due_offset_days: 2,
      description: `SLA "${metric}" is breached. Escalate, contain impact and drive remediation.`,
    },
  ])
}

/**
 * Dispatch task automation for an operations entity. Called from the API
 * sync-hook layer. `selected` is the already-validated module key.
 */
export async function runTaskAutomation(
  selected: string,
  row: Record<string, any>,
  changeType: "Created" | "Updated",
): Promise<void> {
  try {
    if (selected === "sla_monitoring") {
      // Breach can surface on create or a later update — idempotent either way.
      await spawnSlaEscalationTask(row)
      return
    }
    if (changeType !== "Created") return
    if (selected === "projects") await spawnProjectTasks(row)
    else if (selected === "milestones") await spawnMilestoneTasks(row)
    else if (selected === "deliverables") await spawnDeliverableTasks(row)
    else if (selected === "issues") await spawnIssueTasks(row)
  } catch (error) {
    console.log("[v0] operations-task-automation runTaskAutomation failed:", (error as Error).message)
  }
}
