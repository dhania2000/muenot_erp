"use client"

import type { FieldDefinition } from "@/lib/custom-fields/model"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Switch } from "@/components/ui/switch"
import { Label } from "@/components/ui/label"
import { Checkbox } from "@/components/ui/checkbox"
import { Badge } from "@/components/ui/badge"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

/**
 * Renders a single custom field as a form control, chosen entirely from its
 * definition. This is the reusable heart of the "dynamic forms" deliverable:
 * any module can render its custom fields by mapping definitions through this
 * component. Formula fields render as a read-only computed value.
 */
export function DynamicField({
  def,
  value,
  onChange,
  error,
  disabled,
  computedValue,
}: {
  def: FieldDefinition
  value: unknown
  onChange: (value: unknown) => void
  error?: string | null
  disabled?: boolean
  /** For formula fields: the already-computed result to display. */
  computedValue?: number | null
}) {
  const id = `cf-${def.key}`
  const describedBy = error ? `${id}-error` : def.helpText ? `${id}-help` : undefined

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <Label htmlFor={id} className="text-sm">
          {def.label}
          {def.required && <span className="ml-0.5 text-destructive">*</span>}
        </Label>
        {def.type === "formula" && (
          <Badge variant="secondary" className="text-[10px]">
            Computed
          </Badge>
        )}
      </div>

      <FieldControl
        id={id}
        def={def}
        value={value}
        onChange={onChange}
        disabled={disabled}
        computedValue={computedValue}
        describedBy={describedBy}
        invalid={Boolean(error)}
      />

      {def.helpText && !error && (
        <p id={`${id}-help`} className="text-xs text-muted-foreground">
          {def.helpText}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}

function FieldControl({
  id,
  def,
  value,
  onChange,
  disabled,
  computedValue,
  describedBy,
  invalid,
}: {
  id: string
  def: FieldDefinition
  value: unknown
  onChange: (value: unknown) => void
  disabled?: boolean
  computedValue?: number | null
  describedBy?: string
  invalid: boolean
}) {
  const aria = { "aria-describedby": describedBy, "aria-invalid": invalid || undefined }

  switch (def.type) {
    case "text": {
      const max = def.config.max ?? undefined
      const s = value == null ? "" : String(value)
      // A generous max implies multi-line notes; a short cap stays single-line.
      if (max && max > 255) {
        return (
          <Textarea
            id={id}
            value={s}
            maxLength={max}
            disabled={disabled}
            onChange={(e) => onChange(e.target.value)}
            {...aria}
          />
        )
      }
      return (
        <Input id={id} value={s} maxLength={max} disabled={disabled} onChange={(e) => onChange(e.target.value)} {...aria} />
      )
    }

    case "url":
      return (
        <Input
          id={id}
          type="url"
          inputMode="url"
          placeholder="https://…"
          value={value == null ? "" : String(value)}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          {...aria}
        />
      )

    case "number":
      return (
        <Input
          id={id}
          type="number"
          value={value == null ? "" : String(value)}
          min={def.config.min ?? undefined}
          max={def.config.max ?? undefined}
          step={def.config.precision ? Number(`1e-${def.config.precision}`) : "any"}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}
          {...aria}
        />
      )

    case "currency": {
      const amount =
        value && typeof value === "object" ? (value as any).amount : value
      return (
        <div className="flex items-center gap-2">
          <span className="rounded-md border bg-muted px-2 py-1.5 text-xs font-medium text-muted-foreground">
            {def.config.currencyCode ?? "USD"}
          </span>
          <Input
            id={id}
            type="number"
            value={amount == null ? "" : String(amount)}
            min={def.config.min ?? undefined}
            max={def.config.max ?? undefined}
            step={Number(`1e-${def.config.precision ?? 2}`)}
            disabled={disabled}
            onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}
            {...aria}
          />
        </div>
      )
    }

    case "date":
      return (
        <Input
          id={id}
          type="date"
          value={value == null ? "" : String(value)}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value || null)}
          {...aria}
        />
      )

    case "boolean":
      return (
        <div className="flex h-9 items-center">
          <Switch
            id={id}
            checked={value === true}
            disabled={disabled}
            onCheckedChange={(v) => onChange(v)}
            aria-describedby={describedBy}
          />
        </div>
      )

    case "dropdown":
      return (
        <Select
          value={value == null ? "" : String(value)}
          disabled={disabled}
          onValueChange={(v) => onChange(v)}
        >
          <SelectTrigger id={id} {...aria}>
            <SelectValue placeholder="Select…" />
          </SelectTrigger>
          <SelectContent>
            {def.options.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )

    case "multiselect": {
      const selected: string[] = Array.isArray(value) ? value.map(String) : []
      function toggle(v: string, on: boolean) {
        const next = on ? [...selected, v] : selected.filter((x) => x !== v)
        onChange(Array.from(new Set(next)))
      }
      return (
        <div className="flex flex-col gap-2 rounded-md border p-3" role="group" aria-describedby={describedBy}>
          {def.options.map((o) => {
            const checked = selected.includes(o.value)
            return (
              <label key={o.value} className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={checked}
                  disabled={disabled}
                  onCheckedChange={(c) => toggle(o.value, c === true)}
                />
                {o.label}
              </label>
            )
          })}
        </div>
      )
    }

    case "user":
    case "department":
      return (
        <Input
          id={id}
          type="number"
          min={1}
          step={1}
          placeholder={`${def.type === "user" ? "User" : "Department"} id`}
          value={value == null ? "" : String(value)}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}
          {...aria}
        />
      )

    case "entity": {
      const id2 =
        value && typeof value === "object" ? (value as any).id : value
      return (
        <Input
          id={id}
          placeholder={`${def.config.targetEntity ?? "record"} id`}
          value={id2 == null ? "" : String(id2)}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value || null)}
          {...aria}
        />
      )
    }

    case "file": {
      const url =
        value && typeof value === "object" ? (value as any).url : value
      return (
        <Input
          id={id}
          type="url"
          placeholder="https://…/file.pdf"
          value={url == null ? "" : String(url)}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value || null)}
          {...aria}
        />
      )
    }

    case "formula":
      return (
        <div
          id={id}
          className="flex h-9 items-center rounded-md border border-dashed bg-muted/40 px-3 font-mono text-sm tabular-nums"
        >
          {computedValue == null ? (
            <span className="text-muted-foreground">—</span>
          ) : (
            computedValue
          )}
        </div>
      )

    default:
      return null
  }
}
