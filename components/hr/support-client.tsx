"use client"

import { useMemo, useState } from "react"
import useSWR from "swr"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { fetcher } from "@/lib/fetcher"
import { ExcelExportButton } from "@/components/excel-export-button"
import { SupportNewTicket } from "./support-new-ticket"
import { SupportTicketDetail } from "./support-ticket-detail"
import { priorityBadge, slaBadge, statusBadge } from "./support-badges"

const STATUSES = ["Open", "In Progress", "Waiting", "Resolved", "Closed"]
const PRIORITIES = ["Low", "Medium", "High", "Urgent"]
const ALL = "all"

type ListResponse = {
  tickets: any[]
  kpi: {
    total: number
    open: number
    inProgress: number
    waiting: number
    resolved: number
    closed: number
    breached: number
    unassigned: number
  }
  page: number
  pageSize: number
  total: number
  canManage: boolean
  canViewSensitive: boolean
}

function fmt(value?: string | null) {
  if (!value) return "—"
  return String(value).replace("T", " ").slice(0, 16)
}

export function SupportClient() {
  const [q, setQ] = useState("")
  const [status, setStatus] = useState(ALL)
  const [priority, setPriority] = useState(ALL)
  const [category, setCategory] = useState(ALL)
  const [slaOnly, setSlaOnly] = useState(false)
  const [page, setPage] = useState(1)
  const [newOpen, setNewOpen] = useState(false)
  const [activeTicket, setActiveTicket] = useState<number | null>(null)

  const { data: catData } = useSWR<{ categories: any[] }>("/api/hr/support/categories", fetcher)

  const queryString = useMemo(() => {
    const p = new URLSearchParams()
    if (q.trim()) p.set("q", q.trim())
    if (status !== ALL) p.set("status", status)
    if (priority !== ALL) p.set("priority", priority)
    if (category !== ALL) p.set("category", category)
    if (slaOnly) p.set("sla", "breached")
    p.set("page", String(page))
    p.set("pageSize", "25")
    return p.toString()
  }, [q, status, priority, category, slaOnly, page])

  const { data, mutate } = useSWR<ListResponse>(`/api/hr/support?${queryString}`, fetcher, { keepPreviousData: true })

  const tickets = data?.tickets || []
  const kpi = data?.kpi
  const canManage = data?.canManage
  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1

  const kpiCards = canManage
    ? [
        { label: "Open", value: kpi?.open ?? 0, filter: () => { setStatus("Open"); setSlaOnly(false); setPage(1) } },
        { label: "In Progress", value: kpi?.inProgress ?? 0, filter: () => { setStatus("In Progress"); setSlaOnly(false); setPage(1) } },
        { label: "Unassigned", value: kpi?.unassigned ?? 0, filter: () => { setStatus(ALL); setSlaOnly(false); setPage(1) } },
        { label: "SLA breached", value: kpi?.breached ?? 0, danger: true, filter: () => { setStatus(ALL); setSlaOnly(true); setPage(1) } },
        { label: "Resolved", value: kpi?.resolved ?? 0, filter: () => { setStatus("Resolved"); setSlaOnly(false); setPage(1) } },
      ]
    : [
        { label: "Open", value: kpi?.open ?? 0, filter: () => { setStatus("Open"); setPage(1) } },
        { label: "In Progress", value: kpi?.inProgress ?? 0, filter: () => { setStatus("In Progress"); setPage(1) } },
        { label: "Resolved", value: kpi?.resolved ?? 0, filter: () => { setStatus("Resolved"); setPage(1) } },
        { label: "All tickets", value: kpi?.total ?? 0, filter: () => { setStatus(ALL); setPage(1) } },
      ]

  return (
    <main className="space-y-6 p-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-balance">HR Support</h1>
          <p className="text-muted-foreground">
            {canManage
              ? "Employee helpdesk — ownership, SLA tracking, conversations and resolution."
              : "Raise and track your HR requests. We'll keep you posted on progress."}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {canManage ? (
            <ExcelExportButton
              rows={tickets}
              filename="support-tickets"
              columns={[
                { header: "Ticket", value: (r: any) => r.ticket_id },
                { header: "Employee", value: (r: any) => r.employee_name },
                { header: "Subject", value: (r: any) => r.subject },
                { header: "Category", value: (r: any) => r.support_category },
                { header: "Priority", value: (r: any) => r.priority },
                { header: "Status", value: (r: any) => r.status },
                { header: "Assignee", value: (r: any) => r.assigned_to_name || "" },
                { header: "SLA state", value: (r: any) => r.sla_state },
                { header: "SLA due", value: (r: any) => r.sla_due_date },
                { header: "Created", value: (r: any) => r.created_at },
              ]}
            />
          ) : null}
          <Button onClick={() => setNewOpen(true)}>Raise ticket</Button>
        </div>
      </header>

      {/* KPIs */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 lg:grid-cols-5">
        {kpiCards.map((c) => (
          <button
            key={c.label}
            onClick={c.filter}
            className="rounded-xl border bg-card p-4 text-left transition-colors hover:border-primary/40"
          >
            <p className="text-xs text-muted-foreground">{c.label}</p>
            <p className={`mt-1 text-2xl font-semibold ${"danger" in c && c.danger && c.value ? "text-destructive" : "text-foreground"}`}>
              {c.value}
            </p>
          </button>
        ))}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        <Input
          placeholder="Search ticket, subject, employee…"
          value={q}
          onChange={(e) => { setQ(e.target.value); setPage(1) }}
          className="w-full sm:w-72"
        />
        <Select value={status} onValueChange={(v) => { setStatus(v); setPage(1) }}>
          <SelectTrigger className="w-40"><SelectValue placeholder="Status" /></SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All statuses</SelectItem>
            {STATUSES.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={priority} onValueChange={(v) => { setPriority(v); setPage(1) }}>
          <SelectTrigger className="w-36"><SelectValue placeholder="Priority" /></SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All priorities</SelectItem>
            {PRIORITIES.map((p) => <SelectItem key={p} value={p}>{p}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={category} onValueChange={(v) => { setCategory(v); setPage(1) }}>
          <SelectTrigger className="w-44"><SelectValue placeholder="Category" /></SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All categories</SelectItem>
            {(catData?.categories || []).map((c) => <SelectItem key={c.id} value={c.name}>{c.name}</SelectItem>)}
          </SelectContent>
        </Select>
        {canManage ? (
          <Button variant={slaOnly ? "default" : "outline"} size="sm" onClick={() => { setSlaOnly((v) => !v); setPage(1) }}>
            SLA breached
          </Button>
        ) : null}
      </div>

      {/* Table */}
      <div className="overflow-x-auto rounded-xl border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <th className="p-3">Ticket</th>
              {canManage ? <th className="p-3">Employee</th> : null}
              <th className="p-3">Subject</th>
              <th className="p-3">Priority</th>
              <th className="p-3">Status</th>
              <th className="p-3">SLA</th>
              {canManage ? <th className="p-3">Assignee</th> : null}
              <th className="p-3">Updated</th>
            </tr>
          </thead>
          <tbody>
            {tickets.map((t) => (
              <tr
                key={t.id}
                onClick={() => setActiveTicket(t.id)}
                className="cursor-pointer border-b transition-colors last:border-0 hover:bg-muted/40"
              >
                <td className="p-3 font-mono text-xs">{t.ticket_id}</td>
                {canManage ? <td className="p-3">{t.employee_name || "—"}</td> : null}
                <td className="max-w-xs p-3">
                  <span className="line-clamp-1 font-medium">{t.subject}</span>
                  <span className="text-xs text-muted-foreground">{t.support_category}</span>
                </td>
                <td className="p-3">{priorityBadge(t.priority)}</td>
                <td className="p-3">{statusBadge(t.status)}</td>
                <td className="p-3">{slaBadge(t.sla_state) || <span className="text-xs text-muted-foreground">—</span>}</td>
                {canManage ? <td className="p-3 text-muted-foreground">{t.assigned_to_name || "Unassigned"}</td> : null}
                <td className="p-3 text-xs text-muted-foreground">{fmt(t.updated_at || t.created_at)}</td>
              </tr>
            ))}
            {tickets.length === 0 ? (
              <tr>
                <td colSpan={canManage ? 8 : 6} className="p-8 text-center text-sm text-muted-foreground">
                  No tickets found.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {data && data.total > data.pageSize ? (
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">
            Page {data.page} of {totalPages} · {data.total} tickets
          </span>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>Previous</Button>
            <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>Next</Button>
          </div>
        </div>
      ) : null}

      <SupportNewTicket open={newOpen} onOpenChange={setNewOpen} onCreated={() => mutate()} />
      <SupportTicketDetail
        ticketId={activeTicket}
        open={activeTicket !== null}
        onOpenChange={(v) => { if (!v) setActiveTicket(null) }}
        onChanged={() => mutate()}
      />
    </main>
  )
}
