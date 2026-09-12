"use client"

import { useMemo, useState } from "react"
import useSWR from "swr"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { fetcher } from "@/lib/fetcher"
import { statusBadgeVariant, formatWindow, shiftTimeLabel, SHIFT_CHANGE_STATUSES } from "./shift-change-status"
import { ShiftChangeRequestDialog } from "./shift-change-request-dialog"
import { ShiftChangeDetailDialog } from "./shift-change-detail-dialog"
import { ArrowRight, Download, Plus, Search } from "lucide-react"

type Summary = {
  total: number
  pending: number
  approved: number
  rejected: number
  cancelled: number
  withdrawn: number
  upcoming: number
}

export function ShiftChangeRequestsClient() {
  const [q, setQ] = useState("")
  const [status, setStatus] = useState("all")
  const [changeType, setChangeType] = useState("all")
  const [requestedShift, setRequestedShift] = useState("all")
  const [department, setDepartment] = useState("all")
  const [scope, setScope] = useState<"all" | "mine">("all")
  const [view, setView] = useState<"all" | "upcoming">("all")
  const [from, setFrom] = useState("")
  const [to, setTo] = useState("")
  const [page, setPage] = useState(1)
  const [createOpen, setCreateOpen] = useState(false)
  const [detailId, setDetailId] = useState<string | null>(null)

  const params = new URLSearchParams()
  if (q) params.set("q", q)
  if (status !== "all") params.set("status", status)
  if (changeType !== "all") params.set("change_type", changeType)
  if (requestedShift !== "all") params.set("requested_shift_id", requestedShift)
  if (department !== "all") params.set("department", department)
  if (scope === "mine") params.set("scope", "mine")
  if (view === "upcoming") params.set("view", "upcoming")
  if (from) params.set("from", from)
  if (to) params.set("to", to)
  params.set("page", String(page))

  const { data, mutate, isLoading } = useSWR<any>(`/api/hr/shift-change-requests?${params.toString()}`, fetcher)
  // Context supplies the active shift list and employee directory for filters.
  const { data: ctx } = useSWR<any>("/api/hr/shift-change-requests/context", fetcher)

  const requests = data?.requests || []
  const summary: Summary = data?.summary || {
    total: 0,
    pending: 0,
    approved: 0,
    rejected: 0,
    cancelled: 0,
    withdrawn: 0,
    upcoming: 0,
  }
  const canManage = data?.canManage
  const total = data?.total || 0
  const pageSize = data?.pageSize || 25
  const totalPages = Math.max(1, Math.ceil(total / pageSize))

  const shifts = ctx?.shifts || []
  const departments = useMemo(() => {
    const set = new Set<string>()
    for (const e of ctx?.employees || []) if (e.department) set.add(e.department)
    return Array.from(set).sort()
  }, [ctx])

  const cards = [
    { label: "Total", value: summary.total, tone: "text-foreground" },
    { label: "Pending", value: summary.pending, tone: "text-amber-600" },
    { label: "Approved", value: summary.approved, tone: "text-emerald-600" },
    { label: "Rejected", value: summary.rejected, tone: "text-destructive" },
    { label: "Upcoming", value: summary.upcoming, tone: "text-blue-600" },
  ]

  return (
    <main className="space-y-6 p-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-sm text-muted-foreground">Human Resources</p>
          <h1 className="text-3xl font-semibold tracking-tight">Shift Change Requests</h1>
          <p className="text-muted-foreground">
            Request, review, and track shift changes with live conflict and rotation checks.
          </p>
        </div>
        <div className="flex gap-2">
          <a
            href={`/api/hr/shift-change-requests/export?${params.toString()}`}
            className="inline-flex h-9 items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground"
          >
            <Download className="mr-2 h-4 w-4" />
            Export CSV
          </a>
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="mr-2 h-4 w-4" />
            New request
          </Button>
        </div>
      </header>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {cards.map((c) => (
          <div key={c.label} className="rounded-xl border bg-card p-4">
            <p className="text-xs font-medium uppercase text-muted-foreground">{c.label}</p>
            <p className={`mt-1 text-2xl font-semibold ${c.tone}`}>{c.value}</p>
          </div>
        ))}
      </div>

      <Tabs value={view} onValueChange={(v) => { setView(v as "all" | "upcoming"); setPage(1) }}>
        <TabsList>
          <TabsTrigger value="all">All requests</TabsTrigger>
          <TabsTrigger value="upcoming">Upcoming changes</TabsTrigger>
        </TabsList>
      </Tabs>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-56 flex-1">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            value={q}
            onChange={(e) => { setQ(e.target.value); setPage(1) }}
            placeholder="Search request, employee, shift…"
            className="pl-8"
          />
        </div>
        <Select value={status} onValueChange={(v) => { setStatus(v ?? "all"); setPage(1) }}>
          <SelectTrigger className="w-40">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            {SHIFT_CHANGE_STATUSES.map((s) => (
              <SelectItem key={s} value={s}>{s}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={changeType} onValueChange={(v) => { setChangeType(v ?? "all"); setPage(1) }}>
          <SelectTrigger className="w-36">
            <SelectValue placeholder="Type" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All types</SelectItem>
            <SelectItem value="Permanent">Permanent</SelectItem>
            <SelectItem value="Temporary">Temporary</SelectItem>
          </SelectContent>
        </Select>
        <Select value={requestedShift} onValueChange={(v) => { setRequestedShift(v ?? "all"); setPage(1) }}>
          <SelectTrigger className="w-44">
            <SelectValue placeholder="Requested shift" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All shifts</SelectItem>
            {shifts.map((s: any) => (
              <SelectItem key={s.id} value={String(s.id)}>{s.shift_name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        {canManage && (
          <>
            <Select value={department} onValueChange={(v) => { setDepartment(v ?? "all"); setPage(1) }}>
              <SelectTrigger className="w-44">
                <SelectValue placeholder="Department" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All departments</SelectItem>
                {departments.map((d) => (
                  <SelectItem key={d} value={d}>{d}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={scope} onValueChange={(v) => { setScope((v as "all" | "mine") ?? "all"); setPage(1) }}>
              <SelectTrigger className="w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Everyone</SelectItem>
                <SelectItem value="mine">My requests</SelectItem>
              </SelectContent>
            </Select>
          </>
        )}
        <Input type="date" value={from} onChange={(e) => { setFrom(e.target.value); setPage(1) }} className="w-40" aria-label="Effective from" />
        <Input type="date" value={to} onChange={(e) => { setTo(e.target.value); setPage(1) }} className="w-40" aria-label="Effective to" />
      </div>

      <div className="overflow-hidden rounded-xl border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Request</TableHead>
              <TableHead>Employee</TableHead>
              <TableHead>Change</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Window</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={6} className="py-10 text-center text-muted-foreground">Loading…</TableCell>
              </TableRow>
            ) : requests.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="py-10 text-center text-muted-foreground">
                  No shift change requests found.
                </TableCell>
              </TableRow>
            ) : (
              requests.map((r: any) => (
                <TableRow key={r.request_id} className="cursor-pointer" onClick={() => setDetailId(r.request_id)}>
                  <TableCell className="font-mono text-xs">{r.request_id}</TableCell>
                  <TableCell>
                    <div className="font-medium">{r.employee_name}</div>
                    {r.department && <div className="text-xs text-muted-foreground">{r.department}</div>}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1.5 whitespace-nowrap text-sm">
                      <span className="text-muted-foreground">{r.current_shift_name || "—"}</span>
                      <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" />
                      <span className="font-medium">{r.requested_shift_name || "—"}</span>
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {shiftTimeLabel(r.requested_start, r.requested_end)}
                    </div>
                  </TableCell>
                  <TableCell>{r.change_type}</TableCell>
                  <TableCell className="whitespace-nowrap text-sm">
                    {formatWindow(r.change_type, r.from_date, r.to_date)}
                  </TableCell>
                  <TableCell>
                    <Badge variant={statusBadgeVariant(r.status)}>{r.status}</Badge>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">
            Page {page} of {totalPages} · {total} requests
          </p>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
              Previous
            </Button>
            <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
              Next
            </Button>
          </div>
        </div>
      )}

      <ShiftChangeRequestDialog open={createOpen} onOpenChange={setCreateOpen} onCreated={mutate} />
      <ShiftChangeDetailDialog requestId={detailId} onClose={() => setDetailId(null)} onChanged={mutate} />
    </main>
  )
}
