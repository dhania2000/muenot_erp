import { NextResponse } from "next/server"
import { requireFeature } from "@/lib/api-auth"
import { recordAudit } from "@/lib/sales/lead-lifecycle"
import {
  ensureWebsiteAnalyticsSchema,
  getPropertyById,
  listProperties,
  getAnalytics,
  resolveRange,
} from "@/lib/marketing/website-analytics-db"
import {
  analyticsToCsv,
  analyticsToXlsx,
  analyticsToPdf,
  datasetLabel,
  EXPORT_DATASETS,
  type ExportDataset,
  type ExportFormat,
} from "@/lib/marketing/website-analytics-export"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(request: Request) {
  await ensureWebsiteAnalyticsSchema()
  const session = await requireFeature("marketing.website_analytics.view")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const url = new URL(request.url)
  const properties = await listProperties()
  if (!properties.length) return NextResponse.json({ error: "No properties" }, { status: 404 })
  const requestedId = Number(url.searchParams.get("propertyId")) || 0
  const property = (requestedId && (await getPropertyById(requestedId))) || properties[0]

  const range = resolveRange(url.searchParams.get("range") || "30d", url.searchParams.get("from"), url.searchParams.get("to"))
  const format = ((url.searchParams.get("format") || "csv").toLowerCase() as ExportFormat)
  const datasetParam = url.searchParams.get("dataset") || "topPages"
  const dataset: ExportDataset = (EXPORT_DATASETS as readonly string[]).includes(datasetParam)
    ? (datasetParam as ExportDataset)
    : "topPages"

  const analytics = await getAnalytics(property.id, range)
  const stem = `${property.property_code}-${format === "pdf" ? "report" : dataset}-${range.label}`

  if (format === "pdf") {
    const pdf = await analyticsToPdf(analytics, {
      propertyName: property.name,
      domain: property.domain,
      rangeLabel: range.label,
      generatedBy: (session as any)?.name ?? null,
    })
    await recordAudit(null, {
      entityType: "wa_property",
      entityId: property.property_code,
      action: "report_generated",
      summary: `Website analytics PDF report generated (${range.label})`,
      actorId: session.userId,
    })
    return new NextResponse(new Uint8Array(pdf), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${stem}.pdf"`,
      },
    })
  }

  if (format === "xlsx") {
    const xlsx = await analyticsToXlsx(analytics, dataset, { propertyName: property.name, rangeLabel: range.label })
    await recordAudit(null, {
      entityType: "wa_property",
      entityId: property.property_code,
      action: "analytics_exported",
      summary: `Website analytics exported to Excel — ${datasetLabel(dataset)} (${range.label})`,
      actorId: session.userId,
    })
    return new NextResponse(new Uint8Array(xlsx), {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${stem}.xlsx"`,
      },
    })
  }

  const csv = analyticsToCsv(analytics, dataset)
  await recordAudit(null, {
    entityType: "wa_property",
    entityId: property.property_code,
    action: "analytics_exported",
    summary: `Website analytics exported to CSV — ${datasetLabel(dataset)} (${range.label})`,
    actorId: session.userId,
  })
  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${stem}.csv"`,
    },
  })
}
