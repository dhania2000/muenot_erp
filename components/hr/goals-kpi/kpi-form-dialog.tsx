"use client"

import { useEffect, useState } from "react"
import { toast } from "sonner"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import {
  DIRECTION_LABELS,
  KPI_DIRECTIONS,
  KPI_PERIODS,
  KPI_SCOPES,
  PERIOD_LABELS,
  SCOPE_LABELS,
  scopeRequiresSubject,
  type KpiGoalComputed,
} from "@/lib/goals-kpi/config"

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** When provided the dialog edits this goal; otherwise it creates a new one. */
  goal?: KpiGoalComputed | null
  onSaved: () => void
}

type FormState = {
  name: string
  description: string
  scope: string
  scope_ref_label: string
  unit: string
  direction: string
  target_value: string
  actual_value: string
  weight: string
  period_type: string
  period_start: string
  period_end: string
}

const EMPTY: FormState = {
  name: "",
  description: "",
  scope: "individual",
  scope_ref_label: "",
  unit: "",
  direction: "increase",
  target_value: "",
  actual_value: "0",
  weight: "1",
  period_type: "monthly",
  period_start: "",
  period_end: "",
}

export function KpiFormDialog({ open, onOpenChange, goal, onSaved }: Props) {
  const [form, setForm] = useState<FormState>(EMPTY)
  const [saving, setSaving] = useState(false)
  const isEdit = Boolean(goal)

  useEffect(() => {
    if (!open) return
    if (goal) {
      setForm({
        name: goal.name,
        description: goal.description ?? "",
        scope: goal.scope,
        scope_ref_label: goal.scope_ref_label ?? "",
        unit: goal.unit ?? "",
        direction: goal.direction,
        target_value: String(goal.target_value),
        actual_value: String(goal.actual_value),
        weight: String(goal.weight),
        period_type: goal.period_type,
        period_start: goal.period_start ?? "",
        period_end: goal.period_end ?? "",
      })
    } else {
      setForm(EMPTY)
    }
  }, [open, goal])

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }))
  }

  async function submit() {
    if (!form.name.trim()) {
      toast.error("Name is required.")
      return
    }
    setSaving(true)
    const payload = {
      name: form.name.trim(),
      description: form.description.trim() || null,
      scope: form.scope,
      scope_ref_label: form.scope_ref_label.trim() || null,
      unit: form.unit.trim() || null,
      direction: form.direction,
      target_value: Number(form.target_value || 0),
      actual_value: Number(form.actual_value || 0),
      weight: Number(form.weight || 0),
      period_type: form.period_type,
      period_start: form.period_type === "custom" ? form.period_start || null : null,
      period_end: form.period_type === "custom" ? form.period_end || null : null,
    }
    try {
      const res = await fetch(isEdit ? `/api/hr/goals-kpi/${goal!.id}` : "/api/hr/goals-kpi", {
        method: isEdit ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || "Save failed")
      toast.success(isEdit ? "KPI updated" : "KPI created")
      onOpenChange(false)
      onSaved()
    } catch (error) {
      toast.error((error as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const needsSubject = scopeRequiresSubject(form.scope as any)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit KPI" : "New KPI"}</DialogTitle>
          <DialogDescription>
            Define a measurable goal, its target and how progress is scored.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-2">
          <div className="grid gap-2">
            <Label htmlFor="kpi-name">Name</Label>
            <Input
              id="kpi-name"
              value={form.name}
              onChange={(e) => set("name", e.target.value)}
              placeholder="e.g. Monthly revenue"
            />
          </div>

          <div className="grid gap-2">
            <Label htmlFor="kpi-desc">Description</Label>
            <Textarea
              id="kpi-desc"
              value={form.description}
              onChange={(e) => set("description", e.target.value)}
              placeholder="What this KPI measures and why it matters"
              rows={2}
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-2">
              <Label>Scope</Label>
              <Select value={form.scope} onValueChange={(v) => set("scope", v)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {KPI_SCOPES.map((s) => (
                    <SelectItem key={s} value={s}>
                      {SCOPE_LABELS[s]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="kpi-subject">
                Subject{needsSubject ? "" : " (optional)"}
              </Label>
              <Input
                id="kpi-subject"
                value={form.scope_ref_label}
                onChange={(e) => set("scope_ref_label", e.target.value)}
                placeholder={needsSubject ? "Who / what it measures" : "Company-wide"}
              />
            </div>
          </div>

          <div className="grid grid-cols-3 gap-4">
            <div className="grid gap-2">
              <Label htmlFor="kpi-target">Target</Label>
              <Input
                id="kpi-target"
                type="number"
                value={form.target_value}
                onChange={(e) => set("target_value", e.target.value)}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="kpi-actual">Actual</Label>
              <Input
                id="kpi-actual"
                type="number"
                value={form.actual_value}
                onChange={(e) => set("actual_value", e.target.value)}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="kpi-unit">Unit</Label>
              <Input
                id="kpi-unit"
                value={form.unit}
                onChange={(e) => set("unit", e.target.value)}
                placeholder="%, $, hrs"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-2">
              <Label>Direction</Label>
              <Select value={form.direction} onValueChange={(v) => set("direction", v)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {KPI_DIRECTIONS.map((d) => (
                    <SelectItem key={d} value={d}>
                      {DIRECTION_LABELS[d]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="kpi-weight">Weight</Label>
              <Input
                id="kpi-weight"
                type="number"
                min="0"
                step="0.5"
                value={form.weight}
                onChange={(e) => set("weight", e.target.value)}
              />
            </div>
          </div>

          <div className="grid gap-2">
            <Label>Period</Label>
            <Select value={form.period_type} onValueChange={(v) => set("period_type", v)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {KPI_PERIODS.map((p) => (
                  <SelectItem key={p} value={p}>
                    {PERIOD_LABELS[p]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {form.period_type === "custom" && (
            <div className="grid grid-cols-2 gap-4">
              <div className="grid gap-2">
                <Label htmlFor="kpi-start">Start</Label>
                <Input
                  id="kpi-start"
                  type="date"
                  value={form.period_start}
                  onChange={(e) => set("period_start", e.target.value)}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="kpi-end">End</Label>
                <Input
                  id="kpi-end"
                  type="date"
                  value={form.period_end}
                  onChange={(e) => set("period_end", e.target.value)}
                />
              </div>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={saving}>
            {saving ? "Saving…" : isEdit ? "Save changes" : "Create KPI"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
