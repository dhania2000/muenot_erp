import { NextRequest, NextResponse } from "next/server"
import { requireFeature } from "@/lib/api-auth"
import { tdsSummary, listTdsFilings, fileTdsReturn } from "@/lib/finance-tds-filing"

const FEATURE = "finance.tds_filing"

export async function GET(req: NextRequest) {
  const session = await requireFeature(FEATURE)
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const period = req.nextUrl.searchParams.get("period")
  try {
    if (period) return NextResponse.json({ summary: await tdsSummary(period) })
    return NextResponse.json({ filings: await listTdsFilings() })
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 400 })
  }
}

export async function POST(req: NextRequest) {
  const session = await requireFeature(FEATURE)
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const body = await req.json().catch(() => ({}))
  try {
    const result = await fileTdsReturn(String(body.period || ""), body.challan_no ?? null, session.userId)
    return NextResponse.json({ ok: true, ...result })
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 400 })
  }
}
