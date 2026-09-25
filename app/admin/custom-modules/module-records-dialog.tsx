"use client"

import { useMemo, useState } from "react"
import useSWR from "swr"
import { Plus, Trash2, Pencil, AlertCircle, ArrowRight, X, GitMerge, History } from "lucide-react"
import { fetcher } from "@/lib/fetcher"
import type { ModuleDefinition, ModuleField, WorkflowTransition } from "@/lib/custom-modules/model"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Checkbox } from "@/components/ui/checkbox"
import { ModuleMergeDialog } from "./module-merge-dialog"
import { ModuleMergeHistoryDialog } from "./module-merge-history-dialog"

type ModuleRecord = {
  id: number
  state: string | null
  values: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

type RecordsResponse = {
  module: ModuleDefinition
  records: ModuleRecord[]
  can: { create: boolean }
  transitions: Record<string, WorkflowTransition[]>
}

function displayValue(field: ModuleField, raw: unknown): string {
  if (raw == null || raw === "") return "—"
  if (typeof raw === "boolean") return raw ? "Yes" : "No"
  if (Array.isArray(raw)) return raw.length ? raw.map(String).join(", ") : "—"
  if (typeof raw === "object") {
    const amount = (raw as any).amount
    if (amount != null) return `${(raw as any).currency ?? ""} ${amount}`.trim()
    const id = (raw as any).id
    if (id != null) return String(id)
    return JSON.stringify(raw)
  }
  if (field.type === "dropdown" || field.type === "multiselect") {
    const opt = field.options.find((o) => o.value === String(raw))
    if (opt) return opt.label
  }
  return String(raw)
}

/** The fields shown as columns in the record list. */
function listColumns(module: ModuleDefinition): ModuleField[] {
  const cols = module.listView.columns
  if (cols.length > 0) {
    return cols
      .map((key) => module.fields.find((f) => f.key === key))
      .filter((f): f is ModuleField => Boolean(f))
  }
  const flagged = module.fields.filter((f) => f.showInList)
  return flagged.length > 0 ? flagged : module.fields.slice(0, 4)
}

function stateLabel(module: ModuleDefinition, state: string | null): string {
  if (!state) return "—"
  return module.workflow.states.find((s) => s.key === state)?.label ?? state
}

export function ModuleRecordsDialog({
  module,
  onClose,
}: {
  module: ModuleDefinition
  onClose: () => void
}) {
  const key = `/api/custom-modules/${module.slug}/records`
  const { data, error, isLoading, mutate } = useSWR<RecordsResponse>(key, fetcher)

  const [editing, setEditing] = useState<ModuleRecord | null>(null)
  const [creating, setCreating] = useState(false)
  const [busyId, setBusyId] = useState<number | null>(null)
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())
  const [merging, setMerging] = useState(false)
  const [showHistory, setShowHistory] = useState(false)

  const columns = useMemo(() => listColumns(module), [module])
  const records = data?.records ?? []
  const canCreate = data?.can.create ?? false
  const transitions = data?.transitions ?? {}

  function toggleSelected(id: number) {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const selectedRecords = records.filter((r) => selectedIds.has(r.id))

  async function remove(record: ModuleRecord) {
    if (!window.confirm("Delete this record? This cannot be undone.")) return
    setBusyId(record.id)
    try {
      const res = await fetch(`/api/custom-modules/${module.slug}/records/${record.id}`, {
        method: "DELETE",
      })
      if (res.ok) await mutate()
    } finally {
      setBusyId(null)
    }
  }

  async function transition(record: ModuleRecord, toState: string) {
    setBusyId(record.id)
    try {
      const res = await fetch(`/api/custom-modules/${module.slug}/records/${record.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ toState }),
      })
      if (res.ok) await mutate()
    } finally {
      setBusyId(null)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle>{module.pluralName || module.name}</DialogTitle>
          <DialogDescription>
            View and manage records for this module.
          </DialogDescription>
        </DialogHeader>

        {editing || creating ? (
          <RecordForm
            module={module}
            record={editing}
            onCancel={() => {
              setEditing(null)
              setCreating(false)
            }}
            onSaved={() => {
              setEditing(null)
              setCreating(false)
              void mutate()
            }}
          />
        ) : (
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm text-muted-foreground">
                {selectedIds.size > 0
                  ? `${selectedIds.size} selected`
                  : records.length === 0
                    ? "No records yet"
                    : `${records.length} record${records.length === 1 ? "" : "s"}`}
              </p>
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" size="sm" onClick={() => setShowHistory(true)}>
                  <History className="mr-1.5 h-4 w-4" />
                  History
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={selectedIds.size < 2}
                  onClick={() => setMerging(true)}
                >
                  <GitMerge className="mr-1.5 h-4 w-4" />
                  Merge{selectedIds.size >= 2 ? ` (${selectedIds.size})` : ""}
                </Button>
                <Button size="sm" disabled={!canCreate} onClick={() => setCreating(true)}>
                  <Plus className="mr-1.5 h-4 w-4" />
                  New record
                </Button>
              </div>
            </div>

            {error ? (
              <Card className="flex items-center gap-3 p-6 text-sm">
                <AlertCircle className="h-5 w-5 text-destructive" />
                <span>Failed to load records, or you do not have access.</span>
              </Card>
            ) : isLoading ? (
              <div className="flex flex-col gap-2">
                {Array.from({ length: 3 }).map((_, i) => (
                  <Skeleton key={i} className="h-10 w-full" />
                ))}
              </div>
            ) : records.length === 0 ? (
              <Card className="p-8 text-center text-sm text-muted-foreground">
                No records yet. Create the first one.
              </Card>
            ) : (
              <div className="max-h-[50vh] overflow-auto rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-10" />
                      {columns.map((f) => (
                        <TableHead key={f.key}>{f.label}</TableHead>
                      ))}
                      {module.workflow.enabled && <TableHead>State</TableHead>}
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {records.map((record) => {
                      const next = record.state ? transitions[record.state] ?? [] : []
                      return (
                        <TableRow key={record.id} data-state={selectedIds.has(record.id) ? "selected" : undefined}>
                          <TableCell className="w-10">
                            <Checkbox
                              checked={selectedIds.has(record.id)}
                              onCheckedChange={() => toggleSelected(record.id)}
                              aria-label={`Select record ${record.id}`}
                            />
                          </TableCell>
                          {columns.map((f) => (
                            <TableCell key={f.key} className="text-sm">
                              {displayValue(f, record.values[f.key])}
                            </TableCell>
                          ))}
                          {module.workflow.enabled && (
                            <TableCell>
                              <div className="flex flex-wrap items-center gap-1">
                                <Badge variant="outline">{stateLabel(module, record.state)}</Badge>
                                {next.map((t) => (
                                  <Button
                                    key={`${t.from}-${t.to}`}
                                    variant="ghost"
                                    size="sm"
                                    disabled={busyId === record.id}
                                    onClick={() => transition(record, t.to)}
                                  >
                                    <ArrowRight className="mr-1 h-3 w-3" />
                                    {t.label}
                                  </Button>
                                ))}
                              </div>
                            </TableCell>
                          )}
                          <TableCell className="text-right">
                            <div className="flex justify-end gap-1">
                              <Button
                                variant="ghost"
                                size="icon"
                                aria-label="Edit record"
                                onClick={() => setEditing(record)}
                              >
                                <Pencil className="h-4 w-4" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                aria-label="Delete record"
                                disabled={busyId === record.id}
                                onClick={() => remove(record)}
                              >
                                <Trash2 className="h-4 w-4 text-destructive" />
                              </Button>
                            </div>
                          </TableCell>
                        </TableRow>
                      )
                    })}
                  </TableBody>
                </Table>
              </div>
            )}
          </div>
        )}

        {!editing && !creating && (
          <DialogFooter>
            <Button variant="outline" onClick={onClose}>
              <X className="mr-1.5 h-4 w-4" />
              Close
            </Button>
          </DialogFooter>
        )}

        {merging && selectedRecords.length >= 2 && (
          <ModuleMergeDialog
            module={module}
            records={selectedRecords.map((r) => ({ id: r.id, state: r.state, values: r.values }))}
            onClose={() => setMerging(false)}
            onMerged={() => {
              setMerging(false)
              setSelectedIds(new Set())
              void mutate()
            }}
          />
        )}

        {showHistory && (
          <ModuleMergeHistoryDialog
            module={module}
            onClose={() => setShowHistory(false)}
            onChanged={() => {
              setSelectedIds(new Set())
              void mutate()
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

/** An editable field — computed/formula fields are derived server-side. */
function isEditable(field: ModuleField): boolean {
  return field.type !== "formula"
}

function RecordForm({
  module,
  record,
  onCancel,
  onSaved,
}: {
  module: ModuleDefinition
  record: ModuleRecord | null
  onCancel: () => void
  onSaved: () => void
}) {
  const editableFields = module.fields.filter(isEditable)
  const [values, setValues] = useState<Record<string, unknown>>(() => {
    const initial: Record<string, unknown> = {}
    for (const f of editableFields) {
      const existing = record?.values[f.key]
      initial[f.key] = existing ?? (f.type === "boolean" ? false : "")
    }
    return initial
  })
  const [saving, setSaving] = useState(false)
  const [errors, setErrors] = useState<string[]>([])

  function setField(key: string, value: unknown) {
    setValues((prev) => ({ ...prev, [key]: value }))
  }

  async function save() {
    setSaving(true)
    setErrors([])
    try {
      const url = record
        ? `/api/custom-modules/${module.slug}/records/${record.id}`
        : `/api/custom-modules/${module.slug}/records`
      const res = await fetch(url, {
        method: record ? "PUT" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ values }),
      })
      if (res.ok) {
        onSaved()
        return
      }
      const body = await res.json().catch(() => null)
      if (body?.errors && typeof body.errors === "object") {
        setErrors(Object.values(body.errors as Record<string, string>))
      } else {
        setErrors([body?.error ?? "Failed to save the record."])
      }
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {errors.length > 0 && (
        <Card className="flex flex-col gap-1 p-3 text-sm text-destructive">
          {errors.map((e, i) => (
            <div key={i} className="flex items-center gap-2">
              <AlertCircle className="h-4 w-4" />
              <span>{e}</span>
            </div>
          ))}
        </Card>
      )}

      <div className="grid max-h-[50vh] gap-4 overflow-auto pr-1 sm:grid-cols-2">
        {editableFields.map((field) => (
          <div key={field.key} className="flex flex-col gap-1.5">
            <Label htmlFor={`field-${field.key}`}>
              {field.label}
              {field.required && <span className="ml-0.5 text-destructive">*</span>}
            </Label>
            <FieldInput field={field} value={values[field.key]} onChange={(v) => setField(field.key, v)} />
            {field.helpText && <p className="text-xs text-muted-foreground">{field.helpText}</p>}
          </div>
        ))}
      </div>

      <DialogFooter>
        <Button variant="outline" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <Button onClick={save} disabled={saving}>
          {saving ? "Saving…" : record ? "Save changes" : "Create record"}
        </Button>
      </DialogFooter>
    </div>
  )
}

function FieldInput({
  field,
  value,
  onChange,
}: {
  field: ModuleField
  value: unknown
  onChange: (value: unknown) => void
}) {
  const id = `field-${field.key}`

  if (field.type === "boolean") {
    return (
      <div className="flex h-9 items-center">
        <Switch id={id} checked={value === true} onCheckedChange={onChange} />
      </div>
    )
  }

  if (field.type === "dropdown" && field.options.length > 0) {
    return (
      <Select value={value ? String(value) : ""} onValueChange={onChange}>
        <SelectTrigger id={id}>
          <SelectValue placeholder="Select…" />
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
  }

  const inputType =
    field.type === "number" || field.type === "currency"
      ? "number"
      : field.type === "date"
        ? "date"
        : "text"

  return (
    <Input
      id={id}
      type={inputType}
      value={value == null ? "" : String(value)}
      onChange={(e) => onChange(e.target.value)}
    />
  )
}
