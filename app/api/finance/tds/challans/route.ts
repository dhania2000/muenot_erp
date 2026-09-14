import { NextRequest, NextResponse } from "next/server"
import { requireFeature, requireModuleAction } from "@/lib/api-auth"
import { listChallans, createChallan, deleteChallan } from "@/lib/finance-tds-compliance"
import type { TdsDirection } from "@/lib/finance-tds-filing"

const FEATURE = "finance.tds_filing"
const MODULE = "finance.tds_filing"

function dirOf(value: unknown): TdsDirection {
  const s = String(value)
  if (s === "payable") return "payable"
  if (s === "employee") return "employee"
  return "receivable"
}

export async function GET(req: NextRequest) {
  const session = await requireFeature(FEATURE)
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const direction = dirOf(req.nextUrl.searchParams.get("direction"))
  const fy = req.nextUrl.searchParams.get("fy") || undefined
  try {
    return NextResponse.json({ challans: await listChallans(direction, fy) })
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 400 })
  }
}

export async function POST(req: NextRequest) {
  const session = await requireModuleAction(MODULE, "record_challan")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const body = await req.json().catch(() => ({}))
  try {
    const result = await createChallan({
      direction: dirOf(body.direction),
      period: String(body.period || ""),
      bsrCode: body.bsr_code ?? null,
      challanNo: body.challan_no ?? null,
      paymentDate: body.payment_date ?? null,
      tdsAmount: Number(body.tds_amount || 0),
      interest: Number(body.interest || 0),
      lateFee: Number(body.late_fee || 0),
      paymentMode: body.payment_mode ?? null,
      bankName: body.bank_name ?? null,
      paymentRef: body.payment_ref ?? null,
      note: body.note ?? null,
      actorId: session.userId,
    })
    return NextResponse.json({ ok: true, ...result })
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 400 })
  }
}

export async function DELETE(req: NextRequest) {
  const session = await requireModuleAction(MODULE, "record_challan")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const challanId = req.nextUrl.searchParams.get("id")
  if (!challanId) return NextResponse.json({ error: "Challan id is required." }, { status: 400 })
  try {
    return NextResponse.json(await deleteChallan(challanId, session.userId))
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 400 })
  }
}
