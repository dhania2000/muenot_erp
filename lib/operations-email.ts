import "server-only"
import { query, tableColumns } from "@/lib/db"

// =============================================================================
// Operations email intelligence (Phases 62-64)
// -----------------------------------------------------------------------------
// A thin resolution layer over the EXISTING Operations email tables. It does
// not introduce a new mailer, template store or notification surface — it only:
//   • resolves template placeholders from real Operations/HR source rows
//     (Project, Client, Employee, Task, Deliverable, Issue, SLA, Milestone);
//   • links a sent email to the entity it is about (entity_type/entity_id +
//     denormalised project/client for fast history filtering);
//   • continues an existing conversation on follow-ups, or starts a new one.
// Every lookup is schema-defensive via tableColumns() so a lagging production
// schema degrades to "no value" rather than throwing.
// =============================================================================

export type OperationsEmailEntity =
  | "project"
  | "client"
  | "employee"
  | "task"
  | "deliverable"
  | "issue"
  | "sla"
  | "milestone"

/** Placeholder keys grouped by source, surfaced to the compose UI as helpers. */
export const OPERATIONS_PLACEHOLDERS: Record<string, string[]> = {
  Project: ["project_name", "project_manager", "operations_manager", "project_status", "project_priority", "start_date", "end_date", "sla_target", "budget_amount"],
  Client: ["client_name", "client_poc", "client_email", "client_contact"],
  Employee: ["employee_name", "employee_email", "department", "designation"],
  Task: ["task_title", "task_status", "task_priority", "task_due_date", "assigned_to"],
  Deliverable: ["deliverable_name", "deliverable_status", "deliverable_due_date", "deliverable_owner"],
  Issue: ["issue_title", "issue_status", "issue_priority", "issue_due_date"],
  SLA: ["sla_metric", "sla_status", "sla_due_date", "sla_target_value"],
  Milestone: ["milestone_name", "milestone_status", "milestone_due_date", "milestone_owner"],
}

type Vars = Record<string, string | null | undefined>

async function loadRow(table: string, idField: string, id: unknown): Promise<any | null> {
  try {
    const cols = await tableColumns(table)
    if (!cols.size) return null
    const field = cols.has(idField) ? idField : "id"
    const rows = await query<any[]>(`SELECT * FROM ${table} WHERE ${field} = ? LIMIT 1`, [id])
    return rows[0] ?? null
  } catch {
    return null
  }
}

/** Merge a project row's fields (and its client fields) into the vars bag. */
function applyProject(vars: Vars, p: any) {
  if (!p) return
  vars.project_name = p.project_name
  vars.project_manager = p.project_manager
  vars.operations_manager = p.operations_manager
  vars.project_status = p.status
  vars.project_priority = p.priority
  vars.start_date = p.start_date
  vars.end_date = p.end_date
  vars.sla_target = p.sla_target
  vars.budget_amount = p.budget_amount
  vars.client_name = vars.client_name ?? p.client_name
  vars.client_poc = vars.client_poc ?? p.client_poc
  vars.client_email = vars.client_email ?? p.client_email
  vars.client_contact = vars.client_contact ?? p.client_contact
}

/**
 * Resolve all template placeholder values plus the linking context for an
 * entity. Returns the flat variable bag (for renderTemplate) together with the
 * denormalised project_id / client_name used for email-history filtering, and a
 * best-effort default recipient address.
 */
export async function resolveOperationsEmailContext(
  entityType: OperationsEmailEntity,
  entityId: string | number,
): Promise<{ vars: Vars; projectId: string | null; clientName: string | null; defaultTo: string | null }> {
  const vars: Vars = {}
  let projectId: string | null = null
  let projectRow: any = null

  const linkProject = async (pid: unknown) => {
    if (pid == null || String(pid) === "") return
    projectId = String(pid)
    projectRow = await loadRow("operations_projects", "project_id", pid)
    applyProject(vars, projectRow)
  }

  switch (entityType) {
    case "project": {
      await linkProject(entityId)
      break
    }
    case "client": {
      // Resolve from the most recent project for this client so client-scoped
      // mail still carries a project context when one exists.
      const p = await query<any[]>(
        `SELECT * FROM operations_projects WHERE client_id = ? OR client_name = ? ORDER BY created_at DESC LIMIT 1`,
        [entityId, String(entityId)],
      ).catch(() => [] as any[])
      if (p[0]) {
        projectId = String(p[0].project_id ?? p[0].id ?? "")
        projectRow = p[0]
        applyProject(vars, p[0])
      } else {
        vars.client_name = String(entityId)
      }
      break
    }
    case "employee": {
      const r =
        (await loadRow("operations_resources", "resource_id", entityId)) ??
        (await loadRow("operations_resources", "employee_id", entityId))
      if (r) {
        vars.employee_name = r.resource_name
        vars.employee_email = r.official_email ?? r.personal_email
        vars.department = r.department
        vars.designation = r.designation
      }
      break
    }
    case "task": {
      const t = await loadRow("operations_tasks", "id", entityId)
      if (t) {
        vars.task_title = t.task_title
        vars.task_status = t.status
        vars.task_priority = t.priority
        vars.task_due_date = t.due_date
        vars.assigned_to = t.assigned_to
        await linkProject(t.project_id)
      }
      break
    }
    case "deliverable": {
      const d = await loadRow("operations_deliverables", "id", entityId)
      if (d) {
        vars.deliverable_name = d.deliverable_name
        vars.deliverable_status = d.status
        vars.deliverable_due_date = d.due_date
        vars.deliverable_owner = d.owner
        await linkProject(d.project_id)
      }
      break
    }
    case "issue": {
      const i = await loadRow("operations_issues", "id", entityId)
      if (i) {
        vars.issue_title = i.title
        vars.issue_status = i.status
        vars.issue_priority = i.priority
        vars.issue_due_date = i.due_date ?? i.target_date
        await linkProject(i.project_id)
      }
      break
    }
    case "sla": {
      const s = await loadRow("operations_sla_monitoring", "id", entityId)
      if (s) {
        vars.sla_metric = s.sla_metric
        vars.sla_status = s.sla_status
        vars.sla_due_date = s.due_date
        vars.sla_target_value = s.sla_target
        await linkProject(s.project_id)
      }
      break
    }
    case "milestone": {
      const m = await loadRow("operations_milestones", "id", entityId)
      if (m) {
        vars.milestone_name = m.milestone_name
        vars.milestone_status = m.status
        vars.milestone_due_date = m.planned_end ?? m.actual_end
        vars.milestone_owner = m.owner
        await linkProject(m.project_id)
      }
      break
    }
  }

  const clientName = (vars.client_name as string | null | undefined) ?? null
  const defaultTo =
    (vars.employee_email as string | null | undefined) ??
    (vars.client_email as string | null | undefined) ??
    null

  return { vars, projectId, clientName: clientName ? String(clientName) : null, defaultTo }
}
