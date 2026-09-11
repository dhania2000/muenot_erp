"use client"

import { useMemo, useState } from "react"
import useSWR from "swr"
import { toast } from "sonner"
import { fetcher } from "@/lib/fetcher"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { ExcelExportButton } from "@/components/excel-export-button"
import { ImportButton } from "@/components/import-button"
import { RegularisationForm } from "@/components/hr/regularisation-form"
import { RegularisationReviewDialog, type ReviewRequest } from "@/components/hr/regularisation-review-dialog"
import { formatDate, formatTime, type BadgeVariant } from "@/lib/attendance-ui"

const ALL = "__all__"
const REG_STATUSES = ["Pending", "Approved", "Rejected", "Cancelled"]

type RequestRow = {
  id: number
  request_id: string
  employee_id: number
  employee_name: string
  employee_code: string
  work_date: string
  correction_type: string | null
  current_clock_in: string | null
  current_clock_out: string | null
  current_status: string | null
  requested_clock_in: string | null
  requested_clock_out: string | null
  requested_status: string | null
  reason: string
  status: string
  reviewed_by: string | null
  rejection_reason: string | null
  attachment_path: string | null
  attachment_name: string | null
  requested_at: string
}

type Summary = { total: number; pending: number; approved: number; rejected: number; cancelled: number; thisMonth: number }
type Context = {
  canManage: boolean
  self: { id: number; employee_name: string; employee_id: string; department: string | null } | null
  employees: { id: number; employee_name: string; employee_id: string; department: string | null }[]
}
type Response = { requests: RequestRow[]; summary: Summary; context: Context }

function statusBadge(status: string): BadgeVariant {
  if (status === "Approved") return "default"
  if (status === "Rejected") return "destructive"
  if (status === "Cancelled") return "outline"
  return "secondary"
}

