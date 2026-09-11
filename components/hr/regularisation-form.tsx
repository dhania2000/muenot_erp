"use client"

import { useEffect, useMemo, useState } from "react"
import useSWR from "swr"
import { toast } from "sonner"
import { fetcher } from "@/lib/fetcher"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { formatTime, statusVariant, ATTENDANCE_STATUSES } from "@/lib/attendance-ui"
import { ArrowRight, Loader2, Upload } from "lucide-react"

const CORRECTION_TYPES = [
  "Missing Clock In",
  "Missing Clock Out",
  "Incorrect Clock In",
  "Incorrect Clock Out",
  "Incorrect Status",
  "Missing Attendance",
  "Other Correction",
]

const REASON_PRESETS = [
  "Forgot to clock in",
  "Forgot to clock out",
  "Biometric machine unavailable",
  "Internet / network issue",
  "Field visit",
  "Official work outside office",
  "Other",
]

const KEEP = "__keep__"

type EmployeeOption = { id: number; employee_name: string; employee_id: string; department: string | null }
type SelfContext = { id: number; employee_name: string; employee_id: string; department: string | null } | null

type LookupResponse = {
  employee: { department: string | null; designation: string | null; reporting_manager: string | null; employment_status: string | null }
  shift: { name: string; start: string; end: string; isOvernight: boolean } | null
  attendance: { id: number; attendance_id: string; clock_in: string | null; clock_out: string | null; status: string; working_hours: number; workedHuman: string } | null
  dayContext: { dayType: string; onLeave: boolean; halfDayLeave: boolean; holidayName: string | null; isWeeklyOff: boolean }
  suggestedType: string
  pendingExists: boolean
  blocked: { reason: string } | null
  canManage: boolean
  history: { request_id: string; status: string; requested_clock_in: string | null; requested_clock_out: string | null }[]
}

/** MySQL DATETIME "YYYY-MM-DD HH:MM:SS" -> datetime-local "YYYY-MM-DDTHH:MM". */
function toLocalInput(value: string | null | undefined): string {
  if (!value) return ""
  const m = String(value).match(/(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})/)
  return m ? `${m[1]}T${m[2]}` : ""
}

