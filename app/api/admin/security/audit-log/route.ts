import { NextRequest, NextResponse } from "next/server"
import { requireTenantAdmin, effectiveTenantId } from "@/lib/platform-guard"
import {
  searchAuditLogs,
  getAuditFilters,
  exportAuditLogsCsv,
  type AuditQuery,
  type AuditResult,
} from "@/lib/audit-log-store"

export const dynamic = "force-dynamic"

const RESULTS: AuditResult[] = ["success", "failure", "denied"]

function parseQuery(searchParams: URLSearchParams): AuditQuery {
  const opts: AuditQuery = {}
  const q = searchParams.get("q")?.trim()
  if (q) opts.q = q
  const action = searchParams.get("action")?.trim()
  if (action) opts.action = action
  const entityType = searchParams.get("entityType")?.trim()
  if (entityType) opts.entityType = entityType
  const actor = searchParams.get("actorUserId")
  if (actor && Number.isFinite(Number(actor))) opts.actorUserId = Number(actor)
  const result = searchParams.get("result") as AuditResult | null
  if (result && RESULTS.includes(result)) opts.result = result
  const from = searchParams.get("from")?.trim()
  if (from) opts.from = from
  const to = searchParams.get("to")?.trim()
  if (to) opts.to = to
  const limit = searchParams.get("limit")
  if (limit && Number.isFinite(Number(limit))) opts.limit = Number(limit)
  const offset = searchParams.get("offset")
  if (offset && Number.isFinite(Number(offset))) opts.offset = Number(offset)
  return opts
}

export async function GET(req: NextRequest) {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const tenantId = effectiveTenantId(guard.ctx)
  if (tenantId == null) return NextResponse.json({ error: "No tenant in context" }, { status: 403 })

  const { searchParams } = new URL(req.url)
  const opts = parseQuery(searchParams)

  try {
    // CSV export path.
    if (searchParams.get("format") === "csv") {
      const csv = await exportAuditLogsCsv(tenantId, opts)
      return new NextResponse(csv, {
        status: 200,
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="audit-log-${new Date().toISOString().slice(0, 10)}.csv"`,
        },
      })
    }

    const [{ entries, total }, filters] = await Promise.all([
      searchAuditLogs(tenantId, opts),
      getAuditFilters(tenantId),
    ])
    return NextResponse.json({ entries, total, filters, limit: opts.limit ?? 50, offset: opts.offset ?? 0 })
  } catch (error) {
    console.error("[audit-log] query failed", error)
    return NextResponse.json({ error: "Unable to load audit log" }, { status: 500 })
  }
}
