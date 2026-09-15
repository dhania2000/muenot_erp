import { NextRequest, NextResponse } from "next/server"
import { requireFeature } from "@/lib/api-auth"
import { tdsExceptionReport } from "@/lib/finance-tds-exceptions"
import type { TdsDirection } from "@/lib/finance-tds-filing"

const FEATURE = "finance.tds_filing"

function dirOf(value: unknown): TdsDirection {
  const s = String(value)
  if (s === "employee") return "employee"
  if (s === "receivable") return "receivable"
  return "payable"
}

export async function GET(req: NextRequest) {
  const session = await requireFeature(FEATURE)
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const fy = req.nextUrl.searchParams.get("fy")
  const direction = dirOf(req.nextUrl.searchParams.get("direction"))
  if (!fy) return NextResponse.json({ error: "Financial year (fy) is required." }, { status: 400 })
  try {
    return NextResponse.json(await tdsExceptionReport(fy, direction))
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 400 })
  }
}
