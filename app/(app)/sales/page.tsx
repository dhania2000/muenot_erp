import { redirect } from "next/navigation"
import { getAuthContext } from "@/lib/access"
import { salesDashboard, safe } from "@/lib/sales"
import { PageHeader } from "@/components/page-header"
import { DbNotConnected } from "@/components/states"
import { StatCard } from "@/components/sales/stat-card"
import { BarList } from "@/components/sales/bar-list"
import { formatCurrency, formatNumber } from "@/lib/format"
import { Users, TriangleAlert, Trophy, FileText } from "lucide-react"

export default async function SalesDashboardPage() {
  const ctx = await getAuthContext()
  if (!ctx) redirect("/login")
  if (!ctx.access.canView("sales", "dashboard")) redirect("/")

  const res = await safe(() => salesDashboard())

  return (
    <>
      <PageHeader title="Sales Dashboard" description="Pipeline health, deal outcomes and revenue outlook." />
      {!res.ok ? (
        <DbNotConnected error={res.error} />
      ) : (
        <Dashboard data={res.data} />
      )}
    </>
  )
}

function Dashboard({ data }: { data: Awaited<ReturnType<typeof salesDashboard>> }) {
  const { totals, byStatus, bySource, byIndustry, deals, pipeline, forecast } = data
  const won = Number(deals?.won || 0)
  const lost = Number(deals?.lost || 0)
  const winRate = won + lost > 0 ? Math.round((won / (won + lost)) * 100) : 0
  const nextForecast = forecast?.[0]

  return (
    <div className="flex flex-col gap-5 p-6">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label="Total Leads" value={formatNumber(totals?.total)} icon={Users} hint="Across all stages" />
        <StatCard
          label="Overdue Follow-ups"
          value={formatNumber(totals?.overdue)}
          tone="destructive"
          icon={TriangleAlert}
          hint="SLA gap exceeded"
        />
        <StatCard
          label="Win Rate"
          value={`${winRate}%`}
          tone="success"
          icon={Trophy}
          hint={`${won} won · ${lost} lost`}
        />
        <StatCard
          label="Open Quotations"
          value={formatNumber(pipeline?.open_quotes)}
          icon={FileText}
          hint={`${formatCurrency(pipeline?.quote_value)} in play`}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <BarList
          title="Leads by Status"
          items={byStatus.map((r) => ({ label: r.status, value: Number(r.count) }))}
        />
        <BarList
          title="Leads by Source"
          items={bySource.map((r) => ({ label: r.source, value: Number(r.count) }))}
        />
        <BarList
          title="Top Industries"
          items={byIndustry.map((r) => ({ label: r.industry, value: Number(r.count) }))}
        />
        <div className="rounded-lg border border-border bg-card p-4">
          <h3 className="mb-3 text-sm font-semibold">Revenue Forecast</h3>
          {forecast.length === 0 ? (
            <p className="py-4 text-center text-xs text-muted-foreground">No forecast data</p>
          ) : (
            <>
              <div className="mb-4">
                <div className="font-mono text-2xl font-semibold tabular-nums text-primary">
                  {formatCurrency(nextForecast?.expected)}
                </div>
                <div className="mt-0.5 text-xs text-muted-foreground">
                  Expected · {nextForecast?.quarter}
                </div>
              </div>
              <ul className="flex flex-col gap-2 border-t border-border pt-3">
                {forecast.map((f) => (
                  <li key={f.quarter} className="flex items-center justify-between text-sm">
                    <span className="font-mono text-muted-foreground">{f.quarter}</span>
                    <span className="font-mono tabular-nums">{formatCurrency(f.expected)}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard label="Avg Lead Health" value={formatNumber(totals?.avg_health)} hint="Score out of 100" />
        <StatCard label="Deals Won" value={formatNumber(won)} tone="success" />
        <StatCard label="Deals Lost" value={formatNumber(lost)} tone="destructive" />
      </div>
    </div>
  )
}
