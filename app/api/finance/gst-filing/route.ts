import { NextRequest, NextResponse } from "next/server"
import { requireFeature } from "@/lib/api-auth"
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

const FEATURE = "finance.gst_filing"

export async function GET(req: NextRequest) {
  const session = await requireFeature(FEATURE)
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const p = req.nextUrl.searchParams
  const period = p.get("period")
  const view = p.get("view")
  try {
    if (period && view === "reconcile") {
      const [output, center, amendments] = await Promise.all([
        reconcileOutputGst(period),
        gstReconciliationCenter(period),
        listReturnAmendments(period),
      ])
      return NextResponse.json({ output, center, amendments })
    }
    if (period) return NextResponse.json({ summary: await gstSummary(period) })
    return NextResponse.json({ filings: await listGstFilings() })
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 400 })
  }
}

export async function POST(req: NextRequest) {
  const session = await requireFeature(FEATURE)
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const body = await req.json().catch(() => ({}))
  const period = String(body.period || "")
  try {
    if (body.action === "record-payment") {
      const result = await recordGstTaxPaid(period, Number(body.amount || 0), session.userId)
      return NextResponse.json({ ok: true, ...result })
    }
    if (body.action === "transition") {
      const result = await transitionReturnStatus(period, String(body.transition || ""), {
        arn: body.arn ?? null,
        reason: body.reason ?? null,
        actorId: session.userId,
        actorName: session.name ?? null,
      })
      return NextResponse.json({ ok: true, ...result })
    }
    if (body.action === "amend") {
      const result = await amendGstReturn(
        period,
        { reason: body.reason ?? null, arn: body.arn ?? null },
        session.userId,
        session.name ?? null,
      )
      return NextResponse.json({ ok: true, ...result })
    }
    if (body.action === "file-nil") {
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
