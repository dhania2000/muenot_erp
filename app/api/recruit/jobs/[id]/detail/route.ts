import { NextRequest, NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { getJobDetail } from "@/lib/recruit-detail-db"

// Phase 88 — 360-degree detail for one Job: the requisition it came from, every
// application against it, interviews, offers, and a derived hiring funnel.
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id } = await ctx.params
  const data = await getJobDetail(decodeURIComponent(id))
  if (!data) return NextResponse.json({ error: "Job not found" }, { status: 404 })

  return NextResponse.json(data)
}
