"use client"

import { useMemo, useState } from "react"
import useSWR from "swr"
import { toast } from "sonner"
import { fetcher } from "@/lib/fetcher"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ExcelExportButton } from "@/components/excel-export-button"
import { ImportButton } from "@/components/import-button"
import { AttendanceSummaryCards, type AttendanceSummary } from "@/components/hr/attendance-summary"
import { AttendanceMonthly } from "@/components/hr/attendance-monthly"
import {
  ATTENDANCE_STATUSES,
  flagVariant,
  formatDate,
  formatHours,
  formatMinutes,
  formatTime,
  statusVariant,
} from "@/lib/attendance-ui"

const ALL = "__all__"

type AttendanceRow = {
  id: number
  attendance_id: string
  employee_id: number
  employee_code: string
  employee_name: string
  department: string | null
  designation: string | null
  work_date: string
  clock_in: string | null
  clock_out: string | null
  break_minutes: number
  working_hours: number
  status: string
  late_minutes: number
  early_leaving_minutes: number
  overtime_hours: number
  location: string | null
  source: string | null
  remarks: string | null
  regularisation_status: string | null
  is_manual_override: number | boolean
}

type AttendanceResponse = {
  attendance: AttendanceRow[]
  summary?: AttendanceSummary
  total?: number
  page?: number
  totalPages?: number
}

type EmployeeRow = {
  id: number
  employee_id: string
  employee_name: string
  department: string | null
  designation: string | null
  reporting_manager: string | null
}

type EmployeeResponse = {
  employees: EmployeeRow[]
  facets?: Record<string, string[]>
}

function todayISO() {
  return new Date().toISOString().slice(0, 10)
}

function rowFlags(row: AttendanceRow): string[] {
  const flags: string[] = []
  if (row.late_minutes > 0) flags.push("Late")
  if (row.early_leaving_minutes > 0) flags.push("Early Out")
  if (row.overtime_hours > 0) flags.push("Overtime")
  return flags
}

