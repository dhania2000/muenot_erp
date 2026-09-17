import "server-only"

/**
 * Server-side exporters for Website Analytics.
 *
 * These turn the exact same analytics payload the dashboard renders (produced
 * by `getAnalytics`) into downloadable artefacts, so every format agrees with
 * what is on screen — there are no separate/duplicated numbers:
 *   - CSV / Excel : one selected dataset (top pages, channels, goals …).
 *   - PDF         : a professional multi-section analytics report.
 *
 * `xlsx`, `jspdf` and `jspdf-autotable` are imported lazily so they never load
 * on requests that only need JSON or CSV.
 */

export type ExportFormat = "csv" | "xlsx" | "pdf"

export const EXPORT_DATASETS = [
  "topPages",
  "channels",
  "referrers",
  "utm",
  "campaigns",
  "landingPages",
  "exitPages",
  "devices",
  "browsers",
  "countries",
  "events",
  "goals",
] as const
export type ExportDataset = (typeof EXPORT_DATASETS)[number]

const DATASET_LABELS: Record<ExportDataset, string> = {
  topPages: "Top Pages",
  channels: "Channels",
  referrers: "Referrers",
  utm: "UTM Performance",
  campaigns: "Campaign Attribution",
  landingPages: "Landing Pages",
  exitPages: "Exit Pages",
  devices: "Devices",
  browsers: "Browsers",
  countries: "Countries",
  events: "Events",
  goals: "Goals",
}

function datasetRows(analytics: Record<string, any>, dataset: ExportDataset): any[] {
  const map: Record<ExportDataset, any[]> = {
    topPages: analytics.topPages,
    channels: analytics.channels,
    referrers: analytics.referrers,
    utm: analytics.utmPerformance,
    campaigns: analytics.campaigns,
    landingPages: analytics.landingPages,
    exitPages: analytics.exitPages,
    devices: analytics.devices,
    browsers: analytics.browsers,
    countries: analytics.countries,
    events: analytics.events,
    goals: analytics.goals,
  }
  return (map[dataset] ?? analytics.topPages ?? []) as any[]
}

function humanizeKey(key: string): string {
  return key
    .replace(/[_-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

function csvCell(v: unknown): string {
  const s = v == null ? "" : String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function analyticsToCsv(analytics: Record<string, any>, dataset: ExportDataset): string {
  const rows = datasetRows(analytics, dataset)
  if (!rows.length) return ""
  const headers = Object.keys(rows[0])
  const lines = [headers.join(",")]
  for (const row of rows) lines.push(headers.map((h) => csvCell(row[h])).join(","))
  return lines.join("\n")
}

// ---------------------------------------------------------------------------
// Excel (Phase 92)
// ---------------------------------------------------------------------------

export async function analyticsToXlsx(
  analytics: Record<string, any>,
  dataset: ExportDataset,
  meta: { propertyName: string; rangeLabel: string },
): Promise<Buffer> {
  const XLSX = await import("xlsx")
  const rows = datasetRows(analytics, dataset)
  const headers = rows.length ? Object.keys(rows[0]) : ["No data"]

  const aoa: any[][] = []
  aoa.push([`${meta.propertyName} — ${DATASET_LABELS[dataset]}`])
  aoa.push([`Period: ${meta.rangeLabel}`])
  aoa.push([])
  aoa.push(headers.map(humanizeKey))
  for (const row of rows) aoa.push(headers.map((h) => normalizeCell(row[h])))

  const ws = XLSX.utils.aoa_to_sheet(aoa)
  ws["!cols"] = headers.map((h, i) => {
    const widest = aoa.slice(3).reduce((max, r) => Math.max(max, String(r[i] ?? "").length), h.length)
    return { wch: Math.min(widest + 2, 50) }
  })
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, DATASET_LABELS[dataset].slice(0, 28))
  const out = XLSX.write(wb, { bookType: "xlsx", type: "buffer" })
  return out as Buffer
}

function normalizeCell(v: unknown): string | number {
  if (v == null) return ""
  if (typeof v === "number") return v
  if (typeof v === "boolean") return v ? "Yes" : "No"
  if (typeof v === "object") return JSON.stringify(v)
  const n = Number(v)
  return typeof v === "string" && v.trim() !== "" && !Number.isNaN(n) && /^\d+(\.\d+)?$/.test(v) ? n : String(v)
}

// ---------------------------------------------------------------------------
// PDF analytics report (Phase 93)
// ---------------------------------------------------------------------------

const INK = [17, 24, 39] as const
const MUTED = [107, 114, 128] as const
const HEAD_BG = [31, 41, 55] as const

function fmtDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds || 0))
  const m = Math.floor(s / 60)
  const r = s % 60
  return m ? `${m}m ${r}s` : `${r}s`
}

