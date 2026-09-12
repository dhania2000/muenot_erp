"use client"

import { useState } from "react"
import useSWR from "swr"
import { fetcher } from "@/lib/fetcher"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Checkbox } from "@/components/ui/checkbox"
import { Badge } from "@/components/ui/badge"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { AlertTriangle, ArrowRight, Loader2 } from "lucide-react"
import { toast } from "sonner"

const today = () => new Date().toISOString().slice(0, 10)

function shiftTime(s?: { start_time?: string; end_time?: string; is_overnight?: boolean } | null) {
  if (!s || !s.start_time) return "—"
  return `${s.start_time}–${s.end_time}${s.is_overnight ? " (+1)" : ""}`
}

export function ShiftAssignmentCreateDialog({
  open,
  onOpenChange,
  onCreated,
  canOverride,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  onCreated: () => void
  canOverride: boolean
}) {
  const [employeeId, setEmployeeId] = useState<string>("")
  const [shiftId, setShiftId] = useState<string>("")
  const [changeType, setChangeType] = useState<"Permanent" | "Temporary">("Permanent")
  const [from, setFrom] = useState(today())
  const [to, setTo] = useState("")
  const [notes, setNotes] = useState("")
  const [override, setOverride] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  // Base context (employee directory + active shift master) — always loaded.
  const { data: base } = useSWR<any>(open ? "/api/hr/shift-assignments/context" : null, fetcher)

  // Live derived context for the selected employee + candidate shift/date range.
  const ctxParams = new URLSearchParams()
  if (employeeId) ctxParams.set("employee_id", employeeId)
  if (from) ctxParams.set("date", from)
  if (shiftId) ctxParams.set("shift_id", shiftId)
  if (to) ctxParams.set("to_date", to)
  ctxParams.set("change_type", changeType)
  const { data: ctx, isLoading: ctxLoading } = useSWR<any>(
    open && employeeId ? `/api/hr/shift-assignments/context?${ctxParams.toString()}` : null,
    fetcher,
  )

  const employees = base?.employees || []
  const shifts = base?.shifts || []
  const info = ctx?.context
  const currentShift = info?.currentShift
  const upcoming = info?.upcoming
  const conflicts = ctx?.conflicts
  const hasHardConflict = Boolean(conflicts?.errors?.length)
  const hasWarning = Boolean(conflicts?.warnings?.length)

  function reset() {
    setEmployeeId(""); setShiftId(""); setChangeType("Permanent"); setFrom(today()); setTo(""); setNotes(""); setOverride(false)
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!employeeId) return toast.error("Select an employee.")
    if (!shiftId) return toast.error("Select the new shift.")
    if (!notes.trim()) return toast.error("A reason / note is required.")
    if (changeType === "Temporary" && !to) return toast.error("Effective To is required for a temporary assignment.")

    setSubmitting(true)
    try {
      const res = await fetch("/api/hr/shift-assignments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          employee_id: Number(employeeId),
          shift_id: Number(shiftId),
          change_type: changeType,
          effective_from: from,
          effective_to: changeType === "Temporary" ? to : to || null,
          notes,
          is_override: override,
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        toast.error(data.error || "Could not create the assignment.")
        return
      }
      toast.success(`Assignment ${data.assignment_id} created.`)
      reset()
      onOpenChange(false)
      onCreated()
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { onOpenChange(v); if (!v) reset() }}>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Assign shift</DialogTitle>
          <DialogDescription>
            Everything except the effective period is pulled from the Employees and Shift masters — nothing is typed twice.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={submit} className="grid gap-4">
          <div className="grid gap-1.5">
            <Label htmlFor="asg-emp">Employee</Label>
            <Select value={employeeId} onValueChange={(v) => setEmployeeId(v ?? "")}>
              <SelectTrigger id="asg-emp">
                <SelectValue placeholder="Select an employee" />
              </SelectTrigger>
              <SelectContent>
                {employees.map((e: any) => (
                  <SelectItem key={e.id} value={String(e.id)}>
                    {e.employee_name} · {e.employee_id}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Auto-resolved employee facts + current applicable shift (read-only). */}
          {employeeId && (
            <div className="rounded-lg border bg-muted/40 p-3 text-sm">
              {ctxLoading && !info ? (
                <div className="flex items-center gap-2 text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" /> Resolving current shift…
                </div>
              ) : info ? (
                <div className="grid gap-2">
                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                    <span>{info.employee.department || "—"}</span>
                    <span>{info.employee.designation || "—"}</span>
                    <span>Mgr: {info.employee.reporting_manager || "—"}</span>
                    <span>Status: {info.employee.employment_status || "—"}</span>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-muted-foreground">Current shift (on {from})</span>
                    <span className="font-medium">
                      {currentShift ? `${currentShift.shift_name} · ${shiftTime(currentShift)}` : "No applicable shift"}
                    </span>
                  </div>
                  {upcoming && (
                    <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                      <span>Upcoming</span>
                      <span>{upcoming.shift_name} from {String(upcoming.effective_from).slice(0, 10)}</span>
                    </div>
                  )}
                </div>
              ) : null}
            </div>
          )}

          <div className="grid gap-1.5">
            <Label htmlFor="asg-shift">New shift</Label>
            <Select value={shiftId} onValueChange={(v) => setShiftId(v ?? "")}>
              <SelectTrigger id="asg-shift">
                <SelectValue placeholder="Select the new shift" />
              </SelectTrigger>
              <SelectContent>
                {shifts.map((s: any) => (
                  <SelectItem key={s.id} value={String(s.id)}>
                    {s.shift_name} · {shiftTime(s)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {shiftId && currentShift && (
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                {currentShift.shift_name} <ArrowRight className="size-3" />{" "}
                {shifts.find((s: any) => String(s.id) === shiftId)?.shift_name}
              </p>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="asg-type">Assignment type</Label>
              <Select value={changeType} onValueChange={(v) => setChangeType((v as "Permanent" | "Temporary") ?? "Permanent")}>
                <SelectTrigger id="asg-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="Permanent">Permanent</SelectItem>
                  <SelectItem value="Temporary">Temporary</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="asg-from">Effective from</Label>
              <Input id="asg-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} required />
            </div>
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="asg-to">
              Effective to {changeType === "Temporary" ? "" : <span className="text-muted-foreground">(optional)</span>}
            </Label>
            <Input
              id="asg-to"
              type="date"
              value={to}
              min={from}
              onChange={(e) => setTo(e.target.value)}
              required={changeType === "Temporary"}
            />
            {changeType === "Temporary" && (
              <p className="text-xs text-muted-foreground">
                After this date the employee automatically resolves back to their previous applicable shift.
              </p>
            )}
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="asg-notes">Reason / notes</Label>
            <Textarea
              id="asg-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Why is this assignment being made?"
              rows={2}
              required
            />
          </div>

          {(hasHardConflict || hasWarning) && (
            <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
              <div className="flex items-center gap-2 font-medium text-amber-600 dark:text-amber-400">
                <AlertTriangle className="size-4" />
                {hasHardConflict ? "Conflict detected" : "Advisory"}
              </div>
              <ul className="mt-1 list-inside list-disc text-xs text-muted-foreground">
                {conflicts.errors?.map((m: string, i: number) => <li key={`e${i}`}>{m}</li>)}
                {conflicts.warnings?.map((m: string, i: number) => <li key={`w${i}`}>{m}</li>)}
              </ul>
              {hasHardConflict && canOverride && (
                <label className="mt-2 flex items-center gap-2 text-xs">
                  <Checkbox checked={override} onCheckedChange={(v) => setOverride(Boolean(v))} />
                  Override the conflict (authorized).
                </label>
              )}
            </div>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={submitting || (hasHardConflict && !override)}>
              {submitting && <Loader2 className="mr-2 size-4 animate-spin" />}
              Assign shift
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
