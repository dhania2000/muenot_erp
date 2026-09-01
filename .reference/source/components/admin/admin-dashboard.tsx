"use client"

import Link from "next/link"
import {
  Bell, CalendarCheck2, CheckSquare2, ChevronRight, Clock3, FileText, Layers3,
  Menu, MessageSquare, Plus, Power, Search, Settings, Ticket, UsersRound, X,
} from "lucide-react"
import { useState } from "react"

type Metric = { label: string; value: string; icon: typeof UsersRound; href?: string }
type Panel = { title: string; icon: typeof UsersRound; message: string }

const metrics: Metric[] = [
  { label: "Total Clients", value: "0", icon: UsersRound },
  { label: "Total Employees", value: "0", icon: UsersRound, href: "/admin/employees" },
  { label: "Total Projects", value: "0", icon: Layers3 },
  { label: "Due Invoices", value: "0", icon: FileText },
  { label: "Hours Logged", value: "0 hrs", icon: Clock3 },
  { label: "Pending Tasks", value: "0", icon: CheckSquare2 },
  { label: "Today Attendance", value: "0/0", icon: CalendarCheck2 },
  { label: "Unresolved Tickets", value: "0", icon: Ticket },
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

function EmptyPanel({ panel }: { panel: Panel }) {
  const Icon = panel.icon
  return <section className="admin-panel">
    <h2>{panel.title} <span className="admin-help" aria-label={`${panel.title} information`}>?</span></h2>
    <div className="admin-empty"><Icon aria-hidden="true" /><span>{panel.message}</span></div>
  </section>
}

export function AdminDashboard({ employeeTotal, employeeActive }: { employeeTotal: number; employeeActive: number }) {
  const [menuOpen, setMenuOpen] = useState(false)
  const nav = ["Overview", "Project", "Client", "HR", "Ticket", "Finance"]
  const dashboardMetrics = metrics.map((metric, index) => index === 1 ? { ...metric, value: String(employeeTotal) } : metric)

  return <div className="admin-dashboard">
    <header className="admin-topbar">
      <div className="admin-brand"><h1>Dashboard</h1><span>Home <b>•</b> Dashboard</span></div>
      <div className="admin-actions" aria-label="Dashboard actions">
        <button aria-label="Search"><Search /></button><button aria-label="Messages"><MessageSquare /></button>
        <button aria-label="Recent activity"><Clock3 /></button><button aria-label="Add"><Plus /></button>
        <button aria-label="Notifications"><Bell /></button><button aria-label="Power"><Power /></button>
        <button className="admin-mobile-menu" aria-label="Open menu" onClick={() => setMenuOpen(!menuOpen)}>{menuOpen ? <X /> : <Menu />}</button>
      </div>
    </header>
    <nav className={`admin-tabs ${menuOpen ? "is-open" : ""}`} aria-label="Main navigation">
      {nav.map((item, index) => <Link className={index === 0 ? "is-active" : ""} href={item === "Overview" ? "/admin" : `/modules/${item.toLowerCase()}`} key={item}>{item}</Link>)}
      <Link className="admin-settings" href="/admin/settings" aria-label="Settings"><Settings /></Link>
    </nav>
    <main className="admin-content">
      <div className="admin-kpis">{dashboardMetrics.map(({ label, value, icon: Icon, href }) => <Link href={href ?? "#"} className="admin-kpi" key={label} onClick={(event) => !href && event.preventDefault()}><div><span>{label}</span><strong>{value}</strong>{label === "Total Employees" && <small>{employeeActive} active</small>}</div><Icon /></Link>)}</div>
      <div className="admin-panels">{panels.map((panel) => <EmptyPanel key={panel.title} panel={panel} />)}</div>
      <Link href="/admin/settings" className="admin-footer-link">Open admin settings <ChevronRight /></Link>
    </main>
  </div>
}
