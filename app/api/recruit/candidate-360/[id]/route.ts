import { NextRequest, NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { getCandidate360 } from "@/lib/recruit-unification-db"

// Full 360 journey for one candidate. The [id] may be a Candidate Master
// candidate_id or an operational application_id.
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id } = await ctx.params
  const data = await getCandidate360(decodeURIComponent(id))
  if (!data) return NextResponse.json({ error: "Candidate not found" }, { status: 404 })

  return NextResponse.json(data)
}
