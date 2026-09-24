"use client"

/**
 * SPEC 95 — Custom Forms: reusable renderer.
 * ---------------------------------------------------------------------------
 * Turns a FormDefinition + a values map into live, conditionally-visible
 * inputs. Every visibility and required decision is delegated to the SAME pure
 * model the server validates with (isSectionVisible / isFieldVisible), so what
 * a responder sees and what the server accepts can never diverge.
 *
 * The component is controlled: it owns no value state. Callers pass `values`
 * and receive changes via `onChange`, which keeps the admin builder preview and
 * the runtime submit page in sync with a single source of truth.
 */
import { useMemo } from "react"
import {
  type FormDefinition,
  type FormField,
  isFieldVisible,
  isSectionVisible,
} from "@/lib/custom-forms/model"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Switch } from "@/components/ui/switch"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

export type FormValues = Record<string, unknown>

export function FormRenderer({
  form,
  values,
  onChange,
  errors,
  disabled,
}: {
  form: FormDefinition
  values: FormValues
  onChange: (next: FormValues) => void
  errors?: Record<string, string>
  disabled?: boolean
}) {
  const visibleSections = useMemo(
    () => form.sections.filter((s) => isSectionVisible(s, values)),
    [form.sections, values],
  )

  const setValue = (key: string, value: unknown) => {
    const next = { ...values }
    if (value == null || value === "") delete next[key]
    else next[key] = value
    onChange(next)
  }

  if (visibleSections.length === 0) {
    return (
      <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
        No sections are visible for the current answers.
      </p>
    )
  }

  return (
    <div className="flex flex-col gap-8">
      {visibleSections.map((section) => {
        const fields = section.fields.filter((f) => isFieldVisible(section, f, values))
        if (fields.length === 0) return null
        return (
          <fieldset key={section.key} className="flex flex-col gap-4 border-0 p-0" disabled={disabled}>
            <div className="border-b pb-2">
              <legend className="text-base font-semibold">{section.title}</legend>
              {section.description && (
                <p className="mt-1 text-sm text-muted-foreground">{section.description}</p>
              )}
            </div>
            <div className="flex flex-col gap-5">
              {fields.map((field) => (
                <FieldControl
                  key={field.key}
                  field={field}
                  value={values[field.key]}
                  onChange={(v) => setValue(field.key, v)}
                  error={errors?.[field.key]}
                />
              ))}
            </div>
          </fieldset>
        )
      })}
    </div>
  )
}

function FieldControl({
  field,
  value,
  onChange,
  error,
}: {
  field: FormField
  value: unknown
  onChange: (value: unknown) => void
  error?: string
}) {
  const id = `field-${field.key}`
  const describedBy = [field.helpText ? `${id}-help` : null, error ? `${id}-error` : null]
    .filter(Boolean)
    .join(" ")

  const labelRow = (
    <Label htmlFor={id} className="flex items-center gap-1">
      <span>{field.label}</span>
      {field.required && (
        <span className="text-destructive" aria-hidden="true">
          *
        </span>
      )}
    </Label>
  )

  const help = field.helpText ? (
    <p id={`${id}-help`} className="text-xs text-muted-foreground">
      {field.helpText}
    </p>
  ) : null

  const errorNode = error ? (
    <p id={`${id}-error`} className="text-xs font-medium text-destructive">
      {error}
    </p>
  ) : null

  const common = {
    id,
    "aria-describedby": describedBy || undefined,
    "aria-invalid": error ? true : undefined,
    "aria-required": field.required || undefined,
  }

  let control: React.ReactNode

  switch (field.type) {
    case "textarea":
      control = (
        <Textarea
          {...common}
          value={value == null ? "" : String(value)}
          placeholder={field.config.placeholder ?? undefined}
          maxLength={field.config.maxLength ?? undefined}
          onChange={(e) => onChange(e.target.value)}
        />
      )
      break
    case "number":
      control = (
        <Input
          {...common}
          type="number"
          value={value == null ? "" : String(value)}
          min={field.config.min ?? undefined}
          max={field.config.max ?? undefined}
          placeholder={field.config.placeholder ?? undefined}
          onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}
        />
      )
      break
    case "date":
      control = (
        <Input
          {...common}
          type="date"
          value={value == null ? "" : String(value)}
          onChange={(e) => onChange(e.target.value)}
        />
      )
      break
    case "email":
      control = (
        <Input
          {...common}
          type="email"
          value={value == null ? "" : String(value)}
          placeholder={field.config.placeholder ?? undefined}
          onChange={(e) => onChange(e.target.value)}
        />
      )
      break
    case "url":
      control = (
        <Input
          {...common}
          type="url"
          inputMode="url"
          value={value == null ? "" : String(value)}
          placeholder={field.config.placeholder ?? "https://"}
          onChange={(e) => onChange(e.target.value)}
        />
      )
      break
    case "phone":
      control = (
        <Input
          {...common}
          type="tel"
          inputMode="tel"
          value={value == null ? "" : String(value)}
          placeholder={field.config.placeholder ?? undefined}
          onChange={(e) => onChange(e.target.value)}
        />
      )
      break
    case "boolean":
      control = (
        <div className="flex items-center gap-2">
          <Switch
            id={id}
            aria-describedby={describedBy || undefined}
            checked={value === true}
            onCheckedChange={(c) => onChange(c === true)}
          />
          <span className="text-sm text-muted-foreground">{value === true ? "Yes" : "No"}</span>
        </div>
      )
      break
    case "dropdown":
      control = (
        <Select value={value == null ? "" : String(value)} onValueChange={(v) => onChange(v)}>
          <SelectTrigger id={id} aria-describedby={describedBy || undefined} aria-invalid={error ? true : undefined}>
            <SelectValue placeholder={field.config.placeholder ?? "Select…"} />
          </SelectTrigger>
          <SelectContent>
            {field.options.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )
      break
    case "multiselect": {
      const selected = Array.isArray(value) ? (value as string[]) : []
      control = (
        <div className="flex flex-col gap-2 rounded-md border p-3" role="group" aria-describedby={describedBy || undefined}>
          {field.options.map((o) => {
            const checked = selected.includes(o.value)
            return (
              <label key={o.value} className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={checked}
                  onCheckedChange={(c) => {
                    const next = c === true ? [...selected, o.value] : selected.filter((v) => v !== o.value)
                    onChange(next)
                  }}
                />
                <span>{o.label}</span>
              </label>
            )
          })}
        </div>
      )
      break
    }
    case "file": {
      const current = value && typeof value === "object" ? (value as { name?: string; url?: string }) : null
      control = (
        <div className="flex flex-col gap-1">
          <Input
            {...common}
            type="url"
            placeholder="Paste a file URL"
            value={current?.url ?? (typeof value === "string" ? value : "")}
            onChange={(e) => onChange(e.target.value ? { name: e.target.value.split("/").pop(), url: e.target.value } : null)}
          />
          {field.config.accept && (
            <span className="text-xs text-muted-foreground">Accepted: {field.config.accept}</span>
          )}
        </div>
      )
      break
    }
    default:
      control = (
        <Input
          {...common}
          value={value == null ? "" : String(value)}
          placeholder={field.config.placeholder ?? undefined}
          maxLength={field.config.maxLength ?? undefined}
          onChange={(e) => onChange(e.target.value)}
        />
      )
  }

  return (
    <div className="flex flex-col gap-1.5">
      {field.type !== "boolean" ? labelRow : <div className="flex flex-col gap-1.5">{labelRow}</div>}
      {control}
      {help}
      {errorNode}
    </div>
  )
}
