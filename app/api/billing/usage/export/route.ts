import { billingGuard } from "@/lib/billing-guard"
import { getUsageOverview } from "@/lib/billing/usage-metering"

export const runtime = "nodejs"

function csvCell(value: string | number | null): string {
  const s = value == null ? "" : String(value)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/**
 * Export the current tenant's usage report as CSV for the active
 * period. Admin-only; tenant is derived from session context.
 */
export async function GET() {
  await billingGuard()
  const overview = await getUsageOverview({ trendDays: 30 })

  const header = ["Meter", "Category", "Kind", "Unit", "Used", "Previous", "Limit", "Limit period", "Hard limit", "Status"]
  const lines = [header.map(csvCell).join(",")]
  for (const m of overview.meters) {
    lines.push(
      [
        m.label,
        m.category,
        m.kind,
        m.unit,
        m.used,
        m.previous,
        m.limit ?? "",
        m.limit != null ? m.limitPeriod : "",
        m.limit != null ? (m.hardLimit ? "yes" : "no") : "",
        m.status,
      ]
        .map(csvCell)
        .join(","),
    )
  }

  const csv = lines.join("\n")
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="usage-${overview.periodStart}.csv"`,
    },
  })
}
