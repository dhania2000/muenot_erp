"use client"

import { useMemo, useState } from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { ArrowLeft, ArrowRight, GripVertical, Moon, Plus, Trash2 } from "lucide-react"
import {
  CYCLE_TYPES,
  buildPreview,
  describeCycle,
  totalCycleSpan,
  unitLabel,
  validatePattern,
  type CycleType,
  type PatternStep,
} from "@/lib/rotation-ui"

type ShiftOption = { id: number; shift_name: string; start_time?: string | null; end_time?: string | null }

const todayISO = () => new Date().toISOString().slice(0, 10)

const emptyStep = (): PatternStep => ({ shift_id: 0, unit_span: 1, is_weekly_off: false, label: null })

/**
 * Three-step create wizard: header → sequence builder → preview & confirm.
 * The live preview is computed with the same pure engine (lib/rotation-ui) the
 * server resolver uses, so what the admin sees is exactly what gets applied.
 */
export function RotationWizardDialog({
  open,
  onOpenChange,
  shifts,
  onCreated,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  shifts: ShiftOption[]
  onCreated: (rotationId: string) => void
}) {
  const [step, setStep] = useState(1)
  const [saving, setSaving] = useState(false)

  const [name, setName] = useState("")
  const [description, setDescription] = useState("")
  const [cycleType, setCycleType] = useState<CycleType>("Weeks")
  const [cycleLength, setCycleLength] = useState(2)
  const [effectiveFrom, setEffectiveFrom] = useState(todayISO())
  const [effectiveUntil, setEffectiveUntil] = useState("")
  const [steps, setSteps] = useState<PatternStep[]>([emptyStep()])

  function reset() {
    setStep(1)
    setName("")
    setDescription("")
    setCycleType("Weeks")
    setCycleLength(2)
    setEffectiveFrom(todayISO())
    setEffectiveUntil("")
    setSteps([emptyStep()])
  }

  const shiftName = (id: number) => shifts.find((s) => s.id === id)?.shift_name ?? "—"
  const stepsWithNames = useMemo(
    () => steps.map((s) => ({ ...s, shift_name: shiftName(s.shift_id) })),
    [steps, shifts],
  )
  const patternError = validatePattern(cycleType, cycleLength, steps)
  const declaredSpan = cycleType === "Weeks" ? cycleLength * 7 : cycleLength
  const filledSpan = totalCycleSpan(cycleType, steps)

  const preview = useMemo(
    () => (patternError ? [] : buildPreview(effectiveFrom, cycleType, stepsWithNames, effectiveFrom, 28)),
    [patternError, effectiveFrom, cycleType, stepsWithNames],
  )

  function updateStep(i: number, patch: Partial<PatternStep>) {
    setSteps((prev) => prev.map((s, idx) => (idx === i ? { ...s, ...patch } : s)))
  }
  function moveStep(i: number, dir: -1 | 1) {
    setSteps((prev) => {
      const next = [...prev]
      const j = i + dir
      if (j < 0 || j >= next.length) return prev
      ;[next[i], next[j]] = [next[j], next[i]]
      return next
    })
  }

  const canAdvanceStep1 = name.trim().length > 0 && effectiveFrom && (!effectiveUntil || effectiveUntil >= effectiveFrom)

  async function submit() {
    if (patternError) {
      toast.error(patternError)
      return
    }
    setSaving(true)
    try {
      const res = await fetch("/api/hr/shift-rotations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rotation_name: name.trim(),
          description: description.trim() || null,
          cycle_type: cycleType,
          cycle_length: cycleLength,
          effective_from: effectiveFrom,
          effective_until: effectiveUntil || null,
          steps: steps.map((s) => ({
            shift_id: s.is_weekly_off ? 0 : s.shift_id,
            unit_span: s.unit_span,
            is_weekly_off: s.is_weekly_off,
            label: s.label || null,
          })),
        }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast.error(json.error || "Could not create the rotation.")
        return
      }
      toast.success(`Rotation ${json.rotation_id} created.`)
      onCreated(json.rotation_id)
      onOpenChange(false)
      reset()
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        onOpenChange(v)
        if (!v) reset()
      }}
    >
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>New shift rotation</DialogTitle>
        </DialogHeader>

        <div className="flex items-center gap-2 text-xs">
          {["Details", "Pattern", "Preview"].map((s, i) => (
            <div key={s} className="flex items-center gap-2">
              <span
                className={`flex h-6 w-6 items-center justify-center rounded-full text-xs font-semibold ${
                  step === i + 1
                    ? "bg-primary text-primary-foreground"
                    : step > i + 1
                      ? "bg-primary/20 text-primary"
                      : "bg-muted text-muted-foreground"
                }`}
              >
                {i + 1}
              </span>
              <span className={step === i + 1 ? "font-medium" : "text-muted-foreground"}>{s}</span>
              {i < 2 && <span className="text-muted-foreground">/</span>}
            </div>
          ))}
        </div>

        {step === 1 && (
          <div className="grid gap-4">
            <div className="grid gap-1.5">
              <Label htmlFor="rot-name">Rotation name</Label>
              <Input id="rot-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Production 2-week rotation" />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="rot-desc">Description</Label>
              <Textarea id="rot-desc" value={description} onChange={(e) => setDescription(e.target.value)} rows={2} placeholder="Optional notes about this rotation." />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="grid gap-1.5">
                <Label>Cycle type</Label>
                <Select value={cycleType} onValueChange={(v) => setCycleType((v as CycleType) ?? "Weeks")}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {CYCLE_TYPES.map((c) => (<SelectItem key={c} value={c}>{c}</SelectItem>))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="rot-len">Cycle length ({unitLabel(cycleType, cycleLength)})</Label>
                <Input id="rot-len" type="number" min={1} value={cycleLength} onChange={(e) => setCycleLength(Math.max(1, Number(e.target.value) || 1))} />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="rot-from">Effective from</Label>
                <Input id="rot-from" type="date" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="rot-until">Effective until (optional)</Label>
                <Input id="rot-until" type="date" value={effectiveUntil} onChange={(e) => setEffectiveUntil(e.target.value)} />
              </div>
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="grid gap-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium">Sequence builder</p>
                <p className="text-xs text-muted-foreground">{describeCycle(cycleType, cycleLength, steps)}</p>
              </div>
              <Badge variant={filledSpan === declaredSpan ? "secondary" : "destructive"}>
                {filledSpan} / {declaredSpan} {unitLabel(cycleType === "Weeks" ? "Days" : cycleType, declaredSpan)}
              </Badge>
            </div>

            <div className="space-y-2">
              {steps.map((s, i) => (
                <div key={i} className="flex flex-wrap items-end gap-2 rounded-lg border bg-card p-3">
                  <div className="flex flex-col gap-1 pt-4">
                    <button type="button" onClick={() => moveStep(i, -1)} className="text-muted-foreground hover:text-foreground disabled:opacity-30" disabled={i === 0} aria-label="Move up">
                      <GripVertical className="h-4 w-4" />
                    </button>
                  </div>
                  <div className="grid gap-1">
                    <Label className="text-xs">Step {i + 1}</Label>
                    {s.is_weekly_off ? (
                      <div className="flex h-9 w-48 items-center gap-2 rounded-md border bg-muted/40 px-3 text-sm">
                        <Moon className="h-4 w-4 text-muted-foreground" /> Weekly Off
                      </div>
                    ) : (
                      <Select value={s.shift_id ? String(s.shift_id) : ""} onValueChange={(v) => updateStep(i, { shift_id: Number(v) })}>
                        <SelectTrigger className="w-48"><SelectValue placeholder="Choose shift" /></SelectTrigger>
                        <SelectContent>
                          {shifts.map((sh) => (<SelectItem key={sh.id} value={String(sh.id)}>{sh.shift_name}</SelectItem>))}
                        </SelectContent>
                      </Select>
                    )}
                  </div>
                  <div className="grid gap-1">
                    <Label className="text-xs">Span ({unitLabel(cycleType, s.unit_span)})</Label>
                    <Input type="number" min={1} value={s.unit_span} onChange={(e) => updateStep(i, { unit_span: Math.max(1, Number(e.target.value) || 1) })} className="w-24" />
                  </div>
                  <div className="flex flex-col gap-1">
                    <Label className="text-xs">Weekly off</Label>
                    <Button type="button" variant={s.is_weekly_off ? "default" : "outline"} size="sm" className="h-9" onClick={() => updateStep(i, { is_weekly_off: !s.is_weekly_off, shift_id: 0 })}>
                      <Moon className="mr-1 h-3.5 w-3.5" /> {s.is_weekly_off ? "On" : "Off"}
                    </Button>
                  </div>
                  <Button type="button" variant="ghost" size="icon" className="ml-auto text-destructive" onClick={() => setSteps((prev) => (prev.length > 1 ? prev.filter((_, idx) => idx !== i) : prev))} aria-label="Remove step">
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}
            </div>

            <Button type="button" variant="outline" size="sm" className="w-fit" onClick={() => setSteps((prev) => [...prev, emptyStep()])}>
              <Plus className="mr-1 h-4 w-4" /> Add step
            </Button>

            {patternError && <p className="text-sm text-destructive">{patternError}</p>}
          </div>
        )}

        {step === 3 && (
          <div className="grid gap-3">
            <p className="text-sm text-muted-foreground">
              First 28 days from <span className="font-medium text-foreground">{effectiveFrom}</span>, exactly as the attendance resolver will apply it.
            </p>
            <RotationCalendar preview={preview} />
          </div>
        )}

        <DialogFooter className="gap-2 sm:justify-between">
          <div>
            {step > 1 && (
              <Button type="button" variant="ghost" onClick={() => setStep((s) => s - 1)}>
                <ArrowLeft className="mr-1 h-4 w-4" /> Back
              </Button>
            )}
          </div>
          <div className="flex gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            {step < 3 ? (
              <Button type="button" onClick={() => setStep((s) => s + 1)} disabled={(step === 1 && !canAdvanceStep1) || (step === 2 && !!patternError)}>
                Next <ArrowRight className="ml-1 h-4 w-4" />
              </Button>
            ) : (
              <Button type="button" onClick={submit} disabled={saving || !!patternError}>
                {saving ? "Creating…" : "Create rotation"}
              </Button>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Compact 4x7 day grid used by the wizard and the detail dialog. */
export function RotationCalendar({ preview }: { preview: { date: string; step: PatternStep | null }[] }) {
  if (!preview.length) return <p className="text-sm text-muted-foreground">Complete the pattern to see a preview.</p>
  return (
    <div className="grid grid-cols-7 gap-1.5">
      {preview.map((d) => {
        const off = d.step?.is_weekly_off
        return (
          <div
            key={d.date}
            className={`rounded-md border p-2 text-center text-xs ${off ? "bg-muted/50 text-muted-foreground" : "bg-card"}`}
          >
            <div className="font-medium text-foreground">{d.date.slice(5)}</div>
            <div className="mt-1 truncate" title={off ? "Weekly Off" : d.step?.shift_name ?? "—"}>
              {off ? "Off" : d.step?.shift_name ?? "—"}
            </div>
          </div>
        )
      })}
    </div>
  )
}
