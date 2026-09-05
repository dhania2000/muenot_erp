"use client"

import Link from "next/link"
import { useRouter } from "next/navigation"
import {
  Bell, CalendarCheck2, CheckSquare2, ChevronRight, Clock3, FileText, Layers3,
  Menu, MessageSquare, Plus, Power, Search, Settings, Ticket, UserPlus, UsersRound, X,
} from "lucide-react"
import { useState } from "react"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"

type Metric = { label: string; value: string; icon: typeof UsersRound; href?: string }
type Panel = { title: string; icon: typeof UsersRound; message: string }

const metrics: Metric[] = [
  { label: "Total Clients", value: "0", icon: UsersRound, href: "/modules/clients" },
  { label: "Total Employees", value: "0", icon: UsersRound, href: "/admin/employees" },
  { label: "Total Projects", value: "0", icon: Layers3, href: "/modules/operations/projects" },
  { label: "Due Invoices", value: "0", icon: FileText, href: "/modules/finance" },
  { label: "Hours Logged", value: "0 hrs", icon: Clock3, href: "/modules/hr/attendance" },
  { label: "Pending Tasks", value: "0", icon: CheckSquare2 },
  { label: "Today Attendance", value: "0/0", icon: CalendarCheck2, href: "/modules/hr/attendance" },
  { label: "Unresolved Tickets", value: "0", icon: Ticket, href: "/modules/tickets" },
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

const navLinks: { label: string; href: string }[] = [
  { label: "Overview", href: "/admin" },
  { label: "Project", href: "/modules/operations/projects" },
  { label: "Client", href: "/modules/clients" },
  { label: "HR", href: "/modules/hr" },
  { label: "Ticket", href: "/modules/tickets" },
  { label: "Finance", href: "/modules/finance" },
]

function EmptyPanel({ panel }: { panel: Panel }) {
  const Icon = panel.icon
  return <section className="admin-panel">
    <h2>{panel.title} <span className="admin-help" aria-label={`${panel.title} information`}>?</span></h2>
    <div className="admin-empty"><Icon aria-hidden="true" /><span>{panel.message}</span></div>
  </section>
}

export function AdminDashboard({ employeeTotal, employeeActive }: { employeeTotal: number; employeeActive: number }) {
  const router = useRouter()
  const [menuOpen, setMenuOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState("")
  const dashboardMetrics = metrics.map((metric, index) => index === 1 ? { ...metric, value: String(employeeTotal) } : metric)

  const searchResults = query.trim()
    ? navLinks.filter((link) => link.label.toLowerCase().includes(query.trim().toLowerCase()))
    : navLinks

  async function handleLogout() {
    await fetch("/api/auth/logout", { method: "POST" })
    router.push("/login")
    router.refresh()
  }

  function goTo(href: string) {
    setSearchOpen(false)
    setQuery("")
    router.push(href)
  }

  return <div className="admin-dashboard">
    <header className="admin-topbar">
      <div className="admin-brand"><h1>Dashboard</h1></div>
      <div className="admin-actions" aria-label="Dashboard actions">
        <button aria-label="Search" onClick={() => setSearchOpen(true)}><Search /></button>
        <button aria-label="Messages" onClick={() => router.push("/modules/messages")}><MessageSquare /></button>
        <DropdownMenu>
          <DropdownMenuTrigger render={<button aria-label="Recent activity" />}>
            <Clock3 />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-64">
            <DropdownMenuLabel>Recent activity</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <p className="px-2 py-1.5 text-sm text-muted-foreground">No recent activity yet</p>
          </DropdownMenuContent>
        </DropdownMenu>
        <DropdownMenu>
          <DropdownMenuTrigger render={<button aria-label="Add" />}>
            <Plus />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuLabel>Quick create</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => router.push("/admin/employees")}>
              <UserPlus className="size-4" /> Add employee
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => router.push("/modules/tickets/all")}>
              <Ticket className="size-4" /> New ticket
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => router.push("/modules/clients")}>
              <UsersRound className="size-4" /> New client
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <DropdownMenu>
          <DropdownMenuTrigger render={<button aria-label="Notifications" />}>
            <Bell />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-64">
            <DropdownMenuLabel>Notifications</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <p className="px-2 py-1.5 text-sm text-muted-foreground">You&apos;re all caught up</p>
          </DropdownMenuContent>
        </DropdownMenu>
        <button aria-label="Power" onClick={handleLogout}><Power /></button>
        <button className="admin-mobile-menu" aria-label="Open menu" onClick={() => setMenuOpen(!menuOpen)}>{menuOpen ? <X /> : <Menu />}</button>
      </div>
    </header>
    <nav className={`admin-tabs ${menuOpen ? "is-open" : ""}`} aria-label="Main navigation">
      {navLinks.map((item, index) => <Link className={index === 0 ? "is-active" : ""} href={item.href} key={item.label}>{item.label}</Link>)}
      <Link className="admin-settings" href="/admin/settings" aria-label="Settings"><Settings /></Link>
    </nav>
    <main className="admin-content">
      <div className="admin-kpis">{dashboardMetrics.map(({ label, value, icon: Icon, href }) => <Link href={href ?? "#"} className="admin-kpi" key={label} onClick={(event) => !href && event.preventDefault()}><div><span>{label}</span><strong>{value}</strong>{label === "Total Employees" && <small>{employeeActive} active</small>}</div><Icon /></Link>)}</div>
      <div className="admin-panels">{panels.map((panel) => <EmptyPanel key={panel.title} panel={panel} />)}</div>
      <Link href="/admin/settings" className="admin-footer-link">Open admin settings <ChevronRight /></Link>
    </main>

    <Dialog open={searchOpen} onOpenChange={(open) => { setSearchOpen(open); if (!open) setQuery("") }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Search</DialogTitle>
        </DialogHeader>
        <Input autoFocus placeholder="Search modules..." value={query} onChange={(e) => setQuery(e.target.value)} />
        <div className="flex flex-col gap-1 pt-2">
          {searchResults.length === 0 && <p className="px-2 py-1.5 text-sm text-muted-foreground">No results found</p>}
          {searchResults.map((entry) => (
            <button
              key={entry.href}
              type="button"
              onClick={() => goTo(entry.href)}
              className="rounded-md px-2 py-2 text-left text-sm hover:bg-muted"
            >
              {entry.label}
            </button>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  </div>
}