export function AttendanceClient() {
  const [tab, setTab] = useState("daily")

  // Filters
  const [from, setFrom] = useState("")
  const [to, setTo] = useState("")
  const [search, setSearch] = useState("")
  const [department, setDepartment] = useState("")
  const [status, setStatus] = useState("")
  const [exception, setException] = useState("")

  const query = useMemo(() => {
    const sp = new URLSearchParams()
    if (from) sp.set("from", from)
    if (to) sp.set("to", to)
    if (search) sp.set("search", search)
    if (department) sp.set("department", department)
    if (status) sp.set("status", status)
    if (exception) sp.set(exception, "1")
    return sp.toString()
  }, [from, to, search, department, status, exception])

  const { data, mutate, isLoading } = useSWR<AttendanceResponse>(
    `/api/hr/attendance${query ? `?${query}` : ""}`,
    fetcher,
  )
  const { data: employeeData } = useSWR<EmployeeResponse>("/api/hr/employees?facets=1", fetcher)

  const rows = data?.attendance ?? []
  const employees = employeeData?.employees ?? []
  const departments = employeeData?.facets?.department ?? []

  const hasFilters = Boolean(from || to || search || department || status || exception)

  return (
    <main className="space-y-6 p-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Attendance</h1>
          <p className="text-sm text-muted-foreground">
            Daily attendance, work hours, exceptions and regularisation — records are generated from clock events and
            master data.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ImportButton moduleKey="hr-attendance" onImported={() => mutate()} />
          <ExcelExportButton
            rows={rows}
            filename="attendance"
            columns={[
              { header: "Attendance ID", value: (r: AttendanceRow) => r.attendance_id },
              { header: "Employee ID", value: (r: AttendanceRow) => r.employee_code },
              { header: "Employee", value: (r: AttendanceRow) => r.employee_name },
              { header: "Department", value: (r: AttendanceRow) => r.department ?? "" },
              { header: "Work Date", value: (r: AttendanceRow) => r.work_date?.slice(0, 10) ?? "" },
              { header: "Clock In", value: (r: AttendanceRow) => formatTime(r.clock_in) },
              { header: "Clock Out", value: (r: AttendanceRow) => formatTime(r.clock_out) },
              { header: "Break (min)", value: (r: AttendanceRow) => r.break_minutes },
              { header: "Working Hours", value: (r: AttendanceRow) => formatHours(r.working_hours) },
              { header: "Status", value: (r: AttendanceRow) => r.status },
              { header: "Late (min)", value: (r: AttendanceRow) => r.late_minutes },
              { header: "Early Out (min)", value: (r: AttendanceRow) => r.early_leaving_minutes },
              { header: "Overtime (hrs)", value: (r: AttendanceRow) => r.overtime_hours },
              { header: "Location", value: (r: AttendanceRow) => r.location ?? "" },
              { header: "Source", value: (r: AttendanceRow) => r.source ?? "" },
              { header: "Regularisation", value: (r: AttendanceRow) => r.regularisation_status ?? "" },
              { header: "Remarks", value: (r: AttendanceRow) => r.remarks ?? "" },
            ]}
          />
          <ManualEntryDialog employees={employees} onSaved={() => mutate()} />
        </div>
      </header>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="daily">Daily</TabsTrigger>
          <TabsTrigger value="monthly">Monthly by employee</TabsTrigger>
        </TabsList>

        <TabsContent value="daily" className="space-y-6">
          <AttendanceSummaryCards summary={data?.summary} />

          <div className="flex flex-wrap items-end gap-3 rounded-lg border bg-card p-4">
            <div>
              <Label className="mb-1.5 block text-xs" htmlFor="filter-from">
                From
              </Label>
              <Input
                id="filter-from"
                type="date"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
                className="w-[160px]"
              />
            </div>
            <div>
              <Label className="mb-1.5 block text-xs" htmlFor="filter-to">
                To
              </Label>
              <Input
                id="filter-to"
                type="date"
                value={to}
                onChange={(e) => setTo(e.target.value)}
                className="w-[160px]"
              />
            </div>
            <div className="min-w-[200px] flex-1">
              <Label className="mb-1.5 block text-xs" htmlFor="filter-search">
                Search
              </Label>
              <Input
                id="filter-search"
                placeholder="Name, ID, location…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <div>
              <Label className="mb-1.5 block text-xs">Department</Label>
              <Select value={department || ALL} onValueChange={(v) => setDepartment(!v || v === ALL ? "" : v)}>
                <SelectTrigger className="w-[170px]">
                  <SelectValue placeholder="All departments" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>All departments</SelectItem>
                  {departments.map((d) => (
                    <SelectItem key={d} value={d}>
                      {d}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="mb-1.5 block text-xs">Status</Label>
              <Select value={status || ALL} onValueChange={(v) => setStatus(!v || v === ALL ? "" : v)}>
                <SelectTrigger className="w-[160px]">
                  <SelectValue placeholder="All statuses" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>All statuses</SelectItem>
                  {ATTENDANCE_STATUSES.map((s) => (
                    <SelectItem key={s} value={s}>
                      {s}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="mb-1.5 block text-xs">Exception</Label>
              <Select value={exception || ALL} onValueChange={(v) => setException(!v || v === ALL ? "" : v)}>
                <SelectTrigger className="w-[150px]">
                  <SelectValue placeholder="Any" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>Any</SelectItem>
                  <SelectItem value="late">Late</SelectItem>
                  <SelectItem value="early">Early Out</SelectItem>
                  <SelectItem value="overtime">Overtime</SelectItem>
                  <SelectItem value="missed">Missed Checkout</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {hasFilters && (
              <Button
                variant="ghost"
                onClick={() => {
                  setFrom("")
                  setTo("")
                  setSearch("")
                  setDepartment("")
                  setStatus("")
                  setException("")
                }}
              >
                Clear
              </Button>
            )}
          </div>

          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/30 text-left">
                  <th className="p-3 font-medium">Attendance ID</th>
                  <th className="p-3 font-medium">Employee</th>
                  <th className="p-3 font-medium">Work Date</th>
                  <th className="p-3 font-medium">In / Out</th>
                  <th className="p-3 font-medium">Hours</th>
                  <th className="p-3 font-medium">Status</th>
                  <th className="p-3 font-medium">Regularisation</th>
                  <th className="p-3 font-medium">Source</th>
                  <th className="p-3 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const flags = rowFlags(row)
                  return (
                    <tr key={row.id} className="border-b last:border-0 align-top hover:bg-muted/20">
                      <td className="p-3 font-mono text-xs">{row.attendance_id}</td>
                      <td className="p-3">
                        <div className="font-medium">{row.employee_name}</div>
                        <div className="text-xs text-muted-foreground">
                          {row.employee_code}
                          {row.department ? ` · ${row.department}` : ""}
                        </div>
                      </td>
                      <td className="p-3 whitespace-nowrap">{formatDate(row.work_date)}</td>
                      <td className="p-3 whitespace-nowrap tabular-nums text-muted-foreground">
                        {formatTime(row.clock_in)} / {formatTime(row.clock_out)}
                        {row.break_minutes > 0 && (
                          <div className="text-xs">Break {formatMinutes(row.break_minutes)}</div>
                        )}
                      </td>
                      <td className="p-3 whitespace-nowrap">{formatHours(row.working_hours)}</td>
                      <td className="p-3">
                        <div className="flex flex-wrap items-center gap-1">
                          <Badge variant={statusVariant(row.status)}>{row.status}</Badge>
                          {flags.map((f) => (
                            <Badge key={f} variant={flagVariant(f)}>
                              {f === "Late"
                                ? `Late ${row.late_minutes}m`
                                : f === "Early Out"
                                  ? `Early ${row.early_leaving_minutes}m`
                                  : `OT ${formatHours(row.overtime_hours)}`}
                            </Badge>
                          ))}
                          {(row.is_manual_override === 1 || row.is_manual_override === true) && (
                            <Badge variant="outline">Override</Badge>
                          )}
                        </div>
                      </td>
                      <td className="p-3">
                        {row.regularisation_status ? (
                          <Badge
                            variant={
                              row.regularisation_status === "Approved"
                                ? "default"
                                : row.regularisation_status === "Rejected"
                                  ? "destructive"
                                  : "secondary"
                            }
                          >
                            {row.regularisation_status}
                          </Badge>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="p-3 text-xs text-muted-foreground">{row.source ?? "—"}</td>
                      <td className="p-3 text-right">
                        <OverrideDialog row={row} onSaved={() => mutate()} />
                      </td>
                    </tr>
                  )
                })}
                {!isLoading && rows.length === 0 && (
                  <tr>
                    <td colSpan={9} className="p-10 text-center text-sm text-muted-foreground">
                      {hasFilters ? "No records match these filters." : "No attendance records yet."}
                    </td>
                  </tr>
                )}
                {isLoading && (
                  <tr>
                    <td colSpan={9} className="p-10 text-center text-sm text-muted-foreground">
                      Loading…
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </TabsContent>

        <TabsContent value="monthly">
          <AttendanceMonthly employees={employees} />
        </TabsContent>
      </Tabs>
    </main>
  )
}

function ManualEntryDialog({
  employees,
  onSaved,
}: {
  employees: EmployeeRow[]
  onSaved: () => void
}) {
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [employeeId, setEmployeeId] = useState("")
  const [workDate, setWorkDate] = useState(todayISO())
  const [clockIn, setClockIn] = useState("")
  const [clockOut, setClockOut] = useState("")
  const [breakMinutes, setBreakMinutes] = useState("")
  const [status, setStatus] = useState("Present")
  const [remarks, setRemarks] = useState("")

  const selected = employees.find((e) => String(e.id) === employeeId)

  function reset() {
    setEmployeeId("")
    setWorkDate(todayISO())
    setClockIn("")
    setClockOut("")
    setBreakMinutes("")
    setStatus("Present")
    setRemarks("")
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (!employeeId) {
      toast.error("Select an employee")
      return
    }
    setSaving(true)
    try {
      const res = await fetch("/api/hr/attendance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          employee_id: Number(employeeId),
          work_date: workDate,
          clock_in: clockIn || null,
          clock_out: clockOut || null,
          break_minutes: breakMinutes ? Number(breakMinutes) : 0,
          status,
          remarks: remarks || null,
          source: "Admin Manual",
        }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error || "Could not save attendance")
      }
      toast.success("Attendance recorded")
      setOpen(false)
      reset()
      onSaved()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save attendance")
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) reset()
      }}
    >
      <DialogTrigger render={<Button>Add attendance</Button>} />
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Add attendance record</DialogTitle>
          <DialogDescription>
            The attendance ID is generated automatically and working hours are calculated from the clock times.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <Label className="mb-1.5 block">Employee</Label>
            <Select value={employeeId} onValueChange={(v) => setEmployeeId(v || "")}>
              <SelectTrigger>
                <SelectValue placeholder="Select an employee" />
              </SelectTrigger>
              <SelectContent>
                {employees.map((e) => (
                  <SelectItem key={e.id} value={String(e.id)}>
                    {e.employee_id} · {e.employee_name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {selected && (
              <p className="mt-1 text-xs text-muted-foreground">
                {[selected.designation, selected.department].filter(Boolean).join(" · ") || "No department set"}
              </p>
            )}
          </div>
          <div>
            <Label className="mb-1.5 block" htmlFor="me-date">
              Work date
            </Label>
            <Input id="me-date" type="date" value={workDate} onChange={(e) => setWorkDate(e.target.value)} required />
          </div>
          <div>
            <Label className="mb-1.5 block">Status</Label>
            <Select value={status} onValueChange={(v) => setStatus(v || "Present")}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ATTENDANCE_STATUSES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {s}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="mb-1.5 block" htmlFor="me-in">
              Clock in
            </Label>
            <Input id="me-in" type="datetime-local" value={clockIn} onChange={(e) => setClockIn(e.target.value)} />
          </div>
          <div>
            <Label className="mb-1.5 block" htmlFor="me-out">
              Clock out
            </Label>
            <Input id="me-out" type="datetime-local" value={clockOut} onChange={(e) => setClockOut(e.target.value)} />
          </div>
          <div>
            <Label className="mb-1.5 block" htmlFor="me-break">
              Break minutes
            </Label>
            <Input
              id="me-break"
              type="number"
              min={0}
              value={breakMinutes}
              onChange={(e) => setBreakMinutes(e.target.value)}
            />
          </div>
          <div className="sm:col-span-2">
            <Label className="mb-1.5 block" htmlFor="me-remarks">
              Remarks
            </Label>
            <Textarea id="me-remarks" value={remarks} onChange={(e) => setRemarks(e.target.value)} />
          </div>
          <DialogFooter className="sm:col-span-2">
            <Button type="submit" disabled={saving}>
              {saving ? "Saving…" : "Save attendance"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function OverrideDialog({ row, onSaved }: { row: AttendanceRow; onSaved: () => void }) {
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [clockIn, setClockIn] = useState("")
  const [clockOut, setClockOut] = useState("")
  const [breakMinutes, setBreakMinutes] = useState(String(row.break_minutes ?? 0))
  const [status, setStatus] = useState(row.status)
  const [reason, setReason] = useState("")

  // DATETIME "YYYY-MM-DD HH:MM:SS" -> "YYYY-MM-DDTHH:MM" for datetime-local.
  function toLocal(value: string | null) {
    if (!value) return ""
    return String(value).slice(0, 16).replace(" ", "T")
  }

  function openChange(next: boolean) {
    setOpen(next)
    if (next) {
      setClockIn(toLocal(row.clock_in))
      setClockOut(toLocal(row.clock_out))
      setBreakMinutes(String(row.break_minutes ?? 0))
      setStatus(row.status)
      setReason("")
    }
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (!reason.trim()) {
      toast.error("A reason is required for an override")
      return
    }
    setSaving(true)
    try {
      const res = await fetch("/api/hr/attendance", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: row.id,
          clock_in: clockIn || null,
          clock_out: clockOut || null,
          break_minutes: Number(breakMinutes) || 0,
          status,
          reason,
        }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error || "Could not save override")
      }
      toast.success("Attendance updated")
      setOpen(false)
      onSaved()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save override")
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={openChange}>
      <DialogTrigger render={<Button variant="ghost" size="sm">Override</Button>} />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Override attendance</DialogTitle>
          <DialogDescription>
            {row.employee_name} · {formatDate(row.work_date)}. Working hours recalculate from the new times.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
          <div>
            <Label className="mb-1.5 block" htmlFor="ov-in">
              Clock in
            </Label>
            <Input id="ov-in" type="datetime-local" value={clockIn} onChange={(e) => setClockIn(e.target.value)} />
          </div>
          <div>
            <Label className="mb-1.5 block" htmlFor="ov-out">
              Clock out
            </Label>
            <Input id="ov-out" type="datetime-local" value={clockOut} onChange={(e) => setClockOut(e.target.value)} />
          </div>
          <div>
            <Label className="mb-1.5 block" htmlFor="ov-break">
              Break minutes
            </Label>
            <Input
              id="ov-break"
              type="number"
              min={0}
              value={breakMinutes}
              onChange={(e) => setBreakMinutes(e.target.value)}
            />
          </div>
          <div>
            <Label className="mb-1.5 block">Status</Label>
            <Select value={status} onValueChange={(v) => setStatus(v || row.status)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ATTENDANCE_STATUSES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {s}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="sm:col-span-2">
            <Label className="mb-1.5 block" htmlFor="ov-reason">
              Reason
            </Label>
            <Textarea
              id="ov-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Why is this record being changed?"
              required
            />
          </div>
          <DialogFooter className="sm:col-span-2">
            <Button type="submit" disabled={saving}>
              {saving ? "Saving…" : "Save override"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
