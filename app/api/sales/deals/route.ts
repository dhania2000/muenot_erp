import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { requireFeature } from "@/lib/api-auth"
import { scopeWhereForModule, mergeScopeIntoWhere, canCreateInModule } from "@/lib/permission-enforce"
import { dataScopeWhere, mergeDataScope } from "@/lib/data-scope"
import { ensureDealPipelineSchema, createDeal, DealValidationError } from "@/lib/sales/deal-pipeline"

export async function GET(request: Request) {
  const session = await requireFeature("sales.view_deals")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  await ensureDealPipelineSchema()

  const { searchParams } = new URL(request.url)
  const pipelineId = searchParams.get("pipeline_id")

  // Record-level RBAC scope (added / owned / both) then data-level scope
  // (self / team / entity / all), mirroring the leads endpoint.
  const scoped = await scopeWhereForModule(session, "sales.deals", "view", "sales_deals", "d")
  const base = mergeScopeIntoWhere("WHERE d.archived_at IS NULL", [], scoped)
  if (pipelineId) {
    base.where += " AND d.pipeline_id = ?"
    base.args.push(Number(pipelineId))
  }
  const dataScope = await dataScopeWhere(session, "sales.deals", "d")
  const { where, args } = mergeDataScope(base.where, base.args, dataScope)

  const deals = await query(
    `SELECT d.*, u.name AS owner_name, ou.name AS team_name
     FROM sales_deals d
     LEFT JOIN users u ON u.id = d.owner_id
     LEFT JOIN org_units ou ON ou.id = d.team_id
     ${where}
     ORDER BY d.updated_at DESC`,
    args,
  ).catch(async () => {
    // org_units may not exist in every tenant — fall back without the join.
    return query(
      `SELECT d.*, u.name AS owner_name, NULL AS team_name
       FROM sales_deals d
       LEFT JOIN users u ON u.id = d.owner_id
       ${where}
       ORDER BY d.updated_at DESC`,
      args,
    )
  })

  return NextResponse.json({ deals })
}

export async function POST(request: Request) {
  const session = await requireFeature("sales.manage_deals")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  if (!(await canCreateInModule(session, "sales.deals"))) {
    return NextResponse.json({ error: "You do not have permission to create deals." }, { status: 403 })
  }

  try {
    const body = await request.json()
    const created = await createDeal(body, session.userId)
    return NextResponse.json(created)
  } catch (error) {
    if (error instanceof DealValidationError) return NextResponse.json({ error: error.message }, { status: 400 })
    console.error("[deals] create failed", error)
    return NextResponse.json({ error: "Unable to save deal." }, { status: 500 })
  }
}
