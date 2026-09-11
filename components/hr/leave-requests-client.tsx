"use client"

import { useMemo, useState } from "react"
import useSWR from "swr"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { fetcher } from "@/lib/fetcher"
import { statusBadgeVariant, LEAVE_STATUSES } from "./leave-status"
import { LeaveApplyDialog } from "./leave-apply-dialog"
import { LeaveDetailDialog } from "./leave-detail-dialog"
import { LeaveCalendar } from "./leave-calendar"
import { Plus, Download, Search, CalendarDays, ListChecks } from "lucide-react"

type Summary = {
  total: number
  pending: number
  managerApproved: number
  approved: number
  rejected: number
  cancelled: number
  awaitingMyAction: number
}

export function LeaveRequestsClient() {
  const [q, setQ] = useState("")
  const [status, setStatus] = useState("all")
  const [leaveType, setLeaveType] = useState("all")
  const [scope, setScope] = useState<"all" | "mine">("all")
  const [from, setFrom] = useState("")
  const [to, setTo] = useState("")
  const [page, setPage] = useState(1)
  const [applyOpen, setApplyOpen] = useState(false)
  const [detailId, setDetailId] = useState<string | null>(null)

  const params = new URLSearchParams()
  if (q) params.set("q", q)
  if (status !== "all") params.set("status", status)
  if (leaveType !== "all") params.set("leave_type", leaveType)
  if (scope === "mine") params.set("scope", "mine")
  if (from) params.set("from", from)
  if (to) params.set("to", to)
  params.set("page", String(page))

  const { data, mutate, isLoading } = useSWR<any>(`/api/hr/leave-requests?${params.toString()}`, fetcher)
  const { data: typesData } = useSWR<any>("/api/hr/leave-types", fetcher)

  const requests = data?.requests || []
  const summary: Summary = data?.summary || { total: 0, pending: 0, managerApproved: 0, approved: 0, rejected: 0, cancelled: 0, awaitingMyAction: 0 }
  const canManage = data?.canManage
  const total = data?.total || 0
  const pageSize = data?.pageSize || 25
  const totalPages = Math.max(1, Math.ceil(total / pageSize))

  const cards = useMemo(() => {
    const base = [
      { label: "Total", value: summary.total, tone: "text-foreground" },
      { label: "Pending", value: summary.pending, tone: "text-amber-600" },
      { label: "Approved", value: summary.approved, tone: "text-emerald-600" },
      { label: "Rejected", value: summary.rejected, tone: "text-destructive" },
    ]
    if (canManage) base.splice(1, 0, { label: "Awaiting my action", value: summary.awaitingMyAction, tone: "text-blue-600" })
    return base
  }, [summary, canManage])

  return (
    <main className="space-y-6 p-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-sm text-muted-foreground">Human Resources</p>
          <h1 className="text-3xl font-semibold tracking-tight">Leave Requests</h1>
          <p className="text-muted-foreground">Apply, review, and track leave with live balance and policy checks.</p>
        </div>
        <div className="flex gap-2">
          <a
            href={`/api/hr/leave-requests/export?${params.toString()}`}
            className="inline-flex h-9 items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground"
          >
            <Download className="mr-2 h-4 w-4" />
            Export CSV
          </a>
          <Button onClick={() => setApplyOpen(true)}>
            <Plus className="mr-2 h-4 w-4" />
            Apply for leave
          </Button>
        </div>
      </header>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-5">
        {cards.map((c) => (
          <div key={c.label} className="rounded-xl border bg-card p-4">
            <p className="text-xs font-medium uppercase text-muted-foreground">{c.label}</p>
            <p className={`mt-1 text-2xl font-semibold ${c.tone}`}>{c.value}</p>
          </div>
        ))}
      </div>

      <Tabs defaultValue="list">
        <TabsList>
          <TabsTrigger value="list">
            <ListChecks className="mr-2 h-4 w-4" />
            Requests
          </TabsTrigger>
          <TabsTrigger value="calendar">
            <CalendarDays className="mr-2 h-4 w-4" />
            Calendar
          </TabsTrigger>
        </TabsList>

        <TabsContent value="list" className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-56 flex-1">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                value={q}
                onChange={(e) => { setQ(e.target.value); setPage(1) }}
                placeholder="Search employee, ID, reason…"
                className="pl-8"
              />
            </div>
            <Select value={status} onValueChange={(v) => { setStatus(v ?? "all"); setPage(1) }}>
              <SelectTrigger className="w-44">
                <SelectValue placeholder="Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                {LEAVE_STATUSES.map((s) => (
                  <SelectItem key={s} value={s}>{s}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={leaveType} onValueChange={(v) => { setLeaveType(v ?? "all"); setPage(1) }}>
              <SelectTrigger className="w-44">
                <SelectValue placeholder="Leave type" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All types</SelectItem>
                {(typesData?.leaveTypes || []).map((t: any) => (
                  <SelectItem key={t.leave_type_id} value={t.leave_type_id}>{t.leave_type}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            {canManage && (
              <Select value={scope} onValueChange={(v) => { setScope(v as "all" | "mine"); setPage(1) }}>
                <SelectTrigger className="w-36">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Everyone</SelectItem>
                  <SelectItem value="mine">My leave</SelectItem>
                </SelectContent>
              </Select>
            )}
            <Input type="date" value={from} onChange={(e) => { setFrom(e.target.value); setPage(1) }} className="w-40" aria-label="From date" />
            <Input type="date" value={to} onChange={(e) => { setTo(e.target.value); setPage(1) }} className="w-40" aria-label="To date" />
          </div>

          <div className="overflow-hidden rounded-xl border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Request</TableHead>
                  <TableHead>Employee</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Dates</TableHead>
                  <TableHead className="text-right">Days</TableHead>
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
                    <TableCell colSpan={6} className="py-10 text-center text-muted-foreground">No leave requests found.</TableCell>
                  </TableRow>
                ) : (
                  requests.map((r: any) => (
                    <TableRow key={r.request_id} className="cursor-pointer" onClick={() => setDetailId(r.request_id)}>
                      <TableCell className="font-mono text-xs">{r.request_id}</TableCell>
                      <TableCell>
                        <div className="font-medium">{r.employee_name}</div>
                        {r.department && <div className="text-xs text-muted-foreground">{r.department}</div>}
                      </TableCell>
                      <TableCell>{r.leave_type || r.leave_type_id}</TableCell>
                      <TableCell className="whitespace-nowrap text-sm">
                        {String(r.from_date).slice(0, 10)}
                        {r.from_date !== r.to_date && <> → {String(r.to_date).slice(0, 10)}</>}
                      </TableCell>
                      <TableCell className="text-right">
                        {r.days}
                        {Number(r.lop_days) > 0 && <span className="ml-1 text-xs text-amber-600">({r.lop_days} LOP)</span>}
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
        </TabsContent>

        <TabsContent value="calendar">
          <LeaveCalendar onSelectRequest={setDetailId} />
        </TabsContent>
      </Tabs>

      <LeaveApplyDialog open={applyOpen} onOpenChange={setApplyOpen} onCreated={mutate} />
      <LeaveDetailDialog requestId={detailId} onClose={() => setDetailId(null)} onChanged={mutate} />
    </main>
  )
}
