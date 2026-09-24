"use client"

import {
  Users,
  UserCheck,
  ClipboardList,
  ShieldCheck,
  Mail,
  UserCog,
  UserX,
  FileX,
  FileClock,
  ReceiptText,
  KeyRound,
  LogIn,
  UserPlus,
  Send,
  FileSearch,
  FileCheck2,
  SlidersHorizontal,
  Settings2,
  ScrollText,
  ArrowRight,
} from "lucide-react"
import { Bar, BarChart, CartesianGrid, XAxis, YAxis, Line, LineChart, Pie, PieChart, Cell } from "recharts"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart"
import { cn } from "@/lib/utils"
import { KpiTile, SectionHeader, MiniBar, DataCard } from "./shared"
import {
  OVERVIEW_KPIS,
  ONBOARDING_FUNNEL,
  ACTIVITY_TREND,
  ADOPTION_BY_TYPE,
  COMPLIANCE_BREAKDOWN,
  RECENT_EVENTS,
  formatNumber,
} from "./mock-data"
import type { SectionKey } from "./vendor-portal-admin"

const KPI_ICONS = [
  Users, UserCheck, ClipboardList, ShieldCheck, Mail, UserCog, UserX, FileX, FileClock, ReceiptText, KeyRound, LogIn,
]

const CHART_COLORS = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)", "var(--chart-5)"]

const funnelConfig: ChartConfig = { count: { label: "Vendors", color: "var(--chart-2)" } }
const trendConfig: ChartConfig = {
  logins: { label: "Logins", color: "var(--chart-2)" },
  invoices: { label: "Invoices", color: "var(--chart-4)" },
}
const adoptionConfig: ChartConfig = { value: { label: "Vendors" } }

const QUICK_ACTIONS: { label: string; icon: typeof UserPlus; target: SectionKey }[] = [
  { label: "Create Vendor Account", icon: UserPlus, target: "directory" },
  { label: "Invite Vendor", icon: Send, target: "invitations" },
  { label: "Review Applications", icon: FileSearch, target: "applications" },
  { label: "Review Documents", icon: FileCheck2, target: "bank" },
  { label: "Manage Access", icon: SlidersHorizontal, target: "access" },
  { label: "Configure Onboarding", icon: ClipboardList, target: "onboarding" },
  { label: "Portal Settings", icon: Settings2, target: "settings" },
  { label: "Audit Logs", icon: ScrollText, target: "audit" },
]

