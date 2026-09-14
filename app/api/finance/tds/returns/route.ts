import { NextRequest, NextResponse } from "next/server"
import { requireFeature, requireModuleAction } from "@/lib/api-auth"
import { prepareTdsReturn, listTdsReturns, fileTdsReturn, type TdsQuarter } from "@/lib/finance-tds-compliance"
import type { TdsDirection } from "@/lib/finance-tds-filing"

const FEATURE = "finance.tds_filing"
const MODULE = "finance.tds_filing"

function dirOf(value: unknown): TdsDirection {
  const s = String(value)
  if (s === "payable") return "payable"
  if (s === "employee") return "employee"
  return "receivable"
}
function quarterOf(value: unknown): TdsQuarter {
  const s = String(value)
  return s === "Q1" || s === "Q2" || s === "Q3" || s === "Q4" ? s : "Q1"
}

export async function GET(req: NextRequest) {
  const session = await requireFeature(FEATURE)
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const params = req.nextUrl.searchParams
  const direction = dirOf(params.get("direction"))
  const fy = params.get("fy")
  const quarter = params.get("quarter")
  try {
    if (fy && quarter) {
      const preparation = await prepareTdsReturn(quarterOf(quarter), fy, direction)
      return NextResponse.json({ preparation })
    }
    return NextResponse.json({ returns: await listTdsReturns(direction) })
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 400 })
  }
}

export async function POST(req: NextRequest) {
  const session = await requireModuleAction(MODULE, "file_return")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const body = await req.json().catch(() => ({}))
  try {
    const result = await fileTdsReturn(
      quarterOf(body.quarter),
      String(body.fy || ""),
      dirOf(body.direction),
      body.token_no ?? null,
      session.userId,
    )
    return NextResponse.json({ ok: true, ...result })
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 400 })
  }
}
