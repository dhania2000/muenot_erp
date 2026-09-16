import { NextRequest, NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { getRequisitionDetail } from "@/lib/recruit-detail-db"

// Phase 89 — 360-degree detail for one Requisition: linked jobs, applications
// rolled up from those jobs, headcount progress, and budget vs actual cost.
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id } = await ctx.params
  const data = await getRequisitionDetail(decodeURIComponent(id))
  if (!data) return NextResponse.json({ error: "Requisition not found" }, { status: 404 })

  return NextResponse.json(data)
}
