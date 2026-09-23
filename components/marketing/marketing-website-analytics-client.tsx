"use client"

import { useState } from "react"
import useSWR from "swr"
import { fetcher } from "@/lib/fetcher"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart"
import { Area, AreaChart, CartesianGrid, XAxis } from "recharts"
import { Eye, Users, Timer, MoveDownRight, Target, RefreshCw, Settings, Code2, Download, Radio, FileText } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { MarketingHeader, StatCard } from "@/components/marketing/marketing-shared"
import { BreakdownList, PanelCard, formatCompact, formatDuration, deltaLabel } from "@/components/marketing/website-analytics/wa-shared"
import { InstallDialog, NewPropertyDialog, GoalsDialog, SettingsDialog } from "@/components/marketing/website-analytics/wa-manage"

const trafficConfig: ChartConfig = {
  visitors: { label: "Visitors", color: "var(--chart-1)" },
  pageviews: { label: "Pageviews", color: "var(--chart-2)" },
}

const RANGE_OPTIONS = [
  { value: "today", label: "Today" },
  { value: "yesterday", label: "Yesterday" },
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
  { value: "month", label: "This month" },
  { value: "quarter", label: "This quarter" },
  { value: "year", label: "This year" },
]

export function MarketingWebsiteAnalyticsClient() {
  const [propertyId, setPropertyId] = useState<number | null>(null)
  const [range, setRange] = useState("30d")

  const params = new URLSearchParams({ range, compare: "1" })
  if (propertyId) params.set("propertyId", String(propertyId))
  const key = `/api/marketing/website-analytics?${params.toString()}`
  const { data, isLoading, mutate } = useSWR<any>(key, fetcher, { refreshInterval: 30_000, keepPreviousData: true })

  const property = data?.property ?? null
  const analytics = data?.analytics ?? null
  const realtime = data?.realtime ?? null
  const health = data?.health ?? null
  const goals = data?.goals ?? []
  const canManage = !!data?.can?.manage
  const install = data?.install ?? null

  const activePropertyId = property?.id ?? null

  function exportData(dataset: string, format: "csv" | "xlsx" | "pdf" = "csv") {
    const p = new URLSearchParams({ range, dataset, format })
    if (activePropertyId) p.set("propertyId", String(activePropertyId))
    window.open(`/api/marketing/website-analytics/export?${p.toString()}`, "_blank")
  }

  const kpis = analytics?.kpis
  const prev = analytics?.previous

  const healthTone =
    health?.status === "connected"
      ? { label: "Receiving data", cls: "bg-emerald-500" }
      : health?.status === "warning"
        ? { label: "No recent data", cls: "bg-amber-500" }
        : { label: "Not installed", cls: "bg-muted-foreground" }

  return (
    <main className="flex flex-col gap-6 p-6">
      <MarketingHeader
        eyebrow="Marketing"
        title="Website Analytics"
        description="Understand how visitors find and move through your website, which channels convert, and how tracking is performing — all from live tracked events."
        action={
          <div className="flex flex-wrap items-center gap-2">
            {data?.properties?.length ? (
              <Select
                value={activePropertyId ? String(activePropertyId) : undefined}
                onValueChange={(v) => setPropertyId(Number(v))}
              >
                <SelectTrigger className="w-[180px]">
                  <SelectValue placeholder="Select website" />
                </SelectTrigger>
                <SelectContent>
                  {data.properties.map((p: any) => (
                    <SelectItem key={p.id} value={String(p.id)}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : null}
            <Select value={range} onValueChange={setRange}>
              <SelectTrigger className="w-[150px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {RANGE_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {property ? (
              <Button variant="outline" size="sm" onClick={() => exportData("topPages", "pdf")}>
                <FileText className="size-4" /> Report
              </Button>
            ) : null}
            {canManage ? <NewPropertyDialog onCreated={(id) => setPropertyId(id)} /> : null}
            <Button variant="outline" size="icon" onClick={() => mutate()} aria-label="Refresh">
              <RefreshCw className="size-4" />
            </Button>
          </div>
        }
      />

      {!isLoading && !property ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
            <p className="text-sm text-muted-foreground">No websites are being tracked yet.</p>
            {canManage ? <NewPropertyDialog onCreated={(id) => setPropertyId(id)} /> : null}
          </CardContent>
        </Card>
      ) : null}

      {property ? (
        <>
          {/* Tracking health + quick actions */}
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-card p-4">
            <div className="flex items-center gap-3">
              <span className={`size-2.5 rounded-full ${healthTone.cls}`} aria-hidden />
              <div className="flex flex-col">
                <span className="text-sm font-medium">{healthTone.label}</span>
                <span className="text-xs text-muted-foreground">
                  Tracking ID <code className="font-mono">{property.tracking_id}</code>
                  {health?.lastEventAt ? ` · last event ${new Date(health.lastEventAt.replace(" ", "T")).toLocaleString()}` : ""}
                  {typeof health?.eventsToday === "number" ? ` · ${health.eventsToday.toLocaleString()} events today` : ""}
                </span>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {install ? (
                <InstallDialog
                  install={install}
                  trackingId={property.tracking_id}
                  trigger={
                    <Button variant="outline" size="sm">
                      <Code2 className="size-4" /> Install
                    </Button>
                  }
                />
              ) : null}
              <GoalsDialog
                propertyId={property.id}
                goals={goals}
                canManage={canManage}
                onChange={() => mutate()}
                trigger={
                  <Button variant="outline" size="sm">
                    <Target className="size-4" /> Goals
                  </Button>
                }
              />
              <SettingsDialog
                property={property}
                canManage={canManage}
                onSaved={() => mutate()}
                trigger={
                  <Button variant="outline" size="sm">
                    <Settings className="size-4" /> Settings
                  </Button>
                }
              />
            </div>
          </div>

          {/* Zero-data onboarding */}
          {analytics && !analytics.hasData ? (
            <Card className="border-dashed">
              <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
                <Code2 className="size-8 text-muted-foreground" />
                <p className="text-sm font-medium">No analytics data yet for this range</p>
                <p className="max-w-md text-sm text-muted-foreground">
                  Install the tracking snippet on {property.name} to start collecting real visitor, pageview and
                  conversion data. Metrics below update automatically as events arrive.
                </p>
                {install ? (
                  <InstallDialog
                    install={install}
                    trackingId={property.tracking_id}
                    trigger={<Button size="sm">Get tracking snippet</Button>}
                  />
                ) : null}
              </CardContent>
            </Card>
          ) : null}

          {/* KPIs */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard label="Visitors" value={formatCompact(kpis?.visitors ?? 0)} hint={deltaLabel(kpis?.visitors ?? 0, prev?.visitors)?.text} icon={Users} />
            <StatCard label="Pageviews" value={formatCompact(kpis?.pageviews ?? 0)} hint={deltaLabel(kpis?.pageviews ?? 0, prev?.pageviews)?.text} icon={Eye} />
            <StatCard label="Avg. Session" value={formatDuration(kpis?.avgSessionSeconds ?? 0)} hint={`${kpis?.sessions ?? 0} sessions`} icon={Timer} />
            <StatCard label="Bounce Rate" value={`${kpis?.bounceRate ?? 0}%`} hint={`${kpis?.conversions ?? 0} conversions · ${kpis?.conversionRate ?? 0}% CVR`} icon={MoveDownRight} />
          </div>

          {/* Real-time strip */}
          {realtime ? (
            <div className="flex flex-wrap items-center gap-4 rounded-lg border bg-card p-4">
              <div className="flex items-center gap-2">
                <Radio className="size-4 text-emerald-500" />
                <span className="text-sm font-medium">Real-time</span>
              </div>
              <div className="flex items-center gap-6 text-sm">
                <div className="flex flex-col">
                  <span className="text-lg font-semibold tabular-nums">{realtime.activeVisitors}</span>
                  <span className="text-xs text-muted-foreground">Active visitors (5m)</span>
                </div>
                <div className="flex flex-col">
                  <span className="text-lg font-semibold tabular-nums">{realtime.activeSessions}</span>
                  <span className="text-xs text-muted-foreground">Active sessions</span>
                </div>
                {realtime.currentPages?.length ? (
                  <div className="hidden flex-1 flex-col gap-1 sm:flex">
                    <span className="text-xs text-muted-foreground">Top live pages</span>
                    <div className="flex flex-wrap gap-1.5">
                      {realtime.currentPages.slice(0, 4).map((p: any) => (
                        <Badge key={p.path} variant="secondary" className="font-mono text-xs">
                          {p.path} · {p.visitors}
                        </Badge>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}

          <Tabs defaultValue="overview">
            <TabsList>
              <TabsTrigger value="overview">Overview</TabsTrigger>
              <TabsTrigger value="acquisition">Acquisition</TabsTrigger>
              <TabsTrigger value="behavior">Behavior</TabsTrigger>
              <TabsTrigger value="conversions">Conversions</TabsTrigger>
              <TabsTrigger value="audience">Audience</TabsTrigger>
            </TabsList>

            {/* Overview */}
            <TabsContent value="overview" className="flex flex-col gap-4 pt-4">
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Traffic Overview</CardTitle>
                </CardHeader>
                <CardContent>
                  {analytics?.traffic?.length ? (
                    <ChartContainer config={trafficConfig} className="h-[300px] w-full">
                      <AreaChart data={analytics.traffic}>
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
                        <XAxis
                          dataKey="d"
                          tickLine={false}
                          axisLine={false}
                          tickMargin={8}
                          tickFormatter={(v) => new Date(v).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                        />
                        <ChartTooltip content={<ChartTooltipContent />} />
                        <Area dataKey="pageviews" type="natural" fill="url(#fillPageviews)" stroke="var(--color-pageviews)" stackId="a" />
                        <Area dataKey="visitors" type="natural" fill="url(#fillVisitors)" stroke="var(--color-visitors)" stackId="b" />
                      </AreaChart>
                    </ChartContainer>
                  ) : (
                    <p className="py-12 text-center text-sm text-muted-foreground">No traffic recorded in this range.</p>
                  )}
                </CardContent>
              </Card>
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                <PanelCard title="Channels">
                  <BreakdownList rows={analytics?.channels ?? []} labelKey="channel" valueKey="sessions" formatValue={(n) => `${n.toLocaleString()} sessions`} />
                </PanelCard>
                <PanelCard
                  title="Top Pages"
                  action={<ExportMenu onSelect={(f) => exportData("topPages", f)} />}
                >
                  <TopPagesTable rows={analytics?.topPages ?? []} />
                </PanelCard>
              </div>
            </TabsContent>

            {/* Acquisition */}
            <TabsContent value="acquisition" className="grid grid-cols-1 gap-4 pt-4 lg:grid-cols-2">
              <PanelCard title="Channels" action={<ExportMenu onSelect={(f) => exportData("channels", f)} />}>
                <BreakdownList rows={analytics?.channels ?? []} labelKey="channel" valueKey="sessions" formatValue={(n) => `${n.toLocaleString()} sessions`} />
              </PanelCard>
              <PanelCard title="Referrers" action={<ExportMenu onSelect={(f) => exportData("referrers", f)} />}>
                <BreakdownList rows={analytics?.referrers ?? []} labelKey="domain" valueKey="sessions" emptyText="No referral traffic yet." />
              </PanelCard>
              <PanelCard title="UTM Performance" action={<ExportMenu onSelect={(f) => exportData("utm", f)} />}>
                <UtmTable rows={analytics?.utmPerformance ?? []} />
              </PanelCard>
              <PanelCard title="Campaign Attribution" action={<ExportMenu onSelect={(f) => exportData("campaigns", f)} />}>
                <CampaignTable rows={analytics?.campaigns ?? []} />
              </PanelCard>
            </TabsContent>

            {/* Behavior */}
            <TabsContent value="behavior" className="grid grid-cols-1 gap-4 pt-4 lg:grid-cols-2">
              <PanelCard title="Top Pages" action={<ExportMenu onSelect={(f) => exportData("topPages", f)} />}>
                <TopPagesTable rows={analytics?.topPages ?? []} />
              </PanelCard>
              <PanelCard title="Landing Pages" action={<ExportMenu onSelect={(f) => exportData("landingPages", f)} />}>
                <BreakdownList rows={analytics?.landingPages ?? []} labelKey="path" valueKey="sessions" emptyText="No landing pages yet." />
              </PanelCard>
              <PanelCard title="Exit Pages" action={<ExportMenu onSelect={(f) => exportData("exitPages", f)} />}>
                <BreakdownList rows={analytics?.exitPages ?? []} labelKey="path" valueKey="exits" emptyText="No exit data yet." />
              </PanelCard>
              <PanelCard title="Events" action={<ExportMenu onSelect={(f) => exportData("events", f)} />}>
                <BreakdownList rows={analytics?.events ?? []} labelKey="type" valueKey="count" emptyText="No events yet." formatValue={(n) => n.toLocaleString()} />
              </PanelCard>
            </TabsContent>

            {/* Conversions */}
            <TabsContent value="conversions" className="flex flex-col gap-4 pt-4">
              <PanelCard title="Conversion Funnel">
                <Funnel funnel={analytics?.funnel} />
              </PanelCard>
              <PanelCard
                title="Goals"
                action={
                  <GoalsDialog
                    propertyId={property.id}
                    goals={goals}
                    canManage={canManage}
                    onChange={() => mutate()}
                    trigger={
                      <Button variant="ghost" size="sm">
                        <Target className="size-4" /> Manage
                      </Button>
                    }
                  />
                }
              >
                <GoalsTable rows={analytics?.goals ?? []} />
              </PanelCard>
            </TabsContent>

            {/* Audience */}
            <TabsContent value="audience" className="grid grid-cols-1 gap-4 pt-4 lg:grid-cols-2">
              <PanelCard title="Devices" action={<ExportMenu onSelect={(f) => exportData("devices", f)} />}>
                <BreakdownList rows={analytics?.devices ?? []} labelKey="device" valueKey="sessions" />
              </PanelCard>
              <PanelCard title="Browsers" action={<ExportMenu onSelect={(f) => exportData("browsers", f)} />}>
                <BreakdownList rows={analytics?.browsers ?? []} labelKey="browser" valueKey="sessions" />
              </PanelCard>
              <PanelCard title="Operating Systems">
                <BreakdownList rows={analytics?.operatingSystems ?? []} labelKey="os" valueKey="sessions" />
              </PanelCard>
              <PanelCard title="Countries" action={<ExportMenu onSelect={(f) => exportData("countries", f)} />}>
                <BreakdownList rows={analytics?.countries ?? []} labelKey="country" valueKey="sessions" emptyText="No geo data yet." />
              </PanelCard>
            </TabsContent>
          </Tabs>
        </>
      ) : null}
    </main>
  )
}

function ExportMenu({ onSelect }: { onSelect: (format: "csv" | "xlsx") => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm">
          <Download className="size-4" /> Export
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => onSelect("csv")}>CSV</DropdownMenuItem>
        <DropdownMenuItem onClick={() => onSelect("xlsx")}>Excel (.xlsx)</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function TopPagesTable({ rows }: { rows: any[] }) {
  if (!rows.length) return <p className="py-6 text-center text-sm text-muted-foreground">No page views yet.</p>
  return (
    <table className="w-full text-left text-sm">
      <thead>
        <tr className="border-b text-muted-foreground">
          <th className="pb-3 font-medium">Page</th>
          <th className="pb-3 text-right font-medium">Views</th>
          <th className="pb-3 text-right font-medium">Visitors</th>
          <th className="pb-3 text-right font-medium">Avg. Time</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((p) => (
          <tr key={p.path} className="border-b last:border-0">
            <td className="max-w-[220px] truncate py-3 font-mono text-xs">{p.path}</td>
            <td className="py-3 text-right tabular-nums">{Number(p.views).toLocaleString()}</td>
            <td className="py-3 text-right tabular-nums">{Number(p.uniques).toLocaleString()}</td>
            <td className="py-3 text-right text-muted-foreground">{formatDuration(Number(p.avg_seconds) || 0)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function UtmTable({ rows }: { rows: any[] }) {
  if (!rows.length) return <p className="py-6 text-center text-sm text-muted-foreground">No UTM-tagged traffic yet.</p>
  return (
    <table className="w-full text-left text-sm">
      <thead>
        <tr className="border-b text-muted-foreground">
          <th className="pb-3 font-medium">Source / Medium</th>
          <th className="pb-3 font-medium">Campaign</th>
          <th className="pb-3 text-right font-medium">Sessions</th>
          <th className="pb-3 text-right font-medium">Conv.</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i} className="border-b last:border-0">
            <td className="py-3 text-xs">{r.source} / {r.medium}</td>
            <td className="py-3 text-xs">{r.campaign}</td>
            <td className="py-3 text-right tabular-nums">{Number(r.sessions).toLocaleString()}</td>
            <td className="py-3 text-right tabular-nums">{Number(r.conversions).toLocaleString()}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function CampaignTable({ rows }: { rows: any[] }) {
  if (!rows.length)
    return (
      <p className="py-6 text-center text-sm text-muted-foreground">
        No sessions matched an existing campaign. Tag links with{" "}
        <code className="font-mono text-xs">utm_campaign</code> matching a campaign code or name.
      </p>
    )
  return (
    <table className="w-full text-left text-sm">
      <thead>
        <tr className="border-b text-muted-foreground">
          <th className="pb-3 font-medium">Campaign</th>
          <th className="pb-3 text-right font-medium">Sessions</th>
          <th className="pb-3 text-right font-medium">Visitors</th>
          <th className="pb-3 text-right font-medium">Conv.</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id} className="border-b last:border-0">
            <td className="py-3">
              <span className="font-medium">{r.name}</span> <span className="text-xs text-muted-foreground">{r.code}</span>
            </td>
            <td className="py-3 text-right tabular-nums">{Number(r.sessions).toLocaleString()}</td>
            <td className="py-3 text-right tabular-nums">{Number(r.visitors).toLocaleString()}</td>
            <td className="py-3 text-right tabular-nums">{Number(r.conversions).toLocaleString()}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function GoalsTable({ rows }: { rows: any[] }) {
  if (!rows.length) return <p className="py-6 text-center text-sm text-muted-foreground">No active goals. Add one to start measuring conversions.</p>
  return (
    <div className="flex flex-col gap-3">
      {rows.map((g) => (
        <div key={g.id} className="flex items-center justify-between rounded-md border px-3 py-2.5 text-sm">
          <div className="flex flex-col">
            <span className="font-medium">{g.name}</span>
            <span className="text-xs text-muted-foreground">
              {g.match_type === "url" ? `URL = ${g.target}` : `Event = ${g.event_type}`}
            </span>
          </div>
          <div className="flex items-center gap-4">
            <span className="text-lg font-semibold tabular-nums">{Number(g.completions).toLocaleString()}</span>
            <Badge variant="secondary">{g.rate}%</Badge>
          </div>
        </div>
      ))}
    </div>
  )
}

function Funnel({ funnel }: { funnel?: { visitors: number; engaged: number; form_started: number; converted: number } }) {
  if (!funnel || funnel.visitors === 0)
    return <p className="py-6 text-center text-sm text-muted-foreground">Not enough traffic to build a funnel yet.</p>
  const steps = [
    { label: "Visitors", value: funnel.visitors },
    { label: "Engaged", value: funnel.engaged },
    { label: "Form started", value: funnel.form_started },
    { label: "Converted", value: funnel.converted },
  ]
  const max = Math.max(funnel.visitors, 1)
  return (
    <div className="flex flex-col gap-3">
      {steps.map((s, i) => {
        const pct = (s.value / max) * 100
        const stepPct = i === 0 ? 100 : steps[i - 1].value ? (s.value / steps[i - 1].value) * 100 : 0
        return (
          <div key={s.label} className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between text-sm">
              <span>{s.label}</span>
              <span className="tabular-nums">
                {s.value.toLocaleString()} <span className="text-muted-foreground">({stepPct.toFixed(1)}%)</span>
              </span>
            </div>
            <div className="h-3 w-full overflow-hidden rounded-full bg-muted">
              <div className="h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
            </div>
          </div>
        )
      })}
    </div>
  )
}
