"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart"
import { Area, AreaChart, CartesianGrid, XAxis } from "recharts"
import { Eye, Users, Timer, MoveDownRight } from "lucide-react"
import { MarketingHeader, StatCard } from "@/components/marketing/marketing-shared"

const traffic = [
  { day: "Mon", visitors: 3200, pageviews: 8100 },
  { day: "Tue", visitors: 3800, pageviews: 9400 },
  { day: "Wed", visitors: 4100, pageviews: 10200 },
  { day: "Thu", visitors: 3600, pageviews: 8800 },
  { day: "Fri", visitors: 4700, pageviews: 11900 },
  { day: "Sat", visitors: 2900, pageviews: 6700 },
  { day: "Sun", visitors: 2600, pageviews: 6100 },
]

const topPages = [
  { path: "/", views: 24800, avg: "2m 14s" },
  { path: "/pricing", views: 12100, avg: "3m 02s" },
  { path: "/blog/growth-guide", views: 9400, avg: "4m 41s" },
  { path: "/product/features", views: 7300, avg: "2m 58s" },
  { path: "/contact", views: 4100, avg: "1m 22s" },
]

const sources = [
  { source: "Organic Search", share: 38 },
  { source: "Direct", share: 24 },
  { source: "Social", share: 19 },
  { source: "Referral", share: 12 },
  { source: "Paid", share: 7 },
]

const trafficConfig: ChartConfig = {
  visitors: { label: "Visitors", color: "var(--chart-1)" },
  pageviews: { label: "Pageviews", color: "var(--chart-2)" },
}

export function MarketingWebsiteAnalyticsClient() {
  const kpis = [
    { label: "Visitors", value: "24.9K", hint: "This week", icon: Users },
    { label: "Pageviews", value: "61.2K", hint: "This week", icon: Eye },
    { label: "Avg. Session", value: "2m 47s", hint: "+12s vs last week", icon: Timer },
    { label: "Bounce Rate", value: "41.3%", hint: "-2.1 pts", icon: MoveDownRight },
  ]

  return (
    <main className="flex flex-col gap-6 p-6">
      <MarketingHeader
        eyebrow="Marketing"
        title="Website Analytics"
        description="Understand how visitors find and move through your website, and which pages drive the most engagement."
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {kpis.map((k) => (
          <StatCard key={k.label} {...k} />
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Traffic Overview</CardTitle>
        </CardHeader>
        <CardContent>
          <ChartContainer config={trafficConfig} className="h-[300px] w-full">
            <AreaChart data={traffic}>
              <defs>
                <linearGradient id="fillVisitors" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="var(--color-visitors)" stopOpacity={0.7} />
                  <stop offset="95%" stopColor="var(--color-visitors)" stopOpacity={0.05} />
                </linearGradient>
                <linearGradient id="fillPageviews" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="var(--color-pageviews)" stopOpacity={0.6} />
                  <stop offset="95%" stopColor="var(--color-pageviews)" stopOpacity={0.05} />
                </linearGradient>
              </defs>
              <CartesianGrid vertical={false} strokeDasharray="3 3" />
              <XAxis dataKey="day" tickLine={false} axisLine={false} tickMargin={8} />
              <ChartTooltip content={<ChartTooltipContent />} />
              <Area dataKey="pageviews" type="natural" fill="url(#fillPageviews)" stroke="var(--color-pageviews)" stackId="a" />
              <Area dataKey="visitors" type="natural" fill="url(#fillVisitors)" stroke="var(--color-visitors)" stackId="b" />
            </AreaChart>
          </ChartContainer>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Top Pages</CardTitle>
          </CardHeader>
          <CardContent>
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b text-muted-foreground">
                  <th className="pb-3 font-medium">Page</th>
                  <th className="pb-3 text-right font-medium">Views</th>
                  <th className="pb-3 text-right font-medium">Avg. Time</th>
                </tr>
              </thead>
              <tbody>
                {topPages.map((p) => (
                  <tr key={p.path} className="border-b last:border-0">
                    <td className="py-3 font-mono text-xs">{p.path}</td>
                    <td className="py-3 text-right tabular-nums">{p.views.toLocaleString()}</td>
                    <td className="py-3 text-right text-muted-foreground">{p.avg}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Traffic Sources</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4 pt-2">
            {sources.map((s) => (
              <div key={s.source} className="flex flex-col gap-1.5">
                <div className="flex items-center justify-between text-sm">
                  <span>{s.source}</span>
                  <span className="font-medium tabular-nums">{s.share}%</span>
                </div>
                <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                  <div className="h-full rounded-full bg-primary" style={{ width: `${s.share}%` }} />
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
    </main>
  )
}
