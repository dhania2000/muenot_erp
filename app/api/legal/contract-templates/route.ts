import { type NextRequest, NextResponse } from "next/server"
import { requireFeature } from "@/lib/api-auth"
import { listContractTemplates, createContractTemplate } from "@/lib/legal-contracts-templates"

export async function GET(request: NextRequest) {
  const session = await requireFeature("legal.view_contract_templates")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const sp = request.nextUrl.searchParams
  const templates = await listContractTemplates({
    search: sp.get("search") || undefined,
    status: sp.get("status") || undefined,
    contractType: sp.get("type") || undefined,
    category: sp.get("category") || undefined,
    source: sp.get("source") || undefined,
  })
  return NextResponse.json({ templates })
}

export async function POST(request: NextRequest) {
  const session = await requireFeature("legal.view_contract_templates")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const body = await request.json().catch(() => ({}))
  const result = await createContractTemplate({
    name: body.name,
    contractType: body.contractType || body.contract_type,
    category: body.category,
    description: body.description ?? null,
    source: body.source || "manual",
    content: body.content || "",
    requiredVariables: body.requiredVariables ?? null,
    reviewDate: body.reviewDate ?? null,
    expiryDate: body.expiryDate ?? null,
    ownerId: body.ownerId ?? null,
    actorId: session.userId,
  })
  if (!result.ok) return NextResponse.json({ error: result.error, details: result.details }, { status: 400 })
  return NextResponse.json({ template: result.template }, { status: 201 })
}
