import { NextRequest, NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { listUnifiedCandidates, getUnifiedFunnel } from "@/lib/recruit-unification-db"

// Unified candidate pipeline: one row per canonical Candidate Master with the
// furthest stage reached across BOTH the operational and config-driven systems.
export async function GET(req: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const search = req.nextUrl.searchParams.get("search") || undefined
  const [candidates, funnel] = await Promise.all([listUnifiedCandidates(search), getUnifiedFunnel()])

  return NextResponse.json({ candidates, funnel, total: candidates.length })
}
