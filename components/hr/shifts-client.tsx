"use client"

import { useMemo, useState } from "react"
import useSWR from "swr"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Checkbox } from "@/components/ui/checkbox"
import { Textarea } from "@/components/ui/textarea"
import { Separator } from "@/components/ui/separator"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { fetcher } from "@/lib/fetcher"
import { ExcelExportButton } from "@/components/excel-export-button"
import { ImportButton } from "@/components/import-button"
import { ShiftDetail } from "@/components/hr/shift-detail"
import {
  WEEKDAYS,
  OT_ROUNDING_OPTIONS,
  computeShiftHours,
  grossMinutes,
  overtimeStartLabel,
  formatDurationHours,
  formatWorkingDays,
  parseDayList,
  weeklyOffsFromWorkingDays,
  validateShiftInput,
} from "@/lib/shift-ui"

type Shift = Record<string, any>

type FormState = {
  id?: number
  shift_code: string
  shift_name: string
  start_time: string
  end_time: string
  is_overnight: boolean
  break_minutes: string
  grace_minutes: string
  late_enabled: boolean
  early_checkout_enabled: boolean
  early_grace_minutes: string
  overtime_enabled: boolean
  overtime_eligible: boolean
  overtime_threshold_minutes: string
  overtime_rounding_minutes: string
  working_days: number[]
  effective_from: string
  effective_until: string
  status: string
  description: string
}

const EMPTY_FORM: FormState = {
  shift_code: "",
  shift_name: "",
  start_time: "09:00",
  end_time: "18:00",
  is_overnight: false,
  break_minutes: "60",
  grace_minutes: "10",
  late_enabled: true,
  early_checkout_enabled: true,
  early_grace_minutes: "10",
  overtime_enabled: false,
  overtime_eligible: true,
  overtime_threshold_minutes: "0",
  overtime_rounding_minutes: "0",
  working_days: [1, 2, 3, 4, 5],
  effective_from: "",
  effective_until: "",
  status: "Active",
  description: "",
}

function toForm(row: Shift): FormState {
  const workingDays = parseDayList(row.working_days)
  return {
    id: Number(row.id),
    shift_code: row.shift_code ?? "",
    shift_name: row.shift_name ?? "",
    start_time: String(row.start_time ?? "09:00").slice(0, 5),
    end_time: String(row.end_time ?? "18:00").slice(0, 5),
    is_overnight: Boolean(Number(row.is_overnight)),
    break_minutes: String(row.break_minutes ?? 0),
    grace_minutes: String(row.grace_minutes ?? 10),
    late_enabled: row.late_enabled === undefined ? true : Boolean(Number(row.late_enabled)),
    early_checkout_enabled: row.early_checkout_enabled === undefined ? true : Boolean(Number(row.early_checkout_enabled)),
    early_grace_minutes: String(row.early_grace_minutes ?? row.grace_minutes ?? 10),
    overtime_enabled: Boolean(Number(row.overtime_enabled)),
    overtime_eligible: row.overtime_eligible === undefined ? true : Boolean(Number(row.overtime_eligible)),
    overtime_threshold_minutes: String(row.overtime_threshold_minutes ?? 0),
    overtime_rounding_minutes: String(row.overtime_rounding_minutes ?? 0),
    working_days: workingDays.length ? workingDays : [1, 2, 3, 4, 5],
    effective_from: row.effective_from ? String(row.effective_from).slice(0, 10) : "",
    effective_until: row.effective_until ? String(row.effective_until).slice(0, 10) : "",
    status: row.status ?? "Active",
    description: row.description ?? "",
  }
}

type SortKey = "shift_name" | "start_time" | "working_hours" | "active_assignments" | "status"

