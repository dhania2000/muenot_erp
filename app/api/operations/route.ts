import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { query } from "@/lib/db"
import {
  scopeWhereForModule,
  mergeScopeIntoWhere,
  canCreateInModule,
  canActOnRecord,
} from "@/lib/permission-enforce"
import {
  syncTimesheet,
  computeSlaTracking,
  spawnQualityActions,
  syncScorecardCriteria,
  recalcScorecard,
  syncIssue,
  syncSlaBreach,
  snapshotSop,
  stampClientApprovalDecision,
} from "@/lib/operations-sync"
import { runTaskAutomation } from "@/lib/operations-task-automation"
import { ensureOperationsSchema } from "@/lib/operations-ensure"
import type { SessionPayload } from "@/lib/auth"

const tables = {
  resources: "operations_resources",
  projects: "operations_projects",
  allocations: "operations_allocations",
  quality: "operations_quality_reviews",
  issues: "operations_issues",
  milestones: "operations_milestones",
  deliverables: "operations_deliverables",
  project_documents: "operations_project_documents",
  tasks: "operations_tasks",
  work_orders: "operations_work_orders",
  resource_requests: "operations_resource_requests",
  skill_matrix: "operations_skill_matrix",
  capacity_planning: "operations_capacity_planning",
  utilization: "operations_utilization",
  timesheets: "operations_timesheets",
  qa_audits: "operations_qa_audits",
  sla_monitoring: "operations_sla_monitoring",
  corrective_actions: "operations_corrective_actions",
  escalations: "operations_escalations",
  root_cause_capa: "operations_root_cause_capa",
  sops: "operations_sops",
  checklists: "operations_checklists",
  approvals: "operations_approvals",
  client_requirements: "operations_client_requirements",
  client_deliverables: "operations_client_deliverables",
  client_approvals: "operations_client_approvals",
  project_cost: "operations_project_cost",
  resource_cost: "operations_resource_cost",
  vendor_cost: "operations_vendor_cost",
  budget_vs_actual: "operations_budget_vs_actual",
  productivity: "operations_productivity",
  scorecards: "operations_scorecards",
  scorecard_criteria: "operations_scorecard_criteria",
} as const

type Kind = keyof typeof tables

// Maps each writable kind to its permission-matrix key so record scope + create
// guards use the same rules configured in the Employees permission UI.
const permissionKeys: Record<Kind, string> = {
  resources: "operations.resources",
  projects: "operations.projects",
  allocations: "operations.allocations",
  quality: "operations.quality",
  issues: "operations.issues",
  milestones: "operations.milestones",
  deliverables: "operations.deliverables",
  project_documents: "operations.project_documents",
  tasks: "operations.tasks",
  work_orders: "operations.work_orders",
  resource_requests: "operations.resource_requests",
  skill_matrix: "operations.skill_matrix",
  capacity_planning: "operations.capacity_planning",
  utilization: "operations.utilization",
  timesheets: "operations.timesheets",
  qa_audits: "operations.qa_audits",
  sla_monitoring: "operations.sla_monitoring",
  corrective_actions: "operations.corrective_actions",
  escalations: "operations.escalations",
  root_cause_capa: "operations.root_cause_capa",
  sops: "operations.sops",
  checklists: "operations.checklists",
  approvals: "operations.approvals",
  client_requirements: "operations.client_requirements",
  client_deliverables: "operations.client_deliverables",
  client_approvals: "operations.client_approvals",
  project_cost: "operations.project_cost",
  resource_cost: "operations.resource_cost",
  vendor_cost: "operations.vendor_cost",
  budget_vs_actual: "operations.budget_vs_actual",
  productivity: "operations.productivity",
  scorecards: "operations.scorecards",
  scorecard_criteria: "operations.scorecard_criteria",
}

