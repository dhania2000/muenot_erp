import { NextRequest, NextResponse } from "next/server"
import { requireFeature, requireModuleAction } from "@/lib/api-auth"
import {
  gstInputMonthlySummary,
  gstInputQuarterlySummary,
  gstInputFinancialYears,
  reconcilePeriod,
  draftGstr2bFromBills,
  setClaimState,
  detectTaxExceptions,
} from "@/lib/finance-gst-input"

// The GST Input / ITC register is a GST compliance surface, so it is gated by
// the same feature as GST Filing rather than introducing a new grant.
const FEATURE = "finance.gst_filing"

const thisMonth = () => new Date().toISOString().slice(0, 7)

export async function GET(req: NextRequest) {
  const session = await requireFeature(FEATURE)
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const p = req.nextUrl.searchParams
  const financialYear = p.get("financial_year")
  const period = p.get("period") || thisMonth()

  try {
    const [monthly, financialYears, exceptions] = await Promise.all([
      gstInputMonthlySummary(period),
      gstInputFinancialYears(),
      detectTaxExceptions(period),
    ])
    const quarterly = financialYear ? await gstInputQuarterlySummary(financialYear) : null
    return NextResponse.json({ monthly, quarterly, financialYears, exceptions })
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 400 })
  }
}

// Each ITC mutation maps to a granular GST Filing action so the register can be
// permissioned independently: reconciliation/GSTR-2B drafting under reconcile_gst
// and claim/unclaim under manage_itc.
const POST_ACTIONS: Record<string, string> = {
  "draft-2b": "reconcile_gst",
  reconcile: "reconcile_gst",
  claim: "manage_itc",
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}) as Record<string, any>)
  const action = String(body.action || "")
  const period = String(body.period || "")

  const required = POST_ACTIONS[action]
  if (!required) return NextResponse.json({ error: "Unknown action" }, { status: 400 })

  const session = await requireModuleAction(FEATURE, required)
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  try {
    if (action === "draft-2b") {
      if (!period) throw new Error("A tax period is required to draft GSTR-2B.")
      const result = await draftGstr2bFromBills(period)
      return NextResponse.json({ ok: true, ...result })
    }
    if (action === "reconcile") {
      if (!period) throw new Error("A tax period is required to reconcile.")
      const result = await reconcilePeriod(period)
      return NextResponse.json({ ok: true, ...result })
    }
    if (action === "claim") {
      const ids = Array.isArray(body.ids) ? body.ids.map((n: any) => Number(n)).filter(Boolean) : []
      const result = await setClaimState(ids, Boolean(body.claimed), period || null)
      return NextResponse.json({ ok: true, ...result })
    }
    return NextResponse.json({ error: "Unknown action" }, { status: 400 })
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 400 })
  }
}
