import { type NextRequest, NextResponse } from "next/server"
import { requireFeature } from "@/lib/api-auth"
import { listSignatories, createSignatory } from "@/lib/legal-esign-signatories"

export const runtime = "nodejs"

export async function GET(request: NextRequest) {
  const session = await requireFeature("legal.view_esign")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const sp = request.nextUrl.searchParams
  const signatories = await listSignatories({
    activeOnly: sp.get("activeOnly") === "1",
    includeInactive: true,
  })
  return NextResponse.json({ signatories })
}

export async function POST(request: NextRequest) {
  const session = await requireFeature("legal.manage_esign")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const body = await request.json().catch(() => ({}))
  if (!body.name || String(body.name).trim().length === 0) {
    return NextResponse.json({ error: "A signatory name is required" }, { status: 400 })
  }
  const signatory = await createSignatory({
    employeeId: body.employeeId ? Number(body.employeeId) : null,
    name: String(body.name).trim(),
    designation: body.designation ?? null,
    department: body.department ?? null,
    email: body.email ?? null,
    isDefault: !!body.isDefault,
    defaultScope: body.defaultScope ?? null,
    createdBy: session.userId,
  })
  return NextResponse.json({ signatory }, { status: 201 })
}