export function RegularisationForm({
  canManage,
  employees,
  self,
  onSubmitted,
}: {
  canManage: boolean
  employees: EmployeeOption[]
  self: SelfContext
  onSubmitted: () => void
}) {
  const [employeeId, setEmployeeId] = useState(canManage ? "" : String(self?.id ?? ""))
  const [workDate, setWorkDate] = useState("")
  const [correctionType, setCorrectionType] = useState("")
  const [requestedIn, setRequestedIn] = useState("")
  const [requestedOut, setRequestedOut] = useState("")
  const [requestedStatus, setRequestedStatus] = useState("")
  const [reasonPreset, setReasonPreset] = useState("")
  const [reasonDetail, setReasonDetail] = useState("")
  const [attachment, setAttachment] = useState<{ path: string; name: string } | null>(null)
  const [uploading, setUploading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [seededKey, setSeededKey] = useState("")

  const targetEmployee = canManage ? employeeId : String(self?.id ?? "")
  const canLookup = Boolean(targetEmployee && workDate)

  const lookupKey = canLookup
    ? `/api/hr/attendance-regularisation/lookup?work_date=${workDate}${canManage ? `&employee_id=${targetEmployee}` : ""}`
    : null
  const { data: lookup, isLoading: lookupLoading } = useSWR<LookupResponse>(lookupKey, fetcher)

  // Seed the requested fields from the current attendance once per lookup so the
  // approver/employee edits real values instead of blank pickers. This effect
  // only mirrors already-fetched data into local state (no fetching).
  useEffect(() => {
    if (!lookup || !lookupKey || seededKey === lookupKey) return
    setSeededKey(lookupKey)
    setCorrectionType(lookup.suggestedType || "")
    setRequestedIn(toLocalInput(lookup.attendance?.clock_in))
    setRequestedOut(toLocalInput(lookup.attendance?.clock_out))
    setRequestedStatus("")
  }, [lookup, lookupKey, seededKey])

  const att = lookup?.attendance ?? null

  // Per-field change detection drives the highlight + the "no change" guard.
  const inChanged = toLocalInput(att?.clock_in) !== requestedIn
  const outChanged = toLocalInput(att?.clock_out) !== requestedOut
  const statusChanged = Boolean(requestedStatus) && requestedStatus !== (att?.status ?? "")
  const anyChange = inChanged || outChanged || statusChanged

  const dayBanner = useMemo(() => {
    if (!lookup) return null
    if (lookup.blocked) return { tone: "destructive", text: lookup.blocked.reason }
    if (lookup.pendingExists) return { tone: "secondary", text: "A pending regularisation already exists for this date." }
    const dc = lookup.dayContext
    if (dc.dayType === "Leave") return { tone: "secondary", text: "Employee is on approved leave for this date." }
    if (dc.halfDayLeave) return { tone: "secondary", text: "Employee is on approved half-day leave for this date." }
    if (dc.dayType === "Holiday") return { tone: "outline", text: `Holiday${dc.holidayName ? `: ${dc.holidayName}` : ""}.` }
    if (dc.dayType === "Weekly Off") return { tone: "outline", text: "This date is a weekly off." }
    if (!att) return { tone: "secondary", text: "No attendance record found for this date." }
    return null
  }, [lookup, att])

  async function upload(file: File) {
    setUploading(true)
    try {
      const fd = new FormData()
      fd.append("file", file)
      const r = await fetch("/api/hr/attendance-regularisation/upload", { method: "POST", body: fd })
      const json = await r.json()
      if (!r.ok) throw new Error(json.error || "Upload failed")
      setAttachment({ path: json.pathname, name: file.name })
      toast.success("Attachment uploaded")
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Upload failed")
    } finally {
      setUploading(false)
    }
  }

  function resetForm() {
    setWorkDate("")
    setCorrectionType("")
    setRequestedIn("")
    setRequestedOut("")
    setRequestedStatus("")
    setReasonPreset("")
    setReasonDetail("")
    setAttachment(null)
    setSeededKey("")
    if (canManage) setEmployeeId("")
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!targetEmployee) return toast.error("Select an employee.")
    if (!workDate) return toast.error("Select a work date.")
    if (lookup?.blocked && !canManage) return toast.error(lookup.blocked.reason)
    if (lookup?.pendingExists) return toast.error("A pending request already exists for this date.")
    if (!anyChange) return toast.error("Change at least one value before submitting.")
    if (!reasonPreset) return toast.error("Select a reason.")
    if (reasonPreset === "Other" && reasonDetail.trim().length < 3) return toast.error("Please explain the reason.")

    const reason =
      reasonPreset === "Other"
        ? reasonDetail.trim()
        : reasonDetail.trim()
          ? `${reasonPreset}: ${reasonDetail.trim()}`
          : reasonPreset

    setSubmitting(true)
    try {
      const r = await fetch("/api/hr/attendance-regularisation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          employee_id: canManage ? Number(targetEmployee) : undefined,
          work_date: workDate,
          correction_type: correctionType || undefined,
          requested_clock_in: requestedIn || null,
          requested_clock_out: requestedOut || null,
          requested_status: requestedStatus || null,
          reason,
          attachment_path: attachment?.path || null,
          attachment_name: attachment?.name || null,
        }),
      })
      const json = await r.json()
      if (!r.ok) throw new Error(json.error || "Could not submit request")
      toast.success(`Request ${json.requestId} submitted`)
      resetForm()
      onSubmitted()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not submit request")
    } finally {
      setSubmitting(false)
    }
  }

  const submitDisabled = submitting || Boolean(lookup?.pendingExists) || (canLookup && !anyChange)

  return (
    <form onSubmit={submit} className="grid gap-6 rounded-xl border bg-card p-5">
      {/* Who + when */}
      <div className="grid gap-4 md:grid-cols-2">
        <div className="grid gap-1.5">
          <Label>Employee</Label>
          {canManage ? (
            <Select value={employeeId} onValueChange={setEmployeeId}>
              <SelectTrigger>
                <SelectValue placeholder="Select employee" />
              </SelectTrigger>
              <SelectContent>
                {employees.map((emp) => (
                  <SelectItem key={emp.id} value={String(emp.id)}>
                    {emp.employee_name} ({emp.employee_id})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <div className="flex h-9 items-center rounded-md border bg-muted/40 px-3 text-sm">
              {self ? `${self.employee_name} (${self.employee_id})` : "No linked employee profile"}
            </div>
          )}
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="reg-work-date">Work date</Label>
          <Input id="reg-work-date" type="date" value={workDate} onChange={(e) => setWorkDate(e.target.value)} required />
        </div>
      </div>

      {!canLookup && (
        <p className="rounded-lg border border-dashed bg-muted/20 p-4 text-center text-sm text-muted-foreground">
          Select {canManage ? "an employee and " : ""}a work date to load the current attendance and propose changes.
        </p>
      )}

      {canLookup && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">Current → Requested</span>
              {anyChange && !lookupLoading ? (
                <Badge variant="default" className="text-[11px]">
                  {[inChanged && "In", outChanged && "Out", statusChanged && "Status"].filter(Boolean).join(" · ")} changed
                </Badge>
              ) : lookupLoading ? null : (
                <Badge variant="outline" className="text-[11px]">No changes yet</Badge>
              )}
            </div>
            {lookup?.shift && (
              <span className="text-xs text-muted-foreground">
                Shift: {lookup.shift.name} ({lookup.shift.start}–{lookup.shift.end})
                {lookup.shift.isOvernight ? " · overnight" : ""}
              </span>
            )}
          </div>

          {dayBanner && (
            <Badge variant={dayBanner.tone as never} className="whitespace-normal text-left">
              {dayBanner.text}
            </Badge>
          )}

          {lookupLoading ? (
            <div className="flex items-center gap-2 rounded-lg border bg-background/60 p-4 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Loading current attendance…
            </div>
          ) : (
            <div className="overflow-hidden rounded-lg border">
              {/* Column headers */}
              <div className="grid grid-cols-[100px_1fr_1fr] items-center gap-3 border-b bg-muted/40 px-4 py-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                <div>Field</div>
                <div>Current</div>
                <div className="flex items-center gap-1">
                  <ArrowRight className="size-3" /> Requested
                </div>
              </div>

              <CompareRow label="Clock in" changed={inChanged} current={formatTime(att?.clock_in)}>
                <Input
                  aria-label="Requested clock in"
                  type="datetime-local"
                  value={requestedIn}
                  onChange={(e) => setRequestedIn(e.target.value)}
                />
              </CompareRow>

              <CompareRow label="Clock out" changed={outChanged} current={formatTime(att?.clock_out)}>
                <Input
                  aria-label="Requested clock out"
                  type="datetime-local"
                  value={requestedOut}
                  onChange={(e) => setRequestedOut(e.target.value)}
                />
              </CompareRow>

              <CompareRow
                label="Status"
                changed={statusChanged}
                border={false}
                current={att ? <Badge variant={statusVariant(att.status)}>{att.status}</Badge> : "—"}
              >
                <Select value={requestedStatus || KEEP} onValueChange={(v) => setRequestedStatus(v === KEEP ? "" : v)}>
                  <SelectTrigger aria-label="Requested status">
                    <SelectValue placeholder="Keep computed status" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={KEEP}>Keep computed status</SelectItem>
                    {ATTENDANCE_STATUSES.map((s) => (
                      <SelectItem key={s} value={s}>
                        {s}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </CompareRow>
            </div>
          )}

          {/* Correction type + reason */}
          <div className="grid gap-4 md:grid-cols-2">
            <div className="grid gap-1.5">
              <Label>Correction type</Label>
              <Select value={correctionType} onValueChange={setCorrectionType}>
                <SelectTrigger>
                  <SelectValue placeholder="Select correction type" />
                </SelectTrigger>
                <SelectContent>
                  {CORRECTION_TYPES.map((t) => (
                    <SelectItem key={t} value={t}>
                      {t}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label>Reason</Label>
              <Select value={reasonPreset} onValueChange={setReasonPreset}>
                <SelectTrigger>
                  <SelectValue placeholder="Select a reason" />
                </SelectTrigger>
                <SelectContent>
                  {REASON_PRESETS.map((r) => (
                    <SelectItem key={r} value={r}>
                      {r}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="reg-reason-detail">
              {reasonPreset === "Other" ? "Explain the reason" : "Additional details (optional)"}
            </Label>
            <Textarea
              id="reg-reason-detail"
              rows={2}
              value={reasonDetail}
              onChange={(e) => setReasonDetail(e.target.value)}
              placeholder={reasonPreset === "Other" ? "Describe what needs correcting and why" : "Any extra context for the approver"}
            />
          </div>

          {/* Attachment */}
          <div className="grid gap-1.5">
            <Label htmlFor="reg-attach">Supporting document (optional)</Label>
            <div className="flex items-center gap-2">
              <Input
                id="reg-attach"
                type="file"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0]
                  if (f) upload(f)
                }}
              />
              <Button type="button" variant="outline" size="sm" disabled={uploading} onClick={() => document.getElementById("reg-attach")?.click()}>
                {uploading ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />}
                {attachment ? "Replace file" : "Upload file"}
              </Button>
              {attachment && <span className="truncate text-xs text-muted-foreground">{attachment.name}</span>}
            </div>
          </div>
        </div>
      )}

      <div className="flex items-center justify-end gap-2">
        <Button type="button" variant="ghost" onClick={resetForm} disabled={submitting}>
          Clear
        </Button>
        <Button type="submit" disabled={submitDisabled}>
          {submitting && <Loader2 className="size-4 animate-spin" />}
          Submit request
        </Button>
      </div>
    </form>
  )
}

/** A single Field / Current / Requested row in the comparison grid. */
function CompareRow({
  label,
  current,
  changed,
  border = true,
  children,
}: {
  label: string
  current: React.ReactNode
  changed: boolean
  border?: boolean
  children: React.ReactNode
}) {
  return (
    <div
      className={`grid grid-cols-[100px_1fr_1fr] items-center gap-3 px-4 py-3 ${border ? "border-b" : ""} ${
        changed ? "bg-primary/5" : ""
      }`}
    >
      <div className="text-sm text-muted-foreground">{label}</div>
      <div className="text-sm font-medium tabular-nums">{current}</div>
      <div>{children}</div>
    </div>
  )
}