export function ShiftsClient() {
  const { data, mutate } = useSWR<{ shifts: Shift[] }>("/api/hr/shifts", fetcher)

  const [search, setSearch] = useState("")
  const [statusFilter, setStatusFilter] = useState("all")
  const [overtimeFilter, setOvertimeFilter] = useState("all")
  const [sortKey, setSortKey] = useState<SortKey>("shift_name")
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc")

  const [formOpen, setFormOpen] = useState(false)
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [reason, setReason] = useState("")
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [detailId, setDetailId] = useState<number | null>(null)
  const [detailOpen, setDetailOpen] = useState(false)

  const isEdit = form.id !== undefined
  const editingRow = useMemo(
    () => (isEdit ? data?.shifts.find((s) => Number(s.id) === form.id) : undefined),
    [data, form.id, isEdit],
  )
  const assignedCount = Number(editingRow?.active_assignments ?? 0)

  const shifts = useMemo(() => {
    let rows = data?.shifts ?? []
    const q = search.trim().toLowerCase()
    if (q) {
      rows = rows.filter((s) =>
        `${s.shift_id} ${s.shift_code ?? ""} ${s.shift_name}`.toLowerCase().includes(q),
      )
    }
    if (statusFilter !== "all") rows = rows.filter((s) => s.status === statusFilter)
    if (overtimeFilter !== "all") {
      const want = overtimeFilter === "yes"
      rows = rows.filter((s) => Boolean(Number(s.overtime_enabled)) === want)
    }
    const dir = sortDir === "asc" ? 1 : -1
    return [...rows].sort((a, b) => {
      const av = a[sortKey]
      const bv = b[sortKey]
      if (sortKey === "working_hours" || sortKey === "active_assignments") {
        return (Number(av || 0) - Number(bv || 0)) * dir
      }
      return String(av ?? "").localeCompare(String(bv ?? "")) * dir
    })
  }, [data, search, statusFilter, overtimeFilter, sortKey, sortDir])

  // Live preview — computed with the exact helpers the server uses.
  const breakMin = Number(form.break_minutes || 0)
  const gross = grossMinutes(form.start_time, form.end_time, form.is_overnight)
  const netHours = computeShiftHours(form.start_time, form.end_time, breakMin, form.is_overnight)
  const weeklyOffs = weeklyOffsFromWorkingDays(form.working_days)
  const previewError = validateShiftInput({
    shift_name: form.shift_name,
    start_time: form.start_time,
    end_time: form.end_time,
    is_overnight: form.is_overnight,
    break_minutes: breakMin,
    grace_minutes: Number(form.grace_minutes || 0),
    early_grace_minutes: Number(form.early_grace_minutes || 0),
    overtime_enabled: form.overtime_enabled,
    overtime_threshold_minutes: Number(form.overtime_threshold_minutes || 0),
    overtime_rounding_minutes: Number(form.overtime_rounding_minutes || 0),
    effective_from: form.effective_from || null,
    effective_until: form.effective_until || null,
  })

  function openAdd() {
    setForm(EMPTY_FORM)
    setReason("")
    setError(null)
    setFormOpen(true)
  }

  function openEdit(row: Shift) {
    setForm(toForm(row))
    setReason("")
    setError(null)
    setFormOpen(true)
  }

  function openDetail(id: number) {
    setDetailId(id)
    setDetailOpen(true)
  }

  function toggleDay(num: number) {
    setForm((f) => ({
      ...f,
      working_days: f.working_days.includes(num)
        ? f.working_days.filter((d) => d !== num)
        : [...f.working_days, num].sort((a, b) => a - b),
    }))
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (previewError) {
      setError(previewError)
      return
    }
    setSaving(true)
    setError(null)
    const payload: Record<string, any> = {
      ...form,
      break_minutes: Number(form.break_minutes || 0),
      grace_minutes: Number(form.grace_minutes || 0),
      early_grace_minutes: Number(form.early_grace_minutes || 0),
      overtime_threshold_minutes: Number(form.overtime_threshold_minutes || 0),
      overtime_rounding_minutes: Number(form.overtime_rounding_minutes || 0),
      effective_from: form.effective_from || null,
      effective_until: form.effective_until || null,
      reason: reason || undefined,
    }
    try {
      const res = await fetch("/api/hr/shifts", {
        method: isEdit ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(json.error || "Unable to save shift")
        return
      }
      setFormOpen(false)
      setForm(EMPTY_FORM)
      mutate()
    } finally {
      setSaving(false)
    }
  }

  async function toggleStatus(row: Shift) {
    const next = row.status === "Active" ? "Inactive" : "Active"
    await fetch("/api/hr/shifts", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: row.id, status: next }),
    })
    mutate()
  }

  function sortBy(key: SortKey) {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"))
    else {
      setSortKey(key)
      setSortDir("asc")
    }
  }

  const sortArrow = (key: SortKey) => (sortKey === key ? (sortDir === "asc" ? " ↑" : " ↓") : "")

  return (
    <main className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-sm text-muted-foreground">HR / Workforce</p>
          <h1 className="text-3xl font-semibold tracking-tight">Shifts</h1>
          <p className="text-muted-foreground">Configure working schedules, breaks, grace, and overtime policy.</p>
        </div>
        <Button onClick={openAdd}>Add shift</Button>
      </header>

      <div className="flex flex-wrap items-center gap-3">
        <Input
          placeholder="Search by name or code…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="max-w-xs"
        />
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-36">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="Active">Active</SelectItem>
            <SelectItem value="Inactive">Inactive</SelectItem>
          </SelectContent>
        </Select>
        <Select value={overtimeFilter} onValueChange={setOvertimeFilter}>
          <SelectTrigger className="w-40">
            <SelectValue placeholder="Overtime" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All shifts</SelectItem>
            <SelectItem value="yes">Overtime on</SelectItem>
            <SelectItem value="no">Overtime off</SelectItem>
          </SelectContent>
        </Select>
        <div className="ml-auto flex items-center gap-3">
          <ImportButton moduleKey="hr-shifts" onImported={mutate} />
          <ExcelExportButton
            rows={shifts}
            filename="shifts"
            columns={[
              { header: "Shift ID", value: (r: any) => r.shift_id },
              { header: "Shift Code", value: (r: any) => r.shift_code ?? "" },
              { header: "Shift Name", value: (r: any) => r.shift_name },
              { header: "Start Time", value: (r: any) => String(r.start_time).slice(0, 5) },
              { header: "End Time", value: (r: any) => String(r.end_time).slice(0, 5) },
              { header: "Overnight", value: (r: any) => (Number(r.is_overnight) ? "Yes" : "No") },
              { header: "Break Minutes", value: (r: any) => r.break_minutes },
              { header: "Net Working Hours", value: (r: any) => r.working_hours },
              { header: "Grace Minutes", value: (r: any) => r.grace_minutes },
              { header: "Late Tracking", value: (r: any) => (Number(r.late_enabled) ? "Yes" : "No") },
              { header: "Early Checkout Rule", value: (r: any) => (Number(r.early_checkout_enabled) ? "Yes" : "No") },
              { header: "Early Grace Minutes", value: (r: any) => r.early_grace_minutes },
              { header: "Overtime Enabled", value: (r: any) => (Number(r.overtime_enabled) ? "Yes" : "No") },
              { header: "Overtime Eligible", value: (r: any) => (Number(r.overtime_eligible) ? "Yes" : "No") },
              { header: "Overtime Threshold", value: (r: any) => r.overtime_threshold_minutes },
              { header: "Overtime Rounding", value: (r: any) => r.overtime_rounding_minutes },
              { header: "Working Days", value: (r: any) => formatWorkingDays(parseDayList(r.working_days)) },
              { header: "Effective From", value: (r: any) => (r.effective_from ? String(r.effective_from).slice(0, 10) : "") },
              { header: "Effective Until", value: (r: any) => (r.effective_until ? String(r.effective_until).slice(0, 10) : "") },
              { header: "Assigned (Active)", value: (r: any) => r.active_assignments ?? 0 },
              { header: "Status", value: (r: any) => r.status },
              { header: "Description", value: (r: any) => r.description ?? "" },
            ]}
          />
        </div>
      </div>

      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left text-xs uppercase text-muted-foreground">
            <tr>
              <th className="cursor-pointer px-4 py-3" onClick={() => sortBy("shift_name")}>
                Shift{sortArrow("shift_name")}
              </th>
              <th className="cursor-pointer px-4 py-3" onClick={() => sortBy("start_time")}>
                Timing{sortArrow("start_time")}
              </th>
              <th className="cursor-pointer px-4 py-3" onClick={() => sortBy("working_hours")}>
                Net hours{sortArrow("working_hours")}
              </th>
              <th className="px-4 py-3">Working days</th>
              <th className="px-4 py-3">Overtime</th>
              <th className="cursor-pointer px-4 py-3" onClick={() => sortBy("active_assignments")}>
                Assigned{sortArrow("active_assignments")}
              </th>
              <th className="cursor-pointer px-4 py-3" onClick={() => sortBy("status")}>
                Status{sortArrow("status")}
              </th>
              <th className="px-4 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {shifts.map((row) => (
              <tr
                key={row.id}
                className="cursor-pointer border-t transition-colors hover:bg-muted/40"
                onClick={() => openDetail(Number(row.id))}
              >
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2 font-medium">
                    {row.shift_name}
                    {Number(row.is_overnight) ? <Badge variant="outline">Overnight</Badge> : null}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {row.shift_id}
                    {row.shift_code ? ` · ${row.shift_code}` : ""}
                  </div>
                </td>
                <td className="px-4 py-3 tabular-nums">
                  {String(row.start_time).slice(0, 5)} – {String(row.end_time).slice(0, 5)}
                </td>
                <td className="px-4 py-3 tabular-nums">{formatDurationHours(Number(row.working_hours || 0))}</td>
                <td className="px-4 py-3">{formatWorkingDays(parseDayList(row.working_days))}</td>
                <td className="px-4 py-3">
                  {Number(row.overtime_enabled) ? (
                    <Badge variant={Number(row.overtime_eligible) ? "default" : "secondary"}>
                      {Number(row.overtime_eligible) ? "Eligible" : "Disabled"}
                    </Badge>
                  ) : (
                    <span className="text-muted-foreground">Off</span>
                  )}
                </td>
                <td className="px-4 py-3 tabular-nums">{row.active_assignments ?? 0}</td>
                <td className="px-4 py-3">
                  <Badge variant={row.status === "Active" ? "default" : "outline"}>{row.status}</Badge>
                </td>
                <td className="px-4 py-3 text-right" onClick={(e) => e.stopPropagation()}>
                  <div className="flex justify-end gap-2">
                    <Button size="sm" variant="ghost" onClick={() => openEdit(row)}>
                      Edit
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => toggleStatus(row)}>
                      {row.status === "Active" ? "Deactivate" : "Activate"}
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
            {!shifts.length ? (
              <tr>
                <td colSpan={8} className="px-4 py-10 text-center text-muted-foreground">
                  No shifts match your filters.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      <Dialog open={formOpen} onOpenChange={setFormOpen}>
        <DialogContent className="max-h-[88vh] max-w-4xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{isEdit ? `Edit ${form.shift_name || "shift"}` : "Add shift"}</DialogTitle>
          </DialogHeader>

          <form onSubmit={submit} className="grid gap-6 lg:grid-cols-[1fr_18rem]">
            <div className="space-y-6">
              <section className="space-y-3">
                <h3 className="text-sm font-semibold">Basics</h3>
                <div className="grid grid-cols-2 gap-3">
                  <div className="grid gap-2">
                    <Label htmlFor="shift_name">Shift name</Label>
                    <Input
                      id="shift_name"
                      required
                      value={form.shift_name}
                      onChange={(e) => setForm({ ...form, shift_name: e.target.value })}
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="shift_code">Shift code (optional)</Label>
                    <Input
                      id="shift_code"
                      placeholder="e.g. GEN"
                      value={form.shift_code}
                      onChange={(e) => setForm({ ...form, shift_code: e.target.value })}
                    />
                  </div>
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="description">Description</Label>
                  <Textarea
                    id="description"
                    rows={2}
                    value={form.description}
                    onChange={(e) => setForm({ ...form, description: e.target.value })}
                  />
                </div>
              </section>

              <Separator />

              <section className="space-y-3">
                <h3 className="text-sm font-semibold">Timing</h3>
                <div className="grid grid-cols-3 gap-3">
                  <div className="grid gap-2">
                    <Label htmlFor="start_time">Start</Label>
                    <Input
                      id="start_time"
                      type="time"
                      required
                      value={form.start_time}
                      onChange={(e) => setForm({ ...form, start_time: e.target.value })}
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="end_time">End</Label>
                    <Input
                      id="end_time"
                      type="time"
                      required
                      value={form.end_time}
                      onChange={(e) => setForm({ ...form, end_time: e.target.value })}
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="break_minutes">Break (min)</Label>
                    <Input
                      id="break_minutes"
                      type="number"
                      min={0}
                      value={form.break_minutes}
                      onChange={(e) => setForm({ ...form, break_minutes: e.target.value })}
                    />
                  </div>
                </div>
                <label className="flex items-center gap-3 text-sm">
                  <Checkbox
                    checked={form.is_overnight}
                    onCheckedChange={(v) => setForm({ ...form, is_overnight: Boolean(v) })}
                  />
                  Overnight shift (crosses midnight)
                </label>
              </section>

              <Separator />

              <section className="space-y-3">
                <h3 className="text-sm font-semibold">Attendance rules</h3>
                <div className="grid grid-cols-2 gap-3">
                  <div className="grid gap-2">
                    <Label htmlFor="grace_minutes">Arrival grace (min)</Label>
                    <Input
                      id="grace_minutes"
                      type="number"
                      min={0}
                      value={form.grace_minutes}
                      onChange={(e) => setForm({ ...form, grace_minutes: e.target.value })}
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="early_grace_minutes">Early checkout grace (min)</Label>
                    <Input
                      id="early_grace_minutes"
                      type="number"
                      min={0}
                      disabled={!form.early_checkout_enabled}
                      value={form.early_grace_minutes}
                      onChange={(e) => setForm({ ...form, early_grace_minutes: e.target.value })}
                    />
                  </div>
                </div>
                <label className="flex items-center gap-3 text-sm">
                  <Checkbox
                    checked={form.late_enabled}
                    onCheckedChange={(v) => setForm({ ...form, late_enabled: Boolean(v) })}
                  />
                  Track late arrivals
                </label>
                <label className="flex items-center gap-3 text-sm">
                  <Checkbox
                    checked={form.early_checkout_enabled}
                    onCheckedChange={(v) => setForm({ ...form, early_checkout_enabled: Boolean(v) })}
                  />
                  Flag early checkouts
                </label>
              </section>

              <Separator />

              <section className="space-y-3">
                <h3 className="text-sm font-semibold">Overtime</h3>
                <label className="flex items-center gap-3 text-sm">
                  <Checkbox
                    checked={form.overtime_enabled}
                    onCheckedChange={(v) => setForm({ ...form, overtime_enabled: Boolean(v) })}
                  />
                  Enable overtime for this shift
                </label>
                <label className="flex items-center gap-3 text-sm">
                  <Checkbox
                    checked={form.overtime_eligible}
                    disabled={!form.overtime_enabled}
                    onCheckedChange={(v) => setForm({ ...form, overtime_eligible: Boolean(v) })}
                  />
                  Employees on this shift are overtime-eligible
                </label>
                <div className="grid grid-cols-2 gap-3">
                  <div className="grid gap-2">
                    <Label htmlFor="overtime_threshold_minutes">Threshold after end (min)</Label>
                    <Input
                      id="overtime_threshold_minutes"
                      type="number"
                      min={0}
                      disabled={!form.overtime_enabled}
                      value={form.overtime_threshold_minutes}
                      onChange={(e) => setForm({ ...form, overtime_threshold_minutes: e.target.value })}
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label>Rounding</Label>
                    <Select
                      value={form.overtime_rounding_minutes}
                      onValueChange={(v) => setForm({ ...form, overtime_rounding_minutes: v })}
                    >
                      <SelectTrigger disabled={!form.overtime_enabled}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {OT_ROUNDING_OPTIONS.map((opt) => (
                          <SelectItem key={opt} value={String(opt)}>
                            {opt === 0 ? "No rounding" : `${opt} min`}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              </section>

              <Separator />

              <section className="space-y-3">
                <h3 className="text-sm font-semibold">Working days & validity</h3>
                <div className="flex flex-wrap gap-2">
                  {WEEKDAYS.map((d) => {
                    const active = form.working_days.includes(d.num)
                    return (
                      <button
                        key={d.num}
                        type="button"
                        onClick={() => toggleDay(d.num)}
                        className={`rounded-md border px-3 py-1.5 text-sm transition-colors ${
                          active
                            ? "border-primary bg-primary text-primary-foreground"
                            : "bg-background text-muted-foreground hover:bg-muted"
                        }`}
                      >
                        {d.short}
                      </button>
                    )
                  })}
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="grid gap-2">
                    <Label htmlFor="effective_from">Effective from</Label>
                    <Input
                      id="effective_from"
                      type="date"
                      value={form.effective_from}
                      onChange={(e) => setForm({ ...form, effective_from: e.target.value })}
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="effective_until">Effective until</Label>
                    <Input
                      id="effective_until"
                      type="date"
                      value={form.effective_until}
                      onChange={(e) => setForm({ ...form, effective_until: e.target.value })}
                    />
                  </div>
                </div>
                {isEdit ? (
                  <div className="grid gap-2">
                    <Label>Status</Label>
                    <Select value={form.status} onValueChange={(v) => setForm({ ...form, status: v })}>
                      <SelectTrigger className="w-40">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="Active">Active</SelectItem>
                        <SelectItem value="Inactive">Inactive</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                ) : null}
              </section>

              {isEdit && assignedCount > 0 ? (
                <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
                  <p className="font-medium">
                    {assignedCount} active {assignedCount === 1 ? "employee is" : "employees are"} assigned to this
                    shift.
                  </p>
                  <p className="text-muted-foreground">
                    Policy changes affect their attendance calculations. Add a reason for the audit trail.
                  </p>
                  <Input
                    className="mt-2"
                    placeholder="Reason for change (optional)"
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                  />
                </div>
              ) : null}

              {error ? <p className="text-sm text-destructive">{error}</p> : null}
            </div>

            {/* Live preview */}
            <aside className="space-y-3 lg:sticky lg:top-0 lg:self-start">
              <div className="rounded-lg border bg-muted/30 p-4">
                <p className="text-xs uppercase text-muted-foreground">Live preview</p>
                <p className="mt-1 text-2xl font-semibold tabular-nums">{formatDurationHours(netHours)}</p>
                <p className="text-xs text-muted-foreground">net working time / day</p>
                <Separator className="my-3" />
                <dl className="space-y-1.5 text-sm">
                  <div className="flex justify-between">
                    <dt className="text-muted-foreground">Gross span</dt>
                    <dd className="tabular-nums">{formatDurationHours(gross / 60)}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-muted-foreground">Break</dt>
                    <dd className="tabular-nums">{breakMin} min</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-muted-foreground">Working days</dt>
                    <dd>{formatWorkingDays(form.working_days)}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-muted-foreground">Weekly offs</dt>
                    <dd>{weeklyOffs.length ? formatWorkingDays(weeklyOffs) : "—"}</dd>
                  </div>
                  {form.overtime_enabled ? (
                    <div className="flex justify-between">
                      <dt className="text-muted-foreground">Overtime from</dt>
                      <dd className="tabular-nums">
                        {overtimeStartLabel(
                          form.end_time,
                          Number(form.overtime_threshold_minutes || 0),
                          form.is_overnight,
                        )}
                      </dd>
                    </div>
                  ) : null}
                </dl>
                {previewError ? (
                  <p className="mt-3 rounded-md bg-destructive/10 p-2 text-xs text-destructive">{previewError}</p>
                ) : (
                  <p className="mt-3 rounded-md bg-emerald-500/10 p-2 text-xs text-emerald-600">
                    Configuration is valid.
                  </p>
                )}
              </div>
            </aside>

            <DialogFooter className="lg:col-span-2">
              <Button type="button" variant="outline" onClick={() => setFormOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={saving || Boolean(previewError)}>
                {saving ? "Saving…" : isEdit ? "Save changes" : "Create shift"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <ShiftDetail shiftId={detailId} open={detailOpen} onOpenChange={setDetailOpen} />
    </main>
  )
}
