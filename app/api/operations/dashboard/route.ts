import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { requireFeature } from "@/lib/api-auth"

export async function GET() {
  const session = await requireFeature("operations.view_dashboard")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  // Top KPI strip: Active Resources, Active Projects, Total Allocations, Allocated / Available Capacity, Open Issues
  const [capacityRow] = (await query(
    `SELECT
       (SELECT COUNT(*) FROM operations_resources WHERE status = 'Active') AS active_resources,
       (SELECT COUNT(*) FROM operations_projects WHERE status = 'Active') AS active_projects,
       (SELECT COUNT(*) FROM operations_allocations) AS total_allocations,
       (SELECT COUNT(*) FROM operations_issues WHERE status IN ('Open','In Progress')) AS open_issues,
       COALESCE((SELECT SUM(r.capacity_hours * a.allocation_percent / 100)
                 FROM operations_allocations a JOIN operations_resources r ON r.resource_id = a.resource_id
                 WHERE a.status = 'Active'), 0) AS allocated_capacity,
       COALESCE((SELECT SUM(capacity_hours) FROM operations_resources WHERE status = 'Active'), 0) AS total_capacity`,
  )) as any[]
  const availableCapacity = Math.max(
    0,
    Number(capacityRow?.total_capacity ?? 0) - Number(capacityRow?.allocated_capacity ?? 0),
  )

  // Quality & SLA strip
  const [qualityRow] = (await query(
    `SELECT
       COUNT(*) AS quality_reviews,
       ROUND(AVG(quality_score), 1) AS avg_quality,
       SUM(sla_score IS NOT NULL AND sla_score < 70) AS sla_breached
     FROM operations_quality_reviews`,
  )) as any[]

  // Over-allocated resources: total active allocation % per resource exceeds 100
  const [overAllocatedRow] = (await query(
    `SELECT COUNT(*) AS over_allocated FROM (
       SELECT resource_id, SUM(allocation_percent) AS total_percent
       FROM operations_allocations WHERE status = 'Active'
       GROUP BY resource_id HAVING total_percent > 100
     ) t`,
  )) as any[]

  // FTE vs Freelancer/Contractor headcount
  const [headcountRow] = (await query(
    `SELECT
       SUM(resource_type = 'FTE') AS fte,
       SUM(resource_type IN ('Freelancer','Contractor')) AS non_fte
     FROM operations_resources WHERE status = 'Active'`,
  )) as any[]

  // Breakdown: resource type
  const resourceType = await query(
    `SELECT resource_type AS type, COUNT(*) AS count FROM operations_resources GROUP BY resource_type`,
  )

  // Breakdown: allocation status, derived per-resource from active allocation load
  //   0% = Not Allocated, <100% = Partially Allocated, =100% = Active, >100% = Over Allocated
  const allocationLoadRows = (await query(
    `SELECT resource_id, SUM(allocation_percent) AS total_percent
     FROM operations_allocations WHERE status = 'Active' GROUP BY resource_id`,
  )) as any[]
  const allocationBuckets = { Active: 0, "Over Allocated": 0, "Partially Allocated": 0 }
  for (const row of allocationLoadRows) {
    const pct = Number(row.total_percent)
    if (pct > 100) allocationBuckets["Over Allocated"]++
    else if (pct < 100) allocationBuckets["Partially Allocated"]++
    else allocationBuckets["Active"]++
  }
  const allocationStatus = Object.entries(allocationBuckets).map(([status, count]) => ({ status, count }))

  // Breakdown: SLA status, derived from quality review sla_score
  const [slaBucketRow] = (await query(
    `SELECT
       SUM(sla_score IS NULL) AS not_evaluated,
       SUM(sla_score IS NOT NULL AND sla_score >= 70) AS met,
       SUM(sla_score IS NOT NULL AND sla_score < 70) AS breached
     FROM operations_quality_reviews`,
  )) as any[]
  const slaStatus = [
    { status: "Not Evaluated", count: Number(slaBucketRow?.not_evaluated ?? 0) },
    { status: "Met SLA", count: Number(slaBucketRow?.met ?? 0) },
    { status: "Breached SLA", count: Number(slaBucketRow?.breached ?? 0) },
  ]

  // Breakdown: issue status
  const issueStatusRows = (await query(
    `SELECT status, COUNT(*) AS count FROM operations_issues GROUP BY status`,
  )) as any[]
  const issueStatus = issueStatusRows.length
    ? issueStatusRows.map((r) => ({ status: r.status, count: Number(r.count) }))
    : [{ status: "No Data", count: 0 }]

  return NextResponse.json({
    kpis: {
      activeResources: Number(capacityRow?.active_resources ?? 0),
      activeProjects: Number(capacityRow?.active_projects ?? 0),
      totalAllocations: Number(capacityRow?.total_allocations ?? 0),
      allocatedCapacity: Math.round(Number(capacityRow?.allocated_capacity ?? 0)),
      availableCapacity: Math.round(availableCapacity),
      openIssues: Number(capacityRow?.open_issues ?? 0),
      qualityReviews: Number(qualityRow?.quality_reviews ?? 0),
      avgQuality: Number(qualityRow?.avg_quality ?? 0),
      slaBreached: Number(qualityRow?.sla_breached ?? 0),
      overAllocated: Number(overAllocatedRow?.over_allocated ?? 0),
      fte: Number(headcountRow?.fte ?? 0),
      nonFte: Number(headcountRow?.non_fte ?? 0),
    },
    resourceType,
    allocationStatus,
    slaStatus,
    issueStatus,
  })
}
