import { type NextRequest, NextResponse } from "next/server"
import { requireFeature } from "@/lib/api-auth"
import { catalogForSource } from "@/lib/legal-contract-variables"
import { CONTRACT_SOURCES } from "@/lib/legal-contracts-shared"

export async function GET(request: NextRequest) {
  const session = await requireFeature("legal.view_contract_templates")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const source = request.nextUrl.searchParams.get("source")
  if (source) {
    const variables = await catalogForSource(source)
    return NextResponse.json({ variables })
  }
  // No source: return the catalog grouped by every source.
  const bySource: Record<string, unknown> = {}
  for (const s of CONTRACT_SOURCES) bySource[s] = await catalogForSource(s)
  return NextResponse.json({ bySource })
}
