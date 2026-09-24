"use client"

import { useMemo, useState } from "react"
import { Plus, X } from "lucide-react"
import type { FieldDefinition } from "@/lib/custom-fields/model"
import {
  checkFormula,
  getFieldTypeDef,
  keyFromLabel,
  normalizeFieldKey,
} from "@/lib/custom-fields/model"
import type { Catalogue } from "./custom-fields-client"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { Alert, AlertDescription } from "@/components/ui/alert"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

type OptionRow = { value: string; label: string }

/**
 * Create / edit a field definition. This form only assembles a payload; the
 * server re-validates everything through the same model used by the engine, so
 * the client checks here are purely for fast feedback.
 */
export function FieldEditorDialog({
  open,
  catalogue,
  existing,
  siblings,
  onClose,
  onSaved,
}: {
  open: boolean
  catalogue: Catalogue
  existing: FieldDefinition | null
  siblings: FieldDefinition[]
  onClose: () => void
  onSaved: () => void
}) {
  const isEdit = Boolean(existing)

  const [entityType, setEntityType] = useState(existing?.entityType ?? catalogue.entities[0]?.entityType ?? "")
  const [label, setLabel] = useState(existing?.label ?? "")
  const [key, setKey] = useState(existing?.key ?? "")
  const [type, setType] = useState(existing?.type ?? "text")
  const [required, setRequired] = useState(existing?.required ?? false)
  const [active, setActive] = useState(existing?.active ?? true)
  const [helpText, setHelpText] = useState(existing?.helpText ?? "")
  const [viewMinRole, setViewMinRole] = useState(existing?.viewMinRole ?? "employee")
  const [editMinRole, setEditMinRole] = useState(existing?.editMinRole ?? "employee")
  const [options, setOptions] = useState<OptionRow[]>(existing?.options ?? [])
  const [defaultValue, setDefaultValue] = useState(
    existing?.defaultValue == null ? "" : String(existing.defaultValue),
  )

  // Config sub-fields
  const [min, setMin] = useState(existing?.config.min == null ? "" : String(existing.config.min))
  const [max, setMax] = useState(existing?.config.max == null ? "" : String(existing.config.max))
  const [precision, setPrecision] = useState(
    existing?.config.precision == null ? "" : String(existing.config.precision),
  )
  const [currencyCode, setCurrencyCode] = useState(existing?.config.currencyCode ?? "USD")
  const [targetEntity, setTargetEntity] = useState(existing?.config.targetEntity ?? "")
  const [formula, setFormula] = useState(existing?.config.formula ?? "")

  const [submitting, setSubmitting] = useState(false)
  const [serverErrors, setServerErrors] = useState<string[]>([])

  const typeDef = getFieldTypeDef(type)
  const effectiveKey = normalizeFieldKey(key || keyFromLabel(label))

  // Sibling numeric keys available to a formula (exclude this field itself).
  const numericKeys = useMemo(
    () =>
      siblings
        .filter(
          (d) =>
            d.entityType === entityType &&
            d.key !== effectiveKey &&
            (getFieldTypeDef(d.type)?.numeric ?? false),
        )
        .map((d) => d.key),
    [siblings, entityType, effectiveKey],
  )

  const formulaCheck = useMemo(() => {
    if (type !== "formula") return null
    return checkFormula(formula, numericKeys)
  }, [type, formula, numericKeys])

  function updateOption(i: number, patch: Partial<OptionRow>) {
    setOptions((prev) => prev.map((o, idx) => (idx === i ? { ...o, ...patch } : o)))
  }

  async function submit() {
    setServerErrors([])
    setSubmitting(true)
    try {
      const config: Record<string, unknown> = {}
      if (type === "number" || type === "currency") {
        config.min = min === "" ? null : Number(min)
        config.max = max === "" ? null : Number(max)
        config.precision = precision === "" ? null : Number(precision)
        if (type === "currency") config.currencyCode = currencyCode
      }
      if (type === "text") config.max = max === "" ? null : Number(max)
      if (type === "entity") config.targetEntity = targetEntity
      if (type === "formula") config.formula = formula

      const payload = {
        entityType,
        key: effectiveKey || undefined,
        label,
        type,
        required,
        active,
        helpText,
        viewMinRole,
        editMinRole,
        options: typeDef?.hasOptions ? options.filter((o) => o.value.trim()) : [],
        defaultValue: defaultValue === "" ? null : defaultValue,
        config,
        sortOrder: existing?.sortOrder ?? 0,
      }

      const res = await fetch("/api/admin/custom-fields", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        setServerErrors(body.errors ?? [body.error ?? "Could not save the field."])
        return
      }
      onSaved()
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit field" : "New custom field"}</DialogTitle>
          <DialogDescription>
            {isEdit
              ? "Update this field. Its key and entity cannot change."
              : "Define a field to extend a module's records. No code required."}
          </DialogDescription>
        </DialogHeader>

        {serverErrors.length > 0 && (
          <Alert variant="destructive">
            <AlertDescription>
              <ul className="list-inside list-disc text-sm">
                {serverErrors.map((e, i) => (
                  <li key={i}>{e}</li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>
        )}

        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="cf-entity">Entity</Label>
              <Select value={entityType} onValueChange={setEntityType} disabled={isEdit}>
                <SelectTrigger id="cf-entity">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {catalogue.entities.map((e) => (
                    <SelectItem key={e.entityType} value={e.entityType}>
                      {e.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="cf-type">Type</Label>
              <Select value={type} onValueChange={(v) => setType(v as FieldDefinition["type"])} disabled={isEdit}>
                <SelectTrigger id="cf-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {catalogue.fieldTypes.map((t) => (
                    <SelectItem key={t.type} value={t.type}>
                      {t.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {typeDef?.description && (
            <p className="-mt-1 text-xs text-muted-foreground">{typeDef.description}</p>
          )}

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="cf-label">Label</Label>
            <Input
              id="cf-label"
              value={label}
              onChange={(e) => {
                setLabel(e.target.value)
                if (!isEdit && !key) setKey("")
              }}
              placeholder="e.g. Contract value"
            />
            {effectiveKey && (
              <p className="text-xs text-muted-foreground">
                Key: <span className="font-mono">{effectiveKey}</span>
              </p>
            )}
          </div>

          {/* Type-specific configuration */}
          {typeDef?.hasOptions && (
            <div className="flex flex-col gap-2">
              <Label>Options</Label>
              {options.map((o, i) => (
                <div key={i} className="flex items-center gap-2">
                  <Input
                    value={o.value}
                    placeholder="value"
                    className="font-mono"
                    onChange={(e) => updateOption(i, { value: e.target.value })}
                  />
                  <Input
                    value={o.label}
                    placeholder="label"
                    onChange={(e) => updateOption(i, { label: e.target.value })}
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Remove option"
                    onClick={() => setOptions((prev) => prev.filter((_, idx) => idx !== i))}
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </div>
              ))}
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="self-start"
                onClick={() => setOptions((prev) => [...prev, { value: "", label: "" }])}
              >
                <Plus className="mr-1.5 h-4 w-4" />
                Add option
              </Button>
            </div>
          )}

          {(type === "number" || type === "currency") && (
            <div className="grid grid-cols-3 gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="cf-min">Min</Label>
                <Input id="cf-min" type="number" value={min} onChange={(e) => setMin(e.target.value)} />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="cf-max">Max</Label>
                <Input id="cf-max" type="number" value={max} onChange={(e) => setMax(e.target.value)} />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="cf-prec">Precision</Label>
                <Input
                  id="cf-prec"
                  type="number"
                  min={0}
                  max={6}
                  value={precision}
                  onChange={(e) => setPrecision(e.target.value)}
                />
              </div>
            </div>
          )}

          {type === "currency" && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="cf-ccy">Currency code</Label>
              <Input
                id="cf-ccy"
                value={currencyCode}
                maxLength={3}
                className="w-28 font-mono uppercase"
                onChange={(e) => setCurrencyCode(e.target.value.toUpperCase())}
              />
            </div>
          )}

          {type === "text" && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="cf-maxlen">Max length</Label>
              <Input
                id="cf-maxlen"
                type="number"
                min={1}
                max={10000}
                value={max}
                onChange={(e) => setMax(e.target.value)}
                placeholder="Optional"
              />
            </div>
          )}

          {type === "entity" && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="cf-target">Target entity</Label>
              <Select value={targetEntity} onValueChange={setTargetEntity}>
                <SelectTrigger id="cf-target">
                  <SelectValue placeholder="Select entity…" />
                </SelectTrigger>
                <SelectContent>
                  {catalogue.entities.map((e) => (
                    <SelectItem key={e.entityType} value={e.entityType}>
                      {e.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {type === "formula" && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="cf-formula">Formula</Label>
              <Input
                id="cf-formula"
                value={formula}
                className="font-mono"
                placeholder="e.g. quantity * unit_price"
                onChange={(e) => setFormula(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Numeric fields available:{" "}
                {numericKeys.length ? (
                  <span className="font-mono">{numericKeys.join(", ")}</span>
                ) : (
                  "none yet"
                )}
              </p>
              {formula && formulaCheck && !formulaCheck.ok && (
                <p className="text-xs text-destructive">{formulaCheck.error}</p>
              )}
            </div>
          )}

          {type !== "formula" && type !== "boolean" && !typeDef?.hasOptions && !typeDef?.isRelation && type !== "file" && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="cf-default">Default value</Label>
              <Input
                id="cf-default"
                value={defaultValue}
                onChange={(e) => setDefaultValue(e.target.value)}
                placeholder="Optional"
              />
            </div>
          )}

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="cf-help">Help text</Label>
            <Textarea
              id="cf-help"
              value={helpText}
              rows={2}
              onChange={(e) => setHelpText(e.target.value)}
              placeholder="Shown under the field in forms."
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="cf-view">Minimum role to view</Label>
              <Select value={viewMinRole} onValueChange={(v) => setViewMinRole(v as FieldDefinition["viewMinRole"])}>
                <SelectTrigger id="cf-view">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {catalogue.roles.map((r) => (
                    <SelectItem key={r.role} value={r.role}>
                      {r.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="cf-edit">Minimum role to edit</Label>
              <Select value={editMinRole} onValueChange={(v) => setEditMinRole(v as FieldDefinition["editMinRole"])}>
                <SelectTrigger id="cf-edit">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {catalogue.roles.map((r) => (
                    <SelectItem key={r.role} value={r.role}>
                      {r.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="flex items-center gap-6">
            {type !== "formula" && (
              <label className="flex items-center gap-2 text-sm">
                <Switch checked={required} onCheckedChange={setRequired} />
                Required
              </label>
            )}
            <label className="flex items-center gap-2 text-sm">
              <Switch checked={active} onCheckedChange={setActive} />
              Active
            </label>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={submitting || !label.trim()}>
            {submitting ? "Saving…" : isEdit ? "Save changes" : "Create field"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
