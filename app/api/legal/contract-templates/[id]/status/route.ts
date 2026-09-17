import { type NextRequest, NextResponse } from "next/server"
import { requireFeature } from "@/lib/api-auth"
import { setTemplateStatus } from "@/lib/legal-contracts-templates"
import type { TemplateStatus } from "@/lib/legal-contracts-shared"

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireFeature("legal.view_contract_templates")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const { id } = await params
  const body = await request.json().catch(() => ({}))
  const to = body.status as TemplateStatus
  if (!to) return NextResponse.json({ error: "status is required" }, { status: 400 })
  const result = await setTemplateStatus(Number(id), to, session.userId)
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 })
  return NextResponse.json({ template: result.template })
}
