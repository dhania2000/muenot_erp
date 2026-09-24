import { NextResponse } from "next/server"
import { requireTenantAdmin, effectiveTenantId } from "@/lib/platform-guard"
import { getReport } from "@/lib/reports/store"
import { runReport, ReportValidationError } from "@/lib/reports/query-builder"
import { REPORT_CAPS } from "@/lib/reports/model"
import { serializeCsv, serializeJson, buildTable } from "@/lib/data-export-model"
import { recordAuditLog } from "@/lib/audit-log-store"

export const runtime = "nodejs"

const FORMATS = ["csv", "xlsx", "json"] as const
type ReportExportFormat = (typeof FORMATS)[number]

const CONTENT_TYPE: Record<ReportExportFormat, string> = {
  csv: "text/csv; charset=utf-8",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  json: "application/json; charset=utf-8",
}

function safeName(name: string, format: ReportExportFormat): string {
  const base = (name || "report").replace(/[^a-z0-9-_ ]/gi, "").trim().replace(/\s+/g, "-").slice(0, 60) || "report"
  const stamp = new Date().toISOString().slice(0, 10)
  return `${base}-${stamp}.${format}`
}

/**
 * Export a report to CSV / Excel / JSON. Reuses the same validated, tenant
 * scoped, redacted engine as the interactive run — an export can never widen
 * access beyond what the report itself can show. Extracts are still bounded by
 * the hard row cap, and the download is audited.
 */
export async function POST(request: Request) {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const tenantId = effectiveTenantId(guard.ctx)

  const body = await request.json().catch(() => null)
  if (!body) return NextResponse.json({ error: "Invalid request body." }, { status: 400 })

  const format: ReportExportFormat = FORMATS.includes(body.format) ? body.format : "csv"

  let definition = body.definition
  let reportName = String(body.name ?? "report")
  let reportId: number | null = null
  if (!definition && body.id != null) {
    const saved = await getReport(tenantId, Number(body.id))
    if (!saved) return NextResponse.json({ error: "Report not found." }, { status: 404 })
    definition = saved.definition
    reportName = saved.name
    reportId = saved.id
  }
  if (!definition) return NextResponse.json({ error: "A report definition or id is required." }, { status: 400 })

  try {
    const result = await runReport(definition, {
      tenantId,
      role: guard.ctx.tenantRole,
      userId: guard.ctx.userId,
      limitOverride: REPORT_CAPS.maxRows,
    })

    // Re-key rows to human headers so the extract is self-describing.
    const labeled = result.rows.map((row) => {
      const out: Record<string, unknown> = {}
      for (const c of result.columns) out[c.label] = (row as Record<string, unknown>)[c.key] ?? null
      return out
    })

    let bytes: Buffer
    if (format === "json") {
      bytes = Buffer.from(serializeJson({ report: reportName, generatedAt: new Date().toISOString(), rows: labeled }), "utf-8")
    } else if (format === "csv") {
      bytes = Buffer.from(serializeCsv(labeled), "utf-8")
    } else {
      const XLSX = await import("xlsx")
      const wb = XLSX.utils.book_new()
      const { aoa } = buildTable(labeled)
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa.length ? aoa : [["(no data)"]]), "Report")
      const out = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer
      bytes = Buffer.isBuffer(out) ? out : Buffer.from(out)
    }

    await recordAuditLog({
      action: "custom_report.export",
      entityType: "custom_report",
      entityId: reportId ?? 0,
      entityLabel: reportName,
      after: { format, rowCount: result.rowCount, redacted: result.redactedFields.length },
      context: {
        tenantId,
        actorUserId: guard.session.userId,
        actorName: guard.session.name ?? null,
        actorEmail: guard.session.email ?? null,
        actorRole: guard.ctx.tenantRole,
      },
    }).catch(() => {})

    const fileName = safeName(reportName, format)
    return new NextResponse(new Uint8Array(bytes), {
      status: 200,
      headers: {
        "Content-Type": CONTENT_TYPE[format],
        "Content-Disposition": `attachment; filename="${fileName.replace(/"/g, "")}"`,
        "Content-Length": String(bytes.length),
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    })
  } catch (err) {
    if (err instanceof ReportValidationError) {
      return NextResponse.json({ error: err.message, errors: err.errors }, { status: 400 })
    }
    return NextResponse.json({ error: (err as Error).message }, { status: 400 })
  }
}
