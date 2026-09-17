import { type NextRequest, NextResponse } from "next/server"
import { requireFeature } from "@/lib/api-auth"
import {
  getContractTemplate,
  updateContractTemplate,
  deleteContractTemplate,
} from "@/lib/legal-contracts-templates"

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireFeature("legal.view_contract_templates")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const { id } = await params
  const template = await getContractTemplate(Number(id))
  if (!template) return NextResponse.json({ error: "Template not found" }, { status: 404 })
  return NextResponse.json({ template })
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireFeature("legal.view_contract_templates")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const { id } = await params
  const body = await request.json().catch(() => ({}))
  const result = await updateContractTemplate(Number(id), {
    name: body.name,
    contractType: body.contractType ?? body.contract_type,
    category: body.category,
    description: body.description,
    source: body.source,
    content: body.content,
    requiredVariables: body.requiredVariables ?? null,
    reviewDate: body.reviewDate,
    expiryDate: body.expiryDate,
    ownerId: body.ownerId,
    changeNote: body.changeNote ?? null,
    actorId: session.userId,
  })
  if (!result.ok) return NextResponse.json({ error: result.error, details: result.details }, { status: 400 })
  return NextResponse.json({ template: result.template })
}

export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireFeature("legal.view_contract_templates")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const { id } = await params
  const result = await deleteContractTemplate(Number(id))
  return NextResponse.json(result)
}
