import { NextResponse } from "next/server"
import { requireTenantAdmin, effectiveTenantId } from "@/lib/platform-guard"
import { getReport } from "@/lib/reports/store"
import { runReport, ReportValidationError } from "@/lib/reports/query-builder"
import { REPORT_CAPS } from "@/lib/reports/model"

export const runtime = "nodejs"

/**
 * Run a report and return rows for interactive display. Accepts either an
 * ad-hoc `definition` (live builder preview) or a saved report `id`. Results
 * are capped to a preview page size; the export routes produce full extracts.
 */
export async function POST(request: Request) {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const tenantId = effectiveTenantId(guard.ctx)

  const body = await request.json().catch(() => null)
  if (!body) return NextResponse.json({ error: "Invalid request body." }, { status: 400 })

  let definition = body.definition
  if (!definition && body.id != null) {
    const saved = await getReport(tenantId, Number(body.id))
    if (!saved) return NextResponse.json({ error: "Report not found." }, { status: 404 })
    definition = saved.definition
  }
  if (!definition) return NextResponse.json({ error: "A report definition or id is required." }, { status: 400 })

  const limit = Math.min(Number(body.limit) || REPORT_CAPS.previewRows, REPORT_CAPS.maxRows)

  try {
    const result = await runReport(definition, {
      tenantId,
      role: guard.ctx.tenantRole,
      limitOverride: limit,
    })
    return NextResponse.json(result)
  } catch (err) {
    if (err instanceof ReportValidationError) {
      return NextResponse.json({ error: err.message, errors: err.errors }, { status: 400 })
    }
    return NextResponse.json({ error: (err as Error).message }, { status: 400 })
  }
}
