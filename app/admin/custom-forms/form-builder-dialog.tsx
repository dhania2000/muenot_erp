"use client"

import { useMemo, useState } from "react"
import { Plus, Trash2, ChevronDown, ChevronRight, GripVertical } from "lucide-react"
import type {
  ConditionGroup,
  FormDefinition,
  FormField,
  FormFieldType,
  FormSection,
} from "@/lib/custom-forms/model"
import { getFormFieldTypeDef, keyFromLabel } from "@/lib/custom-forms/model"
import type { Catalogue } from "./custom-forms-client"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
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
import { FormRenderer, type FormValues } from "@/components/custom-forms/form-renderer"

// ---------------------------------------------------------------------------
// Draft (editable) shapes — string-keyed local ids so the UI is stable while
// keys are still being derived. Serialized to the model shape on save.
// ---------------------------------------------------------------------------

type DraftOption = { value: string; label: string }
type DraftField = {
  uid: string
  key: string
  label: string
  type: FormFieldType
  required: boolean
  helpText: string
  options: DraftOption[]
  min: string
  max: string
  maxLength: string
  placeholder: string
  accept: string
  visibility: ConditionGroup | null
}
type DraftSection = {
  uid: string
  title: string
  description: string
  visibility: ConditionGroup | null
  fields: DraftField[]
}

let uidCounter = 0
const uid = () => `u${++uidCounter}`

function toDraftField(f: FormField): DraftField {
  return {
    uid: uid(),
    key: f.key,
    label: f.label,
    type: f.type,
    required: f.required,
    helpText: f.helpText,
    options: f.options.map((o) => ({ ...o })),
    min: f.config.min == null ? "" : String(f.config.min),
    max: f.config.max == null ? "" : String(f.config.max),
    maxLength: f.config.maxLength == null ? "" : String(f.config.maxLength),
    placeholder: f.config.placeholder ?? "",
    accept: f.config.accept ?? "",
    visibility: f.visibility,
  }
}

function newField(): DraftField {
  return {
    uid: uid(),
    key: "",
    label: "",
    type: "text",
    required: false,
    helpText: "",
    options: [],
    min: "",
    max: "",
    maxLength: "",
    placeholder: "",
    accept: "",
    visibility: null,
  }
}

function toDraftSection(s: FormSection): DraftSection {
  return {
    uid: uid(),
    title: s.title,
    description: s.description,
    visibility: s.visibility,
    fields: s.fields.map(toDraftField),
  }
}

function newSection(): DraftSection {
  return { uid: uid(), title: "", description: "", visibility: null, fields: [newField()] }
}

/** Serialize the drafts into the raw payload the API/model expects. */
function serialize(sections: DraftSection[]) {
  return sections.map((s) => ({
    key: keyFromLabel(s.title),
    title: s.title,
    description: s.description,
    visibility: s.visibility,
    fields: s.fields.map((f) => ({
      key: f.key || keyFromLabel(f.label),
      label: f.label,
      type: f.type,
      required: f.required,
      helpText: f.helpText,
      options: f.options,
      config: {
        min: f.min === "" ? null : Number(f.min),
        max: f.max === "" ? null : Number(f.max),
        maxLength: f.maxLength === "" ? null : Number(f.maxLength),
        placeholder: f.placeholder,
        accept: f.accept,
      },
      visibility: f.visibility,
    })),
  }))
}