export function AttendanceRegularisationClient() {
  const [status, setStatus] = useState("")
  const [employeeId, setEmployeeId] = useState("")
  const [workFrom, setWorkFrom] = useState("")
  const [workTo, setWorkTo] = useState("")
  const [search, setSearch] = useState("")
  const [review, setReview] = useState<ReviewRequest | null>(null)

  const queryString = useMemo(() => {
    const sp = new URLSearchParams()
    if (status) sp.set("status", status)
    if (employeeId) sp.set("employeeId", employeeId)
    if (workFrom) sp.set("workFrom", workFrom)
    if (workTo) sp.set("workTo", workTo)
    if (search) sp.set("search", search)
    return sp.toString()
  }, [status, employeeId, workFrom, workTo, search])

  const { data, mutate, isLoading } = useSWR<Response>(
    `/api/hr/attendance-regularisation${queryString ? `?${queryString}` : ""}`,
    fetcher,
  )

  const canManage = data?.context.canManage ?? false
  const self = data?.context.self ?? null
  const employees = data?.context.employees ?? []
  const requests = data?.requests ?? []
  const summary = data?.summary

  async function cancel(id: number) {
    const r = await fetch("/api/hr/attendance-regularisation", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, action: "cancel" }),
    })
    const json = await r.json()
    if (!r.ok) return toast.error(json.error || "Could not cancel")
    toast.success("Request cancelled")
    mutate()
  }

  const summaryCards: { label: string; value: number; className?: string }[] = summary
    ? [
        { label: "Total", value: summary.total },
        { label: "Pending", value: summary.pending, className: "text-amber-500" },
        { label: "Approved", value: summary.approved, className: "text-emerald-500" },
        { label: "Rejected", value: summary.rejected, className: "text-destructive" },
        { label: "This Month", value: summary.thisMonth },
      ]
    : []

  return (
    <main className="space-y-6 p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-balance">Attendance Regularisation</h1>
          <p className="text-sm text-muted-foreground">
            {canManage
              ? "Review correction requests and apply approved changes to attendance."
              : "Request corrections to your attendance. Approved changes update your record automatically."}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <ImportButton moduleKey="hr-attendance-regularisation" onImported={mutate} />
          <ExcelExportButton
            rows={requests}
            filename="attendance-regularisation"
            columns={[
              { header: "Request ID", value: (r) => r.request_id },
              { header: "Employee", value: (r) => r.employee_name },
              { header: "Employee Code", value: (r) => r.employee_code },
              { header: "Work Date", value: (r) => r.work_date },
              { header: "Correction", value: (r) => r.correction_type ?? "" },
              { header: "Current In", value: (r) => formatTime(r.current_clock_in) },
              { header: "Current Out", value: (r) => formatTime(r.current_clock_out) },
              { header: "Requested In", value: (r) => formatTime(r.requested_clock_in) },
              { header: "Requested Out", value: (r) => formatTime(r.requested_clock_out) },
              { header: "Reason", value: (r) => r.reason },
              { header: "Status", value: (r) => r.status },
              { header: "Reviewed By", value: (r) => r.reviewed_by ?? "" },
            ]}
          />
        </div>
      </div>

      {/* Summary */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {summaryCards.map((c) => (
          <div key={c.label} className="rounded-xl border bg-card p-4">
            <div className="text-xs uppercase tracking-wide text-muted-foreground">{c.label}</div>
            <div className={`mt-1 text-2xl font-semibold tabular-nums ${c.className ?? ""}`}>{c.value}</div>
          </div>
        ))}
      </div>

      {/* Create request */}
      <section className="space-y-2">
        <h2 className="text-sm font-medium text-muted-foreground">New request</h2>
        <RegularisationForm canManage={canManage} employees={employees} self={self} onSubmitted={mutate} />
      </section>

      {/* Filters */}
      <div className="grid gap-3 rounded-xl border bg-card p-4 md:grid-cols-5">
        <div className="grid gap-1.5">
          <label className="text-xs text-muted-foreground">Status</label>
          <Select value={status || ALL} onValueChange={(v) => setStatus(v === ALL ? "" : v)}>
            <SelectTrigger>
              <SelectValue placeholder="All" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All</SelectItem>
              {REG_STATUSES.map((s) => (
                <SelectItem key={s} value={s}>
                  {s}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {canManage && (
          <div className="grid gap-1.5">
            <label className="text-xs text-muted-foreground">Employee</label>
            <Select value={employeeId || ALL} onValueChange={(v) => setEmployeeId(v === ALL ? "" : v)}>
              <SelectTrigger>
                <SelectValue placeholder="All" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All employees</SelectItem>
                {employees.map((e) => (
                  <SelectItem key={e.id} value={String(e.id)}>
                    {e.employee_name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
        <div className="grid gap-1.5">
          <label className="text-xs text-muted-foreground">Work date from</label>
          <Input type="date" value={workFrom} onChange={(e) => setWorkFrom(e.target.value)} />
        </div>
        <div className="grid gap-1.5">
          <label className="text-xs text-muted-foreground">Work date to</label>
          <Input type="date" value={workTo} onChange={(e) => setWorkTo(e.target.value)} />
        </div>
        <div className="grid gap-1.5">
          <label className="text-xs text-muted-foreground">Search</label>
          <Input placeholder="Request ID, name, code…" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
      </div>

      {/* Requests */}
      <div className="rounded-xl border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Request ID</TableHead>
              <TableHead>Employee</TableHead>
              <TableHead>Work Date</TableHead>
              <TableHead>Correction</TableHead>
              <TableHead>Current → Requested</TableHead>
              <TableHead>Reason</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={8} className="py-10 text-center text-muted-foreground">
                  Loading requests…
                </TableCell>
              </TableRow>
            ) : requests.length === 0 ? (
              <TableRow>
                <TableCell colSpan={8} className="py-10 text-center text-muted-foreground">
                  No regularisation requests yet.
                </TableCell>
              </TableRow>
            ) : (
              requests.map((r) => {
                const isOwn = self && Number(self.id) === Number(r.employee_id)
                const canReview = canManage && r.status === "Pending" && !isOwn
                const canCancel = r.status === "Pending" && (isOwn || canManage)
                return (
                  <TableRow key={r.id}>
                    <TableCell className="font-medium">{r.request_id}</TableCell>
                    <TableCell>
                      <div className="leading-tight">
                        <div>{r.employee_name}</div>
                        <div className="text-xs text-muted-foreground">{r.employee_code}</div>
                      </div>
                    </TableCell>
                    <TableCell>{formatDate(r.work_date)}</TableCell>
                    <TableCell className="text-sm">{r.correction_type ?? "—"}</TableCell>
                    <TableCell className="text-sm tabular-nums">
                      <div className="flex items-center gap-2">
                        <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                          {formatTime(r.current_clock_in)}/{formatTime(r.current_clock_out)}
                        </span>
                        <span aria-hidden className="text-muted-foreground">→</span>
                        <span className="rounded bg-primary/10 px-1.5 py-0.5 text-xs font-medium text-foreground">
                          {formatTime(r.requested_clock_in)}/{formatTime(r.requested_clock_out)}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell className="max-w-[220px]">
                      <div className="truncate text-sm" title={r.reason}>
                        {r.reason}
                      </div>
                      {r.status === "Rejected" && r.rejection_reason && (
                        <div className="truncate text-xs text-destructive" title={r.rejection_reason}>
                          Rejected: {r.rejection_reason}
                        </div>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge variant={statusBadge(r.status)}>{r.status}</Badge>
                      {r.reviewed_by && <div className="mt-0.5 text-xs text-muted-foreground">by {r.reviewed_by}</div>}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-2">
                        {r.attachment_path && (
                          <a
                            href={r.attachment_path}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-xs text-primary underline underline-offset-4"
                          >
                            File
                          </a>
                        )}
                        {canReview && (
                          <Button
                            size="sm"
                            onClick={() =>
                              setReview({
                                id: r.id,
                                request_id: r.request_id,
                                employee_name: r.employee_name,
                                employee_code: r.employee_code,
                                work_date: r.work_date,
                                correction_type: r.correction_type,
                                reason: r.reason,
                                current_clock_in: r.current_clock_in,
                                current_clock_out: r.current_clock_out,
                                current_status: r.current_status,
                                requested_clock_in: r.requested_clock_in,
                                requested_clock_out: r.requested_clock_out,
                                requested_status: r.requested_status,
                                attachment_path: r.attachment_path,
                                attachment_name: r.attachment_name,
                              })
                            }
                          >
                            Review
                          </Button>
                        )}
                        {canCancel && (
                          <Button size="sm" variant="ghost" onClick={() => cancel(r.id)}>
                            Cancel
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                )
              })
            )}
          </TableBody>
        </Table>
      </div>

      <RegularisationReviewDialog request={review} onClose={() => setReview(null)} onReviewed={mutate} />
    </main>
  )
}
