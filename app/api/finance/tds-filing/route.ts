import { NextRequest, NextResponse } from "next/server"
import { requireFeature } from "@/lib/api-auth"
import { tdsSummary, tdsDetail, listTdsFilings, fileTdsReturn, type TdsDirection } from "@/lib/finance-tds-filing"

const FEATURE = "finance.tds_filing"

/** Normalize the query/body direction to a valid TdsDirection. */
function dirOf(value: unknown): TdsDirection {
  const s = String(value)
  if (s === "payable") return "payable"
  if (s === "employee") return "employee"
  return "receivable"
}

export async function GET(req: NextRequest) {
  const session = await requireFeature(FEATURE)
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const period = req.nextUrl.searchParams.get("period")
  const direction = dirOf(req.nextUrl.searchParams.get("direction"))
  try {
    if (period) {
      const [summary, detail] = await Promise.all([
        tdsSummary(period, direction, { coverage: true }),
        tdsDetail(period, direction, { coverage: true }),
      ])
      return NextResponse.json({ summary, detail })
    }
    return NextResponse.json({ filings: await listTdsFilings(direction) })
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 400 })
  }
}

export async function POST(req: NextRequest) {
  const session = await requireFeature(FEATURE)
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const body = await req.json().catch(() => ({}))
  try {
    const result = await fileTdsReturn(
      String(body.period || ""),
      body.challan_no ?? null,
      session.userId,
      dirOf(body.direction),
    )
    return NextResponse.json({ ok: true, ...result })
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 400 })
  }
}
