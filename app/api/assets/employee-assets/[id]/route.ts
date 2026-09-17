import { NextRequest, NextResponse } from "next/server"
import { requireFeature, requireModuleAction } from "@/lib/api-auth"
import { query } from "@/lib/db"
import {
  getAssignmentDetail,
  returnAsset,
  reassignAsset,
  markAssignment,
  updateAssignment,
  loadAssignment,
  ensureEmployeeAssetSchema,
  AssetAssignmentError,
  OCCUPYING_STATUSES,
} from "@/lib/employee-assets"

export const runtime = "nodejs"

type Ctx = { params: Promise<{ id: string }> }

export async function GET(_req: NextRequest, ctx: Ctx) {
  const session = await requireFeature("assets.view_employee_assets")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const { id } = await ctx.params
  const detail = await getAssignmentDetail(id)
  if (!detail) return NextResponse.json({ error: "Assignment not found" }, { status: 404 })
  return NextResponse.json(detail)
}

export async function PATCH(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params
  const body = await req.json().catch(() => ({}))
  const action = String(body.action || "update")

  // Each action maps to its own extended permission grant.
  const gate: Record<string, string> = {
    return: "return_asset",
    reassign: "reassign",
    mark_lost: "mark_status",
    mark_damaged: "mark_status",
    under_repair: "mark_status",
    update: "update",
  }
  const actionKey = gate[action]
  if (!actionKey) return NextResponse.json({ error: "Unknown action" }, { status: 400 })

  const session = await requireModuleAction("assets.employee_assets", actionKey)
  if (!session) return NextResponse.json({ error: "You do not have permission for this action." }, { status: 403 })

  try {
    let detail
    switch (action) {
      case "return":
        detail = await returnAsset(id, body, session)
        break
      case "reassign":
        detail = await reassignAsset(id, body, session)
        break
      case "mark_lost":
        detail = await markAssignment(id, "Lost", body, session)
        break
      case "mark_damaged":
        detail = await markAssignment(id, "Damaged", body, session)
        break
      case "under_repair":
        detail = await markAssignment(id, "Under Repair", body, session)
        break
      default:
        detail = await updateAssignment(id, body, session)
    }
    return NextResponse.json(detail)
  } catch (error) {
    if (error instanceof AssetAssignmentError)
      return NextResponse.json({ error: error.message }, { status: error.status })
    console.log("[v0] asset assignment action failed", (error as Error).message)
    return NextResponse.json({ error: "Action failed." }, { status: 500 })
  }
}

export async function DELETE(_req: NextRequest, ctx: Ctx) {
  const session = await requireModuleAction("assets.employee_assets", "delete")
  if (!session) return NextResponse.json({ error: "You do not have permission to delete." }, { status: 403 })
  const { id } = await ctx.params
  await ensureEmployeeAssetSchema()
  const row = await loadAssignment(id)
  if (!row) return NextResponse.json({ error: "Assignment not found" }, { status: 404 })
  // An active assignment must be returned first so the asset is freed and the
  // audit trail stays intact — never silently orphan a live assignment.
  if (OCCUPYING_STATUSES.includes(row.status)) {
    return NextResponse.json(
      { error: "Return or close this assignment before deleting it." },
      { status: 409 },
    )
  }
  await query(`DELETE FROM employee_asset_assignments WHERE assignment_id = ?`, [id])
  await query(
    `INSERT INTO employee_asset_audit (assignment_id, asset_id, action, user_id, user_name)
     VALUES (?,?,?,?,?)`,
    [id, row.finance_fixed_asset_id, "deleted", session.userId, session.name ?? null],
  ).catch(() => {})
  return NextResponse.json({ ok: true })
}
