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
import { Bar, BarChart, CartesianGrid, XAxis, Line, LineChart, Pie, PieChart, Cell } from "recharts"
import {
  Users,
  UserCheck,
  CalendarCheck,
  CalendarOff,
  Clock,
  FileClock,
  LifeBuoy,
  UserPlus,
  RefreshCw,
  CalendarClock,
  Users2,
} from "lucide-react"
import Link from "next/link"

const CHART_COLORS = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)", "var(--chart-5)"]

const barConfig: ChartConfig = {
  count: { label: "Employees", color: "var(--chart-1)" },
}

const trendConfig: ChartConfig = {
  present: { label: "Present", color: "var(--chart-2)" },
  absent: { label: "Absent", color: "var(--chart-4)" },
}

type DashboardData = {
  kpis: Record<string, number>
  byDepartment: { department: string; count: number }[]
  byType: { type: string; count: number }[]
  leaveByStatus: { status: string; count: number }[]
  ticketsByPriority: { priority: string; count: number }[]
  attendanceTrend: { date: string; present: number; absent: number }[]
  recentJoiners: any[]
  pendingLeaves: any[]
}

function formatDate(value?: string | null) {
  if (!value) return "—"
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return String(value)
  return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })
}

export function HrDashboardClient() {
  const { data, isLoading } = useSWR<DashboardData>("/api/hr/dashboard", fetcher, { refreshInterval: 30000 })

  if (isLoading || !data) {
    return <div className="p-6 text-sm text-muted-foreground md:p-8">Loading HR dashboard...</div>
  }

  const { kpis, byDepartment, byType, leaveByStatus, ticketsByPriority, attendanceTrend, recentJoiners, pendingLeaves } =
    data

  const kpiCards = [
    { label: "Total Employees", value: kpis.totalEmployees, sub: `${kpis.activeEmployees} active`, icon: Users },
    { label: "Present Today", value: kpis.presentToday, sub: `${kpis.markedToday} marked`, icon: CalendarCheck },
    { label: "On Leave Today", value: kpis.onLeaveToday, sub: `${kpis.absentToday} absent`, icon: CalendarOff },
    { label: "Late Today", value: kpis.lateToday, sub: "arrivals flagged", icon: Clock },
    { label: "Pending Leaves", value: kpis.pendingLeaves, sub: `${kpis.totalLeaves} total`, icon: FileClock },
    { label: "Open HR Tickets", value: kpis.openTickets, sub: `${kpis.slaBreached} SLA breached`, icon: LifeBuoy },
    { label: "On Probation", value: kpis.probation, sub: `${kpis.onboarding} onboarding`, icon: UserCheck },
    { label: "Joined This Month", value: kpis.joinedThisMonth, sub: "new hires", icon: UserPlus },
  ]

  const typePie = byType.map((t: any) => ({ name: t.type, value: t.count }))

  const rotationTiles = [
    {
      label: "Active Rotations",
      value: kpis.activeRotations ?? 0,
      sub: `${kpis.totalRotations ?? 0} configured`,
      icon: RefreshCw,
      href: "/modules/hr/shift-rotations?view=running",
    },
    {
      label: "Scheduled Rotations",
      value: kpis.scheduledRotations ?? 0,
      sub: "start in the future",
      icon: CalendarClock,
      href: "/modules/hr/shift-rotations?view=scheduled",
    },
    {
      label: "Employees on Rotation",
      value: kpis.employeesOnRotation ?? 0,
      sub: "resolved via rotation today",
      icon: Users2,
      href: "/modules/hr/shift-rotations",
    },
  ]

  return (
    <div className="flex flex-col gap-6 p-6 md:p-8">
      <div className="flex items-center gap-3">
        <div className="flex size-10 items-center justify-center rounded-md bg-primary/10 text-primary">
          <Users className="size-5" />
        </div>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">HR Dashboard</h1>
          <p className="text-sm text-muted-foreground">Headcount, attendance, leave and support at a glance</p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4 xl:grid-cols-8">
        {kpiCards.map((k) => (
          <Card key={k.label}>
            <CardContent className="flex flex-col gap-2 pt-6">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-muted-foreground">{k.label}</span>
                <k.icon className="size-4 text-muted-foreground" />
              </div>
              <span className="text-2xl font-semibold tracking-tight">{k.value}</span>
              <span className="text-xs text-muted-foreground">{k.sub}</span>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-muted-foreground">Shift Rotations</h2>
          <Link href="/modules/hr/shift-rotations" className="text-xs font-medium text-primary hover:underline">
            View all rotations
          </Link>
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          {rotationTiles.map((t) => (
            <Link key={t.label} href={t.href} className="group">
              <Card className="transition-colors group-hover:border-primary/50">
                <CardContent className="flex flex-col gap-2 pt-6">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-muted-foreground">{t.label}</span>
                    <t.icon className="size-4 text-muted-foreground" />
                  </div>
                  <span className="text-2xl font-semibold tracking-tight">{t.value}</span>
                  <span className="text-xs text-muted-foreground">{t.sub}</span>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-base">Headcount by Department</CardTitle>
          </CardHeader>
          <CardContent>
            {byDepartment.length === 0 ? (
              <p className="text-sm text-muted-foreground">No employee data yet.</p>
            ) : (
              <ChartContainer config={barConfig} className="aspect-auto h-64 w-full">
                <BarChart data={byDepartment} margin={{ left: 0, right: 8 }}>
                  <CartesianGrid vertical={false} />
                  <XAxis dataKey="department" tickLine={false} axisLine={false} tickMargin={8} />
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <Bar dataKey="count" fill="var(--color-count)" radius={4} />
                </BarChart>
              </ChartContainer>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Employment Type</CardTitle>
          </CardHeader>
          <CardContent>
            {typePie.length === 0 ? (
              <p className="text-sm text-muted-foreground">No employee data yet.</p>
            ) : (
              <>
                <ChartContainer config={barConfig} className="aspect-auto h-64 w-full">
                  <PieChart>
                    <ChartTooltip content={<ChartTooltipContent />} />
                    <Pie data={typePie} dataKey="value" nameKey="name" innerRadius={45} outerRadius={75} strokeWidth={2}>
                      {typePie.map((_: any, i: number) => (
                        <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
                      ))}
                    </Pie>
                  </PieChart>
                </ChartContainer>
                <div className="mt-3 flex flex-wrap gap-2">
                  {byType.map((t: any, i: number) => (
                    <Badge key={t.type} variant="secondary" className="gap-1.5 text-xs">
                      <span
                        className="size-2 rounded-full"
                        style={{ backgroundColor: CHART_COLORS[i % CHART_COLORS.length] }}
                      />
                      {t.type} · {t.count}
                    </Badge>
                  ))}
                </div>
              </>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-base">Attendance — Last 7 Days</CardTitle>
          </CardHeader>
          <CardContent>
            {attendanceTrend.length === 0 ? (
              <p className="text-sm text-muted-foreground">No attendance recorded yet.</p>
            ) : (
              <ChartContainer config={trendConfig} className="aspect-auto h-64 w-full">
                <LineChart data={attendanceTrend} margin={{ left: 0, right: 8 }}>
                  <CartesianGrid vertical={false} />
                  <XAxis
                    dataKey="date"
                    tickLine={false}
                    axisLine={false}
                    tickMargin={8}
                    tickFormatter={(v) => formatDate(v).replace(/,.*/, "")}
                  />
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <Line dataKey="present" stroke="var(--color-present)" strokeWidth={2} dot={false} />
                  <Line dataKey="absent" stroke="var(--color-absent)" strokeWidth={2} dot={false} />
                </LineChart>
              </ChartContainer>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Leave Requests by Status</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            {leaveByStatus.length === 0 && <p className="text-sm text-muted-foreground">No leave requests yet.</p>}
            {leaveByStatus.map((s: any) => (
              <div key={s.status} className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">{s.status}</span>
                <span className="font-medium">{s.count}</span>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Support Tickets by Priority</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            {ticketsByPriority.length === 0 && <p className="text-sm text-muted-foreground">No support tickets yet.</p>}
            {ticketsByPriority.map((t: any) => (
              <div key={t.priority} className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">{t.priority}</span>
                <span className="font-medium">{t.count}</span>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Recent Joiners</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {recentJoiners.length === 0 && <p className="text-sm text-muted-foreground">No recent joiners.</p>}
            {recentJoiners.map((e: any) => (
              <div key={e.employee_id} className="flex items-start gap-2 text-sm">
                <UserPlus className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                <div className="flex flex-col">
                  <span className="font-medium">{e.employee_name}</span>
                  <span className="text-xs text-muted-foreground">
                    {[e.designation, e.department].filter(Boolean).join(" · ") || "—"} · {formatDate(e.joining_date)}
                  </span>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Pending Leave Approvals</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {pendingLeaves.length === 0 && <p className="text-sm text-muted-foreground">Nothing awaiting approval.</p>}
            {pendingLeaves.map((l: any) => (
              <div key={l.request_id} className="flex items-start gap-2 text-sm">
                <FileClock className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                <div className="flex flex-col">
                  <span className="font-medium">{l.employee_name || l.request_id}</span>
                  <span className="text-xs text-muted-foreground">
                    {formatDate(l.from_date)} → {formatDate(l.to_date)} · {l.days}d · {l.status}
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
