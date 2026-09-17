import { type NextRequest, NextResponse } from "next/server"
import { requireFeature } from "@/lib/api-auth"
import { listSourceRecords } from "@/lib/legal-contract-variables"

// Typeahead picker for the "linked record" step of contract generation.
export async function GET(request: NextRequest) {
  const session = await requireFeature("legal.view_contracts")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const sp = request.nextUrl.searchParams
  const source = sp.get("source") || ""
  const search = sp.get("search") || ""
  const records = await listSourceRecords(source, search, Number(sp.get("limit")) || 25)
  return NextResponse.json({ records })
}
