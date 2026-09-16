import { NextRequest, NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import {
  getInvestmentDetail,
  addInvestment,
  recordIncome,
  revalueInvestment,
  disposeInvestment,
} from "@/lib/finance-investments"

/**
 * Investment detail + lifecycle actions (Phase 5). GET returns the holding, its
 * posted transaction history and derived stats. POST dispatches one lifecycle
 * event — every action posts a balanced voucher through the shared engine
 * (Journal → GL), so the Trial Balance, Balance Sheet, General Ledger, Journal
 * and P&L reports all reflect it automatically. Session-gated.
 */

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id } = await ctx.params
  const detail = await getInvestmentDetail(decodeURIComponent(id))
  if (!detail) return NextResponse.json({ error: "Investment not found" }, { status: 404 })
  return NextResponse.json(detail)
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id } = await ctx.params
  const investmentId = decodeURIComponent(id)
  const body = await req.json().catch(() => ({}))
  const action = String(body.action || "")
  const createdBy = session.userId

  let result
  switch (action) {
    case "add":
      result = await addInvestment(investmentId, {
        amount: Number(body.amount),
        quantity: body.quantity === "" || body.quantity == null ? undefined : Number(body.quantity),
        date: body.date ?? null,
        fundingSource: body.fundingSource ?? null,
        notes: body.notes ?? null,
        createdBy,
      })
      break
    case "income":
      result = await recordIncome(investmentId, {
        kind: body.kind === "Dividend" ? "Dividend" : "Interest",
        amount: Number(body.amount),
        date: body.date ?? null,
        mode: body.mode ?? null,
        notes: body.notes ?? null,
        createdBy,
      })
      break
    case "revalue":
      result = await revalueInvestment(investmentId, {
        newValue: Number(body.newValue),
        date: body.date ?? null,
        notes: body.notes ?? null,
        createdBy,
      })
      break
    case "dispose":
      result = await disposeInvestment(investmentId, {
        kind: body.kind === "Redemption" ? "Redemption" : body.kind === "Maturity" ? "Maturity" : "Sale",
        proceeds: Number(body.proceeds),
        costPortion: body.costPortion === "" || body.costPortion == null ? null : Number(body.costPortion),
        quantity: body.quantity === "" || body.quantity == null ? null : Number(body.quantity),
        date: body.date ?? null,
        mode: body.mode ?? null,
        notes: body.notes ?? null,
        createdBy,
      })
      break
    default:
      return NextResponse.json({ error: "Unknown action" }, { status: 400 })
  }

  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 })
  return NextResponse.json(result)
}
