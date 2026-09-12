"use client"

import { useMemo, useState } from "react"
import useSWR from "swr"
import { toast } from "sonner"
import { fetcher } from "@/lib/fetcher"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { CalendarDays, History, Layers, Moon, Power, UserPlus, Users } from "lucide-react"
import { describeCycle, unitLabel, type CycleType, type PatternStep } from "@/lib/rotation-ui"
import { rotationState, stateVariant } from "./rotation-shared"
import { RotationCalendar } from "./rotation-wizard-dialog"

const todayISO = () => new Date().toISOString().slice(0, 10)

export function RotationDetailDialog({
  rotationId,
  onClose,
  onChanged,
}: {
  rotationId: string | null
  onClose: () => void
  onChanged: () => void
}) {
  const open = Boolean(rotationId)
  const { data, mutate, isLoading } = useSWR<any>(open ? `/api/hr/shift-rotations/${rotationId}` : null, fetcher)
  const { data: ctx } = useSWR<any>(open ? "/api/hr/shift-rotations/context" : null, fetcher)

  const rot = data?.rotation
  const canManage = Boolean(data?.canManage)
  const canOverride = Boolean(data?.canOverride)

  function refresh() {
    mutate()
    onChanged()
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[92vh] max-w-4xl overflow-y-auto">
        {isLoading || !rot ? (
          <div className="py-16 text-center text-muted-foreground">Loading rotation…</div>
        ) : (
          <>
            <DialogHeader>
              <div className="flex flex-wrap items-center gap-3">
                <DialogTitle className="text-xl">{rot.rotation_name}</DialogTitle>
                <Badge variant={stateVariant(rotationState(rot))}>{rotationState(rot)}</Badge>
                <span className="font-mono text-xs text-muted-foreground">{rot.rotation_id}</span>
              </div>
              <p className="text-sm text-muted-foreground">
                {describeCycle(rot.cycle_type as CycleType, Number(rot.cycle_length), [])} · v{rot.current_version_no} ·{" "}
                {String(rot.effective_from).slice(0, 10)} → {rot.effective_until ? String(rot.effective_until).slice(0, 10) : "Onward"}
              </p>
            </DialogHeader>

            {canManage && (
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant={rot.status === "Active" ? "outline" : "default"}
                  onClick={async () => {
                    const next = rot.status === "Active" ? "Inactive" : "Active"
                    const res = await fetch(`/api/hr/shift-rotations/${rotationId}`, {
                      method: "PATCH",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ status: next }),
                    })
                    if (res.ok) {
                      toast.success(next === "Active" ? "Rotation activated." : "Rotation deactivated.")
                      refresh()
                    } else {
                      toast.error("Could not change status.")
                    }
                  }}
                >
                  <Power className="mr-1 h-4 w-4" />
                  {rot.status === "Active" ? "Deactivate" : "Activate"}
                </Button>
              </div>
            )}

            <Tabs defaultValue="pattern">
              <TabsList className="flex-wrap">
                <TabsTrigger value="pattern"><Layers className="mr-1 h-4 w-4" />Pattern</TabsTrigger>
                <TabsTrigger value="calendar"><CalendarDays className="mr-1 h-4 w-4" />Calendar</TabsTrigger>
                <TabsTrigger value="employees"><Users className="mr-1 h-4 w-4" />Employees</TabsTrigger>
                <TabsTrigger value="audit"><History className="mr-1 h-4 w-4" />Audit</TabsTrigger>
              </TabsList>

              <TabsContent value="pattern" className="mt-4">
                <PatternTab data={data} rotationId={rotationId!} canManage={canManage} shifts={ctx?.shifts || []} onChanged={refresh} />
              </TabsContent>
              <TabsContent value="calendar" className="mt-4">
                <CalendarTab rotationId={rotationId!} effectiveFrom={String(rot.effective_from).slice(0, 10)} />
              </TabsContent>
              <TabsContent value="employees" className="mt-4">
                <EmployeesTab
                  data={data}
                  rotationId={rotationId!}
                  canManage={canManage}
                  canOverride={canOverride}
                  employees={ctx?.employees || []}
                  departments={ctx?.departments || []}
                  onChanged={refresh}
                />
              </TabsContent>
              <TabsContent value="audit" className="mt-4">
                <AuditTab events={data?.events || []} />
              </TabsContent>
            </Tabs>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

/* ------------------------------- Pattern tab ------------------------------ */

function PatternTab({
  data,
  rotationId,
  canManage,
  shifts,
  onChanged,
}: {
  data: any
  rotationId: string
  canManage: boolean
  shifts: any[]
  onChanged: () => void
}) {
  const versions: any[] = data?.versions || []
  const sequences: any[] = data?.sequences || []
  const [openNew, setOpenNew] = useState(false)

  return (
    <div className="space-y-4">
      {canManage && (
        <div className="flex justify-end">
          <Button size="sm" variant="outline" onClick={() => setOpenNew((v) => !v)}>
            {openNew ? "Cancel new version" : "New version"}
          </Button>
        </div>
      )}

      {openNew && (
        <NewVersionForm
          rotationId={rotationId}
          shifts={shifts}
          defaults={{ cycle_type: data?.rotation?.cycle_type, cycle_length: Number(data?.rotation?.cycle_length) }}
          onDone={() => {
            setOpenNew(false)
            onChanged()
          }}
        />
      )}

      {versions.map((v) => {
        const steps = sequences.filter((s) => Number(s.version_id) === Number(v.id))
        const isCurrent = Number(v.version_no) === Number(data?.rotation?.current_version_no)
        return (
          <div key={v.id} className="rounded-xl border bg-card">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
              <div className="flex items-center gap-2">
                <span className="font-medium">Version {v.version_no}</span>
                {isCurrent && <Badge variant="secondary">Current</Badge>}
                <span className="text-xs text-muted-foreground">
                  {v.cycle_length}-{unitLabel(v.cycle_type as CycleType, v.cycle_length)} · from {String(v.effective_from).slice(0, 10)}
                </span>
              </div>
              <span className="text-xs text-muted-foreground">{v.created_by_name}</span>
            </div>
            <div className="flex flex-wrap gap-2 p-4">
              {steps.length === 0 ? (
                <p className="text-sm text-muted-foreground">No steps recorded.</p>
              ) : (
                steps.map((s) => (
                  <div key={s.id} className="flex items-center gap-2 rounded-lg border bg-background px-3 py-2 text-sm">
                    <span className="flex h-5 w-5 items-center justify-center rounded-full bg-muted text-xs">{s.sequence_no}</span>
                    {s.is_weekly_off ? (
                      <span className="flex items-center gap-1 text-muted-foreground"><Moon className="h-3.5 w-3.5" />Weekly Off</span>
                    ) : (
                      <span className="font-medium">{s.shift_name || "—"}</span>
                    )}
                    <span className="text-xs text-muted-foreground">
                      {s.unit_span} {unitLabel(v.cycle_type as CycleType, s.unit_span)}
                    </span>
                  </div>
                ))
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}

const emptyStep = (): PatternStep => ({ shift_id: 0, unit_span: 1, is_weekly_off: false, label: null })

function NewVersionForm({
  rotationId,
  shifts,
  defaults,
  onDone,
}: {
  rotationId: string
  shifts: any[]
  defaults: { cycle_type?: string; cycle_length?: number }
  onDone: () => void
}) {
  const [cycleType, setCycleType] = useState<CycleType>((defaults.cycle_type as CycleType) || "Weeks")
  const [cycleLength, setCycleLength] = useState<number>(defaults.cycle_length || 2)
  const [effectiveFrom, setEffectiveFrom] = useState(todayISO())
  const [steps, setSteps] = useState<PatternStep[]>([emptyStep()])
  const [saving, setSaving] = useState(false)

  function updateStep(i: number, patch: Partial<PatternStep>) {
    setSteps((prev) => prev.map((s, idx) => (idx === i ? { ...s, ...patch } : s)))
  }

  async function submit() {
    setSaving(true)
    try {
      const res = await fetch(`/api/hr/shift-rotations/${rotationId}/versions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          effective_from: effectiveFrom,
          cycle_type: cycleType,
          cycle_length: cycleLength,
          steps: steps.map((s) => ({ shift_id: s.is_weekly_off ? 0 : s.shift_id, unit_span: s.unit_span, is_weekly_off: s.is_weekly_off })),
        }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast.error(json.error || "Could not add version.")
        return
      }
      toast.success(`Version ${json.version_no} added.`)
      onDone()
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-3 rounded-xl border border-dashed bg-muted/30 p-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="grid gap-1.5">
          <Label className="text-xs">Cycle type</Label>
          <Select value={cycleType} onValueChange={(v) => setCycleType((v as CycleType) ?? "Weeks")}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="Days">Days</SelectItem>
              <SelectItem value="Weeks">Weeks</SelectItem>
              <SelectItem value="Months">Months</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-1.5">
          <Label className="text-xs">Cycle length</Label>
          <Input type="number" min={1} value={cycleLength} onChange={(e) => setCycleLength(Math.max(1, Number(e.target.value) || 1))} />
        </div>
        <div className="grid gap-1.5">
          <Label className="text-xs">Effective from</Label>
          <Input type="date" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} />
        </div>
      </div>

      <div className="space-y-2">
        {steps.map((s, i) => (
          <div key={i} className="flex flex-wrap items-end gap-2">
            <div className="grid gap-1">
              <Label className="text-xs">Step {i + 1}</Label>
              {s.is_weekly_off ? (
                <div className="flex h-9 w-44 items-center gap-2 rounded-md border bg-muted/40 px-3 text-sm text-muted-foreground">
                  <Moon className="h-4 w-4" />Weekly Off
                </div>
              ) : (
                <Select value={s.shift_id ? String(s.shift_id) : ""} onValueChange={(v) => updateStep(i, { shift_id: Number(v) })}>
                  <SelectTrigger className="w-44"><SelectValue placeholder="Shift" /></SelectTrigger>
                  <SelectContent>
                    {shifts.map((sh) => (<SelectItem key={sh.id} value={String(sh.id)}>{sh.shift_name}</SelectItem>))}
                  </SelectContent>
                </Select>
              )}
            </div>
            <div className="grid gap-1">
              <Label className="text-xs">Span</Label>
              <Input type="number" min={1} value={s.unit_span} onChange={(e) => updateStep(i, { unit_span: Math.max(1, Number(e.target.value) || 1) })} className="w-20" />
            </div>
            <Button type="button" size="sm" variant={s.is_weekly_off ? "default" : "outline"} className="h-9" onClick={() => updateStep(i, { is_weekly_off: !s.is_weekly_off, shift_id: 0 })}>
              <Moon className="mr-1 h-3.5 w-3.5" />{s.is_weekly_off ? "On" : "Off"}
            </Button>
            <Button type="button" size="sm" variant="ghost" className="h-9 text-destructive" onClick={() => setSteps((prev) => (prev.length > 1 ? prev.filter((_, idx) => idx !== i) : prev))}>
              Remove
            </Button>
          </div>
        ))}
      </div>

      <div className="flex items-center gap-2">
        <Button type="button" size="sm" variant="outline" onClick={() => setSteps((prev) => [...prev, emptyStep()])}>Add step</Button>
        <Button type="button" size="sm" onClick={submit} disabled={saving}>{saving ? "Saving…" : "Save version"}</Button>
      </div>
    </div>
  )
}

/* ------------------------------ Calendar tab ------------------------------ */

function CalendarTab({ rotationId, effectiveFrom }: { rotationId: string; effectiveFrom: string }) {
  const [start, setStart] = useState(() => {
    const t = todayISO()
    return t > effectiveFrom ? t : effectiveFrom
  })
  const [days, setDays] = useState(28)
  const { data } = useSWR<any>(`/api/hr/shift-rotations/${rotationId}/preview?start=${start}&days=${days}`, fetcher)
  const preview = useMemo(
    () => (data?.days || []).map((d: any) => ({ date: d.date, step: { shift_id: d.shift_id ?? 0, unit_span: 1, is_weekly_off: d.is_weekly_off, shift_name: d.shift_name } })),
    [data],
  )

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-3">
        <div className="grid gap-1.5">
          <Label className="text-xs">Start</Label>
          <Input type="date" value={start} onChange={(e) => setStart(e.target.value)} className="w-40" />
        </div>
        <div className="grid gap-1.5">
          <Label className="text-xs">Days</Label>
          <Select value={String(days)} onValueChange={(v) => setDays(Number(v))}>
            <SelectTrigger className="w-28"><SelectValue /></SelectTrigger>
            <SelectContent>
              {[14, 28, 42, 56, 84].map((n) => (<SelectItem key={n} value={String(n)}>{n} days</SelectItem>))}
            </SelectContent>
          </Select>
        </div>
      </div>
      {preview.length === 0 ? (
        <p className="text-sm text-muted-foreground">No pattern is effective for this range.</p>
      ) : (
        <RotationCalendar preview={preview} />
      )}
    </div>
  )
}

/* ------------------------------ Employees tab ----------------------------- */

function EmployeesTab({
  data,
  rotationId,
  canManage,
  canOverride,
  employees,
  departments,
  onChanged,
}: {
  data: any
  rotationId: string
  canManage: boolean
  canOverride: boolean
  employees: any[]
  departments: string[]
  onChanged: () => void
}) {
  const members: any[] = data?.members || []
  const [mode, setMode] = useState<"employee" | "department">("employee")
  const [employeeId, setEmployeeId] = useState("")
  const [department, setDepartment] = useState("")
  const [startDate, setStartDate] = useState(todayISO())
  const [endDate, setEndDate] = useState("")
  const [override, setOverride] = useState(false)
  const [saving, setSaving] = useState(false)

  async function addMembers() {
    if (mode === "employee" && !employeeId) return toast.error("Choose an employee.")
    if (mode === "department" && !department) return toast.error("Choose a department.")
    setSaving(true)
    try {
      const res = await fetch(`/api/hr/shift-rotations/${rotationId}/members`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          employee_ids: mode === "employee" ? [Number(employeeId)] : [],
          department: mode === "department" ? department : undefined,
          start_date: startDate,
          end_date: endDate || null,
          is_override: override,
        }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast.error(json.error || "Could not assign employees.")
        return
      }
      const added = json.added?.length ?? json.addedCount ?? 0
      const skipped = json.skipped?.length ?? 0
      toast.success(`${added} assigned${skipped ? `, ${skipped} skipped` : ""}.`)
      setEmployeeId("")
      setDepartment("")
      onChanged()
    } finally {
      setSaving(false)
    }
  }

  async function endMembership(recordId: string) {
    const res = await fetch(`/api/hr/shift-rotations/${rotationId}/members`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ record_id: recordId, action: "end", end_date: todayISO() }),
    })
    if (res.ok) {
      toast.success("Membership ended.")
      onChanged()
    } else {
      toast.error("Could not end membership.")
    }
  }

  return (
    <div className="space-y-4">
      {canManage && (
        <div className="space-y-3 rounded-xl border bg-card p-4">
          <div className="flex items-center gap-2 text-sm font-medium"><UserPlus className="h-4 w-4" />Assign employees</div>
          <div className="flex flex-wrap items-end gap-3">
            <div className="grid gap-1.5">
              <Label className="text-xs">Mode</Label>
              <Select value={mode} onValueChange={(v) => setMode((v as "employee" | "department") ?? "employee")}>
                <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="employee">Single employee</SelectItem>
                  <SelectItem value="department">Whole department</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {mode === "employee" ? (
              <div className="grid gap-1.5">
                <Label className="text-xs">Employee</Label>
                <Select value={employeeId} onValueChange={(v) => setEmployeeId(v ?? "")}>
                  <SelectTrigger className="w-56"><SelectValue placeholder="Choose employee" /></SelectTrigger>
                  <SelectContent>
                    {employees.map((e: any) => (<SelectItem key={e.id} value={String(e.id)}>{e.employee_name}</SelectItem>))}
                  </SelectContent>
                </Select>
              </div>
            ) : (
              <div className="grid gap-1.5">
                <Label className="text-xs">Department</Label>
                <Select value={department} onValueChange={(v) => setDepartment(v ?? "")}>
                  <SelectTrigger className="w-56"><SelectValue placeholder="Choose department" /></SelectTrigger>
                  <SelectContent>
                    {departments.map((d) => (<SelectItem key={d} value={d}>{d}</SelectItem>))}
                  </SelectContent>
                </Select>
              </div>
            )}
            <div className="grid gap-1.5">
              <Label className="text-xs">Start</Label>
              <Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} className="w-40" />
            </div>
            <div className="grid gap-1.5">
              <Label className="text-xs">End (optional)</Label>
              <Input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} className="w-40" />
            </div>
            {canOverride && (
              <label className="flex h-9 items-center gap-2 text-sm">
                <input type="checkbox" checked={override} onChange={(e) => setOverride(e.target.checked)} className="h-4 w-4" />
                Override conflicts
              </label>
            )}
            <Button size="sm" onClick={addMembers} disabled={saving}>{saving ? "Assigning…" : "Assign"}</Button>
          </div>
        </div>
      )}

      <div className="overflow-hidden rounded-xl border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Employee</TableHead>
              <TableHead>Department</TableHead>
              <TableHead>Window</TableHead>
              <TableHead>Status</TableHead>
              {canManage && <TableHead />}
            </TableRow>
          </TableHeader>
          <TableBody>
            {members.length === 0 ? (
              <TableRow><TableCell colSpan={canManage ? 5 : 4} className="py-8 text-center text-muted-foreground">No employees assigned yet.</TableCell></TableRow>
            ) : (
              members.map((m) => {
                const active = m.status === "Active" && (!m.end_date || String(m.end_date).slice(0, 10) >= todayISO())
                return (
                  <TableRow key={m.record_id}>
                    <TableCell>
                      <div className="font-medium">{m.employee_name}</div>
                      <div className="text-xs text-muted-foreground">{m.employee_code}{m.designation ? ` · ${m.designation}` : ""}</div>
                    </TableCell>
                    <TableCell>{m.department || "—"}</TableCell>
                    <TableCell className="whitespace-nowrap text-sm">
                      {String(m.start_date).slice(0, 10)} → {m.end_date ? String(m.end_date).slice(0, 10) : "Onward"}
                    </TableCell>
                    <TableCell><Badge variant={active ? "secondary" : "outline"}>{active ? "Active" : "Ended"}</Badge></TableCell>
                    {canManage && (
                      <TableCell className="text-right">
                        {active && (
                          <Button size="sm" variant="ghost" className="text-destructive" onClick={() => endMembership(m.record_id)}>End</Button>
                        )}
                      </TableCell>
                    )}
                  </TableRow>
                )
              })
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}

/* -------------------------------- Audit tab ------------------------------- */

function AuditTab({ events }: { events: any[] }) {
  if (events.length === 0) return <p className="py-8 text-center text-sm text-muted-foreground">No audit history yet.</p>
  return (
    <ol className="space-y-3">
      {events.map((e, i) => (
        <li key={i} className="flex gap-3 border-b pb-3 last:border-0">
          <div className="mt-1 h-2 w-2 shrink-0 rounded-full bg-primary" />
          <div className="min-w-0">
            <p className="text-sm">
              <span className="font-medium">{e.summary}</span>
              {e.reason ? <span className="text-muted-foreground"> — {e.reason}</span> : null}
            </p>
            <p className="text-xs text-muted-foreground">
              {e.event_type} · {e.actor_name || "System"} · {String(e.created_at).slice(0, 19).replace("T", " ")}
            </p>
          </div>
        </li>
      ))}
    </ol>
  )
}
