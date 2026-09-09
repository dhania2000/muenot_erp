"use client"

import useSWR from "swr"
import { fetcher } from "@/lib/fetcher"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart"
import { Bar, BarChart, CartesianGrid, XAxis, Pie, PieChart, Cell } from "recharts"
import { TrendingUp, Users, Trophy, Target, Clock, CalendarClock } from "lucide-react"

const currency = (n: number) =>
  new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(n || 0)

const STATUS_COLORS: Record<string, string> = {
  New: "var(--chart-5)",
  "Follow Up 1": "var(--chart-3)",
  "Follow Up 2": "var(--chart-3)",
  "In Discussion": "var(--chart-1)",
  "Proposal Sent": "var(--chart-1)",
  Ready: "var(--chart-2)",
  Won: "var(--chart-2)",
  Lost: "var(--chart-4)",
}

const sourceConfig: ChartConfig = {
  count: { label: "Leads", color: "var(--chart-1)" },
}

export function SalesDashboardClient() {
  const { data, isLoading } = useSWR("/api/sales/dashboard", fetcher, { refreshInterval: 30000 })

  if (isLoading || !data) {
    return <div className="text-sm text-muted-foreground">Loading dashboard...</div>
  }

  const { totals, byStatus, bySource, byIndustry, revenue, forecast, upcomingMeetings } = data

  const kpis = [
    { label: "Total Leads", value: totals.total_leads, icon: Users },
    { label: "Open Pipeline", value: totals.open_count, icon: TrendingUp },
    { label: "Win Rate", value: `${totals.win_rate}%`, icon: Trophy },
    { label: "Avg Health Score", value: totals.avg_health_score ?? 0, icon: Target },
    { label: "Overdue Follow-ups", value: totals.overdue_count, icon: Clock },
    { label: "Active Contract Value", value: currency(revenue.total_contract_value), icon: TrendingUp },
  ]

  const pieData = byStatus.map((s: any) => ({ name: s.status, value: s.count }))

  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        {kpis.map((k) => (
          <Card key={k.label}>
            <CardContent className="flex flex-col gap-2 pt-6">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-muted-foreground">{k.label}</span>
                <k.icon className="size-4 text-muted-foreground" />
              </div>
              <span className="text-2xl font-semibold tracking-tight">{k.value}</span>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-base">Leads by Source</CardTitle>
          </CardHeader>
          <CardContent>
            <ChartContainer config={sourceConfig} className="aspect-auto h-64 w-full">
              <BarChart data={bySource} margin={{ left: 0, right: 8 }}>
                <CartesianGrid vertical={false} />
                <XAxis dataKey="source" tickLine={false} axisLine={false} tickMargin={8} />
                <ChartTooltip content={<ChartTooltipContent />} />
                <Bar dataKey="count" fill="var(--color-count)" radius={4} />
              </BarChart>
            </ChartContainer>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Leads by Status</CardTitle>
          </CardHeader>
          <CardContent>
            <ChartContainer config={sourceConfig} className="aspect-auto h-64 w-full">
              <PieChart>
                <ChartTooltip content={<ChartTooltipContent />} />
                <Pie data={pieData} dataKey="value" nameKey="name" innerRadius={45} outerRadius={75} strokeWidth={2}>
                  {pieData.map((entry: any, i: number) => (
                    <Cell key={i} fill={STATUS_COLORS[entry.name] || "var(--chart-5)"} />
                  ))}
                </Pie>
              </PieChart>
            </ChartContainer>
            <div className="mt-3 flex flex-wrap gap-2">
              {byStatus.map((s: any) => (
                <Badge key={s.status} variant="secondary" className="gap-1.5 text-xs">
                  <span
                    className="size-2 rounded-full"
                    style={{ backgroundColor: STATUS_COLORS[s.status] || "var(--chart-5)" }}
                  />
                  {s.status} · {s.count}
                </Badge>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Leads by Industry</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            {byIndustry.map((i: any) => (
              <div key={i.industry} className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">{i.industry}</span>
                <span className="font-medium">{i.count}</span>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Revenue Forecast</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {forecast.length === 0 && <p className="text-sm text-muted-foreground">No forecasts yet.</p>}
            {forecast.map((f: any) => (
              <div key={`${f.quarter}-${f.year}`} className="flex flex-col gap-1 rounded-md border border-border p-3">
                <div className="flex items-center justify-between text-sm font-medium">
                  <span>
                    {f.quarter} {f.year}
                  </span>
                  <span>{currency(f.expected_revenue)}</span>
                </div>
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span>Best {currency(f.best_case)}</span>
                  <span>Worst {currency(f.worst_case)}</span>
                  <span>Coverage {f.pipeline_coverage}</span>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Upcoming Meetings</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {upcomingMeetings.length === 0 && <p className="text-sm text-muted-foreground">No upcoming meetings.</p>}
            {upcomingMeetings.map((m: any) => (
              <div key={m.meeting_code} className="flex items-start gap-2 text-sm">
                <CalendarClock className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                <div className="flex flex-col">
                  <span className="font-medium">{m.company_name}</span>
                  <span className="text-xs text-muted-foreground">
                    {m.meeting_date} · {m.meeting_type} · {m.contact_person}
                  </span>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
