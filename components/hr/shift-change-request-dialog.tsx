"use client"

import { useEffect, useMemo, useState } from "react"
import useSWR from "swr"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Checkbox } from "@/components/ui/checkbox"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { AlertTriangle, ArrowRight, CheckCircle2, XCircle } from "lucide-react"
import { fetcher } from "@/lib/fetcher"
import { shiftTimeLabel } from "./shift-change-status"

const REASON_CATEGORIES = [
  "Personal",
  "Medical",
  "Commute / Transport",
  "Childcare / Family",
  "Team Requirement",
  "Client Timezone",
  "Other",
] as const

type ConflictReport = {
  errors: string[]
  warnings: string[]
  overlappingRequests: any[]
  conflictingAssignments: any[]
  rotationConflict: { rotationName: string; rotationShift: string } | null
} | null

export function ShiftChangeRequestDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: () => void
}) {
  const [selectedEmployee, setSelectedEmployee] = useState("")
  const [requestedShiftId, setRequestedShiftId] = useState("")
  const [changeType, setChangeType] = useState<"Permanent" | "Temporary">("Permanent")
  const [fromDate, setFromDate] = useState("")
  const [toDate, setToDate] = useState("")
  const [reasonCategory, setReasonCategory] = useState("")
  const [reason, setReason] = useState("")
  const [attachmentUrl, setAttachmentUrl] = useState("")
  const [isOverride, setIsOverride] = useState(false)
  const [overrideReason, setOverrideReason] = useState("")
  const [submitting, setSubmitting] = useState(false)

  // Server-derived employee/shift context + live conflict preview.
  const params = new URLSearchParams()
  if (selectedEmployee) params.set("employee_id", selectedEmployee)
  if (fromDate) params.set("date", fromDate)
  if (requestedShiftId) params.set("requested_shift_id", requestedShiftId)
  if (changeType === "Temporary" && toDate) params.set("to_date", toDate)
  const { data: ctx } = useSWR<any>(open ? `/api/hr/shift-change-requests/context?${params.toString()}` : null, fetcher)

  const canManage = ctx?.canManage
  const canOverride = Boolean(ctx?.canManage) // override eligibility surfaced through manage context
  const shifts = ctx?.shifts || []
  const context = ctx?.context
  const currentShift = context?.currentShift
  const rotation = context?.rotation
  const conflicts: ConflictReport = ctx?.conflicts || null
  const requestedShift = shifts.find((s: any) => String(s.id) === requestedShiftId)

  useEffect(() => {
    if (!open) {
      setSelectedEmployee("")
      setRequestedShiftId("")
      setChangeType("Permanent")
      setFromDate("")
      setToDate("")
      setReasonCategory("")
      setReason("")
      setAttachmentUrl("")
      setIsOverride(false)
      setOverrideReason("")
    }
  }, [open])

  // Permanent changes have no end date.
  useEffect(() => {
    if (changeType === "Permanent") setToDate("")
  }, [changeType])

  const employeeLabel = useMemo(() => {
    if (!context?.employee) return null
    const e = context.employee
    return `${e.employee_name}${e.department ? ` · ${e.department}` : ""}`
  }, [context])

  const hardConflicts = (conflicts?.errors?.length || 0) > 0
  const advisoryConflicts = (conflicts?.warnings?.length || 0) > 0

  const missingFields =
    (canManage && !selectedEmployee) ||
    !requestedShiftId ||
    !fromDate ||
    (changeType === "Temporary" && !toDate) ||
    !reason.trim()

  const blockedByConflict = hardConflicts && !isOverride

  async function submit() {
    if (missingFields) {
      toast.error("Please complete the required fields.")
      return
    }
    if (isOverride && !overrideReason.trim()) {
      toast.error("An override reason is required.")
      return
    }
    setSubmitting(true)
    try {
      const res = await fetch("/api/hr/shift-change-requests", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          employee_id: canManage ? selectedEmployee || undefined : undefined,
          requested_shift_id: requestedShiftId,
          change_type: changeType,
          from_date: fromDate,
          to_date: changeType === "Temporary" ? toDate : null,
          reason_category: reasonCategory || null,
          reason,
          attachment_url: attachmentUrl || null,
          is_override: isOverride,
          override_reason: isOverride ? overrideReason : null,
        }),
      })
      const json = await res.json()
      if (!res.ok) {
        toast.error(json.error || "Could not submit request.")
        return
      }
      toast.success(`Shift change request ${json.request_id} submitted.`)
      onCreated()
      onOpenChange(false)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>New shift change request</DialogTitle>
          <DialogDescription>
            {employeeLabel
              ? `Requesting for ${employeeLabel}`
              : "The current shift, approver and conflicts are resolved automatically."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {canManage && (
            <div className="space-y-1.5">
              <Label>Employee</Label>
              <Select value={selectedEmployee} onValueChange={(v) => setSelectedEmployee(v ?? "")}>
                <SelectTrigger>
                  <SelectValue placeholder="Request on behalf of…" />
                </SelectTrigger>
                <SelectContent>
                  {(ctx?.employees || []).map((e: any) => (
                    <SelectItem key={e.id} value={String(e.id)}>
                      {e.employee_name}
                      {e.department ? ` · ${e.department}` : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {/* Current vs requested comparison */}
          <div className="grid gap-3 sm:grid-cols-[1fr_auto_1fr] sm:items-stretch">
            <div className="rounded-lg border bg-muted/30 p-3">
              <p className="text-xs font-medium uppercase text-muted-foreground">Current shift</p>
              <p className="mt-1 font-medium">{currentShift?.shift_name || "Not assigned"}</p>
              <p className="text-sm text-muted-foreground">
                {shiftTimeLabel(currentShift?.start_time, currentShift?.end_time, currentShift?.is_overnight)}
              </p>
              {rotation?.name && (
                <p className="mt-1 text-xs text-muted-foreground">
                  Rotation: {rotation.name}
                  {rotation.shift ? ` (${rotation.shift})` : ""}
                </p>
              )}
            </div>
            <div className="hidden items-center justify-center sm:flex">
              <ArrowRight className="h-5 w-5 text-muted-foreground" />
            </div>
            <div className="rounded-lg border border-primary/40 bg-primary/5 p-3">
              <p className="text-xs font-medium uppercase text-muted-foreground">Requested shift</p>
              <p className="mt-1 font-medium">{requestedShift?.shift_name || "Select a shift"}</p>
              <p className="text-sm text-muted-foreground">
                {shiftTimeLabel(requestedShift?.start_time, requestedShift?.end_time, requestedShift?.is_overnight)}
              </p>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>Requested shift</Label>
            <Select value={requestedShiftId} onValueChange={(v) => setRequestedShiftId(v ?? "")}>
              <SelectTrigger>
                <SelectValue placeholder="Select the shift to move to" />
              </SelectTrigger>
              <SelectContent>
                {shifts.map((s: any) => (
                  <SelectItem key={s.id} value={String(s.id)}>
                    {s.shift_name} · {shiftTimeLabel(s.start_time, s.end_time, s.is_overnight)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label>Change type</Label>
              <Select value={changeType} onValueChange={(v) => setChangeType((v as "Permanent" | "Temporary") ?? "Permanent")}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="Permanent">Permanent</SelectItem>
                  <SelectItem value="Temporary">Temporary</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Effective from</Label>
              <Input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>{changeType === "Temporary" ? "Effective to" : "Ends"}</Label>
              {changeType === "Temporary" ? (
                <Input type="date" value={toDate} min={fromDate} onChange={(e) => setToDate(e.target.value)} />
              ) : (
                <Input value="Onward" disabled />
              )}
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Reason category</Label>
              <Select value={reasonCategory} onValueChange={(v) => setReasonCategory(v ?? "")}>
                <SelectTrigger>
                  <SelectValue placeholder="Select a category" />
                </SelectTrigger>
                <SelectContent>
                  {REASON_CATEGORIES.map((c) => (
                    <SelectItem key={c} value={c}>
                      {c}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Attachment URL (optional)</Label>
              <Input value={attachmentUrl} onChange={(e) => setAttachmentUrl(e.target.value)} placeholder="https://…" />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>Reason</Label>
            <Textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Explain why this shift change is needed…"
              rows={3}
            />
          </div>

          {/* Live conflict preview */}
          {requestedShiftId && fromDate && conflicts && (
            <div className="rounded-lg border bg-muted/30 p-3">
              {conflicts.errors.length || conflicts.warnings.length ? (
                <div className="space-y-1.5">
                  {conflicts.errors.map((m, i) => (
                    <p key={`e${i}`} className="flex items-start gap-1.5 text-xs text-destructive">
                      <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                      {m}
                    </p>
                  ))}
                  {conflicts.warnings.map((m, i) => (
                    <p key={`w${i}`} className="flex items-start gap-1.5 text-xs text-amber-600">
                      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                      {m}
                    </p>
                  ))}
                </div>
              ) : (
                <p className="flex items-center gap-1.5 text-xs text-emerald-600">
                  <CheckCircle2 className="h-3.5 w-3.5" />
                  No conflicts detected — ready to submit.
                </p>
              )}
            </div>
          )}

          {/* Override (privileged) */}
          {canOverride && (hardConflicts || advisoryConflicts) && (
            <div className="space-y-2 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3">
              <div className="flex items-center gap-2">
                <Checkbox id="scr-override" checked={isOverride} onCheckedChange={(v) => setIsOverride(Boolean(v))} />
                <Label htmlFor="scr-override" className="cursor-pointer text-sm font-normal">
                  Override conflicts / policy (records a justification)
                </Label>
              </div>
              {isOverride && (
                <Textarea
                  value={overrideReason}
                  onChange={(e) => setOverrideReason(e.target.value)}
                  placeholder="Why is an override warranted?"
                  rows={2}
                />
              )}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={submitting || missingFields || blockedByConflict}>
            {submitting ? "Submitting…" : "Submit request"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
