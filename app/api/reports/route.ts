import { NextResponse } from "next/server"
import { requireTenantAdmin, effectiveTenantId } from "@/lib/platform-guard"
import { REPORT_SOURCES, type PublicReportSource } from "@/lib/reports/catalog"
import { resolveSourceColumns } from "@/lib/reports/query-builder"
import { createReport, listReports, type Actor } from "@/lib/reports/store"
import {
  AGGREGATIONS,
  AGGREGATION_LABELS,
  DATE_RANGE_LABELS,
  DATE_RANGE_PRESETS,
  FILTER_OPERATORS,
  OPERATOR_LABELS,
  REPORT_CAPS,
} from "@/lib/reports/model"

export const runtime = "nodejs"

/**
 * Build the PUBLIC catalog: catalog sources projected to browser-safe fields,
 * with each source's columns intersected against the live schema so the UI only
 * ever offers columns that actually exist. Physical table / tenant-column names
 * never leave the server.
 */
async function publicCatalog(): Promise<PublicReportSource[]> {
  const out: PublicReportSource[] = []
  for (const source of REPORT_SOURCES) {
    const available = await resolveSourceColumns(source)
    if (available.size === 0) continue
    const columns = source.columns.filter((c) => available.has(c.key))
    if (columns.length === 0) continue
    out.push({
      key: source.key,
      module: source.module,
      entity: source.entity,
      label: source.label,
      description: source.description,
      requiredFeature: source.requiredFeature,
      defaultDateColumn:
        source.defaultDateColumn && available.has(source.defaultDateColumn) ? source.defaultDateColumn : null,
      columns,
    })
  }
  return out
}

const metadata = {
  operators: FILTER_OPERATORS.map((o) => ({ value: o, label: OPERATOR_LABELS[o] })),
  aggregations: AGGREGATIONS.map((a) => ({ value: a, label: AGGREGATION_LABELS[a] })),
  dateRangePresets: DATE_RANGE_PRESETS.map((p) => ({ value: p, label: DATE_RANGE_LABELS[p] })),
  caps: REPORT_CAPS,
}

export async function GET() {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const tenantId = effectiveTenantId(guard.ctx)

  const [reports, catalog] = await Promise.all([listReports(tenantId), publicCatalog()])
  return NextResponse.json({ reports, catalog, metadata })
}

export async function POST(request: Request) {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const tenantId = effectiveTenantId(guard.ctx)

  const body = await request.json().catch(() => null)
  if (!body) return NextResponse.json({ error: "Invalid request body." }, { status: 400 })

  const actor: Actor = {
    userId: guard.session.userId,
    name: guard.session.name ?? null,
    email: guard.session.email ?? null,
    role: guard.ctx.tenantRole,
  }

  try {
    const report = await createReport(
      tenantId,
      { name: body.name, description: body.description, definition: body.definition },
      actor,
    )
    return NextResponse.json({ report }, { status: 201 })
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 })
  }
}
