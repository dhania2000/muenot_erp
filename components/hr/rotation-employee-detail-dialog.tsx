"use client"

import { useState } from "react"
import useSWR from "swr"
import Link from "next/link"
import { fetcher } from "@/lib/fetcher"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Loader2, CalendarClock, MoonStar } from "lucide-react"
import { toast } from "sonner"
import { shiftTimeLabel } from "./shift-change-status"

type PreviewDay = { date: string; sequence_no: number; is_weekly_off: boolean; shift_name: string | null }

/** Collapse the day-by-day preview into contiguous sequence ranges. */
function groupPreview(days: PreviewDay[]) {
  const groups: {
    key: string
    start: string
    end: string
    sequence_no: number
    is_weekly_off: boolean
    shift_name: string | null
  }[] = []
  for (const d of days) {
    const key = `${d.sequence_no}|${d.is_weekly_off}|${d.shift_name ?? ""}`
    const last = groups[groups.length - 1]
    if (last && last.key === key) last.end = d.date
    else groups.push({ key, start: d.date, end: d.date, ...d })
  }
  return groups
}

function fmt(d?: string | null) {
  return d ? String(d).slice(0, 10) : "—"
}

export function RotationEmployeeDetailDialog({
  recordId,
  canManage,
  onClose,
  onChanged,
}: {
  recordId: string | null
  canManage: boolean
  onClose: () => void
  onChanged: () => void
}) {
  const { data, isLoading, mutate } = useSWR<any>(
    recordId ? `/api/hr/rotation-employees?recordId=${encodeURIComponent(recordId)}` : null,
    fetcher,
  )
  const [endDate, setEndDate] = useState("")
  const [busy, setBusy] = useState(false)

  const m = data?.membership
  const state = data?.state
  const pattern = data?.pattern
  const preview: PreviewDay[] = data?.preview || []
  const events: any[] = data?.events || []
  const groups = groupPreview(preview)

  async function endMembership() {
    if (!m) return
    const date = endDate || new Date().toISOString().slice(0, 10)
    setBusy(true)
    try {
      const res = await fetch("/api/hr/rotation-employees", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ record_id: m.record_id, action: "end", end_date: date }),
      })
      const j = await res.json()
      if (!res.ok) return toast.error(j.error || "Could not end the membership.")
      toast.success(`Membership ends ${date}.`)
      mutate()
      onChanged()
    } finally {
      setBusy(false)
    }
  }

  async function setStatus(status: "Active" | "Inactive") {
    if (!m) return
    setBusy(true)
    try {
      const res = await fetch("/api/hr/rotation-employees", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ record_id: m.record_id, status }),
      })
      const j = await res.json()
      if (!res.ok) return toast.error(j.error || "Could not update the membership.")
      toast.success(`Membership set ${status}.`)
      mutate()
      onChanged()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={Boolean(recordId)} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="font-mono text-base">{recordId}</DialogTitle>
          <DialogDescription>
            Rotation membership — the current sequence and shift are resolved live, never stored.
          </DialogDescription>
        </DialogHeader>

        {isLoading || !m ? (
          <div className="flex items-center gap-2 py-10 text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Loading membership…
          </div>
        ) : (
          <div className="grid gap-5">
            {/* Identity */}
            <div className="grid grid-cols-2 gap-4">
              <Fact label="Employee">
                <Link href={`/modules/hr/employees/${m.employee_pk}?tab=shift`} className="font-medium text-primary underline">
                  {m.employee_name}
                </Link>
                <div className="text-xs text-muted-foreground">
                  {m.employee_code}
                  {m.department ? ` · ${m.department}` : ""}
                  {m.designation ? ` · ${m.designation}` : ""}
                </div>
              </Fact>
              <Fact label="Rotation">
                <Link href={`/modules/hr/shift-rotations?rotation=${m.rotation_code}`} className="font-medium text-primary underline">
                  {m.rotation_name}
                </Link>
                <div className="text-xs text-muted-foreground">
                  {m.rotation_code} · {m.cycle_type}
                  {m.rotation_status !== "Active" ? " · rotation inactive" : ""}
                </div>
              </Fact>
              <Fact label="Membership start">{fmt(m.start_date)}</Fact>
              <Fact label="Membership end">{m.end_date ? fmt(m.end_date) : "Onward"}</Fact>
              <Fact label="Status">
                <Badge variant={m.status === "Active" ? "default" : "outline"}>{m.status}</Badge>
              </Fact>
              <Fact label="Added by">{m.added_by_name || "—"}</Fact>
            </div>

            {/* Live resolver snapshot */}
            <div className="rounded-xl border bg-muted/40 p-4">
              <div className="mb-3 flex items-center gap-2 text-sm font-semibold">
                <CalendarClock className="size-4 text-primary" /> Current position (today)
              </div>
              {state?.current ? (
                <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                  <Fact label="Sequence">#{state.current.sequenceNo}</Fact>
                  <Fact label="Shift">
                    {state.current.isWeeklyOff ? (
                      "Weekly off"
                    ) : (
                      <>
                        {state.currentShift?.shift_name || state.current.shiftName || "—"}
                        <div className="text-xs text-muted-foreground">
                          {state.currentShift
                            ? shiftTimeLabel(state.currentShift.start_time, state.currentShift.end_time, state.currentShift.is_overnight)
                            : ""}
                          {state.currentShift?.is_overnight ? (
                            <span className="ml-1 inline-flex items-center gap-0.5 text-amber-600">
                              <MoonStar className="size-3" /> overnight
                            </span>
                          ) : null}
                        </div>
                      </>
                    )}
                  </Fact>
                  <Fact label="Next sequence">{state.next ? `#${state.next.sequenceNo}` : "—"}</Fact>
                  <Fact label="Next change">
                    {state.next ? (
                      <>
                        {fmt(state.next.effectiveFrom)}
                        <div className="text-xs text-muted-foreground">
                          {state.next.isWeeklyOff ? "Weekly off" : state.next.shiftName || "—"}
                        </div>
                      </>
                    ) : (
                      "—"
                    )}
                  </Fact>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  No live sequence applies today (membership is upcoming, ended, inactive, or the rotation has no pattern).
                </p>
              )}
            </div>

            {/* Upcoming schedule preview */}
            <div>
              <h3 className="mb-2 text-sm font-semibold">Upcoming schedule</h3>
              {groups.length === 0 ? (
                <p className="text-sm text-muted-foreground">No upcoming schedule to preview.</p>
              ) : (
                <ul className="divide-y rounded-xl border">
                  {groups.map((g, i) => (
                    <li key={i} className="flex items-center justify-between px-4 py-2 text-sm">
                      <span className="whitespace-nowrap">
                        {g.start === g.end ? fmt(g.start) : `${fmt(g.start)} → ${fmt(g.end)}`}
                      </span>
                      <span className="flex items-center gap-2">
                        <span className="text-xs text-muted-foreground">Seq #{g.sequence_no}</span>
                        {g.is_weekly_off ? (
                          <Badge variant="outline">Weekly off</Badge>
                        ) : (
                          <Badge variant="secondary">{g.shift_name || "—"}</Badge>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              {pattern?.steps?.length ? (
                <p className="mt-2 text-xs text-muted-foreground">
                  Pattern: {pattern.steps.length} step{pattern.steps.length === 1 ? "" : "s"} · {pattern.cycleType} cycle
                </p>
              ) : null}
            </div>

            {/* Audit */}
            <div>
              <h3 className="mb-2 text-sm font-semibold">History</h3>
              {events.length === 0 ? (
                <p className="text-sm text-muted-foreground">No recorded events for this membership.</p>
              ) : (
                <ul className="space-y-2">
                  {events.slice(0, 12).map((e, i) => (
                    <li key={i} className="rounded-lg border px-3 py-2 text-sm">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-medium">{e.summary}</span>
                        <span className="whitespace-nowrap text-xs text-muted-foreground">{fmt(e.created_at)}</span>
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {e.event_type}
                        {e.actor_name ? ` · ${e.actor_name}` : ""}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* Actions */}
            {canManage && (
              <div className="flex flex-wrap items-end gap-3 border-t pt-4">
                <div className="grid gap-1.5">
                  <label className="text-xs font-medium text-muted-foreground" htmlFor="roe-end">
                    End membership on
                  </label>
                  <Input
                    id="roe-end"
                    type="date"
                    value={endDate}
                    min={String(m.start_date).slice(0, 10)}
                    onChange={(e) => setEndDate(e.target.value)}
                    className="w-44"
                  />
                </div>
                <Button variant="outline" disabled={busy} onClick={endMembership}>
                  End membership
                </Button>
                {m.status === "Active" ? (
                  <Button variant="outline" disabled={busy} onClick={() => setStatus("Inactive")}>
                    Deactivate
                  </Button>
                ) : (
                  <Button variant="outline" disabled={busy} onClick={() => setStatus("Active")}>
                    Reactivate
                  </Button>
                )}
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-0.5">
      <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</span>
      <div className="text-sm">{children}</div>
    </div>
  )
}
