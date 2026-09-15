import { NextRequest, NextResponse } from "next/server"
import { requireFeature, requireModuleAction } from "@/lib/api-auth"
import {
  prepareTdsReturn,
  listTdsReturns,
  fileTdsReturn,
  validateTdsReturn,
  setReturnStatus,
  createReturnCorrection,
  TDS_RETURN_STATUSES,
  type TdsQuarter,
  type TdsReturnStatus,
} from "@/lib/finance-tds-compliance"
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
function statusOf(value: unknown): TdsReturnStatus | null {
  const s = String(value)
  return (TDS_RETURN_STATUSES as readonly string[]).includes(s) ? (s as TdsReturnStatus) : null
}

export async function GET(req: NextRequest) {
  const session = await requireFeature(FEATURE)
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const params = req.nextUrl.searchParams
  const direction = dirOf(params.get("direction"))
  const fy = params.get("fy")
  const quarter = params.get("quarter")
  try {
    // Phase 37 — pre-filing validation for a specific quarter.
    if (fy && quarter && params.get("validate")) {
      const validation = await validateTdsReturn(quarterOf(quarter), fy, direction)
      return NextResponse.json({ validation })
    }
    // Phase 36 — return preparation for a specific quarter.
    if (fy && quarter) {
      const preparation = await prepareTdsReturn(quarterOf(quarter), fy, direction)
      return NextResponse.json({ preparation })
    }
    // Phase 39 — filing history.
    return NextResponse.json({ returns: await listTdsReturns(direction) })
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 400 })
  }
}

export async function POST(req: NextRequest) {
  const session = await requireModuleAction(MODULE, "file_return")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const body = await req.json().catch(() => ({}))
  const action = String(body.action || "file")
  try {
    // Phase 38 — move a filed/prepared return through its lifecycle.
    if (action === "set_status") {
      const target = statusOf(body.status)
      if (!target) return NextResponse.json({ error: "Unknown return status." }, { status: 400 })
      const result = await setReturnStatus(String(body.return_id || ""), target, {
        actorId: session.userId,
        remarks: body.remarks ?? null,
        arn: body.arn ?? null,
      })
      return NextResponse.json({ ok: true, ...result })
    }

    // Phase 40 — file a correction/revised return without overwriting the original.
    if (action === "correct") {
      const result = await createReturnCorrection({
        originalReturnId: String(body.return_id || ""),
        correctionType: body.correction_type ?? undefined,
        tokenNo: body.token_no ?? null,
        remarks: body.remarks ?? null,
        actorId: session.userId,
      })
      return NextResponse.json({ ok: true, ...result })
    }

    // Default (Phase 38) — file the original return for a quarter.
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
