import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { backfillUnification } from "@/lib/recruit-unification-db"

// One-time (re-runnable) backfill that links existing operational applications
// to a canonical Candidate Master and stamps application_id onto config-driven
// stage rows that only carried a candidate_id. Idempotent.
export async function POST() {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const result = await backfillUnification()
  return NextResponse.json({ ok: true, ...result })
}
