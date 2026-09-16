import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { listCandidateDatabase } from "@/lib/recruit-unification-db"

export async function GET() {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  // Candidate Master (recruitment_candidates) is the single source of truth for
  // candidate profiles; this reader folds in live application stats.
  const candidates = await listCandidateDatabase()
  return NextResponse.json({ candidates })
}
