import { NextRequest, NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { getFeatureChecker } from "@/lib/permissions"
import {
  listUnitAssignments,
  assignUser,
  unassignUser,
  OrgValidationError,
  OrgNotFoundError,
} from "@/lib/org-hierarchy"

const FEATURE = "organization.hierarchy"

export async function GET(req: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const can = await getFeatureChecker(session.userId, session.role)
  if (!can(FEATURE)) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const unitId = Number(req.nextUrl.searchParams.get("unit_id"))
  if (!Number.isFinite(unitId)) return NextResponse.json({ error: "Invalid unit_id" }, { status: 400 })

  try {
    const assignments = await listUnitAssignments(unitId)
    return NextResponse.json({ assignments })
  } catch (err) {
    if (err instanceof OrgNotFoundError) return NextResponse.json({ error: err.message }, { status: 404 })
    console.error("[v0] org assignments list failed:", err)
    return NextResponse.json({ error: "Failed to load assignments" }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const can = await getFeatureChecker(session.userId, session.role)
  if (!can(FEATURE)) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  try {
    const body = await req.json()
    const unitId = Number(body.org_unit_id)
    const userId = Number(body.user_id)
    if (!Number.isFinite(unitId) || !Number.isFinite(userId)) {
      return NextResponse.json({ error: "org_unit_id and user_id are required" }, { status: 400 })
    }
    await assignUser(
      unitId,
      userId,
      { title: body.assignment_title ?? null, isPrimary: Boolean(body.is_primary) },
      { userId: session.userId, name: session.name },
    )
    return NextResponse.json({ ok: true }, { status: 201 })
  } catch (err) {
    if (err instanceof OrgValidationError) return NextResponse.json({ error: err.message }, { status: 400 })
    if (err instanceof OrgNotFoundError) return NextResponse.json({ error: err.message }, { status: 404 })
    console.error("[v0] org assign failed:", err)
    return NextResponse.json({ error: "Failed to assign user" }, { status: 500 })
  }
}

export async function DELETE(req: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const can = await getFeatureChecker(session.userId, session.role)
  if (!can(FEATURE)) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const unitId = Number(req.nextUrl.searchParams.get("unit_id"))
  const userId = Number(req.nextUrl.searchParams.get("user_id"))
  if (!Number.isFinite(unitId) || !Number.isFinite(userId)) {
    return NextResponse.json({ error: "unit_id and user_id are required" }, { status: 400 })
  }

  try {
    await unassignUser(unitId, userId, { userId: session.userId, name: session.name })
    return NextResponse.json({ ok: true })
  } catch (err) {
    if (err instanceof OrgNotFoundError) return NextResponse.json({ error: err.message }, { status: 404 })
    console.error("[v0] org unassign failed:", err)
    return NextResponse.json({ error: "Failed to remove user" }, { status: 500 })
  }
}
