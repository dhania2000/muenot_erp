"use client"

import Link from "next/link"
import { useState } from "react"
import {
  CalendarCheck2, CheckSquare2, ChevronRight, Clock3, FileText, Layers3,
  Ticket, UsersRound,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { OperationsDashboardClient } from "@/components/operations/operations-dashboard-client"

type Metric = {
  label: string
  value: string
  icon: typeof UsersRound
  href?: string
  iconWrap: string
  iconColor: string
  bar: string
}
type Panel = { title: string; icon: typeof UsersRound; message: string }

const metrics: Metric[] = [
  { label: "Total Clients", value: "0", icon: UsersRound, href: "/modules/clients", iconWrap: "bg-blue-500/10", iconColor: "text-blue-500", bar: "bg-blue-500" },
  { label: "Total Employees", value: "0", icon: UsersRound, href: "/admin/employees", iconWrap: "bg-violet-500/10", iconColor: "text-violet-500", bar: "bg-violet-500" },
  { label: "Total Projects", value: "0", icon: Layers3, href: "/modules/operations/projects", iconWrap: "bg-emerald-500/10", iconColor: "text-emerald-500", bar: "bg-emerald-500" },
  { label: "Due Invoices", value: "0", icon: FileText, href: "/modules/finance", iconWrap: "bg-amber-500/10", iconColor: "text-amber-500", bar: "bg-amber-500" },
  { label: "Hours Logged", value: "0 hrs", icon: Clock3, href: "/modules/hr/attendance", iconWrap: "bg-cyan-500/10", iconColor: "text-cyan-500", bar: "bg-cyan-500" },
  { label: "Pending Tasks", value: "0", icon: CheckSquare2, iconWrap: "bg-rose-500/10", iconColor: "text-rose-500", bar: "bg-rose-500" },
  { label: "Today Attendance", value: "0/0", icon: CalendarCheck2, href: "/modules/hr/attendance", iconWrap: "bg-teal-500/10", iconColor: "text-teal-500", bar: "bg-teal-500" },
  { label: "Unresolved Tickets", value: "0", icon: Ticket, href: "/modules/tickets", iconWrap: "bg-orange-500/10", iconColor: "text-orange-500", bar: "bg-orange-500" },
]

const panels: Panel[] = [
  { title: "Income", icon: FileText, message: "No financial records yet" },
  { title: "Timesheet", icon: Clock3, message: "Not enough data" },
  { title: "Pending Leaves", icon: CalendarCheck2, message: "No record found" },
  { title: "Open Tickets", icon: Ticket, message: "No record found" },
  { title: "Pending Tasks", icon: CheckSquare2, message: "No record found" },
  { title: "Pending FollowUp", icon: UsersRound, message: "No record found" },
  { title: "Document Expiries", icon: FileText, message: "No record found" },
  { title: "Project Activity Timeline", icon: CheckSquare2, message: "No record found" },
  { title: "User Activity Timeline", icon: UsersRound, message: "No record found" },
]

type NavTab =
  | { label: string; kind: "tab" }
  | { label: string; kind: "link"; href: string }

const navTabs: NavTab[] = [
  { label: "Overview", kind: "tab" },
  { label: "Project", kind: "tab" },
  { label: "Client", kind: "link", href: "/modules/clients" },
  { label: "HR", kind: "link", href: "/modules/hr" },
  { label: "Ticket", kind: "link", href: "/modules/tickets" },
  { label: "Finance", kind: "link", href: "/modules/finance" },
]

function KpiCard({ metric, activeNote }: { metric: Metric; activeNote?: string }) {
  const Icon = metric.icon
  const Wrapper = metric.href ? Link : "div"
  return (
    <Wrapper
      href={metric.href ?? "#"}
      className="group relative flex flex-col overflow-hidden rounded-xl border border-border bg-card p-5 shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:border-foreground/15 hover:shadow-md"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-1">
          <span className="text-sm font-medium text-muted-foreground">{metric.label}</span>
          <strong className="text-3xl font-semibold leading-none tracking-tight text-foreground">{metric.value}</strong>
          {activeNote && <small className="mt-1 text-xs text-muted-foreground">{activeNote}</small>}
        </div>
        <span className={cn("flex size-11 shrink-0 items-center justify-center rounded-lg transition-transform duration-200 group-hover:scale-110", metric.iconWrap)}>
          <Icon className={cn("size-5", metric.iconColor)} aria-hidden="true" />
        </span>
      </div>
      <span className={cn("absolute inset-x-0 bottom-0 h-1 origin-left scale-x-0 transition-transform duration-200 group-hover:scale-x-100", metric.bar)} aria-hidden="true" />
    </Wrapper>
  )
}

function EmptyPanel({ panel }: { panel: Panel }) {
  const Icon = panel.icon
  return (
    <section className="flex flex-col rounded-xl border border-border bg-card p-5 shadow-sm">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-foreground">{panel.title}</h2>
        <span
          className="flex size-5 items-center justify-center rounded-full border border-border text-[11px] font-medium text-muted-foreground"
          aria-label={`${panel.title} information`}
        >
          ?
        </span>
      </div>
      <div className="flex flex-1 flex-col items-center justify-center gap-3 py-10 text-center">
        <span className="flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <Icon className="size-5" aria-hidden="true" />
        </span>
        <span className="text-sm text-muted-foreground">{panel.message}</span>
      </div>
    </section>
  )
}

export function AdminDashboard({ employeeTotal, employeeActive }: { employeeTotal: number; employeeActive: number }) {
  const [activeTab, setActiveTab] = useState("Overview")
  const dashboardMetrics = metrics.map((metric, index) =>
    index === 1 ? { ...metric, value: String(employeeTotal) } : metric,
  )

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-6 p-4 md:p-6 lg:p-8">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">
          {activeTab === "Project" ? "Project" : "Overview"}
        </h1>
        <p className="text-sm text-muted-foreground">
          {activeTab === "Project"
            ? "Manage projects right here without leaving the dashboard."
            : "Welcome back — here's what's happening across your workspace."}
        </p>
      </div>

      <nav className="flex gap-1 overflow-x-auto rounded-xl border border-border bg-card p-1 shadow-sm" aria-label="Dashboard sections">
        {navTabs.map((item) => {
          const isActive = item.kind === "tab" && item.label === activeTab
          const className = cn(
            "flex-1 whitespace-nowrap rounded-lg px-4 py-2 text-center text-sm font-medium transition-colors",
            isActive
              ? "bg-primary text-primary-foreground shadow-sm"
              : "text-muted-foreground hover:bg-muted hover:text-foreground",
          )
          if (item.kind === "link") {
            return (
              <Link key={item.label} href={item.href} className={className}>
                {item.label}
              </Link>
            )
          }
          return (
            <button
              key={item.label}
              type="button"
              onClick={() => setActiveTab(item.label)}
              aria-current={isActive ? "page" : undefined}
              className={className}
            >
              {item.label}
            </button>
          )
        })}
      </nav>

      {activeTab === "Project" ? (
        <div className="rounded-xl border border-border bg-card shadow-sm">
          <OperationsDashboardClient initialModule="projects" />
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {dashboardMetrics.map((metric) => (
              <KpiCard
                key={metric.label}
                metric={metric}
                activeNote={metric.label === "Total Employees" ? `${employeeActive} active` : undefined}
              />
            ))}
          </div>

          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
            {panels.map((panel) => (
              <EmptyPanel key={panel.title} panel={panel} />
            ))}
          </div>

          <Link
            href="/admin/settings"
            className="inline-flex items-center gap-1 self-start text-sm font-medium text-primary transition-colors hover:text-primary/80"
          >
            Open admin settings <ChevronRight className="size-4" />
          </Link>
        </>
      )}
    </div>
  )
}
