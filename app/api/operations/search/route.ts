import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { query } from "@/lib/db"
import { scopeWhereForModule, mergeScopeIntoWhere } from "@/lib/permission-enforce"
import type { SessionPayload } from "@/lib/auth"

export const runtime = "nodejs"

/**
 * Phase 81 — Operations global search.
 *
 * A single read-only entry point that fans one query out across the existing
 * Operations tables and returns grouped hits for:
 *   Project ID · Project Name · Client · Task · Issue · Deliverable ·
 *   Employee · Reference ID
 *
 * It never introduces new storage — every group reads the same table the
 * matching module already owns, and every group is filtered through the same
 * `scopeWhereForModule` row-scope the module list view uses, so search can
 * never surface a record the viewer is not allowed to see.
 */

type Group = {
  key: string
  label: string
  href: string
  results: SearchHit[]
}

type SearchHit = {
  id: string | number
  title: string
  subtitle: string
  meta: string
}

// Each searchable entity: the table, the permission key that governs row scope,
// the LIKE columns, and how a matched row renders. `href` is the module list
// page the hit links to (list pages are the canonical destination in this ERP).
type EntityDef = {
  key: string
  label: string
  table: string
  permissionKey: string
  href: string
  // Columns matched with LIKE %q%.
  textColumns: string[]
  // When true, an all-digit query also matches the numeric primary key.
  matchId?: boolean
  title: (row: any) => string
  subtitle: (row: any) => string
  meta: (row: any) => string
}

const entities: EntityDef[] = [
  {
    key: "projects",
    label: "Projects",
    table: "operations_projects",
    permissionKey: "operations.projects",
    href: "/modules/operations/projects",
    textColumns: ["project_name", "client_name", "project_manager", "service_vertical"],
    matchId: true,
    title: (r) => r.project_name || `Project #${r.id}`,
    subtitle: (r) => r.client_name || "—",
    meta: (r) => r.status || "",
  },
  {
    key: "tasks",
    label: "Tasks",
    table: "operations_tasks",
    permissionKey: "operations.tasks",
    href: "/modules/operations/tasks",
    textColumns: ["task_title", "project_name", "client_name", "assigned_to", "resource_name"],
    matchId: true,
    title: (r) => r.task_title || `Task #${r.id}`,
    subtitle: (r) => r.project_name || r.client_name || "—",
    meta: (r) => r.status || r.board_stage || "",
  },
  {
    key: "issues",
    label: "Issues",
    table: "operations_issues",
    permissionKey: "operations.issues",
    href: "/modules/operations/issues",
    textColumns: ["title", "description", "client_name", "issue_type", "issue_category"],
    matchId: true,
    title: (r) => r.title || r.description || `Issue #${r.id}`,
    subtitle: (r) => r.client_name || r.issue_type || "—",
    meta: (r) => r.status || r.priority || "",
  },
  {
    key: "deliverables",
    label: "Deliverables",
    table: "operations_deliverables",
    permissionKey: "operations.deliverables",
    href: "/modules/operations/deliverables",
    textColumns: ["deliverable_name", "project_name", "deliverable_type", "owner"],
    matchId: true,
    title: (r) => r.deliverable_name || `Deliverable #${r.id}`,
    subtitle: (r) => r.project_name || "—",
    meta: (r) => r.status || r.quality_status || "",
  },
  {
    key: "client_deliverables",
    label: "Client Deliverables",
    table: "operations_client_deliverables",
    permissionKey: "operations.client_deliverables",
    href: "/modules/operations/client-deliverables",
    textColumns: ["deliverable_name", "client_name", "deliverable_type", "owner"],
    matchId: true,
    title: (r) => r.deliverable_name || `Deliverable #${r.id}`,
    subtitle: (r) => r.client_name || "—",
    meta: (r) => r.status || r.acceptance_status || "",
  },
  {
    key: "employees",
    label: "Employees / Resources",
    table: "operations_resources",
    permissionKey: "operations.resources",
    href: "/modules/operations/resources",
    textColumns: ["resource_name", "employee_id", "official_email", "personal_email", "department", "designation"],
    matchId: true,
    title: (r) => r.resource_name || `Resource #${r.id}`,
    subtitle: (r) => [r.designation, r.department].filter(Boolean).join(" · ") || "—",
    meta: (r) => r.employee_id ? `EMP ${r.employee_id}` : r.status || "",
  },
]

