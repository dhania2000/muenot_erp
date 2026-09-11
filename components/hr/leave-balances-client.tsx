"use client"

import { useState } from "react"
import useSWR from "swr"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Search, Plus, CalendarPlus, RefreshCw, ArrowUpDown } from "lucide-react"
import { fetcher } from "@/lib/fetcher"
import { ExcelExportButton } from "@/components/excel-export-button"
import { ImportButton } from "@/components/import-button"
import { LeaveBalanceAdjustDialog } from "./leave-balance-adjust-dialog"
import { LeaveBalanceDetailDialog, type BalanceKey } from "./leave-balance-detail-dialog"

const STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  Healthy: "default",
  "Low Balance": "secondary",
  "Zero Balance": "outline",
  Negative: "destructive",
}

const currentYear = new Date().getFullYear()

function n(v: any) {
  return Number(v || 0)
}

export function LeaveBalancesClient() {
  const [year, setYear] = useState(String(currentYear))
  const [q, setQ] = useState("")
  const [department, setDepartment] = useState("all")
  const [leaveType, setLeaveType] = useState("all")
  const [status, setStatus] = useState("all")
  const [sort, setSort] = useState("employee")
  const [dir, setDir] = useState<"asc" | "desc">("asc")

  const [adjustOpen, setAdjustOpen] = useState(false)
  const [adjustPreset, setAdjustPreset] = useState<any>(null)
  const [detailKey, setDetailKey] = useState<BalanceKey>(null)
  const [busyAction, setBusyAction] = useState<string | null>(null)

  const params = new URLSearchParams()
  params.set("year", year)
  if (q) params.set("q", q)
  if (department !== "all") params.set("department", department)
  if (leaveType !== "all") params.set("leave_type", leaveType)
  if (status !== "all") params.set("status", status)
  params.set("sort", sort)
  params.set("dir", dir)

  const { data, mutate, isLoading } = useSWR<any>(`/api/hr/leave-balances?${params.toString()}`, fetcher)
  const { data: typesData } = useSWR<any>("/api/hr/leave-types", fetcher)

  const balances = data?.balances || []
  const summary = data?.summary || { employees: 0, totalAvailable: 0, totalUsed: 0, totalPending: 0, lowBalance: 0, zeroBalance: 0 }
  const canManage = data?.canManage
  const years: number[] = data?.years?.length ? data.years : [currentYear]
  const departments: string[] = data?.departments || []

  const cards = [
    { label: "Employees", value: summary.employees, tone: "text-foreground" },
    { label: "Available", value: summary.totalAvailable, tone: "text-emerald-600" },
    { label: "Used", value: summary.totalUsed, tone: "text-foreground" },
    { label: "Pending", value: summary.totalPending, tone: "text-amber-600" },
    { label: "Low balance", value: summary.lowBalance, tone: "text-amber-600" },
    { label: "Zero balance", value: summary.zeroBalance, tone: "text-destructive" },
  ]

  function toggleSort(key: string) {
    if (sort === key) setDir((d) => (d === "asc" ? "desc" : "asc"))
    else {
      setSort(key)
      setDir("asc")
    }
  }

  async function runAction(path: string, label: string) {
    setBusyAction(path)
    try {
      const res = await fetch(`/api/hr/leave-balances/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ year: Number(year) }),
      })
      const json = await res.json()
      if (!res.ok) {
        toast.error(json.error || `${label} failed.`)
        return
      }
      const s = json.summary
      if (path === "initialize") {
        toast.success(`${label}: ${s.created} balance(s) created, ${s.skipped} already existed.`)
      } else {
        toast.success(`${label}: ${s.entries} accrual entr(ies) credited (${s.credited} day(s)).`)
      }
      mutate()
    } finally {
      setBusyAction(null)
    }
  }

  return (
    <main className="space-y-6 p-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-sm text-muted-foreground">Human Resources</p>
          <h1 className="text-3xl font-semibold tracking-tight">Leave Balances</h1>
          <p className="text-muted-foreground">
            Live entitlement position for each employee, backed by traceable quota-history transactions.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {canManage && (
            <>
              <Button
                variant="outline"
                onClick={() => runAction("initialize", "Initialize year")}
                disabled={busyAction === "initialize"}
              >
                <CalendarPlus className="mr-2 h-4 w-4" />
                {busyAction === "initialize" ? "Initializing…" : `Initialize ${year}`}
              </Button>
              <Button
                variant="outline"
                onClick={() => runAction("accrual", "Run accrual")}
                disabled={busyAction === "accrual"}
              >
                <RefreshCw className="mr-2 h-4 w-4" />
                {busyAction === "accrual" ? "Accruing…" : "Run accrual"}
              </Button>
              <ImportButton moduleKey="hr-leave-balances" onImported={mutate} />
            </>
          )}
          <ExcelExportButton
            rows={balances}
            filename={`leave-balances-${year}`}
            columns={[
              { header: "Employee", value: (r: any) => r.employee_name },
              { header: "Employee ID", value: (r: any) => r.employee_code },
              { header: "Department", value: (r: any) => r.department || "" },
              { header: "Leave Type", value: (r: any) => r.leave_type },
              { header: "Year", value: (r: any) => r.year },
              { header: "Opening", value: (r: any) => n(r.opening) },
              { header: "Accrued", value: (r: any) => n(r.accrued) },
              { header: "Carry Forward", value: (r: any) => n(r.carry_forward) },
              { header: "Adjusted", value: (r: any) => n(r.adjusted) },
              { header: "Used", value: (r: any) => n(r.used) },
              { header: "Pending", value: (r: any) => n(r.pending) },
              { header: "Expired", value: (r: any) => n(r.expired) },
              { header: "Available", value: (r: any) => n(r.available) },
              { header: "Status", value: (r: any) => r.status },
              { header: "Last Updated", value: (r: any) => String(r.last_updated || "").slice(0, 16).replace("T", " ") },
            ]}
          />
          {canManage && (
            <Button onClick={() => { setAdjustPreset(null); setAdjustOpen(true) }}>
              <Plus className="mr-2 h-4 w-4" />
              Adjust balance
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
        <Select value={year} onValueChange={setYear}>
          <SelectTrigger className="w-28" aria-label="Leave year">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {years.map((y) => (
              <SelectItem key={y} value={String(y)}>{y}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <div className="relative min-w-56 flex-1">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search employee, ID, leave type…"
            className="pl-8"
          />
        </div>

        {canManage && (
          <Select value={department} onValueChange={setDepartment}>
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
        )}

        <Select value={leaveType} onValueChange={setLeaveType}>
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

        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="w-40">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="Healthy">Healthy</SelectItem>
            <SelectItem value="Low Balance">Low balance</SelectItem>
            <SelectItem value="Zero Balance">Zero balance</SelectItem>
            <SelectItem value="Negative">Negative</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="overflow-x-auto rounded-xl border">
        <Table>
          <TableHeader>
            <TableRow>
              <SortHead label="Employee" col="employee" sort={sort} dir={dir} onSort={toggleSort} />
              <SortHead label="Leave Type" col="leave_type" sort={sort} dir={dir} onSort={toggleSort} />
              <SortHead label="Year" col="year" sort={sort} dir={dir} onSort={toggleSort} />
              <TableHead className="text-right">Opening</TableHead>
              <TableHead className="text-right">Accrued</TableHead>
              <TableHead className="text-right">Carry Fwd</TableHead>
              <SortHead label="Used" col="used" dir={dir} sort={sort} onSort={toggleSort} align="right" />
              <SortHead label="Pending" col="pending" dir={dir} sort={sort} onSort={toggleSort} align="right" />
              <TableHead className="text-right">Adjusted</TableHead>
              <SortHead label="Available" col="available" dir={dir} sort={sort} onSort={toggleSort} align="right" />
              <TableHead>Status</TableHead>
              <SortHead label="Last Updated" col="last_updated" dir={dir} sort={sort} onSort={toggleSort} />
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={12} className="py-10 text-center text-muted-foreground">Loading…</TableCell>
              </TableRow>
            ) : balances.length === 0 ? (
              <TableRow>
                <TableCell colSpan={12} className="py-10 text-center text-muted-foreground">
                  No leave balances for {year}. {canManage ? `Use “Initialize ${year}” to create them.` : ""}
                </TableCell>
              </TableRow>
            ) : (
              balances.map((r: any) => (
                <TableRow
                  key={r.balance_id}
                  className="cursor-pointer"
                  onClick={() =>
                    setDetailKey({ employee_id: r.employee_id, leave_type_id: r.leave_type_id, year: Number(r.year) })
                  }
                >
                  <TableCell>
                    <div className="font-medium">{r.employee_name}</div>
                    <div className="text-xs text-muted-foreground">{r.employee_code}{r.department ? ` · ${r.department}` : ""}</div>
                  </TableCell>
                  <TableCell>{r.leave_type}</TableCell>
                  <TableCell>{r.year}</TableCell>
                  <TableCell className="text-right">{n(r.opening)}</TableCell>
                  <TableCell className="text-right">{n(r.accrued)}</TableCell>
                  <TableCell className="text-right">{n(r.carry_forward)}</TableCell>
                  <TableCell className="text-right">{n(r.used)}</TableCell>
                  <TableCell className="text-right">{n(r.pending)}</TableCell>
                  <TableCell className="text-right">{n(r.adjusted)}</TableCell>
                  <TableCell className="text-right font-semibold">{n(r.available)}</TableCell>
                  <TableCell>
                    <Badge variant={STATUS_VARIANT[r.status] || "outline"}>{r.status}</Badge>
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                    {String(r.last_updated || "").slice(0, 16).replace("T", " ")}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <LeaveBalanceAdjustDialog
        open={adjustOpen}
        onOpenChange={setAdjustOpen}
        onApplied={mutate}
        preset={adjustPreset}
      />
      <LeaveBalanceDetailDialog
        balanceKey={detailKey}
        canManage={Boolean(canManage)}
        onClose={() => setDetailKey(null)}
        onChanged={mutate}
        onAdjust={(preset) => {
          setDetailKey(null)
          setAdjustPreset(preset)
          setAdjustOpen(true)
        }}
      />
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
