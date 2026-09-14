import { NextRequest, NextResponse } from "next/server"
import { requireFeature, requireModuleAction } from "@/lib/api-auth"
import {
  listChallanAllocations,
  challanAllocatable,
  allocationCandidates,
  allocateChallan,
  autoAllocateChallan,
  clearChallanAllocations,
} from "@/lib/finance-tds-compliance"

const FEATURE = "finance.tds_filing"
const MODULE = "finance.tds_filing"

export async function GET(req: NextRequest) {
  const session = await requireFeature(FEATURE)
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const challanId = req.nextUrl.searchParams.get("challan")
  if (!challanId) return NextResponse.json({ error: "Challan id is required." }, { status: 400 })
  try {
    const [allocations, headroom, candidates] = await Promise.all([
      listChallanAllocations(challanId),
      challanAllocatable(challanId),
      allocationCandidates(challanId),
    ])
    return NextResponse.json({ allocations, headroom, candidates })
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 400 })
  }
}

export async function POST(req: NextRequest) {
  const session = await requireModuleAction(MODULE, "record_challan")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const body = await req.json().catch(() => ({}))
  const challanId = String(body.challan_id || "")
  if (!challanId) return NextResponse.json({ error: "Challan id is required." }, { status: 400 })
  try {
    if (body.mode === "auto") {
      return NextResponse.json(await autoAllocateChallan(challanId, session.userId))
    }
    const lines = Array.isArray(body.lines)
      ? body.lines.map((l: any) => ({
          party_id: l.party_id ?? null,
          party_name: l.party_name ?? null,
          section: l.section ?? null,
          amount: Number(l.amount || 0),
        }))
      : []
    return NextResponse.json(await allocateChallan({ challanId, lines, actorId: session.userId }))
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 400 })
  }
}

export async function DELETE(req: NextRequest) {
  const session = await requireModuleAction(MODULE, "record_challan")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const challanId = req.nextUrl.searchParams.get("challan")
  if (!challanId) return NextResponse.json({ error: "Challan id is required." }, { status: 400 })
  try {
    return NextResponse.json(await clearChallanAllocations(challanId, session.userId))
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 400 })
  }
}
