"use client"

import { useState } from "react"
import useSWR from "swr"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Search, Plus, ArrowUpDown, ChevronLeft, ChevronRight } from "lucide-react"
import { fetcher } from "@/lib/fetcher"
import { ExcelExportButton } from "@/components/excel-export-button"
import { ImportButton } from "@/components/import-button"
import { LeaveQuotaAdjustDialog } from "./leave-quota-adjust-dialog"
import { LeaveQuotaDetailDialog } from "./leave-quota-detail-dialog"
import { EVENT_META, EVENT_FILTERS, formatDays, formatDateTime } from "./leave-quota-format"

const currentYear = new Date().getFullYear()

export function LeaveQuotaHistoryClient() {
  const [year, setYear] = useState(String(currentYear))
  const [q, setQ] = useState("")
  const [employee, setEmployee] = useState("all")
  const [department, setDepartment] = useState("all")
  const [leaveType, setLeaveType] = useState("all")
  const [event, setEvent] = useState("all")
  const [from, setFrom] = useState("")
  const [to, setTo] = useState("")
  const [sort, setSort] = useState("created_at")
  const [dir, setDir] = useState<"asc" | "desc">("desc")
  const [page, setPage] = useState(1)

  const [adjustOpen, setAdjustOpen] = useState(false)
  const [detailRef, setDetailRef] = useState<string | null>(null)

  const params = new URLSearchParams()
  params.set("year", year)
  if (q) params.set("q", q)
  if (employee !== "all") params.set("employee", employee)
  if (department !== "all") params.set("department", department)
  if (leaveType !== "all") params.set("leave_type", leaveType)
  if (event !== "all") params.set("event", event)
  if (from) params.set("from", from)
  if (to) params.set("to", to)
  params.set("sort", sort)
  params.set("dir", dir)
  params.set("page", String(page))

  const { data, mutate, isLoading } = useSWR<any>(`/api/hr/leave-quota-history?${params.toString()}`, fetcher)
  const { data: ctx } = useSWR<any>("/api/hr/leave-quota-history/context", fetcher)

  const events: any[] = data?.events || []
  const canManage = Boolean(data?.canManage)
  const summary = data?.summary || { transactions: 0, leaveUsed: 0, accrued: 0, adjustments: 0, carryForward: 0, reversals: 0 }
  const total = Number(data?.total || 0)
  const pageSize = Number(data?.pageSize || 25)
  const years: number[] = data?.years?.length ? data.years : [currentYear]
  const departments: string[] = data?.departments || []
  const employees: any[] = ctx?.employees || []
  const leaveTypes: any[] = ctx?.leaveTypes || []
  const totalPages = Math.max(1, Math.ceil(total / pageSize))

  const cards = [
    { label: "Transactions", value: summary.transactions, tone: "text-foreground" },
    { label: "Leave used", value: summary.leaveUsed, tone: "text-orange-600" },
    { label: "Accrued", value: summary.accrued, tone: "text-emerald-600" },
    { label: "Adjustments", value: formatDays(summary.adjustments), tone: "text-violet-600" },
    { label: "Carry forward", value: summary.carryForward, tone: "text-teal-600" },
    { label: "Reversals", value: summary.reversals, tone: "text-fuchsia-600" },
  ]

  function toggleSort(key: string) {
    setPage(1)
    if (sort === key) setDir((d) => (d === "asc" ? "desc" : "asc"))
    else {
      setSort(key)
      setDir(key === "created_at" ? "desc" : "asc")
    }
  }

  // Reset to first page whenever a filter changes.
  function onFilter<T>(setter: (v: T) => void) {
    return (v: T) => {
      setPage(1)
      setter(v)
    }
  }

  return (
    <main className="space-y-6 p-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-sm text-muted-foreground">Human Resources</p>
          <h1 className="text-3xl font-semibold tracking-tight">Leave Quota History</h1>
          <p className="text-muted-foreground">
            The immutable transaction ledger behind every leave balance — each movement traced to its source.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {canManage && <ImportButton moduleKey="hr-leave-quota-history" onImported={mutate} />}
          <ExcelExportButton
            rows={events}
            filename={`leave-quota-history-${year}`}
            columns={[
              { header: "Quota Event ID", value: (r: any) => r.quota_event_id },
              { header: "Employee", value: (r: any) => r.employee_name },
              { header: "Employee ID", value: (r: any) => r.employee_code },
              { header: "Department", value: (r: any) => r.department || "" },
              { header: "Leave Type", value: (r: any) => r.leave_type || "" },
              { header: "Year", value: (r: any) => r.year },
              { header: "Event", value: (r: any) => EVENT_META[r.event_type]?.label || r.event_type },
              { header: "Days", value: (r: any) => formatDays(r.days) },
              { header: "Reference", value: (r: any) => r.reference || "" },
              { header: "Source", value: (r: any) => r.source || "" },
              { header: "Reason", value: (r: any) => r.reason || "" },
              { header: "Created By", value: (r: any) => r.created_by_name || "System" },
              { header: "Created At", value: (r: any) => formatDateTime(r.created_at) },
            ]}
          />
          {canManage && (
            <Button onClick={() => setAdjustOpen(true)}>
              <Plus className="mr-2 h-4 w-4" />
              New adjustment
            </Button>
          )}
        </div>
      </header>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {cards.map((c) => (
          <div key={c.label} className="rounded-xl border bg-card p-4">
            <p className="text-xs font-medium uppercase text-muted-foreground">{c.label}</p>
            <p className={`mt-1 text-2xl font-semibold ${c.tone}`}>{c.value}</p>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Select value={year} onValueChange={onFilter(setYear)}>
          <SelectTrigger className="w-28" aria-label="Leave year">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All years</SelectItem>
            {years.map((y) => (
              <SelectItem key={y} value={String(y)}>
                {y}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <div className="relative min-w-56 flex-1">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            value={q}
            onChange={(e) => {
              setPage(1)
              setQ(e.target.value)
            }}
            placeholder="Search event id, employee, reference…"
            className="pl-8"
          />
        </div>

        {canManage && (
          <Select value={employee} onValueChange={onFilter(setEmployee)}>
            <SelectTrigger className="w-48">
              <SelectValue placeholder="Employee" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All employees</SelectItem>
              {employees.map((e: any) => (
                <SelectItem key={e.id} value={String(e.id)}>
                  {e.employee_name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        {canManage && (
          <Select value={department} onValueChange={onFilter(setDepartment)}>
            <SelectTrigger className="w-40">
              <SelectValue placeholder="Department" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All departments</SelectItem>
              {departments.map((d) => (
                <SelectItem key={d} value={d}>
                  {d}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        <Select value={leaveType} onValueChange={onFilter(setLeaveType)}>
          <SelectTrigger className="w-44">
            <SelectValue placeholder="Leave type" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All types</SelectItem>
            {leaveTypes.map((t: any) => (
              <SelectItem key={t.leave_type_id} value={t.leave_type_id}>
                {t.leave_type}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={event} onValueChange={onFilter(setEvent)}>
          <SelectTrigger className="w-44">
            <SelectValue placeholder="Event" />
          </SelectTrigger>
          <SelectContent>
            {EVENT_FILTERS.map((f) => (
              <SelectItem key={f.value} value={f.value}>
                {f.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Input
          type="date"
          value={from}
          onChange={(e) => {
            setPage(1)
            setFrom(e.target.value)
          }}
          className="w-40"
          aria-label="From date"
        />
        <Input
          type="date"
          value={to}
          onChange={(e) => {
            setPage(1)
            setTo(e.target.value)
          }}
          className="w-40"
          aria-label="To date"
        />
      </div>

      <div className="overflow-x-auto rounded-xl border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Event ID</TableHead>
              <SortHead label="Employee" col="employee" sort={sort} dir={dir} onSort={toggleSort} />
              <SortHead label="Leave Type" col="leave_type" sort={sort} dir={dir} onSort={toggleSort} />
              <SortHead label="Year" col="year" sort={sort} dir={dir} onSort={toggleSort} />
              <SortHead label="Event" col="event_type" sort={sort} dir={dir} onSort={toggleSort} />
              <SortHead label="Days" col="days" sort={sort} dir={dir} onSort={toggleSort} align="right" />
              <TableHead>Reference</TableHead>
              <TableHead>Source</TableHead>
              <TableHead>Created By</TableHead>
              <SortHead label="Created At" col="created_at" sort={sort} dir={dir} onSort={toggleSort} />
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={10} className="py-10 text-center text-muted-foreground">
                  Loading…
                </TableCell>
              </TableRow>
            ) : events.length === 0 ? (
              <TableRow>
                <TableCell colSpan={10} className="py-10 text-center text-muted-foreground">
                  No ledger events match the current filters.
                </TableCell>
              </TableRow>
            ) : (
              events.map((r) => {
                const meta = EVENT_META[r.event_type]
                const negative = Number(r.days) < 0
                return (
                  <TableRow
                    key={r.event_id}
                    className="cursor-pointer"
                    onClick={() => setDetailRef(r.quota_event_id || String(r.event_id))}
                  >
                    <TableCell className="font-mono text-xs">
                      {r.quota_event_id}
                      {r.reversed_by && (
                        <Badge variant="outline" className="ml-1 border-amber-500/40 text-amber-600">
                          reversed
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="font-medium">{r.employee_name}</div>
                      <div className="text-xs text-muted-foreground">
                        {r.employee_code}
                        {r.department ? ` · ${r.department}` : ""}
                      </div>
                    </TableCell>
                    <TableCell>{r.leave_type || "—"}</TableCell>
                    <TableCell>{r.year}</TableCell>
                    <TableCell>
                      {meta ? (
                        <Badge variant="outline" className={meta.className}>
                          {meta.label}
                        </Badge>
                      ) : (
                        r.event_type
                      )}
                    </TableCell>
                    <TableCell className={`text-right font-semibold ${negative ? "text-destructive" : "text-emerald-600"}`}>
                      {formatDays(r.days)}
                    </TableCell>
                    <TableCell className="font-mono text-xs">{r.reference || "—"}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{r.source || "System"}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{r.created_by_name || "System"}</TableCell>
                    <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                      {formatDateTime(r.created_at)}
                    </TableCell>
                  </TableRow>
                )
              })
            )}
          </TableBody>
        </Table>
      </div>

      <div className="flex items-center justify-between text-sm text-muted-foreground">
        <span>
          {total === 0 ? "0" : `${(page - 1) * pageSize + 1}–${Math.min(page * pageSize, total)}`} of {total}
        </span>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1}>
            <ChevronLeft className="h-4 w-4" />
            Prev
          </Button>
          <span>
            Page {page} / {totalPages}
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            disabled={page >= totalPages}
          >
            Next
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <LeaveQuotaAdjustDialog open={adjustOpen} onOpenChange={setAdjustOpen} onApplied={mutate} preset={null} />
      <LeaveQuotaDetailDialog eventRef={detailRef} onClose={() => setDetailRef(null)} onChanged={mutate} />
    </main>
  )
}

function SortHead({
  label,
  col,
  sort,
  dir,
  onSort,
  align = "left",
}: {
  label: string
  col: string
  sort: string
  dir: "asc" | "desc"
  onSort: (col: string) => void
  align?: "left" | "right"
}) {
  const active = sort === col
  return (
    <TableHead className={align === "right" ? "text-right" : undefined}>
      <button
        type="button"
        onClick={() => onSort(col)}
        className={`inline-flex items-center gap-1 hover:text-foreground ${active ? "text-foreground" : ""} ${
          align === "right" ? "flex-row-reverse" : ""
        }`}
      >
        {label}
        <ArrowUpDown className={`h-3 w-3 ${active ? "opacity-100" : "opacity-40"}`} />
        {active && <span className="sr-only">{dir === "asc" ? "ascending" : "descending"}</span>}
      </button>
    </TableHead>
  )
}
