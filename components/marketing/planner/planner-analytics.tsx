"use client"

import useSWR from "swr"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart"
import { Bar, BarChart, CartesianGrid, XAxis, YAxis, Pie, PieChart, Cell } from "recharts"
import { Loader2, TrendingUp, Clock, CircleCheck, Layers } from "lucide-react"
import { StatusBadge, fmtMoney, plannerFetch } from "./planner-shared"

const fetcher = (url: string) => plannerFetch(url)

type Analytics = {
  byStatus: { status: string; count: number }[]
  byChannel: { channel: string; count: number }[]
  byType: { content_type: string; count: number }[]
  byCampaign: { campaign: string; count: number }[]
  workload: { user_id: number; name: string; open_items: number; overdue: number }[]
  performance: {
    total: number
    published: number
    completed: number
    overdue: number
    on_time_rate: number
    completion_rate: number
    estimated_budget: number
    actual_spend: number
  }
}

const PIE_COLORS = [
  "var(--color-chart-1)",
  "var(--color-chart-2)",
  "var(--color-chart-3)",
  "var(--color-chart-4)",
  "var(--color-chart-5)",
]

export function PlannerAnalytics({ query }: { query: string }) {
  const { data, isLoading } = useSWR<Analytics>(`/api/marketing/planner/analytics${query ? `?${query}` : ""}`, fetcher)

  if (isLoading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    )
  }
  if (!data) return <p className="text-sm text-muted-foreground">No analytics available.</p>

  const perf = data.performance ?? ({} as Analytics["performance"])
  const statusData = (data.byStatus ?? []).map((s) => ({ name: s.status, count: Number(s.count) }))
  const channelData = (data.byChannel ?? []).map((c) => ({ name: c.channel, count: Number(c.count) }))
  const typeData = (data.byType ?? []).map((t) => ({ name: t.content_type, value: Number(t.count) }))

  const barConfig: ChartConfig = { count: { label: "Items", color: "var(--color-chart-1)" } }
  const typeConfig: ChartConfig = Object.fromEntries(
    typeData.map((t, i) => [t.name, { label: t.name, color: PIE_COLORS[i % PIE_COLORS.length] }]),
  )

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat
          icon={<Layers className="size-4" />}
          label="Total items"
          value={String(perf.total ?? 0)}
          hint={`${perf.published ?? 0} published`}
        />
        <Stat
          icon={<CircleCheck className="size-4" />}
          label="Completion rate"
          value={`${Math.round((perf.completion_rate ?? 0) * (perf.completion_rate <= 1 ? 100 : 1))}%`}
          hint={`${perf.completed ?? 0} completed`}
        />
        <Stat
          icon={<TrendingUp className="size-4" />}
          label="On-time rate"
          value={`${Math.round((perf.on_time_rate ?? 0) * (perf.on_time_rate <= 1 ? 100 : 1))}%`}
          hint="of published items"
        />
        <Stat
          icon={<Clock className="size-4" />}
          label="Overdue"
          value={String(perf.overdue ?? 0)}
          hint="open past due date"
          danger={(perf.overdue ?? 0) > 0}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">By status</CardTitle>
            <CardDescription>Distribution across the workflow</CardDescription>
          </CardHeader>
          <CardContent>
            {statusData.length === 0 ? (
              <Empty />
            ) : (
              <ChartContainer config={barConfig} className="h-[260px] w-full">
                <BarChart data={statusData} layout="vertical" margin={{ left: 8, right: 12 }}>
                  <CartesianGrid horizontal={false} />
                  <XAxis type="number" allowDecimals={false} tickLine={false} axisLine={false} />
                  <YAxis
                    type="category"
                    dataKey="name"
                    width={80}
                    tickLine={false}
                    axisLine={false}
                    tick={{ fontSize: 12 }}
                  />
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <Bar dataKey="count" fill="var(--color-count)" radius={4} />
                </BarChart>
              </ChartContainer>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">By content type</CardTitle>
            <CardDescription>Mix of content being produced</CardDescription>
          </CardHeader>
          <CardContent>
            {typeData.length === 0 ? (
              <Empty />
            ) : (
              <ChartContainer config={typeConfig} className="mx-auto h-[260px]">
                <PieChart>
                  <ChartTooltip content={<ChartTooltipContent nameKey="name" />} />
                  <Pie data={typeData} dataKey="value" nameKey="name" innerRadius={55} strokeWidth={2}>
                    {typeData.map((t, i) => (
                      <Cell key={t.name} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                    ))}
                  </Pie>
                </PieChart>
              </ChartContainer>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">By channel</CardTitle>
            <CardDescription>Where content is going out</CardDescription>
          </CardHeader>
          <CardContent>
            {channelData.length === 0 ? (
              <Empty />
            ) : (
              <ChartContainer config={barConfig} className="h-[260px] w-full">
                <BarChart data={channelData} margin={{ left: 4, right: 4 }}>
                  <CartesianGrid vertical={false} />
                  <XAxis dataKey="name" tickLine={false} axisLine={false} tick={{ fontSize: 11 }} interval={0} angle={-15} textAnchor="end" height={50} />
                  <YAxis allowDecimals={false} tickLine={false} axisLine={false} />
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <Bar dataKey="count" fill="var(--color-count)" radius={4} />
                </BarChart>
              </ChartContainer>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Team workload</CardTitle>
            <CardDescription>Open items per assignee</CardDescription>
          </CardHeader>
          <CardContent>
            {(data.workload ?? []).length === 0 ? (
              <Empty />
            ) : (
              <ul className="flex flex-col gap-2">
                {data.workload.map((w) => (
                  <li key={w.user_id} className="flex items-center justify-between text-sm">
                    <span className="truncate">{w.name}</span>
                    <span className="flex items-center gap-2">
                      <span className="rounded-full bg-muted px-2 py-0.5 text-xs">{w.open_items} open</span>
                      {Number(w.overdue) > 0 ? (
                        <span className="rounded-full bg-destructive/15 px-2 py-0.5 text-xs font-medium text-destructive">
                          {w.overdue} overdue
                        </span>
                      ) : null}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Budget</CardTitle>
          <CardDescription>Estimated vs. actual spend across the plan</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-8">
          <div className="flex flex-col">
            <span className="text-xs text-muted-foreground">Estimated</span>
            <span className="text-lg font-semibold">{fmtMoney(perf.estimated_budget)}</span>
          </div>
          <div className="flex flex-col">
            <span className="text-xs text-muted-foreground">Actual spend</span>
            <span
              className={
                (perf.actual_spend ?? 0) > (perf.estimated_budget ?? 0)
                  ? "text-lg font-semibold text-destructive"
                  : "text-lg font-semibold"
              }
            >
              {fmtMoney(perf.actual_spend)}
            </span>
          </div>
          <div className="flex flex-col">
            <span className="text-xs text-muted-foreground">Variance</span>
            <span className="text-lg font-semibold">
              {fmtMoney((perf.estimated_budget ?? 0) - (perf.actual_spend ?? 0))}
            </span>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

function Stat({
  icon,
  label,
  value,
  hint,
  danger,
}: {
  icon: React.ReactNode
  label: string
  value: string
  hint?: string
  danger?: boolean
}) {
  return (
    <Card>
      <CardContent className="flex flex-col gap-1 p-4">
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          {icon}
          {label}
        </span>
        <span className={danger ? "text-2xl font-semibold text-destructive" : "text-2xl font-semibold"}>{value}</span>
        {hint ? <span className="text-xs text-muted-foreground">{hint}</span> : null}
      </CardContent>
    </Card>
  )
}

function Empty() {
  return <p className="py-10 text-center text-sm text-muted-foreground">No data yet.</p>
}
