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
  const allowed: Record<Kind, string[]> = { resources:["employee_id","resource_name","resource_type","skill_set","capacity_hours","status","notes"], projects:["project_name","client_name","manager_name","start_date","end_date","status","priority","sla_due_date","description"], allocations:["project_id","resource_id","allocation_percent","from_date","to_date","status","assigned_by","notes"], quality:["project_id","resource_id","review_date","quality_score","sla_score","status","reviewer_name","remarks"], issues:["project_id","resource_id","title","description","priority","status","assigned_to","due_date","remarks"] }
  const keys = allowed[selected].filter((key) => body[key] !== undefined); if (!keys.length) return NextResponse.json({ error: "No fields supplied" }, { status: 400 })
  try { const values = keys.map((key) => body[key] === "" ? null : body[key]); const placeholders = keys.map(() => "?").join(","); const result = await query<any>(`INSERT INTO ${tables[selected]} (${keys.join(",")}) VALUES (${placeholders})`, values); return NextResponse.json({ id: result.insertId }, { status: 201 }) } catch { return NextResponse.json({ error: "Failed to create operation record" }, { status: 500 }) }
}
