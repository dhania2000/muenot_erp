import { NextRequest, NextResponse } from "next/server"
import { requireFeature, requireModuleAction } from "@/lib/api-auth"
import {
  gstSummary,
  listGstFilings,
  fileGstReturn,
  recordGstTaxPaid,
  transitionReturnStatus,
  amendGstReturn,
  listReturnAmendments,
  reconcileOutputGst,
  gstReconciliationCenter,
} from "@/lib/finance-gst-filing"
import {
  gstComplianceReport,
  gstQuarterlyCompliance,
  gstComplianceFinancialYears,
} from "@/lib/finance-gst-compliance"
import {
  gstPeriodCloseChecklist,
  closeGstPeriod,
  gstFilingAuditTrail,
  gstCaPackage,
} from "@/lib/finance-gst-automation"

const FEATURE = "finance.gst_filing"
const MODULE = "finance.gst_filing"

/**
 * Maps a state-machine transition to the extended action that authorises it.
 * File / payment / reopen / amend are DELIBERATELY separate from generic
 * Update so a plain Update grant can never advance a filed return.
 */
const TRANSITION_ACTION: Record<string, string> = {
  prepare: "prepare_return",
  "submit-review": "review_return",
  review: "review_return",
  reopen: "reopen_period",
  file: "file_return",
  "mark-payment-pending": "record_payment",
  complete: "record_payment",
  amend: "amend_return",
  cancel: "cancel_return",
}

function forbidden() {
  return NextResponse.json({ error: "Forbidden" }, { status: 403 })
}

export async function GET(req: NextRequest) {
  const session = await requireFeature(FEATURE)
  if (!session) return forbidden()
  const p = req.nextUrl.searchParams
  const period = p.get("period")
  const view = p.get("view")
  try {
    if (period && view === "reconcile") {
      if (!(await requireModuleAction(MODULE, "reconcile_gst"))) return forbidden()
      const [output, center, amendments] = await Promise.all([
        reconcileOutputGst(period),
        gstReconciliationCenter(period),
        listReturnAmendments(period),
      ])
      return NextResponse.json({ output, center, amendments })
    }
    if (period && view === "compliance") {
      return NextResponse.json({ compliance: await gstComplianceReport(period) })
    }
    if (period && view === "close") {
      return NextResponse.json({ close: await gstPeriodCloseChecklist(period) })
    }
    if (period && view === "audit") {
      if (!(await requireModuleAction(MODULE, "view_sensitive"))) return forbidden()
      return NextResponse.json({ audit: await gstFilingAuditTrail(period) })
    }
    if (period && view === "ca-package") {
      if (!(await requireModuleAction(MODULE, "export_return"))) return forbidden()
      return NextResponse.json({ package: await gstCaPackage(period) })
    }
    if (view === "quarterly") {
      const fy = p.get("fy")
      const years = await gstComplianceFinancialYears()
      const target = fy || years[0] || null
      const quarterly = target ? await gstQuarterlyCompliance(target) : null
      return NextResponse.json({ quarterly, financial_years: years })
    }
    if (period) return NextResponse.json({ summary: await gstSummary(period) })
    return NextResponse.json({ filings: await listGstFilings() })
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 400 })
  }
}

export async function POST(req: NextRequest) {
  // Must at least be able to view the module to reach any mutation.
  if (!(await requireFeature(FEATURE))) return forbidden()
  const body = await req.json().catch(() => ({}))
  const period = String(body.period || "")
  const action = String(body.action || "")

  // Resolve which extended action authorises this request, then enforce it.
  let requiredAction: string
  if (action === "record-payment") requiredAction = "record_payment"
  else if (action === "close-period") requiredAction = "manage_filing"
  else if (action === "amend") requiredAction = "amend_return"
  else if (action === "file-nil") requiredAction = "file_return"
  else if (action === "transition") {
    const t = String(body.transition || "")
    const mapped = TRANSITION_ACTION[t]
    if (!mapped) return NextResponse.json({ error: `Unknown transition: ${t}` }, { status: 400 })
    requiredAction = mapped
  } else {
    // Default (no/unknown action) is a direct file.
    requiredAction = "file_return"
  }

  const session = await requireModuleAction(MODULE, requiredAction)
  if (!session) return forbidden()

  try {
    if (action === "record-payment") {
      const result = await recordGstTaxPaid(period, Number(body.amount || 0), session.userId)
      return NextResponse.json({ ok: true, ...result })
    }
    if (action === "transition") {
      const result = await transitionReturnStatus(period, String(body.transition || ""), {
        arn: body.arn ?? null,
        reason: body.reason ?? null,
        actorId: session.userId,
        actorName: session.name ?? null,
      })
      return NextResponse.json({ ok: true, ...result })
    }
    if (action === "close-period") {
      const result = await closeGstPeriod(period, {
        actorId: session.userId,
        actorName: session.name ?? null,
      })
      return NextResponse.json({ ok: true, ...result })
    }
    if (action === "amend") {
      const result = await amendGstReturn(
        period,
        { reason: body.reason ?? null, arn: body.arn ?? null },
        session.userId,
        session.name ?? null,
      )
      return NextResponse.json({ ok: true, ...result })
    }
    if (action === "file-nil") {
      const result = await fileGstReturn(period, body.arn ?? null, session.userId, {
        nil: true,
        actorName: session.name ?? null,
      })
      return NextResponse.json({ ok: true, ...result })
    }
    const result = await fileGstReturn(period, body.arn ?? null, session.userId, {
      actorName: session.name ?? null,
    })
    return NextResponse.json({ ok: true, ...result })
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 400 })
  }
}
