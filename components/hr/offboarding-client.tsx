"use client"
import useSWR from "swr"
import { useMemo, useState } from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { fetcher } from "@/lib/fetcher"
import { ExcelExportButton } from "@/components/excel-export-button"
import { ImportButton } from "@/components/import-button"
import { OffboardingDetail } from "@/components/hr/offboarding-detail"

const EXIT_TYPES = ["Resignation", "Termination", "Retirement", "Contract End", "Absconded", "Mutual Separation", "Other"]
const QUICK = [
  { key: "", label: "All" },
  { key: "active", label: "Active" },
  { key: "notice", label: "In notice" },
  { key: "pending_clearance", label: "Pending clearance" },
  { key: "pending_settlement", label: "Pending settlement" },
  { key: "leaving_week", label: "Leaving this week" },
  { key: "completed", label: "Completed" },
  { key: "cancelled", label: "Cancelled" },
]

function parseNoticeDays(raw: any): number | null {
  if (!raw) return null
  const text = String(raw).toLowerCase()
  const n = Number.parseFloat(text.replace(/[^0-9.]/g, ""))
  if (!Number.isFinite(n) || n <= 0) return null
  if (text.includes("month")) return Math.round(n * 30)
  if (text.includes("week")) return Math.round(n * 7)
  return Math.round(n)
}
function addDays(date: string, days: number | null) {
  if (!date || days == null) return null
  const d = new Date(`${date}T00:00:00`)
  if (Number.isNaN(d.getTime())) return null
  d.setDate(d.getDate() + days)
  return d.toISOString().slice(0, 10)
}
function statusTone(status: string): string {
  const s = (status || "").toLowerCase()
  if (["completed", "approved"].some((x) => s.includes(x))) return "border-emerald-500/40 bg-emerald-500/10 text-emerald-400"
  if (["cancelled", "withdrawn"].some((x) => s.includes(x))) return "border-red-500/40 bg-red-500/10 text-red-400"
  if (s.includes("hold")) return "border-orange-500/40 bg-orange-500/10 text-orange-400"
  return "border-amber-500/40 bg-amber-500/10 text-amber-400"
}
function Metric({ label, value, accent }: { label: string; value: number; accent?: string }) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`mt-1 text-2xl font-semibold ${accent || "text-foreground"}`}>{value}</p>
    </div>
  )
}

