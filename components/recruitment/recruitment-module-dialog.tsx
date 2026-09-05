"use client"

import { useEffect, useMemo, useState } from "react"
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
import { Textarea } from "@/components/ui/textarea"
import { Checkbox } from "@/components/ui/checkbox"
import { Alert, AlertDescription } from "@/components/ui/alert"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Loader2Icon } from "lucide-react"
import { inr } from "@/lib/finance-calc"
import type { FieldDef, ModuleConfig } from "@/lib/finance-schema"

type FormState = Record<string, string>

/** Build the initial blank form from a config's input (non-computed) fields. */
function emptyForm(cfg: ModuleConfig): FormState {
  const form: FormState = {}
  for (const f of cfg.fields) {
    if (f.computed) continue
    form[f.key] = ""
  }
  return form
}

/** Unique section names, preserving their first-seen order. */
function sectionsOf(cfg: ModuleConfig) {
  const seen = new Set<string>()
  const order: string[] = []
  for (const f of cfg.fields) {
    if (!seen.has(f.section)) {
      seen.add(f.section)
      order.push(f.section)
    }
  }
  return order
}

export function RecruitmentModuleDialog({
  cfg,
  open,
  onOpenChange,
  record,
  onSaved,
}: {
  cfg: ModuleConfig
  open: boolean
  onOpenChange: (open: boolean) => void
  record: Record<string, any> | null
  onSaved: () => void
}) {
  const [form, setForm] = useState<FormState>(() => emptyForm(cfg))
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const checkboxKeys = useMemo(
    () => new Set(cfg.fields.filter((f) => f.type === "checkbox").map((f) => f.key)),
    [cfg],
  )
  const computedFields = useMemo(() => cfg.fields.filter((f) => f.computed), [cfg])
  const sections = useMemo(() => sectionsOf(cfg), [cfg])

  useEffect(() => {
    if (!open) return
    setError(null)
    const base = emptyForm(cfg)
    if (record) {
      for (const key of Object.keys(base)) {
        const v = record[key]
        if (checkboxKeys.has(key)) base[key] = v ? "1" : ""
        else base[key] = v === null || v === undefined ? "" : String(v)
      }
    }
    setForm(base)
  }, [open, record, cfg, checkboxKeys])

  function update(key: string, value: string) {
    setForm((prev) => ({ ...prev, [key]: value }))
  }

  // Live mirror of the server calculation so users see totals before saving.
  const computed = useMemo(() => {
    if (!cfg.compute) return {} as Record<string, any>
    const raw: Record<string, any> = { ...form }
    for (const key of checkboxKeys) raw[key] = form[key] ? 1 : 0
    try {
      return cfg.compute(raw)
    } catch {
      return {} as Record<string, any>
    }
  }, [cfg, form, checkboxKeys])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    for (const f of cfg.fields) {
      if (f.required && !form[f.key]) {
        setError(`${f.label} is required`)
        return
      }
    }
    setLoading(true)
    setError(null)

    const payload: Record<string, any> = { ...form }
    for (const key of checkboxKeys) payload[key] = form[key] ? 1 : 0
    if (record?.id) payload.id = record.id

    try {
      const res = await fetch(`/api/recruitment/module/${cfg.key}`, {
        method: record ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(body.error || `Unable to save ${cfg.label.toLowerCase()}`)
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

  const idLabel = cfg.fields.find((f) => f.key === cfg.idColumn)?.label ?? "ID"

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-3xl">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>
              {record ? `Edit ${cfg.label} · ${record[cfg.idColumn] ?? ""}` : `New ${cfg.label}`}
            </DialogTitle>
            <DialogDescription>
              {record
                ? "Update the details. Calculated values refresh automatically as you type."
                : cfg.editableId
                  ? `The ${idLabel} is auto-generated when left blank. Derived values are calculated for you.`
                  : cfg.idPrefix
                    ? `The ${idLabel} is generated automatically on save. Derived values are calculated for you.`
                    : "Derived values are calculated for you."}
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-6 py-4">
            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}

            {sections.map((section) => {
              const fields = cfg.fields.filter((f) => f.section === section && !f.computed)
              if (!fields.length) return null
              return (
                <FieldGroup key={section}>
                  <h3 className="text-sm font-semibold text-foreground">{section}</h3>
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                    {fields.map((f) => (
                      <FieldInput key={f.key} field={f} value={form[f.key] ?? ""} onChange={update} />
                    ))}
                  </div>
                </FieldGroup>
              )
            })}

            {computedFields.length > 0 && (
              <FieldGroup>
                <h3 className="text-sm font-semibold text-foreground">Calculated automatically</h3>
                <div className="grid grid-cols-2 gap-2 rounded-lg border bg-muted/40 p-4 text-sm sm:grid-cols-3">
                  {computedFields.map((f) => {
                    const value = computed[f.key]
                    return (
                      <div key={f.key} className="flex flex-col">
                        <span className="text-xs text-muted-foreground">{f.label}</span>
                        <span className="font-medium">
                          {f.money ? inr(value) : value === undefined || value === null ? "—" : String(value)}
                        </span>
                      </div>
                    )
                  })}
                </div>
              </FieldGroup>
            )}
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={loading}>
              {loading && <Loader2Icon className="animate-spin" data-icon="inline-start" />}
              {record ? "Save changes" : `Create ${cfg.label.toLowerCase()}`}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function FieldInput({
  field,
  value,
  onChange,
}: {
  field: FieldDef
  value: string
  onChange: (key: string, value: string) => void
}) {
  const wide = field.type === "textarea"

  if (field.type === "checkbox") {
    return (
      <label className="flex items-center gap-2 self-end pb-2 text-sm">
        <Checkbox checked={!!value} onCheckedChange={(c) => onChange(field.key, c ? "1" : "")} />
        {field.label}
      </label>
    )
  }

  if (field.type === "select") {
    const empty = field.optional
    const emptyValue = "__none__"
    return (
      <Field>
        <FieldLabel>{field.label}</FieldLabel>
        <Select
          value={value === "" && empty ? emptyValue : value}
          onValueChange={(v) => onChange(field.key, !v || v === emptyValue ? "" : String(v))}
        >
          <SelectTrigger className="w-full">
            <SelectValue placeholder={field.label} />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {empty && <SelectItem value={emptyValue}>{field.emptyLabel ?? "—"}</SelectItem>}
              {(field.options ?? []).map((o) => (
                <SelectItem key={o} value={o}>
                  {o}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </Field>
    )
  }

  return (
    <Field className={wide ? "sm:col-span-2 lg:col-span-3" : undefined}>
      <FieldLabel htmlFor={field.key}>{field.label}</FieldLabel>
      {field.type === "textarea" ? (
        <Textarea
          id={field.key}
          rows={2}
          placeholder={field.placeholder}
          value={value}
          onChange={(e) => onChange(field.key, e.target.value)}
        />
      ) : (
        <Input
          id={field.key}
          type={field.type === "number" ? "number" : field.type === "date" ? "date" : "text"}
          step={field.type === "number" ? "any" : undefined}
          placeholder={field.placeholder}
          value={value}
          onChange={(e) => onChange(field.key, e.target.value)}
          required={field.required}
        />
      )}
    </Field>
  )
}
