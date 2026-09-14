import { NextRequest, NextResponse } from "next/server"
import { requireFeature } from "@/lib/api-auth"
import { tdsLiability } from "@/lib/finance-tds-compliance"
import type { TdsDirection } from "@/lib/finance-tds-filing"

const FEATURE = "finance.tds_filing"

function dirOf(value: unknown): TdsDirection {
  const s = String(value)
  if (s === "payable") return "payable"
  if (s === "employee") return "employee"
  return "receivable"
}

export async function GET(req: NextRequest) {
  const session = await requireFeature(FEATURE)
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const fy = req.nextUrl.searchParams.get("fy")
  const direction = dirOf(req.nextUrl.searchParams.get("direction"))
  if (!fy) return NextResponse.json({ error: "Financial year (fy) is required." }, { status: 400 })
  try {
    return NextResponse.json(await tdsLiability(fy, direction))
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 400 })
  }
}
