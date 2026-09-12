"use client"

import useSWR from "swr"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { fetcher } from "@/lib/fetcher"
import { formatDurationHours, formatWorkingDays, overtimeStartLabel, parseDayList } from "@/lib/shift-ui"

type DetailResponse = {
  shift: any
  usage: { activeAssignments: number; totalAssignments: number; assignedEmployees: number }
  assignments: any[]
  events: any[]
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

export function ShiftDetail({
  shiftId,
  open,
  onOpenChange,
}: {
  shiftId: number | null
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { data, isLoading } = useSWR<DetailResponse>(
    open && shiftId ? `/api/hr/shifts/${shiftId}` : null,
    fetcher,
  )

  const shift = data?.shift
  const usage = data?.usage
  const workingDays = parseDayList(shift?.working_days)
  const weeklyOffs = parseDayList(shift?.weekly_offs)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-center gap-2">
            {shift?.shift_name ?? "Shift"}
            {shift?.shift_code ? <Badge variant="secondary">{shift.shift_code}</Badge> : null}
            {shift ? (
              <Badge variant={shift.status === "Active" ? "default" : "outline"}>{shift.status}</Badge>
            ) : null}
            {shift && Number(shift.is_overnight) ? <Badge variant="outline">Overnight</Badge> : null}
          </DialogTitle>
        </DialogHeader>

        {isLoading || !shift ? (
          <p className="py-8 text-center text-sm text-muted-foreground">Loading…</p>
        ) : (
          <div className="space-y-6">
            <div>
              <p className="text-xs text-muted-foreground">{shift.shift_id}</p>
              {shift.description ? <p className="mt-1 text-sm">{shift.description}</p> : null}
            </div>

            <section>
              <h3 className="mb-2 text-sm font-semibold">Assignment usage</h3>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Stat label="Active assignments" value={usage?.activeAssignments ?? 0} />
                <Stat label="Employees assigned" value={usage?.assignedEmployees ?? 0} />
                <Stat label="Total assignments" value={usage?.totalAssignments ?? 0} />
                <Stat label="Net hours / day" value={formatDurationHours(Number(shift.working_hours || 0))} />
              </div>
            </section>

            <Separator />

            <div className="grid gap-6 sm:grid-cols-2">
              <section>
                <h3 className="mb-1 text-sm font-semibold">Timing</h3>
                <Row label="Start time" value={String(shift.start_time).slice(0, 5)} />
                <Row label="End time" value={String(shift.end_time).slice(0, 5)} />
                <Row label="Overnight" value={yesNo(Number(shift.is_overnight))} />
                <Row label="Break" value={`${shift.break_minutes ?? 0} min`} />
                <Row label="Net working hours" value={formatDurationHours(Number(shift.working_hours || 0))} />
              </section>

              <section>
                <h3 className="mb-1 text-sm font-semibold">Attendance rules</h3>
                <Row label="Grace period" value={`${shift.grace_minutes ?? 0} min`} />
                <Row label="Late tracking" value={yesNo(Number(shift.late_enabled))} />
                <Row label="Early checkout rule" value={yesNo(Number(shift.early_checkout_enabled))} />
                <Row label="Early checkout grace" value={`${shift.early_grace_minutes ?? 0} min`} />
              </section>

              <section>
                <h3 className="mb-1 text-sm font-semibold">Overtime</h3>
                <Row label="Overtime enabled" value={yesNo(Number(shift.overtime_enabled))} />
                <Row label="Eligible" value={yesNo(Number(shift.overtime_eligible))} />
                <Row label="Threshold" value={`${shift.overtime_threshold_minutes ?? 0} min`} />
                <Row
                  label="Rounding"
                  value={
                    Number(shift.overtime_rounding_minutes) ? `${shift.overtime_rounding_minutes} min` : "None"
                  }
                />
                {Number(shift.overtime_enabled) ? (
                  <Row
                    label="Overtime starts"
                    value={overtimeStartLabel(
                      shift.end_time,
                      Number(shift.overtime_threshold_minutes || 0),
                      Boolean(Number(shift.is_overnight)),
                    )}
                  />
                ) : null}
              </section>

              <section>
                <h3 className="mb-1 text-sm font-semibold">Working days & validity</h3>
                <Row label="Working days" value={formatWorkingDays(workingDays)} />
                <Row label="Weekly offs" value={weeklyOffs.length ? formatWorkingDays(weeklyOffs) : "—"} />
                <Row label="Effective from" value={shift.effective_from ? String(shift.effective_from).slice(0, 10) : "—"} />
                <Row label="Effective until" value={shift.effective_until ? String(shift.effective_until).slice(0, 10) : "—"} />
              </section>
            </div>

            <Separator />

            <section>
              <h3 className="mb-2 text-sm font-semibold">Assigned employees</h3>
              {data?.assignments?.length ? (
                <ul className="space-y-1.5">
                  {data.assignments.slice(0, 20).map((a) => (
                    <li key={a.id} className="flex items-center justify-between gap-3 border-b pb-1.5 text-sm last:border-0">
                      <span>
                        <span className="font-medium">{a.employee_name ?? a.employee_code ?? `#${a.employee_id}`}</span>
                        {a.department ? <span className="text-muted-foreground"> · {a.department}</span> : null}
                      </span>
                      <span className="flex items-center gap-2 text-xs text-muted-foreground">
                        {a.effective_from ? String(a.effective_from).slice(0, 10) : ""}
                        <Badge variant={a.status === "Active" ? "default" : "outline"}>{a.status}</Badge>
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">No employees are assigned to this shift yet.</p>
              )}
            </section>

            <Separator />

            <section>
              <h3 className="mb-2 text-sm font-semibold">Change history</h3>
              {data?.events?.length ? (
                <ul className="space-y-2">
                  {data.events.map((entry) => (
                    <li
                      key={entry.id}
                      className="flex flex-wrap items-baseline justify-between gap-2 border-b pb-2 text-sm last:border-0"
                    >
                      <span>
                        <span className="font-medium capitalize">{entry.event_type}</span>
                        <span className="text-muted-foreground"> · {entry.summary}</span>
                        {entry.reason ? <span className="text-muted-foreground"> ({entry.reason})</span> : null}
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
