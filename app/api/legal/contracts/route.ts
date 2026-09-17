import { type NextRequest, NextResponse } from "next/server"
import { requireFeature } from "@/lib/api-auth"
import { listGeneratedContracts, contractStats, generateContract } from "@/lib/legal-contracts-generate"

export async function GET(request: NextRequest) {
  const session = await requireFeature("legal.view_contracts")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const sp = request.nextUrl.searchParams
  const [{ rows, total }, stats] = await Promise.all([
    listGeneratedContracts({
      search: sp.get("search") || undefined,
      status: sp.get("status") || undefined,
      source: sp.get("source") || undefined,
      contractType: sp.get("type") || undefined,
      limit: Number(sp.get("limit")) || 50,
      offset: Number(sp.get("offset")) || 0,
    }),
    contractStats(),
  ])
  return NextResponse.json({ contracts: rows, total, stats })
}

export async function POST(request: NextRequest) {
  const session = await requireFeature("legal.view_contracts")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const body = await request.json().catch(() => ({}))
  const result = await generateContract({
    templateId: body.templateId ?? null,
    title: body.title ?? null,
    contractType: body.contractType ?? body.contract_type ?? null,
    category: body.category ?? null,
    source: body.source || "manual",
    sourceRef: body.sourceRef ?? null,
    contentOverride: body.content ?? null,
    effectiveDate: body.effectiveDate ?? null,
    startDate: body.startDate ?? null,
    endDate: body.endDate ?? null,
    renewalDate: body.renewalDate ?? null,
    manualVars: body.manualVars ?? {},
    status: body.status || "Generated",
    allowMissing: !!body.allowMissing,
    supersedesId: body.supersedesId ?? null,
    actorId: session.userId,
    actorName: session.name ?? null,
  })
  if (!result.ok) {
    return NextResponse.json({ error: result.error, missing: result.missing }, { status: result.code })
  }
  return NextResponse.json({ contract: result.contract, deduped: !!result.deduped }, { status: 201 })
}
