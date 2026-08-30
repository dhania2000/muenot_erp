"use client"

import { useEffect, useState } from "react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
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
import type { ForecastRow } from "@/components/sales/forecast-client"

const QUARTERS = ["Q1", "Q2", "Q3", "Q4"]
const COVERAGE = ["Low", "Medium", "High", "On Track"]

type FormState = {
  quarter: string
  year: string
  expected_revenue: string
  best_case: string
  worst_case: string
  pipeline_coverage: string
  owner: string
}

const currentYear = new Date().getFullYear()

const EMPTY: FormState = {
  quarter: "Q1",
  year: String(currentYear),
  expected_revenue: "",
  best_case: "",
  worst_case: "",
  pipeline_coverage: "",
  owner: "",
}

export function ForecastDialog({
  open,
  onOpenChange,
  forecast,
  onSaved,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  forecast: ForecastRow | null
  onSaved: () => void
}) {
  const [form, setForm] = useState<FormState>(EMPTY)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!open) return
    setError(null)
    if (forecast) {
      setForm({
        quarter: forecast.quarter || "Q1",
        year: String(forecast.year ?? currentYear),
        expected_revenue: String(forecast.expected_revenue ?? ""),
        best_case: String(forecast.best_case ?? ""),
        worst_case: String(forecast.worst_case ?? ""),
        pipeline_coverage: forecast.pipeline_coverage || "",
        owner: forecast.owner || "",
      })
    } else {
      setForm(EMPTY)
    }
  }, [open, forecast])

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }))
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!form.quarter || !form.year) {
      setError("Quarter and year are required")
      return
    }
    setLoading(true)
    setError(null)

    const payload = {
      ...form,
      year: Number(form.year),
      expected_revenue: Number(form.expected_revenue || 0),
      best_case: Number(form.best_case || 0),
      worst_case: Number(form.worst_case || 0),
    }

    try {
      const res = await fetch(forecast ? `/api/sales/forecast/${forecast.id}` : "/api/sales/forecast", {
        method: forecast ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(body.error || "Unable to save forecast")
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
            <DialogTitle>{forecast ? "Edit forecast" : "Add revenue forecast"}</DialogTitle>
            <DialogDescription>
              {forecast ? "Update this quarter's revenue forecast." : "Add a new quarterly revenue forecast."}
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
                  <FieldLabel htmlFor="quarter">Quarter</FieldLabel>
                  <Select value={form.quarter} onValueChange={(v) => update("quarter", v)}>
                    <SelectTrigger id="quarter" className="w-full">
                      <SelectValue placeholder="Select quarter" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {QUARTERS.map((q) => (
                          <SelectItem key={q} value={q}>
                            {q}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </Field>
                <Field>
                  <FieldLabel htmlFor="year">Year</FieldLabel>
                  <Input
                    id="year"
                    type="number"
                    value={form.year}
                    onChange={(e) => update("year", e.target.value)}
                    required
                  />
                </Field>
              </div>

              <div className="grid grid-cols-3 gap-4">
                <Field>
                  <FieldLabel htmlFor="expected_revenue">Expected (INR)</FieldLabel>
                  <Input
                    id="expected_revenue"
                    type="number"
                    min="0"
                    value={form.expected_revenue}
                    onChange={(e) => update("expected_revenue", e.target.value)}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="best_case">Best case (INR)</FieldLabel>
                  <Input
                    id="best_case"
                    type="number"
                    min="0"
                    value={form.best_case}
                    onChange={(e) => update("best_case", e.target.value)}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="worst_case">Worst case (INR)</FieldLabel>
                  <Input
                    id="worst_case"
                    type="number"
                    min="0"
                    value={form.worst_case}
                    onChange={(e) => update("worst_case", e.target.value)}
                  />
                </Field>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <Field>
                  <FieldLabel htmlFor="pipeline_coverage">Pipeline coverage</FieldLabel>
                  <Select value={form.pipeline_coverage} onValueChange={(v) => update("pipeline_coverage", v)}>
                    <SelectTrigger id="pipeline_coverage" className="w-full">
                      <SelectValue placeholder="Select coverage" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {COVERAGE.map((c) => (
                          <SelectItem key={c} value={c}>
                            {c}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </Field>
                <Field>
                  <FieldLabel htmlFor="owner">Owner</FieldLabel>
                  <Input id="owner" value={form.owner} onChange={(e) => update("owner", e.target.value)} />
                </Field>
              </div>
            </FieldGroup>
          </div>

          <DialogFooter>
            <Button type="submit" disabled={loading}>
              {loading && <Loader2Icon className="animate-spin" data-icon="inline-start" />}
              {forecast ? "Save changes" : "Add forecast"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