// Whitelist of writable columns per kind. Shared by create (POST) and update
// (PUT) so both paths accept exactly the same fields and never allow arbitrary
// column writes.
const allowedFields: Record<Kind, string[]> = {
  resources:["employee_id","resource_name","resource_type","department","designation","skill_category","primary_skills","secondary_skills","skill_set","capacity_hours","employment_status","joining_date","exit_date","current_location","work_mode","availability_status","cost_rate","rate_type","reporting_manager","personal_email","official_email","contact_mobile","vendor_agency","shift","status","notes","remarks"],
  projects:["project_name","client_id","client_name","service_vertical","project_type","project_manager","operations_manager","manager_name","start_date","end_date","status","billing_model","budget_amount","required_resources","allocated_resources","resources_deficiency","sla_target","sla_due_date","priority","shift","work_mode","client_poc","client_email","client_contact","description","remarks"],
  allocations:["project_id","client_name","resource_id","resource_name","resource_type","role","allocation_percent","from_date","to_date","shift","working_capacity","allocated_capacity","available_capacity","status","project_manager","operations_manager","assigned_by","notes","remarks"],
  quality:["task_id","project_id","client_name","resource_id","resource_name","resource_type","review_date","quality_score","quality_target","error_rate","rework_count","sla_target","sla_actual","sla_score","sla_status","client_escalation","root_cause","corrective_action","action_owner","action_due_date","closure_date","status","reviewer_name","remarks"],
  issues:["date_reported","project_id","client_name","issue_type","issue_category","priority","title","description","impact","reported_by","assigned_to","root_cause","corrective_action","preventive_action","target_date","due_date","closure_date","status","escalation_level","client_impact","business_impact","remarks"],
  milestones:["project_id","project_name","milestone_name","description","owner","planned_start","planned_end","actual_start","actual_end","completion_percent","priority","status","remarks"],
  deliverables:["project_id","project_name","deliverable_name","milestone_id","description","deliverable_type","owner","due_date","submitted_date","accepted_date","version","quality_status","status","remarks"],
  project_documents:["project_id","project_name","document_name","document_type","category","version","owner","document_url","effective_date","expiry_date","confidentiality","status","remarks"],
  tasks:["project_id","project_name","client_name","task_title","description","task_type","assigned_to","resource_id","resource_name","milestone_id","milestone_name","reporter","priority","start_date","due_date","estimated_hours","actual_hours","completion_percent","board_stage","status","remarks"],
  work_orders:["work_order_no","project_id","task_id","client_name","title","description","instructions","work_type","assigned_to","resource_id","resource_name","requested_by","priority","start_date","due_date","estimated_cost","actual_cost","status","remarks"],
  resource_requests:["project_id","project_name","requested_by","resource_type","skill_category","required_skills","quantity","allocation_percent","required_from","required_to","priority","justification","approver","status","remarks"],
  skill_matrix:["resource_id","resource_name","department","skill_category","skill_name","proficiency_level","experience_years","certification","last_assessed","assessed_by","status","remarks"],
  capacity_planning:["period","department","resource_type","project_id","planned_capacity","allocated_capacity","available_capacity","demand_forecast","utilization_target","owner","status","remarks"],
  utilization:["resource_id","resource_name","project_id","period","billable_hours","non_billable_hours","available_hours","utilization_percent","billable_percent","target_utilization","status","remarks"],
  timesheets:["resource_id","resource_name","project_id","project_name","task_id","work_date","start_time","end_time","hours_worked","billable_hours","non_billable_hours","activity_type","description","approved_by","approval_status","status","remarks"],
  qa_audits:["audit_no","project_id","client_name","audit_type","audit_scope","auditor","audit_date","findings","non_conformities","severity","score","corrective_action_required","closure_date","status","remarks"],
  sla_monitoring:["project_id","client_name","sla_metric","sla_target","actual_value","unit","measurement_period","due_date","actual_completion","delay_days","breach_count","penalty","owner","review_date","sla_status","status","remarks"],
  corrective_actions:["reference_no","project_id","source_type","issue_summary","root_cause","corrective_action","preventive_action","action_owner","target_date","closure_date","effectiveness","status","remarks"],
  escalations:["escalation_no","project_id","client_name","raised_by","escalation_level","category","description","impact","assigned_to","raised_date","target_resolution","resolution","closure_date","status","remarks"],
  root_cause_capa:["reference_no","project_id","problem_statement","analysis_method","root_cause","capa_type","corrective_action","preventive_action","owner","target_date","verification_date","effectiveness","status","remarks"],
  sops:["sop_code","title","category","department","version","description","owner","effective_date","review_date","next_review_date","approval_status","document_url","status","remarks"],
  checklists:["checklist_name","category","project_id","linked_sop","description","total_items","completed_items","owner","due_date","completion_percent","status","remarks"],
  approvals:["approval_no","request_type","related_to","project_id","requested_by","approver","request_date","priority","description","decision","decision_date","status","remarks"],
  client_requirements:["client_name","project_id","requirement_title","description","requirement_type","priority","source","owner","received_date","target_date","acceptance_criteria","status","remarks"],
  client_deliverables:["client_name","project_id","deliverable_name","description","deliverable_type","owner","due_date","submitted_date","acceptance_date","acceptance_status","version","status","remarks"],
  client_approvals:["client_name","project_id","approval_item","description","submitted_to","submitted_date","approver_name","decision","decision_date","feedback","status","remarks"],
  project_cost:["project_id","project_name","client_name","cost_category","cost_head","budgeted_cost","actual_cost","committed_cost","variance","currency","period","cost_date","status","remarks"],
  resource_cost:["resource_id","resource_name","project_id","cost_type","rate","rate_type","hours","period","total_cost","currency","billable","status","remarks"],
  vendor_cost:["vendor_name","project_id","service_category","po_number","description","invoice_amount","paid_amount","currency","invoice_date","due_date","payment_status","status","remarks"],
  budget_vs_actual:["project_id","project_name","client_name","category","budget_amount","actual_amount","variance","variance_percent","period","currency","forecast_amount","status","remarks"],
  productivity:["resource_id","resource_name","project_id","period","tasks_assigned","tasks_completed","deliverables_completed","estimated_hours","logged_hours","billable_hours","task_completion_percent","efficiency_percent","billable_percent","productivity_score","source","status","remarks"],
  scorecards:["scorecard_no","scorecard_type","subject_type","subject_id","subject_name","project_id","client_name","period","review_date","reviewer","total_score","max_score","score_percent","result","status","remarks"],
  scorecard_criteria:["scorecard_id","criteria_name","weight","max_score","score","weighted_score","status","remarks"],
}

