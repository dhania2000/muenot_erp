import { NextRequest, NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { getLoanWithSchedule } from "@/lib/finance-loans"

/**
 * Loans & Advances detail — a single read that returns the loan/advance row
 * together with its server-built amortisation schedule (EMI, principal /
 * interest split, running outstanding) and the derived stats. All money is
 * computed on the server so the browser never re-derives the schedule.
 */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id } = await ctx.params
  const detail = await getLoanWithSchedule(decodeURIComponent(id))
  if (!detail) return NextResponse.json({ error: "Loan / advance not found" }, { status: 404 })

  return NextResponse.json(detail)
}