// "Client" is not its own table — clients live on projects. Surface distinct
// client names so a user searching a client jumps straight to their projects.
async function searchClients(session: SessionPayload, like: string): Promise<Group | null> {
  const scoped = await scopeWhereForModule(session, "operations.projects", "view", "operations_projects")
  const { where, args } = mergeScopeIntoWhere("WHERE client_name LIKE ?", [like], scoped)
  try {
    const rows = await query<any[]>(
      `SELECT client_name, COUNT(*) AS project_count FROM operations_projects ${where} AND client_name IS NOT NULL AND client_name <> '' GROUP BY client_name ORDER BY project_count DESC LIMIT 10`,
      args,
    )
    if (!rows.length) return null
    return {
      key: "clients",
      label: "Clients",
      href: "/modules/operations/projects",
      results: rows.map((r) => ({
        id: r.client_name,
        title: r.client_name,
        subtitle: `${r.project_count} project${Number(r.project_count) === 1 ? "" : "s"}`,
        meta: "",
      })),
    }
  } catch {
    return null
  }
}

// Reference IDs live on several tables under differently named "number" columns.
// Search them together and return one combined "Reference ID" group.
const referenceSources: { table: string; column: string; permissionKey: string; href: string; label: string }[] = [
  { table: "operations_work_orders", column: "work_order_no", permissionKey: "operations.work_orders", href: "/modules/operations/work-orders", label: "Work Order" },
  { table: "operations_escalations", column: "escalation_no", permissionKey: "operations.escalations", href: "/modules/operations/escalations", label: "Escalation" },
  { table: "operations_qa_audits", column: "audit_no", permissionKey: "operations.qa_audits", href: "/modules/operations/qa-audits", label: "QA Audit" },
  { table: "operations_scorecards", column: "scorecard_no", permissionKey: "operations.scorecards", href: "/modules/operations/scorecards", label: "Scorecard" },
  { table: "operations_approvals", column: "approval_no", permissionKey: "operations.approvals", href: "/modules/operations/approvals", label: "Approval" },
  { table: "operations_corrective_actions", column: "reference_no", permissionKey: "operations.corrective_actions", href: "/modules/operations/corrective-actions", label: "Corrective Action" },
  { table: "operations_root_cause_capa", column: "reference_no", permissionKey: "operations.root_cause_capa", href: "/modules/operations/root-cause-capa", label: "Root Cause / CAPA" },
]

async function searchReferences(session: SessionPayload, like: string): Promise<Group | null> {
  const hits: (SearchHit & { href: string })[] = []
  for (const src of referenceSources) {
    const scoped = await scopeWhereForModule(session, src.permissionKey, "view", src.table)
    const { where, args } = mergeScopeIntoWhere(`WHERE ${src.column} LIKE ?`, [like], scoped)
    try {
      const rows = await query<any[]>(
        `SELECT id, ${src.column} AS ref, status FROM ${src.table} ${where} ORDER BY created_at DESC LIMIT 5`,
        args,
      )
      for (const r of rows) {
        if (!r.ref) continue
        hits.push({ id: `${src.table}:${r.id}`, title: String(r.ref), subtitle: src.label, meta: r.status || "", href: src.href })
      }
    } catch {
      // Table/column may not exist on older installs — skip that source.
    }
  }
  if (!hits.length) return null
  return { key: "references", label: "Reference IDs", href: "/modules/operations", results: hits.slice(0, 12) }
}

async function searchEntity(session: SessionPayload, def: EntityDef, q: string, like: string): Promise<Group | null> {
  const scoped = await scopeWhereForModule(session, def.permissionKey, "view", def.table)
  const clauses: string[] = def.textColumns.map((c) => `${c} LIKE ?`)
  const params: any[] = def.textColumns.map(() => like)
  const isNumeric = /^\d+$/.test(q)
  if (def.matchId && isNumeric) {
    clauses.push("id = ?")
    params.push(Number(q))
  }
  const baseWhere = `WHERE (${clauses.join(" OR ")})`
  const { where, args } = mergeScopeIntoWhere(baseWhere, params, scoped)
  try {
    const rows = await query<any[]>(`SELECT * FROM ${def.table} ${where} ORDER BY created_at DESC LIMIT 10`, args)
    if (!rows.length) return null
    return {
      key: def.key,
      label: def.label,
      href: def.href,
      results: rows.map((r) => ({
        id: r.id,
        title: def.title(r),
        subtitle: def.subtitle(r),
        meta: def.meta(r),
      })),
    }
  } catch {
    return null
  }
}

export async function GET(request: Request) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const q = (new URL(request.url).searchParams.get("q") || "").trim()
  if (q.length < 2) return NextResponse.json({ query: q, groups: [] as Group[] })

  const like = `%${q}%`
  try {
    const entityGroups = await Promise.all(entities.map((def) => searchEntity(session, def, q, like)))
    const [clients, references] = await Promise.all([searchClients(session, like), searchReferences(session, like)])

    const groups = [...entityGroups, clients, references].filter((g): g is Group => g !== null)
    const total = groups.reduce((sum, g) => sum + g.results.length, 0)
    return NextResponse.json({ query: q, total, groups })
  } catch (error) {
    console.log("[v0] operations search failed:", (error as Error).message)
    return NextResponse.json({ error: "Search failed" }, { status: 500 })
  }
}