export function FormBuilderDialog({
  open,
  catalogue,
  existing,
  onClose,
  onSaved,
}: {
  open: boolean
  catalogue: Catalogue
  existing: FormDefinition | null
  onClose: () => void
  onSaved: () => void
}) {
  const isEdit = Boolean(existing)
  const [title, setTitle] = useState(existing?.title ?? "")
  const [description, setDescription] = useState(existing?.description ?? "")
  const [submitLabel, setSubmitLabel] = useState(existing?.submitLabel ?? "Submit")
  const [approvalEnabled, setApprovalEnabled] = useState(existing?.approval.enabled ?? false)
  const [approverMinRole, setApproverMinRole] = useState(existing?.approval.approverMinRole ?? "tenant_admin")
  const [sections, setSections] = useState<DraftSection[]>(
    existing ? existing.sections.map(toDraftSection) : [newSection()],
  )
  const [tab, setTab] = useState<"build" | "preview">("build")
  const [previewValues, setPreviewValues] = useState<FormValues>({})
  const [errors, setErrors] = useState<string[]>([])
  const [saving, setSaving] = useState(false)

  // All field keys in the form — the pool a condition may reference.
  const fieldChoices = useMemo(() => {
    const out: { key: string; label: string }[] = []
    for (const s of sections) {
      for (const f of s.fields) {
        const key = f.key || keyFromLabel(f.label)
        if (key) out.push({ key, label: f.label || key })
      }
    }
    return out
  }, [sections])

  const previewForm: FormDefinition = useMemo(
    () => ({
      id: existing?.id ?? null,
      title: title || "Untitled form",
      slug: existing?.slug ?? "preview",
      description,
      status: "published",
      submitLabel,
      approval: { enabled: approvalEnabled, approverMinRole: approverMinRole as FormDefinition["approval"]["approverMinRole"] },
      sections: serialize(sections) as unknown as FormSection[],
      version: existing?.version ?? 1,
    }),
    [existing, title, description, submitLabel, approvalEnabled, approverMinRole, sections],
  )

  function updateSection(idx: number, patch: Partial<DraftSection>) {
    setSections((prev) => prev.map((s, i) => (i === idx ? { ...s, ...patch } : s)))
  }
  function updateField(si: number, fi: number, patch: Partial<DraftField>) {
    setSections((prev) =>
      prev.map((s, i) =>
        i === si ? { ...s, fields: s.fields.map((f, j) => (j === fi ? { ...f, ...patch } : f)) } : s,
      ),
    )
  }
  function removeSection(idx: number) {
    setSections((prev) => (prev.length === 1 ? prev : prev.filter((_, i) => i !== idx)))
  }
  function addField(si: number) {
    setSections((prev) => prev.map((s, i) => (i === si ? { ...s, fields: [...s.fields, newField()] } : s)))
  }
  function removeField(si: number, fi: number) {
    setSections((prev) =>
      prev.map((s, i) =>
        i === si ? { ...s, fields: s.fields.length === 1 ? s.fields : s.fields.filter((_, j) => j !== fi) } : s,
      ),
    )
  }

  async function save() {
    setErrors([])
    setSaving(true)
    try {
      const payload = {
        id: existing?.id ?? undefined,
        title,
        description,
        submitLabel,
        status: existing?.status ?? "draft",
        approval: { enabled: approvalEnabled, approverMinRole },
        sections: serialize(sections),
      }
      const res = await fetch(
        existing?.id ? `/api/admin/custom-forms` : "/api/admin/custom-forms",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        },
      )
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        setErrors(body.errors ?? [body.error ?? "Could not save the form."])
        return
      }
      onSaved()
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92vh] max-w-4xl overflow-hidden p-0">
        <div className="flex max-h-[92vh] flex-col">
          <DialogHeader className="border-b p-6 pb-4">
            <DialogTitle>{isEdit ? "Edit form" : "New form"}</DialogTitle>
            <DialogDescription>
              Compose sections and fields, add conditional visibility and an approval workflow. The
              server re-validates everything on save.
            </DialogDescription>
          </DialogHeader>

          <div className="flex items-center gap-1 border-b px-6">
            <TabButton active={tab === "build"} onClick={() => setTab("build")}>
              Build
            </TabButton>
            <TabButton
              active={tab === "preview"}
              onClick={() => {
                setPreviewValues({})
                setTab("preview")
              }}
            >
              Preview
            </TabButton>
          </div>

          <div className="flex-1 overflow-y-auto p-6">
            {errors.length > 0 && (
              <Alert variant="destructive" className="mb-4">
                <AlertDescription>
                  <ul className="list-inside list-disc space-y-0.5">
                    {errors.map((e, i) => (
                      <li key={i}>{e}</li>
                    ))}
                  </ul>
                </AlertDescription>
              </Alert>
            )}

            {tab === "build" ? (
              <div className="flex flex-col gap-6">
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="form-title">Form title</Label>
                    <Input
                      id="form-title"
                      value={title}
                      onChange={(e) => setTitle(e.target.value)}
                      placeholder="e.g. Vendor onboarding request"
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="form-submit-label">Submit button label</Label>
                    <Input
                      id="form-submit-label"
                      value={submitLabel}
                      onChange={(e) => setSubmitLabel(e.target.value)}
                      placeholder="Submit"
                    />
                  </div>
                  <div className="flex flex-col gap-1.5 sm:col-span-2">
                    <Label htmlFor="form-description">Description</Label>
                    <Textarea
                      id="form-description"
                      value={description}
                      onChange={(e) => setDescription(e.target.value)}
                      placeholder="Shown to responders above the form."
                    />
                  </div>
                </div>

                <div className="flex flex-col gap-3 rounded-md border p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="text-sm font-medium">Require approval</div>
                      <p className="text-xs text-muted-foreground">
                        Submissions wait for an approver before they are accepted.
                      </p>
                    </div>
                    <Switch checked={approvalEnabled} onCheckedChange={setApprovalEnabled} />
                  </div>
                  {approvalEnabled && (
                    <div className="flex flex-col gap-1.5">
                      <Label>Minimum approver role</Label>
                      <Select value={approverMinRole} onValueChange={(v) => setApproverMinRole(v as typeof approverMinRole)}>
                        <SelectTrigger className="w-64">
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
                  )}
                </div>

                <div className="flex flex-col gap-4">
                  {sections.map((section, si) => (
                    <SectionEditor
                      key={section.uid}
                      section={section}
                      index={si}
                      canRemove={sections.length > 1}
                      fieldTypes={catalogue.fieldTypes}
                      operators={catalogue.operators}
                      fieldChoices={fieldChoices}
                      onChange={(patch) => updateSection(si, patch)}
                      onRemove={() => removeSection(si)}
                      onFieldChange={(fi, patch) => updateField(si, fi, patch)}
                      onAddField={() => addField(si)}
                      onRemoveField={(fi) => removeField(si, fi)}
                    />
                  ))}
                  <Button variant="outline" onClick={() => setSections((prev) => [...prev, newSection()])}>
                    <Plus className="mr-1.5 h-4 w-4" />
                    Add section
                  </Button>
                </div>
              </div>
            ) : (
              <div className="mx-auto max-w-2xl">
                {description && <p className="mb-4 text-sm text-muted-foreground">{description}</p>}
                <FormRenderer form={previewForm} values={previewValues} onChange={setPreviewValues} />
                <p className="mt-6 text-xs text-muted-foreground">
                  This is a live preview. Toggle fields to see conditional visibility in action.
                </p>
              </div>
            )}
          </div>

          <DialogFooter className="border-t p-6 pt-4">
            <Button variant="outline" onClick={onClose} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={save} disabled={saving}>
              {saving ? "Saving…" : isEdit ? "Save changes" : "Create form"}
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`-mb-px border-b-2 px-3 py-2.5 text-sm font-medium transition-colors ${
        active
          ? "border-primary text-foreground"
          : "border-transparent text-muted-foreground hover:text-foreground"
      }`}
    >
      {children}
    </button>
  )
}

