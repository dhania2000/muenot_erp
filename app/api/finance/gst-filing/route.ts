import { NextRequest, NextResponse } from "next/server"
import { requireFeature } from "@/lib/api-auth"
import { gstSummary, listGstFilings, fileGstReturn, recordGstTaxPaid } from "@/lib/finance-gst-filing"

const FEATURE = "finance.gst_filing"

export async function GET(req: NextRequest) {
  const session = await requireFeature(FEATURE)
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const period = req.nextUrl.searchParams.get("period")
  try {
    if (period) return NextResponse.json({ summary: await gstSummary(period) })
    return NextResponse.json({ filings: await listGstFilings() })
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 400 })
  }
}

export async function POST(req: NextRequest) {
  const session = await requireFeature(FEATURE)
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const body = await req.json().catch(() => ({}))
  try {
    if (body.action === "record-payment") {
      const result = await recordGstTaxPaid(String(body.period || ""), Number(body.amount || 0), session.userId)
      return NextResponse.json({ ok: true, ...result })
    }
    const result = await fileGstReturn(String(body.period || ""), body.arn ?? null, session.userId)
    return NextResponse.json({ ok: true, ...result })
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 400 })
  }
}