export function OffboardingClient() {
  const [search, setSearch] = useState("")
  const [quick, setQuick] = useState("")
  const [exitType, setExitType] = useState("")
  const [department, setDepartment] = useState("")
  const [page, setPage] = useState(1)
  const [open, setOpen] = useState(false)
  const [detailId, setDetailId] = useState<number | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [form, setForm] = useState<Record<string, string>>({})

  const params = new URLSearchParams()
  if (search) params.set("search", search)
  if (quick) params.set("quick", quick)
  if (exitType) params.set("exit_type", exitType)
  if (department) params.set("department", department)
  params.set("page", String(page))
  const key = `/api/hr/offboarding?${params.toString()}`

  const { data, mutate } = useSWR<any, Error>(key, fetcher)
  const { data: employees } = useSWR<{ employees: any[] }, Error>("/api/hr/employees", fetcher)

  const metrics = data?.metrics
  const rows: any[] = data?.offboarding || []
  const total = data?.total || 0
  const pageSize = data?.pageSize || 20
  const facetDepts: string[] = data?.facets?.departments || []

  const selectedEmployee = useMemo(
    () => (employees?.employees || []).find((e: any) => String(e.id) === form.employee_id),
    [employees, form.employee_id],
  )
  const previewLwd = useMemo(() => {
    if (!selectedEmployee || !form.notice_date) return null
    return addDays(form.notice_date, parseNoticeDays(selectedEmployee.notice_period))
  }, [selectedEmployee, form.notice_date])

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (!form.employee_id) {
      toast.error("Please select an employee")
      return
    }
    setSubmitting(true)
    try {
      const res = await fetch("/api/hr/offboarding", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(json.error || "Failed to start offboarding")
      toast.success(`Offboarding initiated (${json.offboarding_id})`)
      setOpen(false)
      setForm({})
      mutate()
      setDetailId(json.id)
    } catch (error) {
      toast.error((error as Error).message)
    } finally {
      setSubmitting(false)
    }
  }

  const totalPages = Math.max(1, Math.ceil(total / pageSize))

  return (
    <section className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">Offboarding</h1>
          <p className="text-muted-foreground">Manage employee exits: notice, clearances, assets, settlement, and finalization.</p>
        </div>
        <div className="flex items-center gap-2">
          <ImportButton moduleKey="hr-offboarding" onImported={() => mutate()} />
          <ExcelExportButton
            rows={rows}
            filename="offboarding"
            columns={[
              { header: "Offboarding ID", value: (r: any) => r.offboarding_id },
              { header: "Employee", value: (r: any) => r.employee_name },
              { header: "Employee Code", value: (r: any) => r.employee_code },
              { header: "Department", value: (r: any) => r.department },
              { header: "Exit Type", value: (r: any) => r.exit_type },
              { header: "Notice Date", value: (r: any) => r.notice_date },
              { header: "Expected LWD", value: (r: any) => r.expected_last_working_date },
              { header: "Last Working Date", value: (r: any) => r.last_working_date },
              { header: "Settlement Status", value: (r: any) => r.settlement_status },
              { header: "Status", value: (r: any) => r.status },
              { header: "Remarks", value: (r: any) => r.remarks },
            ]}
          />
          <Button onClick={() => setOpen(true)}>Start offboarding</Button>
        </div>
      </div>

      {/* Dashboard */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
        <Metric label="Active offboarding" value={metrics?.activeOffboarding ?? 0} />
        <Metric label="Leaving this week" value={metrics?.leavingThisWeek ?? 0} accent="text-amber-400" />
        <Metric label="Pending clearance" value={metrics?.pendingClearance ?? 0} accent="text-amber-400" />
        <Metric label="Pending assets" value={metrics?.pendingAssets ?? 0} accent="text-amber-400" />
        <Metric label="Pending settlement" value={metrics?.pendingSettlement ?? 0} accent="text-amber-400" />
        <Metric label="Completed this month" value={metrics?.completedThisMonth ?? 0} accent="text-emerald-400" />
      </div>

      {/* Filters */}
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <Input
            placeholder="Search employee, ID, department…"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value)
              setPage(1)
            }}
            className="w-64"
          />
          <Select value={exitType || "all"} onValueChange={(v) => { setExitType(v === "all" ? "" : v); setPage(1) }}>
            <SelectTrigger className="w-44"><SelectValue placeholder="Exit type" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All exit types</SelectItem>
              {EXIT_TYPES.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={department || "all"} onValueChange={(v) => { setDepartment(v === "all" ? "" : v); setPage(1) }}>
            <SelectTrigger className="w-44"><SelectValue placeholder="Department" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All departments</SelectItem>
              {facetDepts.map((d) => <SelectItem key={d} value={d}>{d}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {QUICK.map((q) => (
            <button
              key={q.key}
              onClick={() => { setQuick(q.key); setPage(1) }}
              className={`rounded-full border px-3 py-1 text-xs transition-colors ${
                quick === q.key ? "border-primary bg-primary text-primary-foreground" : "border-border bg-card text-muted-foreground hover:text-foreground"
              }`}
            >
              {q.label}
            </button>
          ))}
        </div>
      </div>

      {/* Table */}
      <div className="rounded-lg border border-border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Employee</TableHead>
              <TableHead>Exit type</TableHead>
              <TableHead>LWD</TableHead>
              <TableHead>Clearances</TableHead>
              <TableHead>Settlement</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="py-10 text-center text-sm text-muted-foreground">No offboarding cases found.</TableCell>
              </TableRow>
            )}
            {rows.map((r) => (
              <TableRow key={r.id} className="cursor-pointer" onClick={() => setDetailId(r.id)}>
                <TableCell>
                  <div className="font-medium text-foreground">{r.employee_name}</div>
                  <div className="text-xs text-muted-foreground">{r.employee_code} · {r.department || "—"}</div>
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">{r.exit_type || "—"}</TableCell>
                <TableCell className="text-sm text-muted-foreground">{(r.last_working_date || r.expected_last_working_date || "—")?.toString().slice(0, 10)}</TableCell>
                <TableCell className="text-sm text-muted-foreground">{r.clearance_done ?? 0}/{r.clearance_total ?? 0}{Number(r.assets_pending) > 0 ? ` · ${r.assets_pending} asset(s)` : ""}</TableCell>
                <TableCell className="text-sm text-muted-foreground">{r.settlement_status || "—"}</TableCell>
                <TableCell><Badge variant="outline" className={statusTone(r.status)}>{r.status}</Badge></TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <span className="text-xs text-muted-foreground">{total} case(s) · page {page} of {totalPages}</span>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Previous</Button>
            <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>Next</Button>
          </div>
        </div>
      )}

      {/* Start dialog */}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto">
          <DialogHeader><DialogTitle>Start employee offboarding</DialogTitle></DialogHeader>
          <form onSubmit={submit} className="space-y-4">
            <div className="space-y-1">
              <Label>Employee</Label>
              <Select value={form.employee_id || ""} onValueChange={(v) => setForm((f) => ({ ...f, employee_id: v }))}>
                <SelectTrigger><SelectValue placeholder="Select employee" /></SelectTrigger>
                <SelectContent>
                  {(employees?.employees ?? [])
                    .filter((e: any) => e.employment_status !== "Ex-Employee")
                    .map((e: any) => (
                      <SelectItem key={e.id} value={String(e.id)}>{e.employee_name} · {e.employee_id}</SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>

            {selectedEmployee && (
              <div className="grid grid-cols-2 gap-3 rounded-lg border border-border bg-muted/40 p-3 text-sm sm:grid-cols-3">
                <div><p className="text-xs text-muted-foreground">Department</p><p className="text-foreground">{selectedEmployee.department || "—"}</p></div>
                <div><p className="text-xs text-muted-foreground">Designation</p><p className="text-foreground">{selectedEmployee.designation || "—"}</p></div>
                <div><p className="text-xs text-muted-foreground">Manager</p><p className="text-foreground">{selectedEmployee.reporting_manager || "—"}</p></div>
                <div><p className="text-xs text-muted-foreground">Joined</p><p className="text-foreground">{(selectedEmployee.joining_date || "—")?.toString().slice(0, 10)}</p></div>
                <div><p className="text-xs text-muted-foreground">Notice period</p><p className="text-foreground">{selectedEmployee.notice_period || "—"}</p></div>
                <div><p className="text-xs text-muted-foreground">Current status</p><p className="text-foreground">{selectedEmployee.employment_status || "—"}</p></div>
              </div>
            )}

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1">
                <Label>Exit type</Label>
                <Select value={form.exit_type || ""} onValueChange={(v) => setForm((f) => ({ ...f, exit_type: v }))}>
                  <SelectTrigger><SelectValue placeholder="Select" /></SelectTrigger>
                  <SelectContent>{EXIT_TYPES.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label>Notice date</Label>
                <Input type="date" value={form.notice_date || ""} onChange={(e) => setForm((f) => ({ ...f, notice_date: e.target.value }))} />
              </div>
              <div className="space-y-1">
                <Label>Requested last working date</Label>
                <Input type="date" value={form.last_working_date || ""} onChange={(e) => setForm((f) => ({ ...f, last_working_date: e.target.value }))} />
              </div>
              <div className="flex items-end">
                {previewLwd && <p className="text-xs text-muted-foreground">Notice-based expected LWD: <span className="text-foreground">{previewLwd}</span></p>}
              </div>
            </div>

            <div className="space-y-1">
              <Label>Reason</Label>
              <Textarea value={form.exit_reason || ""} onChange={(e) => setForm((f) => ({ ...f, exit_reason: e.target.value }))} placeholder="Reason for exit" />
            </div>
            <div className="space-y-1">
              <Label>Remarks</Label>
              <Textarea value={form.remarks || ""} onChange={(e) => setForm((f) => ({ ...f, remarks: e.target.value }))} placeholder="Internal remarks (optional)" />
            </div>

            <p className="text-xs text-muted-foreground">Starting will move the employee to <span className="text-foreground">Notice Period</span> and auto-create the clearance checklist.</p>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
              <Button type="submit" disabled={submitting}>{submitting ? "Starting…" : "Start offboarding"}</Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      <OffboardingDetail id={detailId} onClose={() => setDetailId(null)} onChanged={() => mutate()} />
    </section>
  )
}
