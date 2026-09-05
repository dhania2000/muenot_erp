import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { query } from "@/lib/db"

const tables = { resources: "operations_resources", projects: "operations_projects", allocations: "operations_allocations", quality: "operations_quality_reviews", issues: "operations_issues" } as const

type Kind = keyof typeof tables
function kind(value: string | null): Kind | null { return value && value in tables ? value as Kind : null }

export async function GET(request: Request) {
  const session = await getSession(); if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const url = new URL(request.url); const selected = kind(url.searchParams.get("kind"))
  try {
    if (selected) { const rows = await query<any[]>(`SELECT * FROM ${tables[selected]} ORDER BY created_at DESC`); return NextResponse.json({ kind: selected, rows }) }
    const summaryRows = await query<any[]>(`SELECT (SELECT COUNT(*) FROM operations_resources WHERE status='Active') active_resources, (SELECT COUNT(*) FROM operations_projects WHERE status='Active') active_projects, (SELECT COUNT(*) FROM operations_allocations WHERE status='Active') active_allocations, (SELECT COUNT(*) FROM operations_issues WHERE status IN ('Open','In Progress')) open_issues`)
    return NextResponse.json({ summary: summaryRows[0] })
  } catch { return NextResponse.json({ error: "Failed to load operations data" }, { status: 500 }) }
}

export async function POST(request: Request) {
  const session = await getSession(); if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const body = await request.json(); const selected = kind(body.kind); if (!selected) return NextResponse.json({ error: "Invalid record type" }, { status: 400 })
  const allowed: Record<Kind, string[]> = {
    resources:["employee_id","resource_name","resource_type","department","designation","skill_category","primary_skills","secondary_skills","skill_set","capacity_hours","employment_status","joining_date","exit_date","current_location","work_mode","availability_status","cost_rate","rate_type","reporting_manager","personal_email","official_email","contact_mobile","vendor_agency","shift","status","notes","remarks"],
    projects:["project_name","client_id","client_name","service_vertical","project_type","project_manager","operations_manager","manager_name","start_date","end_date","status","billing_model","required_resources","allocated_resources","resources_deficiency","sla_target","sla_due_date","priority","shift","work_mode","client_poc","client_email","client_contact","description","remarks"],
    allocations:["project_id","client_name","resource_id","resource_name","resource_type","role","allocation_percent","from_date","to_date","shift","working_capacity","allocated_capacity","available_capacity","status","project_manager","operations_manager","assigned_by","notes","remarks"],
    quality:["task_id","project_id","client_name","resource_id","resource_name","resource_type","review_date","quality_score","quality_target","error_rate","rework_count","sla_target","sla_actual","sla_score","sla_status","client_escalation","root_cause","corrective_action","action_owner","action_due_date","closure_date","status","reviewer_name","remarks"],
    issues:["date_reported","project_id","client_name","issue_type","issue_category","priority","title","description","impact","reported_by","assigned_to","root_cause","corrective_action","preventive_action","target_date","due_date","closure_date","status","escalation_level","client_impact","business_impact","remarks"],
  }
  const keys = allowed[selected].filter((key) => body[key] !== undefined); if (!keys.length) return NextResponse.json({ error: "No fields supplied" }, { status: 400 })
  try { const values = keys.map((key) => body[key] === "" ? null : body[key]); const placeholders = keys.map(() => "?").join(","); const result = await query<any>(`INSERT INTO ${tables[selected]} (${keys.join(",")}) VALUES (${placeholders})`, values); return NextResponse.json({ id: result.insertId }, { status: 201 }) } catch { return NextResponse.json({ error: "Failed to create operation record" }, { status: 500 }) }
}
