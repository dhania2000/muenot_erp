"use client"

import useSWR from "swr"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart"
import { Bar, BarChart, CartesianGrid, XAxis, Pie, PieChart, Cell } from "recharts"
import { Users, MousePointerClick, Send, Target, UserCheck, Megaphone } from "lucide-react"
import { MarketingHeader, StatCard } from "@/components/marketing/marketing-shared"
import { fetcher } from "@/lib/fetcher"

type DashboardData = {
  kpis: {
    totalContacts: number
    newContacts30d: number
    subscribed: number
    activeCampaigns: number
    launchingThisWeek: number
    emailsSent30d: number
    openRate: number
    leadsCaptured: number
  }
  performance: { month: string; sent: number; opened: number }[]
  channels: { name: string; value: number; count: number }[]
  recentCampaigns: { name: string; channel: string; status: string; enrolled: number; goalRate: string }[]
}

const CHANNEL_COLORS = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)"]

const perfConfig: ChartConfig = {
  sent: { label: "Sent", color: "var(--chart-3)" },
  opened: { label: "Opened", color: "var(--chart-1)" },
}

const channelConfig: ChartConfig = {
  value: { label: "Share" },
}

const STATUS_VARIANT: Record<string, "default" | "secondary" | "outline"> = {
  Active: "default",
  Draft: "secondary",
  Paused: "secondary",
  Scheduled: "secondary",
  Completed: "outline",
  Archived: "outline",
}

function compact(n: number) {
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(n)
}

function full(n: number) {
  return new Intl.NumberFormat("en-US").format(n)
}

export function MarketingDashboardClient() {
  const { data, isLoading } = useSWR<DashboardData>("/api/marketing/dashboard", fetcher, {
    refreshInterval: 60_000,
  })

  const k = data?.kpis
  const kpis = [
    {
      label: "Total Contacts",
      value: k ? full(k.totalContacts) : "—",
      hint: k ? `+${full(k.newContacts30d)} in last 30 days` : "Loading…",
      icon: Users,
    },
    {
      label: "Active Campaigns",
      value: k ? k.activeCampaigns : "—",
      hint: k ? `${full(k.launchingThisWeek)} launching this week` : "Loading…",
      icon: Megaphone,
    },
    {
      label: "Emails Sent",
      value: k ? compact(k.emailsSent30d) : "—",
      hint: "Last 30 days",
      icon: Send,
    },
    {
      label: "Avg. Open Rate",
      value: k ? `${k.openRate.toFixed(1)}%` : "—",
      hint: "Last 30 days",
      icon: MousePointerClick,
    },
    {
      label: "Leads Captured",
      value: k ? full(k.leadsCaptured) : "—",
      hint: "This quarter",
      icon: Target,
    },
    {
      label: "Subscribed",
      value: k ? full(k.subscribed) : "—",
      hint: "Email opt-in contacts",
      icon: UserCheck,
    },
  ]

  const performance = data?.performance ?? []
  const channels = (data?.channels ?? []).map((c, i) => ({ ...c, color: CHANNEL_COLORS[i % CHANNEL_COLORS.length] }))
  const recent = data?.recentCampaigns ?? []
  const hasChannelData = channels.some((c) => c.count > 0)

  return (
    <main className="flex flex-col gap-6 p-6">
      <MarketingHeader
        eyebrow="Marketing"
        title="Marketing Dashboard"
        description="A live overview of your audience, campaign performance, and channel mix across the marketing organisation."
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        {kpis.map((kpi) => (
          <StatCard key={kpi.label} {...kpi} />
        ))}
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-base">Campaign Performance</CardTitle>
          </CardHeader>
          <CardContent>
            {performance.length === 0 ? (
              <div className="flex h-[280px] items-center justify-center text-sm text-muted-foreground">
                {isLoading ? "Loading…" : "No email activity yet."}
              </div>
            ) : (
              <ChartContainer config={perfConfig} className="h-[280px] w-full">
                <BarChart data={performance}>
                  <CartesianGrid vertical={false} strokeDasharray="3 3" />
                  <XAxis dataKey="month" tickLine={false} axisLine={false} tickMargin={8} />
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <Bar dataKey="sent" fill="var(--color-sent)" radius={4} />
                  <Bar dataKey="opened" fill="var(--color-opened)" radius={4} />
                </BarChart>
              </ChartContainer>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Channel Mix</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col items-center gap-4">
            {!hasChannelData ? (
              <div className="flex h-[200px] items-center justify-center text-sm text-muted-foreground">
                {isLoading ? "Loading…" : "No channel activity yet."}
              </div>
            ) : (
              <>
                <ChartContainer config={channelConfig} className="h-[200px] w-full">
                  <PieChart>
                    <ChartTooltip content={<ChartTooltipContent />} />
                    <Pie data={channels} dataKey="value" nameKey="name" innerRadius={50} strokeWidth={2}>
                      {channels.map((c) => (
                        <Cell key={c.name} fill={c.color} />
                      ))}
                    </Pie>
                  </PieChart>
                </ChartContainer>
                <div className="grid w-full grid-cols-2 gap-2">
                  {channels.map((c) => (
                    <div key={c.name} className="flex items-center gap-2 text-sm">
                      <span className="size-2.5 rounded-full" style={{ backgroundColor: c.color }} />
                      <span className="text-muted-foreground">{c.name}</span>
                      <span className="ml-auto font-medium">{c.value}%</span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Recent Campaigns</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b text-muted-foreground">
                  <th className="pb-3 font-medium">Campaign</th>
                  <th className="pb-3 font-medium">Trigger</th>
                  <th className="pb-3 font-medium">Status</th>
                  <th className="pb-3 text-right font-medium">Enrolled</th>
                  <th className="pb-3 text-right font-medium">Goal Rate</th>
                </tr>
              </thead>
              <tbody>
                {recent.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="py-8 text-center text-muted-foreground">
                      {isLoading ? "Loading…" : "No campaigns yet."}
                    </td>
                  </tr>
                ) : (
                  recent.map((r) => (
                    <tr key={r.name} className="border-b last:border-0">
                      <td className="py-3 font-medium">{r.name}</td>
                      <td className="py-3 capitalize text-muted-foreground">{r.channel}</td>
                      <td className="py-3">
                        <Badge variant={STATUS_VARIANT[r.status] ?? "outline"}>{r.status}</Badge>
                      </td>
                      <td className="py-3 text-right tabular-nums">{full(r.enrolled)}</td>
                      <td className="py-3 text-right tabular-nums">{r.goalRate}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </main>
  )
}
