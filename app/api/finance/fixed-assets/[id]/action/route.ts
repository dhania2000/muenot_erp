import { NextRequest, NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import {
  capitaliseAsset,
  depreciateAsset,
  transferAsset,
  disposeAsset,
  archiveAsset,
} from "@/lib/finance-fixed-assets"

export const runtime = "nodejs"

type Ctx = { params: Promise<{ id: string }> }

// One endpoint for every Fixed Asset lifecycle action. The body's `action`
// selects the operation; each delegates to the engine, which posts through the
// shared Journal → GL engine (never writing the ledger directly).
export async function POST(req: NextRequest, ctx: Ctx) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const { id } = await ctx.params
  const body = await req.json().catch(() => ({}))
  const action = String(body.action || "")
  const createdBy = session.userId

  switch (action) {
    case "capitalise": {
      const r = await capitaliseAsset(id, { putToUseDate: body.put_to_use_date, createdBy })
      return r.ok ? NextResponse.json(r) : NextResponse.json({ error: r.error }, { status: 400 })
    }
    case "depreciate": {
      const r = await depreciateAsset(id, { period: body.period, date: body.date, createdBy })
      if (r.ok) return NextResponse.json(r)
      return NextResponse.json({ error: r.error || r.skipped || "Nothing to depreciate" }, { status: 400 })
    }
    case "transfer": {
      const r = await transferAsset(id, {
        transferDate: body.transfer_date,
        toLocation: body.to_location,
        toDepartment: body.to_department,
        toCostCentre: body.to_cost_centre,
        toCustodian: body.to_custodian,
        notes: body.notes,
        createdBy,
      })
      return r.ok ? NextResponse.json(r) : NextResponse.json({ error: r.error }, { status: 400 })
    }
    case "dispose":
    case "scrap": {
      const r = await disposeAsset(id, {
        scrap: action === "scrap",
        disposalDate: body.disposal_date,
        proceeds: body.proceeds,
        mode: body.mode,
        notes: body.notes,
        createdBy,
      })
      return r.ok ? NextResponse.json(r) : NextResponse.json({ error: r.error }, { status: 400 })
    }
    case "archive": {
      const r = await archiveAsset(id)
      return r.ok ? NextResponse.json(r) : NextResponse.json({ error: r.error }, { status: 400 })
    }
    default:
      return NextResponse.json({ error: `Unknown action "${action}"` }, { status: 400 })
  }
}
