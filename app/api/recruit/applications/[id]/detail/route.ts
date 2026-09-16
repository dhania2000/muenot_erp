import { NextRequest, NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { getApplicationDetail } from "@/lib/recruit-detail-db"

// Phase 90 — 360-degree detail for one Application: the linked candidate, job,
// and requisition, plus every stage record (screening, assessment, interview,
// feedback, selection, offer, verification, reference, pre-joining, joining).
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id } = await ctx.params
  const data = await getApplicationDetail(decodeURIComponent(id))
  if (!data) return NextResponse.json({ error: "Application not found" }, { status: 404 })

  return NextResponse.json(data)
}