function kind(value: string | null): Kind | null { return value && value in tables ? value as Kind : null }

// After a successful create/update, fan out to the cross-module sync layer.
// Best-effort: a hook failure is logged but never fails the user's write.
async function runSyncHooks(
  selected: Kind,
  row: Record<string, any>,
  session: SessionPayload,
  changeType: "Created" | "Updated",
): Promise<void> {
  try {
    if (selected === "timesheets") await syncTimesheet(row)
    else if (selected === "quality") await spawnQualityActions(row, row.id)
    else if (selected === "scorecard_criteria") await syncScorecardCriteria(row, row.id)
    else if (selected === "scorecards") await recalcScorecard(row.id)
    else if (selected === "issues") await syncIssue(row, row.id)
    else if (selected === "sla_monitoring") await syncSlaBreach(row, row.id)
    else if (selected === "sops") await snapshotSop(row, row.id, changeType, { id: session.userId, name: session.name })
    else if (selected === "client_approvals") await stampClientApprovalDecision(row.id, { id: session.userId, name: session.name })

    // Phase 71 — spawn linked follow-up tasks into the existing tasks pipeline.
    // Idempotent, so calling on both Created and Updated is safe.
    await runTaskAutomation(selected, row, changeType)
  } catch (error) {
    console.log("[v0] operations sync hook failed:", (error as Error).message)
  }
}

export async function GET(request: Request) {
  const session = await getSession(); if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const url = new URL(request.url); const selected = kind(url.searchParams.get("kind"))
  try {
    if (selected) {
      const scoped = await scopeWhereForModule(session, permissionKeys[selected], "view", tables[selected])
      const { where, args } = mergeScopeIntoWhere("", [], scoped)
      const rows = await query<any[]>(`SELECT * FROM ${tables[selected]} ${where} ORDER BY created_at DESC`, args)
      return NextResponse.json({ kind: selected, rows })
    }
    const summaryRows = await query<any[]>(`SELECT (SELECT COUNT(*) FROM operations_resources WHERE status='Active') active_resources, (SELECT COUNT(*) FROM operations_projects WHERE status='Active') active_projects, (SELECT COUNT(*) FROM operations_allocations WHERE status='Active') active_allocations, (SELECT COUNT(*) FROM operations_issues WHERE status IN ('Open','In Progress')) open_issues`)
    return NextResponse.json({ summary: summaryRows[0] })
  } catch { return NextResponse.json({ error: "Failed to load operations data" }, { status: 500 }) }
}

