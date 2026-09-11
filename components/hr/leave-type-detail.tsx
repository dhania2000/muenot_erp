"use client"

import useSWR from "swr"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { Progress } from "@/components/ui/progress"
import { fetcher } from "@/lib/fetcher"

type Usage = {
  eligibleEmployees: number
  employeesUsing: number
  requestsThisYear: number
  approvedRequests: number
  pendingRequests: number
  daysTaken: number
  daysPending: number
  totalAllocated: number
  totalAvailable: number
}

type DetailResponse = {
  leaveType: any
  usage: Usage
  audit: any[]
  inUse: boolean
  year: number
}

function yesNo(value: any) {
  return value ? "Yes" : "No"
}

function Stat({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }) {
  return (
    <div className="rounded-lg border bg-card p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-xl font-semibold tabular-nums">{value}</p>
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  )
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-1.5 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right font-medium">{value}</span>
    </div>
  )
}

export function LeaveTypeDetail({
  leaveTypeId,
  open,
  onOpenChange,
}: {
  leaveTypeId: string | null
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { data, isLoading } = useSWR<DetailResponse>(
    open && leaveTypeId ? `/api/hr/leave-types/${leaveTypeId}` : null,
    fetcher,
  )

  const type = data?.leaveType
  const usage = data?.usage
  const consumed = usage && usage.totalAllocated > 0 ? Math.min(100, (usage.daysTaken / usage.totalAllocated) * 100) : 0

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {type?.leave_type ?? "Leave type"}
            {type?.leave_code ? <Badge variant="secondary">{type.leave_code}</Badge> : null}
            {type ? (
              <Badge variant={type.status === "Active" ? "default" : "outline"}>{type.status}</Badge>
            ) : null}
          </DialogTitle>
        </DialogHeader>

        {isLoading || !type ? (
          <p className="py-8 text-center text-sm text-muted-foreground">Loading…</p>
        ) : (
          <div className="space-y-6">
            <div>
              <p className="text-xs text-muted-foreground">{type.leave_type_id}</p>
              {type.description ? <p className="mt-1 text-sm">{type.description}</p> : null}
            </div>

            <section>
              <h3 className="mb-2 text-sm font-semibold">Usage this year ({data?.year})</h3>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Stat label="Eligible employees" value={usage?.eligibleEmployees ?? 0} />
                <Stat label="Employees using" value={usage?.employeesUsing ?? 0} />
                <Stat label="Requests" value={usage?.requestsThisYear ?? 0} hint={`${usage?.pendingRequests ?? 0} pending`} />
                <Stat label="Days taken" value={usage?.daysTaken ?? 0} hint={`${usage?.daysPending ?? 0} pending`} />
              </div>
              {usage && usage.totalAllocated > 0 ? (
                <div className="mt-3">
                  <div className="mb-1 flex justify-between text-xs text-muted-foreground">
                    <span>Allocated {usage.totalAllocated}</span>
                    <span>Available {usage.totalAvailable}</span>
                  </div>
                  <Progress value={consumed} />
                </div>
              ) : null}
            </section>

            <Separator />

            <div className="grid gap-6 sm:grid-cols-2">
              <section>
                <h3 className="mb-1 text-sm font-semibold">Entitlement</h3>
                <Row label="Annual quota" value={type.annual_quota} />
                <Row label="Accrual method" value={type.accrual_method} />
                <Row label="Prorate on join" value={yesNo(type.prorate_on_join)} />
                <Row label="Carry forward" value={type.carry_forward} />
                <Row label="Allow negative" value={yesNo(type.allow_negative)} />
                <Row label="Low balance alert" value={type.low_balance_threshold} />
              </section>

              <section>
                <h3 className="mb-1 text-sm font-semibold">Request rules</h3>
                <Row label="Min days / request" value={type.min_days_per_request} />
                <Row label="Max days / request" value={type.max_days_per_request} />
                <Row label="Max consecutive days" value={type.max_consecutive_days} />
                <Row label="Max requests / year" value={type.max_requests_per_year} />
                <Row label="Advance notice (days)" value={type.advance_notice_days} />
                <Row label="Half-day allowed" value={yesNo(type.allow_half_day)} />
                <Row label="Backdated allowed" value={yesNo(type.allow_backdated)} />
              </section>

              <section>
                <h3 className="mb-1 text-sm font-semibold">Day counting & pay</h3>
                <Row label="Count weekends" value={yesNo(type.count_weekends)} />
                <Row label="Count holidays" value={yesNo(type.count_holidays)} />
                <Row label="Paid leave" value={yesNo(type.paid)} />
                <Row label="Requires document" value={yesNo(type.requires_document)} />
              </section>

              <section>
                <h3 className="mb-1 text-sm font-semibold">Eligibility & validity</h3>
                <Row label="Gender" value={type.applicable_gender || "Any"} />
                <Row label="Employment type" value={type.applicable_employment_type || "Any"} />
                <Row label="Effective from" value={type.effective_from || "—"} />
                <Row label="Effective until" value={type.effective_until || "—"} />
              </section>
            </div>

            <Separator />

            <section>
              <h3 className="mb-2 text-sm font-semibold">Change history</h3>
              {data?.audit?.length ? (
                <ul className="space-y-2">
                  {data.audit.map((entry, index) => (
                    <li key={index} className="flex flex-wrap items-baseline justify-between gap-2 border-b pb-2 text-sm last:border-0">
                      <span>
                        <span className="font-medium capitalize">{entry.action}</span>
                        {entry.field ? <span className="text-muted-foreground"> · {entry.field}</span> : null}
                        {entry.old_value || entry.new_value ? (
                          <span className="text-muted-foreground">
                            {" "}
                            {entry.old_value ?? "—"} → {entry.new_value ?? "—"}
                          </span>
                        ) : null}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {entry.actor_name ? `${entry.actor_name} · ` : ""}
                        {new Date(entry.created_at).toLocaleString()}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">No changes recorded yet.</p>
              )}
            </section>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
