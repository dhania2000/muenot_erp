import { NextRequest, NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { getFeatureChecker } from "@/lib/permissions"
import {
  updateOrgUnit,
  deleteOrgUnit,
  OrgValidationError,
  OrgNotFoundError,
  type UpdateOrgUnitInput,
  type DeleteMode,
} from "@/lib/org-hierarchy"

const FEATURE = "organization.hierarchy"

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const can = await getFeatureChecker(session.userId, session.role)
  if (!can(FEATURE)) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const { id } = await params
  const unitId = Number(id)
  if (!Number.isFinite(unitId)) return NextResponse.json({ error: "Invalid id" }, { status: 400 })

  try {
    const body = (await req.json()) as UpdateOrgUnitInput
    const unit = await updateOrgUnit(unitId, body, { userId: session.userId, name: session.name })
    return NextResponse.json({ unit })
  } catch (err) {
    if (err instanceof OrgValidationError) return NextResponse.json({ error: err.message }, { status: 400 })
    if (err instanceof OrgNotFoundError) return NextResponse.json({ error: err.message }, { status: 404 })
    console.error("[v0] org unit update failed:", err)
    return NextResponse.json({ error: "Failed to update unit" }, { status: 500 })
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const can = await getFeatureChecker(session.userId, session.role)
  if (!can(FEATURE)) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const { id } = await params
  const unitId = Number(id)
  if (!Number.isFinite(unitId)) return NextResponse.json({ error: "Invalid id" }, { status: 400 })

  const modeParam = req.nextUrl.searchParams.get("mode")
  const mode: DeleteMode = modeParam === "reparent" || modeParam === "cascade" ? modeParam : "block"

  try {
    await deleteOrgUnit(unitId, mode, { userId: session.userId, name: session.name })
    return NextResponse.json({ ok: true })
  } catch (err) {
    if (err instanceof OrgValidationError) return NextResponse.json({ error: err.message }, { status: 400 })
    if (err instanceof OrgNotFoundError) return NextResponse.json({ error: err.message }, { status: 404 })
    console.error("[v0] org unit delete failed:", err)
    return NextResponse.json({ error: "Failed to delete unit" }, { status: 500 })
  }
}