export async function POST(request: Request) {
  const session = await getSession(); if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const body = await request.json(); const selected = kind(body.kind); if (!selected) return NextResponse.json({ error: "Invalid record type" }, { status: 400 })
  if (!(await canCreateInModule(session, permissionKeys[selected]))) return NextResponse.json({ error: "You do not have permission to create this record." }, { status: 403 })
  if (selected === "sla_monitoring") Object.assign(body, computeSlaTracking(body))
  const keys = allowedFields[selected].filter((key) => body[key] !== undefined); if (!keys.length) return NextResponse.json({ error: "No fields supplied" }, { status: 400 })
  try {
    await ensureOperationsSchema()
    const values = keys.map((key) => body[key] === "" ? null : body[key]); const placeholders = keys.map(() => "?").join(",")
    const result = await query<any>(`INSERT INTO ${tables[selected]} (${keys.join(",")}) VALUES (${placeholders})`, values)
    await runSyncHooks(selected, { ...body, id: result.insertId }, session, "Created")
    return NextResponse.json({ id: result.insertId }, { status: 201 })
  } catch { return NextResponse.json({ error: "Failed to create operation record" }, { status: 500 }) }
}

export async function PUT(request: Request) {
  const session = await getSession(); if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const body = await request.json(); const selected = kind(body.kind); if (!selected) return NextResponse.json({ error: "Invalid record type" }, { status: 400 })
  const id = body.id; if (!id) return NextResponse.json({ error: "Missing record id" }, { status: 400 })
  try {
    await ensureOperationsSchema()
    const existing = await query<any[]>(`SELECT * FROM ${tables[selected]} WHERE id = ? LIMIT 1`, [id])
    if (!existing.length) return NextResponse.json({ error: "Record not found" }, { status: 404 })
    if (!(await canActOnRecord(session, permissionKeys[selected], "update", existing[0]))) return NextResponse.json({ error: "You do not have permission to edit this record." }, { status: 403 })
    if (selected === "sla_monitoring") Object.assign(body, computeSlaTracking({ ...existing[0], ...body }))
    const keys = allowedFields[selected].filter((key) => body[key] !== undefined); if (!keys.length) return NextResponse.json({ error: "No fields supplied" }, { status: 400 })
    const values = keys.map((key) => body[key] === "" ? null : body[key])
    const setClause = keys.map((key) => `${key} = ?`).join(",")
    await query(`UPDATE ${tables[selected]} SET ${setClause} WHERE id = ?`, [...values, id])
    await runSyncHooks(selected, { ...existing[0], ...body, id }, session, "Updated")
    return NextResponse.json({ id })
  } catch { return NextResponse.json({ error: "Failed to update operation record" }, { status: 500 }) }
}

export async function DELETE(request: Request) {
  const session = await getSession(); if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const url = new URL(request.url); const selected = kind(url.searchParams.get("kind")); const id = url.searchParams.get("id")
  if (!selected) return NextResponse.json({ error: "Invalid record type" }, { status: 400 })
  if (!id) return NextResponse.json({ error: "Missing record id" }, { status: 400 })
  try {
    const existing = await query<any[]>(`SELECT * FROM ${tables[selected]} WHERE id = ? LIMIT 1`, [id])
    if (!existing.length) return NextResponse.json({ error: "Record not found" }, { status: 404 })
    if (!(await canActOnRecord(session, permissionKeys[selected], "delete", existing[0]))) return NextResponse.json({ error: "You do not have permission to delete this record." }, { status: 403 })
    await query(`DELETE FROM ${tables[selected]} WHERE id = ?`, [id])
    return NextResponse.json({ ok: true })
  } catch { return NextResponse.json({ error: "Failed to delete operation record" }, { status: 500 }) }
}
