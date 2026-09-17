import { type NextRequest, NextResponse } from "next/server"
import { requireFeature } from "@/lib/api-auth"
import { getSignatory, updateSignatory } from "@/lib/legal-esign-signatories"
import type { SignatoryStatus } from "@/lib/legal-esign-shared"

export const runtime = "nodejs"

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireFeature("legal.view_esign")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const { id } = await params
  const signatory = await getSignatory(Number(id))
  if (!signatory) return NextResponse.json({ error: "Not found" }, { status: 404 })
  return NextResponse.json({ signatory })
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireFeature("legal.manage_esign")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const { id } = await params
  const existing = await getSignatory(Number(id))
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 })
  const body = await request.json().catch(() => ({}))
  const signatory = await updateSignatory(Number(id), {
    name: body.name !== undefined ? String(body.name).trim() : undefined,
    designation: body.designation,
    department: body.department,
    email: body.email,
    status: body.status as SignatoryStatus | undefined,
    isDefault: body.isDefault,
    defaultScope: body.defaultScope,
  })
  return NextResponse.json({ signatory })
}
