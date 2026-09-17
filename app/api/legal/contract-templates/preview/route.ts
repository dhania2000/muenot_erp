import { type NextRequest, NextResponse } from "next/server"
import { requireFeature } from "@/lib/api-auth"
import { renderContractTemplate, validateTemplate, hasUnresolvedTokens } from "@/lib/legal-contracts-render"
import { resolveContractVariables } from "@/lib/legal-contract-variables"

// Live preview: render arbitrary template content against either a chosen
// source record or sample/manual values, without persisting anything.
export async function POST(request: NextRequest) {
  const session = await requireFeature("legal.view_contract_templates")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const body = await request.json().catch(() => ({}))
  const content = String(body.content || "")
  const source = String(body.source || "manual")

  const validation = validateTemplate({ content, source })
  const resolved = await resolveContractVariables({
    source,
    sourceRef: body.sourceRef ?? null,
    manualVars: body.manualVars ?? {},
    meta: {
      contractId: body.contractId || "CONT-PREVIEW",
      referenceNo: body.referenceNo || "PREVIEW/LEGAL/0000",
      title: body.title || "Draft Agreement",
      effectiveDate: body.effectiveDate,
      startDate: body.startDate,
      endDate: body.endDate,
      renewalDate: body.renewalDate,
      generatedBy: session.name || undefined,
    },
  })
  const rendered = renderContractTemplate(content, resolved.vars)
  return NextResponse.json({
    rendered,
    validation,
    resolvedVars: resolved.vars,
    partyName: resolved.partyName,
    hasUnresolved: hasUnresolvedTokens(rendered),
  })
}