export function OverviewSection({ onNavigate }: { onNavigate: (s: SectionKey) => void }) {
  const complianceMax = Math.max(...COMPLIANCE_BREAKDOWN.map((c) => c.count))

  return (
    <div className="grid gap-6">
      <SectionHeader
        title="Vendor Portal Overview"
        description="Real-time snapshot of vendor accounts, onboarding, compliance and portal activity across the external Vendor Portal."
        icon={Users}
      />

      {/* KPI grid */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        {OVERVIEW_KPIS.map((k, i) => (
          <KpiTile
            key={k.label}
            label={k.label}
            value={formatNumber(k.value)}
            sub={k.sub}
            delta={k.delta}
            icon={KPI_ICONS[i % KPI_ICONS.length]}
          />
        ))}
      </div>

      {/* Quick actions */}
      <DataCard className="p-4">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold">Quick actions</h3>
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
          {QUICK_ACTIONS.map((a) => (
            <button
              key={a.label}
              type="button"
              onClick={() => onNavigate(a.target)}
              className="group flex items-center gap-3 rounded-lg border border-border bg-card px-3 py-2.5 text-left transition-colors hover:border-primary/40 hover:bg-primary/5"
            >
              <span className="inline-flex size-8 items-center justify-center rounded-md bg-primary/10 text-primary">
                <a.icon className="size-4" />
              </span>
              <span className="min-w-0 flex-1 truncate text-sm font-medium">{a.label}</span>
              <ArrowRight className="size-4 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
            </button>
          ))}
        </div>
      </DataCard>

      {/* Charts row 1 */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Vendor onboarding funnel</CardTitle>
            <CardDescription>Progression through onboarding stages</CardDescription>
          </CardHeader>
          <CardContent>
            <ChartContainer config={funnelConfig} className="h-[240px] w-full">
              <BarChart data={ONBOARDING_FUNNEL} layout="vertical" margin={{ left: 8, right: 16 }}>
                <CartesianGrid horizontal={false} strokeDasharray="3 3" />
                <XAxis type="number" hide />
                <YAxis
                  type="category"
                  dataKey="stage"
                  tickLine={false}
                  axisLine={false}
                  width={92}
                  tick={{ fontSize: 11 }}
                />
                <ChartTooltip content={<ChartTooltipContent />} />
                <Bar dataKey="count" fill="var(--color-count)" radius={4} barSize={16} />
              </BarChart>
            </ChartContainer>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Vendor activity trend</CardTitle>
            <CardDescription>Portal logins and invoice submissions</CardDescription>
          </CardHeader>
          <CardContent>
            <ChartContainer config={trendConfig} className="h-[240px] w-full">
              <LineChart data={ACTIVITY_TREND} margin={{ left: 8, right: 8 }}>
                <CartesianGrid vertical={false} strokeDasharray="3 3" />
                <XAxis dataKey="month" tickLine={false} axisLine={false} tick={{ fontSize: 11 }} />
                <ChartTooltip content={<ChartTooltipContent />} />
                <Line type="monotone" dataKey="logins" stroke="var(--color-logins)" strokeWidth={2} dot={false} />
                <Line type="monotone" dataKey="invoices" stroke="var(--color-invoices)" strokeWidth={2} dot={false} />
              </LineChart>
            </ChartContainer>
          </CardContent>
        </Card>
      </div>

      {/* Charts row 2 */}
      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Portal adoption</CardTitle>
            <CardDescription>Active vendors by type</CardDescription>
          </CardHeader>
          <CardContent className="flex items-center justify-center">
            <ChartContainer config={adoptionConfig} className="h-[220px] w-full">
              <PieChart>
                <ChartTooltip content={<ChartTooltipContent nameKey="type" />} />
                <Pie data={ADOPTION_BY_TYPE} dataKey="value" nameKey="type" innerRadius={48} outerRadius={80} paddingAngle={2}>
                  {ADOPTION_BY_TYPE.map((_, i) => (
                    <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
                  ))}
                </Pie>
              </PieChart>
            </ChartContainer>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Pending compliance</CardTitle>
            <CardDescription>Compliance status distribution</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 pt-1">
            {COMPLIANCE_BREAKDOWN.map((c) => (
              <div key={c.status} className="grid gap-1.5">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-medium">{c.status}</span>
                  <span className="tabular-nums text-muted-foreground">{c.count}</span>
                </div>
                <MiniBar
                  value={c.count}
                  max={complianceMax}
                  tone={
                    c.status === "Compliant"
                      ? "success"
                      : c.status === "Expired" || c.status === "Rejected"
                        ? "danger"
                        : "warning"
                  }
                />
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex-row items-center justify-between">
            <div className="grid gap-0.5">
              <CardTitle className="text-sm">Recent portal events</CardTitle>
              <CardDescription>Latest vendor activity</CardDescription>
            </div>
            <Button variant="ghost" size="sm" onClick={() => onNavigate("audit")}>
              View all
            </Button>
          </CardHeader>
          <CardContent className="grid gap-0 pt-0">
            <ul className="grid divide-y divide-border">
              {RECENT_EVENTS.map((e) => (
                <li key={e.id} className="flex items-start gap-3 py-2.5 first:pt-0">
                  <span
                    className={cn(
                      "mt-1.5 size-2 shrink-0 rounded-full",
                      e.tone === "success"
                        ? "bg-emerald-500"
                        : e.tone === "danger"
                          ? "bg-destructive"
                          : e.tone === "warning"
                            ? "bg-amber-500"
                            : "bg-blue-500",
                    )}
                  />
                  <div className="grid min-w-0 gap-0.5">
                    <p className="truncate text-sm">
                      <span className="font-medium">{e.vendor}</span>{" "}
                      <span className="text-muted-foreground">— {e.action}</span>
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {e.actor} · {e.time}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
