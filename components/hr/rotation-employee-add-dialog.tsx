"use client"

import { useMemo, useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
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
import { AlertTriangle, Loader2, Search } from "lucide-react"
import { toast } from "sonner"

const today = () => new Date().toISOString().slice(0, 10)

type Rotation = {
  rotation_id: string
  rotation_name: string
  cycle_type: string
  cycle_length: number
  effective_from: string
  effective_until: string | null
  active_members: number
}
type Employee = {
  id: number
  employee_id: string
  employee_name: string
  department: string | null
  designation: string | null
  employment_status: string | null
  exit_date: string | null
}

const INACTIVE = new Set(["terminated", "resigned", "exited", "inactive", "left", "archived", "offboarded", "ex-employee"])

export function RotationEmployeeAddDialog({
  open,
  onOpenChange,
  meta,
  onCreated,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  meta: { rotations: Rotation[]; employees: Employee[]; departments: string[]; canOverride: boolean } | undefined
  onCreated: () => void
}) {
  const [rotationId, setRotationId] = useState("")
  const [startDate, setStartDate] = useState(today())
  const [endDate, setEndDate] = useState("")
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [empSearch, setEmpSearch] = useState("")
  const [bulkDept, setBulkDept] = useState("")
  const [override, setOverride] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  const rotations = meta?.rotations || []
  const employees = meta?.employees || []
  const departments = meta?.departments || []
  const canOverride = Boolean(meta?.canOverride)

  const rotation = rotations.find((r) => r.rotation_id === rotationId)

  const filteredEmployees = useMemo(() => {
    const q = empSearch.trim().toLowerCase()
    if (!q) return employees.slice(0, 200)
    return employees
      .filter((e) =>
        [e.employee_name, e.employee_id, e.department, e.designation]
          .filter(Boolean)
          .some((v) => String(v).toLowerCase().includes(q)),
      )
      .slice(0, 200)
  }, [employees, empSearch])

  function reset() {
    setRotationId("")
    setStartDate(today())
    setEndDate("")
    setSelected(new Set())
    setEmpSearch("")
    setBulkDept("")
    setOverride(false)
  }

  function toggle(id: number) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function isIneligible(e: Employee) {
    const status = (e.employment_status || "").trim().toLowerCase()
    if (INACTIVE.has(status)) return true
    if (e.exit_date && String(e.exit_date).slice(0, 10) < startDate) return true
    return false
  }

  const ineligibleSelected = Array.from(selected)
    .map((id) => employees.find((e) => e.id === id))
    .filter((e): e is Employee => Boolean(e) && isIneligible(e as Employee))

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!rotationId) return toast.error("Choose a rotation.")
    if (!startDate) return toast.error("Choose a membership start date.")
    if (!selected.size && !bulkDept) return toast.error("Select at least one employee or a department.")
    if (endDate && endDate < startDate) return toast.error("End date cannot be before the start date.")

    setSubmitting(true)
    try {
      const res = await fetch("/api/hr/rotation-employees", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rotation_id: rotationId,
          employee_ids: Array.from(selected),
          department: bulkDept || undefined,
          start_date: startDate,
          end_date: endDate || null,
          is_override: override,
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        toast.error(data.error || "Could not assign employees.")
        return
      }
      const skipped: any[] = data.skipped || []
      if (data.added > 0) {
        toast.success(
          `${data.added} employee(s) added to ${rotation?.rotation_name || rotationId}.` +
            (skipped.length ? ` ${skipped.length} skipped.` : ""),
        )
      }
      if (skipped.length) {
        toast.warning(
          `Skipped: ${skipped.slice(0, 4).map((s) => `${s.employeeName} (${s.reason})`).join("; ")}` +
            (skipped.length > 4 ? " …" : ""),
        )
      }
      if (data.added > 0 || !skipped.length) {
        reset()
        onOpenChange(false)
      }
      onCreated()
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { onOpenChange(v); if (!v) reset() }}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add employees to a rotation</DialogTitle>
          <DialogDescription>
            Record IDs, current sequence and next run are generated by the system — you only choose who, which rotation and from when.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={submit} className="grid gap-4">
          <div className="grid gap-1.5">
            <Label htmlFor="roe-rotation">Rotation</Label>
            <Select value={rotationId} onValueChange={(v) => setRotationId(v ?? "")}>
              <SelectTrigger id="roe-rotation">
                <SelectValue placeholder="Select a running rotation" />
              </SelectTrigger>
              <SelectContent>
                {rotations.length === 0 ? (
                  <SelectItem value="none" disabled>
                    No running rotations
                  </SelectItem>
                ) : (
                  rotations.map((r) => (
                    <SelectItem key={r.rotation_id} value={r.rotation_id}>
                      {r.rotation_name} · {r.rotation_id}
                    </SelectItem>
                  ))
                )}
              </SelectContent>
            </Select>
          </div>

          {rotation && (
            <div className="rounded-lg border bg-muted/40 p-3 text-sm">
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                <span>ID: {rotation.rotation_id}</span>
                <span>Cycle: {rotation.cycle_length} {rotation.cycle_type.toLowerCase()}</span>
                <span>Effective: {String(rotation.effective_from).slice(0, 10)}{rotation.effective_until ? ` → ${String(rotation.effective_until).slice(0, 10)}` : ""}</span>
                <span>Active members: {rotation.active_members}</span>
              </div>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="roe-start">Membership start</Label>
              <Input
                id="roe-start"
                type="date"
                value={startDate}
                min={rotation ? String(rotation.effective_from).slice(0, 10) : undefined}
                onChange={(e) => setStartDate(e.target.value)}
                required
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="roe-end">
                End date <span className="text-muted-foreground">(optional)</span>
              </Label>
              <Input id="roe-end" type="date" value={endDate} min={startDate} onChange={(e) => setEndDate(e.target.value)} />
            </div>
          </div>
          <p className="-mt-2 text-xs text-muted-foreground">
            Sequence day 1 is counted from each employee&apos;s membership start, not the rotation&apos;s global start.
          </p>

          {/* Employee picker */}
          <div className="grid gap-1.5">
            <Label>Employees ({selected.size} selected)</Label>
            <div className="relative">
              <Search className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
              <Input
                value={empSearch}
                onChange={(e) => setEmpSearch(e.target.value)}
                placeholder="Search name, ID, department…"
                className="pl-8"
              />
            </div>
            <div className="max-h-56 overflow-y-auto rounded-lg border">
              {filteredEmployees.length === 0 ? (
                <p className="px-3 py-6 text-center text-sm text-muted-foreground">No matching employees.</p>
              ) : (
                <ul className="divide-y">
                  {filteredEmployees.map((e) => {
                    const bad = isIneligible(e)
                    return (
                      <li key={e.id}>
                        <label className="flex cursor-pointer items-center gap-3 px-3 py-2 text-sm hover:bg-accent/50">
                          <Checkbox checked={selected.has(e.id)} onCheckedChange={() => toggle(e.id)} />
                          <span className="min-w-0 flex-1">
                            <span className="font-medium">{e.employee_name}</span>
                            <span className="block text-xs text-muted-foreground">
                              {e.employee_id}
                              {e.department ? ` · ${e.department}` : ""}
                            </span>
                          </span>
                          {bad && <Badge variant="outline" className="text-amber-600">Ineligible</Badge>}
                        </label>
                      </li>
                    )
                  })}
                </ul>
              )}
            </div>
          </div>

          {/* Bulk department */}
          <div className="grid gap-1.5">
            <Label htmlFor="roe-dept">
              Or add an entire department <span className="text-muted-foreground">(optional)</span>
            </Label>
            <Select value={bulkDept} onValueChange={(v) => setBulkDept(v === "none" ? "" : (v ?? ""))}>
              <SelectTrigger id="roe-dept">
                <SelectValue placeholder="No department bulk-add" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No department bulk-add</SelectItem>
                {departments.map((d) => (
                  <SelectItem key={d} value={d}>
                    {d}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Every eligible active employee in the department is added, in addition to those ticked above.
            </p>
          </div>

          {(ineligibleSelected.length > 0 || bulkDept) && (
            <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
              <div className="flex items-center gap-2 font-medium text-amber-600 dark:text-amber-400">
                <AlertTriangle className="size-4" /> Some selections may be skipped
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                Ineligible employees and cross-rotation conflicts are skipped and reported after saving
                {canOverride ? ", unless you override." : "."}
              </p>
              {canOverride && (
                <label className="mt-2 flex items-center gap-2 text-xs">
                  <Checkbox checked={override} onCheckedChange={(v) => setOverride(Boolean(v))} />
                  Override eligibility &amp; conflicts (authorized).
                </label>
              )}
            </div>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting && <Loader2 className="mr-2 size-4 animate-spin" />}
              Add to rotation
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