export async function analyticsToPdf(
  analytics: Record<string, any>,
  meta: { propertyName: string; domain?: string | null; rangeLabel: string; generatedBy?: string | null },
): Promise<Buffer> {
  const { jsPDF } = await import("jspdf")
  const autoTable = (await import("jspdf-autotable")).default

  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" })
  const pageWidth = doc.internal.pageSize.getWidth()
  const marginX = 14
  let y = 16

  doc.setFont("helvetica", "bold")
  doc.setFontSize(16)
  doc.setTextColor(INK[0], INK[1], INK[2])
  doc.text("Website Analytics Report", marginX, y)
  y += 7

  doc.setFont("helvetica", "normal")
  doc.setFontSize(10)
  doc.setTextColor(MUTED[0], MUTED[1], MUTED[2])
  doc.text(`${meta.propertyName}${meta.domain ? ` · ${meta.domain}` : ""}`, marginX, y)
  y += 5
  doc.text(`Period: ${meta.rangeLabel}`, marginX, y)
  y += 5
  const stamp = `Generated ${new Date().toLocaleString()}${meta.generatedBy ? ` by ${meta.generatedBy}` : ""}`
  doc.text(stamp, marginX, y)
  y += 8

  const k = analytics.kpis ?? {}
  const kpiRows: any[] = [
    ["Visitors", Number(k.visitors || 0).toLocaleString()],
    ["Pageviews", Number(k.pageviews || 0).toLocaleString()],
    ["Sessions", Number(k.sessions || 0).toLocaleString()],
    ["Avg. Session", fmtDuration(Number(k.avgSessionSeconds || 0))],
    ["Bounce Rate", `${k.bounceRate ?? 0}%`],
    ["Conversions", `${Number(k.conversions || 0).toLocaleString()} (${k.conversionRate ?? 0}%)`],
  ]
  autoTable(doc, {
    startY: y,
    head: [["Metric", "Value"]],
    body: kpiRows,
    theme: "grid",
    headStyles: { fillColor: [HEAD_BG[0], HEAD_BG[1], HEAD_BG[2]] },
    styles: { fontSize: 9, cellPadding: 2 },
    margin: { left: marginX, right: marginX },
  })
  y = (doc as any).lastAutoTable.finalY + 8

  const section = (title: string, head: string[], body: any[][]) => {
    if (!body.length) return
    if (y > 250) {
      doc.addPage()
      y = 16
    }
    doc.setFont("helvetica", "bold")
    doc.setFontSize(11)
    doc.setTextColor(INK[0], INK[1], INK[2])
    doc.text(title, marginX, y)
    y += 3
    autoTable(doc, {
      startY: y,
      head: [head],
      body,
      theme: "striped",
      headStyles: { fillColor: [HEAD_BG[0], HEAD_BG[1], HEAD_BG[2]] },
      styles: { fontSize: 8, cellPadding: 1.8 },
      margin: { left: marginX, right: marginX },
    })
    y = (doc as any).lastAutoTable.finalY + 8
  }

  section(
    "Top Pages",
    ["Page", "Views", "Visitors", "Avg. Time"],
    (analytics.topPages ?? []).slice(0, 15).map((p: any) => [
      p.path,
      Number(p.views).toLocaleString(),
      Number(p.uniques).toLocaleString(),
      fmtDuration(Number(p.avg_seconds) || 0),
    ]),
  )

  section(
    "Channels",
    ["Channel", "Sessions", "Visitors", "Conversions"],
    (analytics.channels ?? []).map((c: any) => [
      c.channel,
      Number(c.sessions).toLocaleString(),
      Number(c.visitors).toLocaleString(),
      Number(c.conversions).toLocaleString(),
    ]),
  )

  const f = analytics.funnel ?? {}
  section(
    "Conversion Funnel",
    ["Stage", "Visitors"],
    [
      ["Visitors", Number(f.visitors || 0).toLocaleString()],
      ["Engaged", Number(f.engaged || 0).toLocaleString()],
      ["Form Started", Number(f.form_started || 0).toLocaleString()],
      ["Converted", Number(f.converted || 0).toLocaleString()],
    ],
  )

  section(
    "Goals",
    ["Goal", "Completions", "Rate"],
    (analytics.goals ?? []).map((g: any) => [g.name, Number(g.completions).toLocaleString(), `${g.rate}%`]),
  )

  const pageCount = (doc as any).internal.getNumberOfPages()
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i)
    doc.setFont("helvetica", "normal")
    doc.setFontSize(8)
    doc.setTextColor(MUTED[0], MUTED[1], MUTED[2])
    doc.text(
      `Muenot ERP · Website Analytics · Page ${i} of ${pageCount}`,
      pageWidth / 2,
      doc.internal.pageSize.getHeight() - 8,
      { align: "center" },
    )
  }

  return Buffer.from(doc.output("arraybuffer"))
}

export function datasetLabel(dataset: ExportDataset): string {
  return DATASET_LABELS[dataset] ?? dataset
}
