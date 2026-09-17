import { type NextRequest, NextResponse } from "next/server"
import { requireFeature } from "@/lib/api-auth"
import { listTemplateVersions } from "@/lib/legal-contracts-templates"

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireFeature("legal.view_contract_templates")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const { id } = await params
  const versions = await listTemplateVersions(Number(id))
  return NextResponse.json({ versions })
}
