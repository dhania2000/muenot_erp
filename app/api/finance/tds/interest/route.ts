import { NextRequest, NextResponse } from "next/server"
import { requireFeature } from "@/lib/api-auth"
import { suggestDepositInterest, suggestReturnLateFee, type TdsQuarter } from "@/lib/finance-tds-compliance"

const FEATURE = "finance.tds_filing"

function quarterOf(value: string | null): TdsQuarter {
  return value === "Q1" || value === "Q2" || value === "Q3" || value === "Q4" ? value : "Q1"
}

export async function GET(req: NextRequest) {
  const session = await requireFeature(FEATURE)
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const sp = req.nextUrl.searchParams
  const kind = sp.get("kind") || "deposit"
  const tds = Number(sp.get("tds") || 0)
  try {
    if (kind === "late_fee") {
      const suggestion = suggestReturnLateFee(
        quarterOf(sp.get("quarter")),
        sp.get("fy") || "",
        tds,
        sp.get("date"),
      )
      return NextResponse.json({ suggestion })
    }
    const suggestion = suggestDepositInterest(sp.get("period") || "", tds, sp.get("date"))
    return NextResponse.json({ suggestion })
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 400 })
  }
}
