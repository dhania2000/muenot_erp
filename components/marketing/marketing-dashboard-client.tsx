"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart"
import { Bar, BarChart, CartesianGrid, XAxis, Pie, PieChart, Cell } from "recharts"
import { Users, MousePointerClick, Send, Target, TrendingUp, Megaphone } from "lucide-react"
import { MarketingHeader, StatCard } from "@/components/marketing/marketing-shared"

const performance = [
  { month: "Jan", sent: 12400, opened: 5100, clicked: 1280 },
  { month: "Feb", sent: 13800, opened: 5900, clicked: 1520 },
  { month: "Mar", sent: 15200, opened: 6800, clicked: 1810 },
  { month: "Apr", sent: 14100, opened: 6200, clicked: 1640 },
  { month: "May", sent: 16700, opened: 7600, clicked: 2150 },
  { month: "Jun", sent: 18300, opened: 8700, clicked: 2480 },
]

const channels = [
  { name: "Email", value: 42, color: "var(--chart-1)" },
  { name: "Social", value: 27, color: "var(--chart-2)" },
  { name: "Paid Ads", value: 18, color: "var(--chart-3)" },
  { name: "Organic", value: 13, color: "var(--chart-4)" },
]

const recent = [
  { name: "Summer Product Launch", channel: "Email", status: "Active", ctr: "14.2%" },
  { name: "Q3 Retargeting", channel: "Paid Ads", status: "Active", ctr: "9.8%" },
  { name: "Webinar Invite Series", channel: "Email", status: "Scheduled", ctr: "—" },
  { name: "Brand Awareness", channel: "Social", status: "Active", ctr: "6.4%" },
  { name: "Spring Newsletter", channel: "Email", status: "Completed", ctr: "12.1%" },
]

const perfConfig: ChartConfig = {
  sent: { label: "Sent", color: "var(--chart-3)" },
  opened: { label: "Opened", color: "var(--chart-1)" },
  clicked: { label: "Clicked", color: "var(--chart-2)" },
}

const channelConfig: ChartConfig = {
  value: { label: "Share" },
}

const STATUS_VARIANT: Record<string, "default" | "secondary" | "outline"> = {
  Active: "default",
  Scheduled: "secondary",
  Completed: "outline",
}

export function MarketingDashboardClient() {
  const kpis = [
    { label: "Total Contacts", value: "18,420", hint: "+3.2% this month", icon: Users },
    { label: "Active Campaigns", value: 12, hint: "4 launching this week", icon: Megaphone },
    { label: "Emails Sent", value: "96.4K", hint: "Last 30 days", icon: Send },
    { label: "Avg. Click Rate", value: "11.8%", hint: "+1.4 pts", icon: MousePointerClick },
    { label: "Leads Captured", value: "2,317", hint: "This quarter", icon: Target },
    { label: "Marketing ROI", value: "4.6x", hint: "Trailing 90 days", icon: TrendingUp },
  ]

  return (
    <main className="flex flex-col gap-6 p-6">
      <MarketingHeader
        eyebrow="Marketing"
        title="Marketing Dashboard"
        description="A live overview of your audience, campaign performance, and channel mix across the marketing organisation."
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        {kpis.map((k) => (
          <StatCard key={k.label} {...k} />
        ))}
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-base">Campaign Performance</CardTitle>
          </CardHeader>
          <CardContent>
            <ChartContainer config={perfConfig} className="h-[280px] w-full">
              <BarChart data={performance}>
                <CartesianGrid vertical={false} strokeDasharray="3 3" />
                <XAxis dataKey="month" tickLine={false} axisLine={false} tickMargin={8} />
                <ChartTooltip content={<ChartTooltipContent />} />
                <Bar dataKey="sent" fill="var(--color-sent)" radius={4} />
                <Bar dataKey="opened" fill="var(--color-opened)" radius={4} />
                <Bar dataKey="clicked" fill="var(--color-clicked)" radius={4} />
              </BarChart>
            </ChartContainer>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Channel Mix</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col items-center gap-4">
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
                  <th className="pb-3 font-medium">Channel</th>
                  <th className="pb-3 font-medium">Status</th>
                  <th className="pb-3 text-right font-medium">Click Rate</th>
                </tr>
              </thead>
              <tbody>
                {recent.map((r) => (
                  <tr key={r.name} className="border-b last:border-0">
                    <td className="py-3 font-medium">{r.name}</td>
                    <td className="py-3 text-muted-foreground">{r.channel}</td>
                    <td className="py-3">
                      <Badge variant={STATUS_VARIANT[r.status] ?? "outline"}>{r.status}</Badge>
                    </td>
                    <td className="py-3 text-right tabular-nums">{r.ctr}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </main>
  )
}