function SectionEditor({
  section,
  index,
  canRemove,
  fieldTypes,
  operators,
  fieldChoices,
  onChange,
  onRemove,
  onFieldChange,
  onAddField,
  onRemoveField,
}: {
  section: DraftSection
  index: number
  canRemove: boolean
  fieldTypes: Catalogue["fieldTypes"]
  operators: Catalogue["operators"]
  fieldChoices: { key: string; label: string }[]
  onChange: (patch: Partial<DraftSection>) => void
  onRemove: () => void
  onFieldChange: (fi: number, patch: Partial<DraftField>) => void
  onAddField: () => void
  onRemoveField: (fi: number) => void
}) {
  const [open, setOpen] = useState(true)
  return (
    <div className="rounded-lg border">
      <div className="flex items-center gap-2 border-b bg-muted/40 px-3 py-2">
        <button type="button" onClick={() => setOpen((o) => !o)} aria-label="Toggle section">
          {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </button>
        <span className="text-sm font-medium">
          Section {index + 1}
          {section.title ? `: ${section.title}` : ""}
        </span>
        <Badge variant="secondary" className="ml-1">
          {section.fields.length} field{section.fields.length === 1 ? "" : "s"}
        </Badge>
        <div className="ml-auto">
          <Button
            variant="ghost"
            size="icon"
            aria-label="Remove section"
            disabled={!canRemove}
            onClick={onRemove}
          >
            <Trash2 className="h-4 w-4 text-destructive" />
          </Button>
        </div>
      </div>

      {open && (
        <div className="flex flex-col gap-4 p-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label>Section title</Label>
              <Input value={section.title} onChange={(e) => onChange({ title: e.target.value })} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>Description</Label>
              <Input
                value={section.description}
                onChange={(e) => onChange({ description: e.target.value })}
              />
            </div>
          </div>

          <ConditionEditor
            label="Show this whole section only when…"
            group={section.visibility}
            operators={operators}
            fieldChoices={fieldChoices}
            onChange={(visibility) => onChange({ visibility })}
          />

          <div className="flex flex-col gap-3">
            {section.fields.map((field, fi) => (
              <FieldEditor
                key={field.uid}
                field={field}
                canRemove={section.fields.length > 1}
                fieldTypes={fieldTypes}
                operators={operators}
                fieldChoices={fieldChoices.filter((c) => c.key !== (field.key || keyFromLabel(field.label)))}
                onChange={(patch) => onFieldChange(fi, patch)}
                onRemove={() => onRemoveField(fi)}
              />
            ))}
            <Button variant="outline" size="sm" className="self-start" onClick={onAddField}>
              <Plus className="mr-1.5 h-4 w-4" />
              Add field
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

function FieldEditor({
  field,
  canRemove,
  fieldTypes,
  operators,
  fieldChoices,
  onChange,
  onRemove,
}: {
  field: DraftField
  canRemove: boolean
  fieldTypes: Catalogue["fieldTypes"]
  operators: Catalogue["operators"]
  fieldChoices: { key: string; label: string }[]
  onChange: (patch: Partial<DraftField>) => void
  onRemove: () => void
}) {
  const typeDef = getFormFieldTypeDef(field.type)
  const hasOptions = typeDef?.hasOptions ?? false
  const isNumber = field.type === "number"
  const isText = field.type === "text" || field.type === "textarea"
  const isFile = field.type === "file"

  return (
    <div className="rounded-md border bg-background p-3">
      <div className="flex items-start gap-2">
        <GripVertical className="mt-2 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <div className="flex flex-1 flex-col gap-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label>Field label</Label>
              <Input
                value={field.label}
                onChange={(e) => onChange({ label: e.target.value })}
                placeholder="e.g. Company name"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>Type</Label>
              <Select value={field.type} onValueChange={(v) => onChange({ type: v as FormFieldType })}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {fieldTypes.map((t) => (
                    <SelectItem key={t.type} value={t.type}>
                      {t.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label>Help text</Label>
            <Input
              value={field.helpText}
              onChange={(e) => onChange({ helpText: e.target.value })}
              placeholder="Optional guidance shown beneath the field."
            />
          </div>

          {hasOptions && (
            <OptionsEditor options={field.options} onChange={(options) => onChange({ options })} />
          )}

          <div className="grid gap-3 sm:grid-cols-2">
            {isNumber && (
              <>
                <div className="flex flex-col gap-1.5">
                  <Label>Minimum</Label>
                  <Input
                    type="number"
                    value={field.min}
                    onChange={(e) => onChange({ min: e.target.value })}
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label>Maximum</Label>
                  <Input
                    type="number"
                    value={field.max}
                    onChange={(e) => onChange({ max: e.target.value })}
                  />
                </div>
              </>
            )}
            {isText && (
              <div className="flex flex-col gap-1.5">
                <Label>Max length</Label>
                <Input
                  type="number"
                  value={field.maxLength}
                  onChange={(e) => onChange({ maxLength: e.target.value })}
                />
              </div>
            )}
            {isFile && (
              <div className="flex flex-col gap-1.5">
                <Label>Accepted types</Label>
                <Input
                  value={field.accept}
                  onChange={(e) => onChange({ accept: e.target.value })}
                  placeholder="e.g. .pdf,.png"
                />
              </div>
            )}
            {!isFile && (
              <div className="flex flex-col gap-1.5">
                <Label>Placeholder</Label>
                <Input
                  value={field.placeholder}
                  onChange={(e) => onChange({ placeholder: e.target.value })}
                />
              </div>
            )}
          </div>

          <ConditionEditor
            label="Show this field only when…"
            group={field.visibility}
            operators={operators}
            fieldChoices={fieldChoices}
            onChange={(visibility) => onChange({ visibility })}
          />

          <div className="flex items-center gap-2">
            <Switch checked={field.required} onCheckedChange={(c) => onChange({ required: c })} />
            <span className="text-sm">Required</span>
          </div>
        </div>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Remove field"
          disabled={!canRemove}
          onClick={onRemove}
        >
          <Trash2 className="h-4 w-4 text-destructive" />
        </Button>
      </div>
    </div>
  )
}

function OptionsEditor({
  options,
  onChange,
}: {
  options: DraftOption[]
  onChange: (options: DraftOption[]) => void
}) {
  return (
    <div className="flex flex-col gap-2">
      <Label>Options</Label>
      <div className="flex flex-col gap-2">
        {options.map((opt, i) => (
          <div key={i} className="flex items-center gap-2">
            <Input
              value={opt.label}
              placeholder="Label"
              onChange={(e) => {
                const next = [...options]
                next[i] = { ...next[i], label: e.target.value, value: next[i].value || keyLike(e.target.value) }
                onChange(next)
              }}
            />
            <Input
              value={opt.value}
              placeholder="value"
              className="max-w-40 font-mono text-xs"
              onChange={(e) => {
                const next = [...options]
                next[i] = { ...next[i], value: e.target.value }
                onChange(next)
              }}
            />
            <Button
              variant="ghost"
              size="icon"
              aria-label="Remove option"
              onClick={() => onChange(options.filter((_, j) => j !== i))}
            >
              <Trash2 className="h-4 w-4 text-destructive" />
            </Button>
          </div>
        ))}
      </div>
      <Button
        variant="outline"
        size="sm"
        className="self-start"
        onClick={() => onChange([...options, { label: "", value: "" }])}
      >
        <Plus className="mr-1.5 h-4 w-4" />
        Add option
      </Button>
    </div>
  )
}

function keyLike(label: string): string {
  return label.trim().toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "")
}

function ConditionEditor({
  label,
  group,
  operators,
  fieldChoices,
  onChange,
}: {
  label: string
  group: ConditionGroup | null
  operators: Catalogue["operators"]
  fieldChoices: { key: string; label: string }[]
  onChange: (group: ConditionGroup | null) => void
}) {
  const enabled = group != null
  const rules = group?.rules ?? []

  function setEnabled(on: boolean) {
    if (on) onChange({ match: "all", rules: [{ field: fieldChoices[0]?.key ?? "", operator: "equals", value: "" }] })
    else onChange(null)
  }

  if (fieldChoices.length === 0 && !enabled) {
    return (
      <p className="text-xs text-muted-foreground">
        Add other fields first to make this conditional.
      </p>
    )
  }

  return (
    <div className="rounded-md border border-dashed p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">{label}</span>
        <Switch checked={enabled} onCheckedChange={setEnabled} disabled={fieldChoices.length === 0} />
      </div>

      {enabled && group && (
        <div className="mt-3 flex flex-col gap-2">
          <div className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">Match</span>
            <Select
              value={group.match}
              onValueChange={(v) => onChange({ ...group, match: v as "all" | "any" })}
            >
              <SelectTrigger className="h-8 w-28">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">all</SelectItem>
                <SelectItem value="any">any</SelectItem>
              </SelectContent>
            </Select>
            <span className="text-muted-foreground">of the rules</span>
          </div>

          {rules.map((rule, ri) => {
            const opDef = operators.find((o) => o.op === rule.operator)
            return (
              <div key={ri} className="flex flex-wrap items-center gap-2">
                <Select
                  value={rule.field}
                  onValueChange={(v) => {
                    const next = [...rules]
                    next[ri] = { ...next[ri], field: v }
                    onChange({ ...group, rules: next })
                  }}
                >
                  <SelectTrigger className="h-8 w-44">
                    <SelectValue placeholder="Field" />
                  </SelectTrigger>
                  <SelectContent>
                    {fieldChoices.map((c) => (
                      <SelectItem key={c.key} value={c.key}>
                        {c.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select
                  value={rule.operator}
                  onValueChange={(v) => {
                    const next = [...rules]
                    next[ri] = { ...next[ri], operator: v as typeof rule.operator }
                    onChange({ ...group, rules: next })
                  }}
                >
                  <SelectTrigger className="h-8 w-48">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {operators.map((o) => (
                      <SelectItem key={o.op} value={o.op}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {(opDef?.needsValue ?? true) && (
                  <Input
                    className="h-8 w-40"
                    value={rule.value}
                    placeholder="value"
                    onChange={(e) => {
                      const next = [...rules]
                      next[ri] = { ...next[ri], value: e.target.value }
                      onChange({ ...group, rules: next })
                    }}
                  />
                )}
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Remove rule"
                  onClick={() => {
                    const next = rules.filter((_, j) => j !== ri)
                    onChange(next.length === 0 ? null : { ...group, rules: next })
                  }}
                >
                  <Trash2 className="h-4 w-4 text-destructive" />
                </Button>
              </div>
            )
          })}

          <Button
            variant="outline"
            size="sm"
            className="self-start"
            onClick={() =>
              onChange({
                ...group,
                rules: [...rules, { field: fieldChoices[0]?.key ?? "", operator: "equals", value: "" }],
              })
            }
          >
            <Plus className="mr-1.5 h-4 w-4" />
            Add rule
          </Button>
        </div>
      )}
    </div>
  )
}
