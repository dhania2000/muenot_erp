"use client"

import { useEffect, useState } from "react"
import useSWR from "swr"
import { fetcher } from "@/lib/fetcher"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Loader2Icon } from "lucide-react"
import { ADJUSTMENT_TYPES, type AdjustmentType } from "@/lib/sales/forecast-model"
import type { AdjustmentRecord } from "@/components/sales/forecast-client"

const TYPE_HELP: Record<AdjustmentType, string> = {
  Expected: "Adds to (or subtracts from) the system-calculated expected revenue for this quarter.",
  "Best Case": "Adjusts the optimistic ceiling — extra upside you believe is achievable.",
  "Worst Case": "Adjusts the conservative floor — use a negative value to haircut committed revenue.",
  Target: "Sets a revenue goal for the quarter. Coverage and health are measured against this.",
}

type FormState = {
  quarter: string
  adjustment_type: AdjustmentType
  amount: string
  owner_id: string
  reason: string
}

function emptyForm(defaultQuarter: number): FormState {
  return {
    quarter: String(defaultQuarter || 1),
    adjustment_type: "Target",
    amount: "",
    owner_id: "all",
    reason: "",
  }
}

export function ForecastAdjustmentDialog({
  open,
  onOpenChange,
  fyStartYear,
  fyLabel,
  defaultQuarter,
  editing,
  onSaved,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  fyStartYear: number
  fyLabel: string
  defaultQuarter: number
  editing: AdjustmentRecord | null
  onSaved: () => void
}) {
  const [form, setForm] = useState<FormState>(emptyForm(defaultQuarter))
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const { data: teamData } = useSWR<{ users: { id: number; name: string }[] }>(
    open ? "/api/sales/team" : null,
    fetcher,
  )
  const users = teamData?.users ?? []

  useEffect(() => {
    if (!open) return
    setError(null)
    if (editing) {
      setForm({
        quarter: String(editing.quarter),
        adjustment_type: editing.adjustment_type,
        amount: String(editing.amount ?? ""),
        owner_id: editing.owner_id != null ? String(editing.owner_id) : "all",
        reason: editing.reason ?? "",
      })
    } else {
      setForm(emptyForm(defaultQuarter))
    }
  }, [open, editing, defaultQuarter])

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }))
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const amount = Number(form.amount)
    if (!Number.isFinite(amount)) {
      setError("Enter a valid amount")
      return
    }
    if (form.adjustment_type === "Target" && amount < 0) {
      setError("Target cannot be negative")
      return
    }
    if (!form.reason.trim()) {
      setError("A reason is required so the adjustment is traceable")
      return
    }
    setLoading(true)
    setError(null)

    const payload = {
      fy_start_year: fyStartYear,
      quarter: Number(form.quarter),
      adjustment_type: form.adjustment_type,
      amount,
      owner_id: form.owner_id === "all" ? null : Number(form.owner_id),
      reason: form.reason.trim(),
    }

    try {
      const res = await fetch(
        editing ? `/api/sales/forecast/${editing.id}` : "/api/sales/forecast",
        {
          method: editing ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
      )
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(body.error || "Unable to save adjustment")
        setLoading(false)
        return
      }
      setLoading(false)
      onSaved()
    } catch {
      setError("Something went wrong. Please try again.")
      setLoading(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>{editing ? "Edit adjustment" : "New forecast adjustment"}</DialogTitle>
            <DialogDescription>
              {editing
                ? "Update this manual override. The change is audited."
                : `Layer a manual target or override on top of the calculated forecast for ${fyLabel}.`}
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-4 py-4">
            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}

            <FieldGroup>
              <div className="grid grid-cols-2 gap-4">
                <Field>
                  <FieldLabel htmlFor="adj-quarter">Quarter</FieldLabel>
                  <Select value={form.quarter} onValueChange={(v) => update("quarter", v ?? "")}>
                    <SelectTrigger id="adj-quarter" className="w-full">
                      <SelectValue placeholder="Quarter" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {[1, 2, 3, 4].map((q) => (
                          <SelectItem key={q} value={String(q)}>
                            Q{q} {fyLabel}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </Field>
                <Field>
                  <FieldLabel htmlFor="adj-type">Type</FieldLabel>
                  <Select
                    value={form.adjustment_type}
                    onValueChange={(v) => update("adjustment_type", (v as AdjustmentType) ?? "Target")}
                  >
                    <SelectTrigger id="adj-type" className="w-full">
                      <SelectValue placeholder="Type" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {ADJUSTMENT_TYPES.map((t) => (
                          <SelectItem key={t} value={t}>
                            {t}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </Field>
              </div>

              <Field>
                <FieldLabel htmlFor="adj-amount">Amount</FieldLabel>
                <Input
                  id="adj-amount"
                  type="number"
                  step="0.01"
                  value={form.amount}
                  onChange={(e) => update("amount", e.target.value)}
                  required
                />
                <FieldDescription>{TYPE_HELP[form.adjustment_type]}</FieldDescription>
              </Field>

              <Field>
                <FieldLabel htmlFor="adj-owner">Scope</FieldLabel>
                <Select value={form.owner_id} onValueChange={(v) => update("owner_id", v ?? "all")}>
                  <SelectTrigger id="adj-owner" className="w-full">
                    <SelectValue placeholder="Scope" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value="all">Whole team</SelectItem>
                      {users.map((u) => (
                        <SelectItem key={u.id} value={String(u.id)}>
                          {u.name}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
                <FieldDescription>
                  Team-wide adjustments apply to the company view; owner-scoped ones only appear when filtering to that
                  rep.
                </FieldDescription>
              </Field>

              <Field>
                <FieldLabel htmlFor="adj-reason">Reason</FieldLabel>
                <Textarea
                  id="adj-reason"
                  rows={3}
                  value={form.reason}
                  onChange={(e) => update("reason", e.target.value)}
                  placeholder="e.g. Board-committed stretch target for Q2, or haircut on a slipping enterprise deal."
                  required
                />
              </Field>
            </FieldGroup>
          </div>

          <DialogFooter>
            <Button type="submit" disabled={loading}>
              {loading && <Loader2Icon className="animate-spin" data-icon="inline-start" />}
              {editing ? "Save changes" : "Add adjustment"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
