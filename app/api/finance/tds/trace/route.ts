import { NextRequest, NextResponse } from "next/server"
import { requireFeature } from "@/lib/api-auth"
import { tdsTraceReconciliation } from "@/lib/finance-tds-trace"
import type { TdsDirection } from "@/lib/finance-tds-filing"
import type { TdsQuarter } from "@/lib/finance-tds-compliance"

const FEATURE = "finance.tds_filing"

function dirOf(value: unknown): TdsDirection {
  const s = String(value)
  if (s === "payable") return "payable"
  if (s === "employee") return "employee"
  return "receivable"
}

function quarterOf(value: string | null): TdsQuarter | null {
  return value === "Q1" || value === "Q2" || value === "Q3" || value === "Q4" ? value : null
}

export async function GET(req: NextRequest) {
  const session = await requireFeature(FEATURE)
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const direction = dirOf(req.nextUrl.searchParams.get("direction"))
  const fy = req.nextUrl.searchParams.get("fy") || ""
  const quarter = quarterOf(req.nextUrl.searchParams.get("quarter"))
  try {
    return NextResponse.json(await tdsTraceReconciliation(fy, direction, quarter))
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 400 })
  }
}
