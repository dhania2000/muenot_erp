"use client"

import { useEffect, useMemo, useState } from "react"
import useSWR from "swr"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Checkbox } from "@/components/ui/checkbox"
import { Badge } from "@/components/ui/badge"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { AlertTriangle, CheckCircle2, XCircle, CalendarDays } from "lucide-react"
import { fetcher } from "@/lib/fetcher"

type ValidationMessage = { level: "error" | "warning"; code: string; message: string }
type Computation = { total: number; paidDays: number; lopDays: number; breakdown: { date: string; weekday: string; counted: number; reason: string }[] } | null

export function LeaveApplyDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: () => void
}) {
  const [selectedEmployee, setSelectedEmployee] = useState<string>("")
  const contextUrl = `/api/hr/leave-requests/context${selectedEmployee ? `?employee_id=${selectedEmployee}` : ""}`
  const { data: context } = useSWR<any>(open ? contextUrl : null, fetcher)

  const [leaveTypeId, setLeaveTypeId] = useState("")
  const [fromDate, setFromDate] = useState("")
  const [toDate, setToDate] = useState("")
  const [isHalfDay, setIsHalfDay] = useState(false)
  const [halfSession, setHalfSession] = useState("first")
  const [reason, setReason] = useState("")
  const [attachmentUrl, setAttachmentUrl] = useState("")
  const [validation, setValidation] = useState<{ errors: ValidationMessage[]; warnings: ValidationMessage[]; computation: Computation } | null>(null)
  const [validating, setValidating] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  const canManage = context?.canManage
  const leaveTypes = context?.leaveTypes || []
  const balances = context?.balances || {}
  const selectedType = leaveTypes.find((t: any) => t.leave_type_id === leaveTypeId)
  const balance = balances[leaveTypeId]

  // Reset when dialog closes.
  useEffect(() => {
    if (!open) {
      setLeaveTypeId("")
      setFromDate("")
      setToDate("")
      setIsHalfDay(false)
      setReason("")
      setAttachmentUrl("")
      setValidation(null)
      setSelectedEmployee("")
    }
  }, [open])

  // Half-day forces a single day.
  useEffect(() => {
    if (isHalfDay && fromDate) setToDate(fromDate)
  }, [isHalfDay, fromDate])

  const canValidate = Boolean(leaveTypeId && fromDate && toDate)

  // Debounced live validation.
  useEffect(() => {
    if (!open || !canValidate) {
      setValidation(null)
      return
    }
    const controller = new AbortController()
    const timer = setTimeout(async () => {
      setValidating(true)
      try {
        const res = await fetch("/api/hr/leave-requests/validate", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            employee_id: selectedEmployee || undefined,
            leave_type_id: leaveTypeId,
            from_date: fromDate,
            to_date: toDate,
            is_half_day: isHalfDay,
            half_day_session: isHalfDay ? halfSession : null,
            attachment_url: attachmentUrl || null,
          }),
          signal: controller.signal,
        })
        const json = await res.json()
        setValidation({ errors: json.errors || [], warnings: json.warnings || [], computation: json.computation || null })
      } catch (error) {
        if ((error as Error).name !== "AbortError") console.log("[v0] validate error", (error as Error).message)
      } finally {
        setValidating(false)
      }
    }, 350)
    return () => {
      controller.abort()
      clearTimeout(timer)
    }
  }, [open, canValidate, selectedEmployee, leaveTypeId, fromDate, toDate, isHalfDay, halfSession, attachmentUrl])

  const hasErrors = (validation?.errors?.length || 0) > 0
  const computation = validation?.computation

  const employeeLabel = useMemo(() => {
    if (!context?.employee) return null
    return `${context.employee.employee_name}${context.employee.department ? ` · ${context.employee.department}` : ""}`
  }, [context])

  async function submit() {
    if (!canValidate || hasErrors) return
    if (!reason.trim()) {
      toast.error("Please add a reason.")
      return
    }
    setSubmitting(true)
    try {
      const res = await fetch("/api/hr/leave-requests", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          employee_id: selectedEmployee || undefined,
          leave_type_id: leaveTypeId,
          from_date: fromDate,
          to_date: toDate,
          is_half_day: isHalfDay,
          half_day_session: isHalfDay ? halfSession : null,
          reason,
          attachment_url: attachmentUrl || null,
        }),
      })
      const json = await res.json()
      if (!res.ok) {
        toast.error(json.error || "Could not submit request.")
        if (json.validation) {
          setValidation({ errors: json.validation.errors || [], warnings: json.validation.warnings || [], computation: json.validation.computation || null })
        }
        return
      }
      toast.success(`Leave request ${json.request_id} submitted.`)
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
          <DialogTitle>Apply for leave</DialogTitle>
          <DialogDescription>
            {employeeLabel ? `Applying as ${employeeLabel}` : "Fill in the details below. Balances and policy checks update live."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {canManage && (
            <div className="space-y-1.5">
              <Label>Employee</Label>
              <Select value={selectedEmployee} onValueChange={(v) => setSelectedEmployee(v ?? "")}>
                <SelectTrigger>
                  <SelectValue placeholder="Apply on behalf of…" />
                </SelectTrigger>
                <SelectContent>
                  {(context?.employees || []).map((e: any) => (
                    <SelectItem key={e.id} value={String(e.id)}>
                      {e.employee_name}
                      {e.department ? ` · ${e.department}` : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="space-y-1.5">
            <Label>Leave type</Label>
            <Select value={leaveTypeId} onValueChange={(v) => setLeaveTypeId(v ?? "")}>
              <SelectTrigger>
                <SelectValue placeholder="Select leave type" />
              </SelectTrigger>
              <SelectContent>
                {leaveTypes.map((t: any) => (
                  <SelectItem key={t.leave_type_id} value={t.leave_type_id}>
                    {t.leave_type}
                    {t.paid ? "" : " (Unpaid)"}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {balance && (
              <p className="text-xs text-muted-foreground">
                Available <span className="font-medium text-foreground">{balance.available}</span> · Used {balance.used} · Pending {balance.pending}
              </p>
            )}
          </div>

          <div className="flex items-center gap-2">
            <Checkbox
              id="half-day"
              checked={isHalfDay}
              disabled={selectedType && !selectedType.allow_half_day}
              onCheckedChange={(v) => setIsHalfDay(Boolean(v))}
            />
            <Label htmlFor="half-day" className="cursor-pointer text-sm font-normal">
              Half day{selectedType && !selectedType.allow_half_day ? " (not allowed for this type)" : ""}
            </Label>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>From date</Label>
              <Input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>{isHalfDay ? "Session" : "To date"}</Label>
              {isHalfDay ? (
                <Select value={halfSession} onValueChange={(v) => setHalfSession(v ?? "first")}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="first">First half</SelectItem>
                    <SelectItem value="second">Second half</SelectItem>
                  </SelectContent>
                </Select>
              ) : (
                <Input type="date" value={toDate} min={fromDate} onChange={(e) => setToDate(e.target.value)} />
              )}
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>Reason</Label>
            <Textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why are you requesting leave?" rows={3} />
          </div>

          {selectedType?.requires_document ? (
            <div className="space-y-1.5">
              <Label>Supporting document URL</Label>
              <Input value={attachmentUrl} onChange={(e) => setAttachmentUrl(e.target.value)} placeholder="https://…" />
              <p className="text-xs text-muted-foreground">This leave type requires a document.</p>
            </div>
          ) : null}

          {/* Live computation + policy feedback */}
          {canValidate && (
            <div className="rounded-lg border bg-muted/30 p-3">
              <div className="flex items-center gap-2 text-sm font-medium">
                <CalendarDays className="h-4 w-4 text-muted-foreground" />
                {validating ? (
                  "Checking policy…"
                ) : computation ? (
                  <span>
                    {computation.total} day(s)
                    {computation.paidDays > 0 && <span className="text-muted-foreground"> · {computation.paidDays} paid</span>}
                    {computation.lopDays > 0 && <span className="text-amber-600"> · {computation.lopDays} LOP</span>}
                  </span>
                ) : (
                  "—"
                )}
              </div>

              {computation && computation.breakdown.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1">
                  {computation.breakdown.map((d) => (
                    <span
                      key={d.date}
                      title={`${d.weekday} — ${d.reason}`}
                      className={`rounded px-1.5 py-0.5 text-xs ${
                        d.counted > 0 ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground line-through"
                      }`}
                    >
                      {d.date.slice(5)}
                    </span>
                  ))}
                </div>
              )}

              {(validation?.errors?.length || validation?.warnings?.length) ? (
                <div className="mt-3 space-y-1.5">
                  {validation?.errors?.map((m, i) => (
                    <p key={`e${i}`} className="flex items-start gap-1.5 text-xs text-destructive">
                      <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                      {m.message}
                    </p>
                  ))}
                  {validation?.warnings?.map((m, i) => (
                    <p key={`w${i}`} className="flex items-start gap-1.5 text-xs text-amber-600">
                      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                      {m.message}
                    </p>
                  ))}
                </div>
              ) : computation && !validating ? (
                <p className="mt-2 flex items-center gap-1.5 text-xs text-emerald-600">
                  <CheckCircle2 className="h-3.5 w-3.5" />
                  Looks good — ready to submit.
                </p>
              ) : null}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!canValidate || hasErrors || submitting || validating}>
            {submitting ? "Submitting…" : "Submit request"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
