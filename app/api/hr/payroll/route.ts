import { NextRequest, NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { canPerformAction } from "@/lib/permission-enforce"
import {
  createPayrollRun,
  finalizePayrollRun,
  getPayrollRun,
  listPayrollRuns,
  previewPayroll,
} from "@/lib/payroll-reconciliation"
import { isValidPeriod } from "@/lib/payroll-reconciliation-core"

/**
 * SPEC 44 (#203) — Payroll reconciliation.
 *   GET  ?period=YYYY-MM&preview=1   live attendance × timesheet reconciliation
 *   GET  ?id=N                        one persisted run (tenant scoped)
 *   GET                               list runs
 *   POST { action: "create", period, tax_slabs?, idempotency_key? }
 *   POST { action: "finalize", id, force?, reason? }
 */

async function authorize(write: boolean) {
  const session = await getSession()
  if (!session) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) }
  const action = write ? "edit" : "view"
  const ok =
    (await canPerformAction(session, "hr.attendance", action)) &&
    (await canPerformAction(session, "operations.timesheets", "view"))
  if (!ok) return { error: NextResponse.json({ error: "You do not have permission to manage payroll." }, { status: 403 }) }
  return { session }
}

export async function GET(request: NextRequest) {
  const auth = await authorize(false)
  if (auth.error) return auth.error
  const url = request.nextUrl
  try {
    const id = url.searchParams.get("id")
    if (id) {
      const run = await getPayrollRun(Number(id))
      return run ? NextResponse.json({ run }) : NextResponse.json({ error: "Payroll run not found." }, { status: 404 })
    }
    const period = url.searchParams.get("period") ?? undefined
    if (url.searchParams.get("preview")) {
      if (!isValidPeriod(period)) return NextResponse.json({ error: "Period must be YYYY-MM." }, { status: 400 })
      return NextResponse.json(await previewPayroll(period))
    }
    return NextResponse.json({ runs: await listPayrollRuns(period) })
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 400 })
  }
}

export async function POST(request: NextRequest) {
  const auth = await authorize(true)
  if (auth.error) return auth.error
  const body = await request.json().catch(() => null)
  if (!body || typeof body !== "object") return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 })
  const actor = { userId: Number(auth.session.userId) }
  try {
    if (body.action === "create") {
      if (!isValidPeriod(body.period)) return NextResponse.json({ error: "Period must be YYYY-MM." }, { status: 400 })
      const idem = request.headers.get("idempotency-key") ?? body.idempotency_key
      const result = await createPayrollRun({ period: body.period, tax_slabs: body.tax_slabs, idempotency_key: idem }, actor)
      return NextResponse.json(result, { status: result.duplicate ? 200 : 201 })
    }
    if (body.action === "finalize") {
      const id = Number(body.id)
      if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ error: "A valid run id is required." }, { status: 400 })
      const run = await finalizePayrollRun(id, actor, { force: Boolean(body.force), reason: body.reason })
      return NextResponse.json({ run })
    }
    return NextResponse.json({ error: "Unknown action." }, { status: 400 })
  } catch (error) {
    const message = (error as Error).message
    const status = /not found/i.test(message) ? 404 : /already finalized|unreconciled/i.test(message) ? 409 : 400
    return NextResponse.json({ error: message }, { status })
  }
}
