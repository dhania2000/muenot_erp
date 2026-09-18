import { NextRequest, NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { getFeatureChecker } from "@/lib/permissions"
import {
  listOrgUnits,
  getOrgTree,
  createOrgUnit,
  OrgValidationError,
  type CreateOrgUnitInput,
} from "@/lib/org-hierarchy"

const FEATURE = "organization.hierarchy"

export async function GET(req: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const can = await getFeatureChecker(session.userId, session.role)
  if (!can(FEATURE)) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const shape = req.nextUrl.searchParams.get("shape")
  if (shape === "tree") {
    const tree = await getOrgTree()
    return NextResponse.json({ tree })
  }
  const units = await listOrgUnits()
  return NextResponse.json({ units })
}

export async function POST(req: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const can = await getFeatureChecker(session.userId, session.role)
  if (!can(FEATURE)) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  try {
    const body = (await req.json()) as CreateOrgUnitInput
    const unit = await createOrgUnit(body, { userId: session.userId, name: session.name })
    return NextResponse.json({ unit }, { status: 201 })
  } catch (err) {
    if (err instanceof OrgValidationError) return NextResponse.json({ error: err.message }, { status: 400 })
    console.error("[v0] org unit create failed:", err)
    return NextResponse.json({ error: "Failed to create unit" }, { status: 500 })
  }
}
