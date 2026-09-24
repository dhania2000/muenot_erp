"use client"

import { useMemo, useState } from "react"
import { Plus, Trash2, GripVertical, AlertCircle } from "lucide-react"
import type { ModuleDefinition } from "@/lib/custom-modules/model"
import type { Catalogue } from "./custom-modules-client"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Badge } from "@/components/ui/badge"
import { Card } from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

type FieldDraft = {
  key: string
  label: string
  type: string
  required: boolean
  helpText: string
  showInList: boolean
  optionsText: string
  formula: string
  currencyCode: string
  targetEntity: string
}

type StateDraft = { key: string; label: string; isInitial: boolean; isFinal: boolean }
type TransitionDraft = { from: string; to: string; label: string; minRole: string }
type MetricDraft = { label: string; op: string; field: string; groupBy: string }
type ReportDraft = { label: string; metrics: MetricDraft[] }

const BLANK_FIELD: FieldDraft = {
  key: "",
  label: "",
  type: "text",
  required: false,
  helpText: "",
  showInList: true,
  optionsText: "",
  formula: "",
  currencyCode: "USD",
  targetEntity: "",
}

function fieldsFromModule(m: ModuleDefinition | null): FieldDraft[] {
  if (!m) return [{ ...BLANK_FIELD }]
  return m.fields.map((f) => ({
    key: f.key,
    label: f.label,
    type: f.type,
    required: f.required,
    helpText: f.helpText,
    showInList: f.showInList,
    optionsText: f.options.map((o) => o.label).join("\n"),
    formula: f.config.formula ?? "",
    currencyCode: f.config.currencyCode ?? "USD",
    targetEntity: f.config.targetEntity ?? "",
  }))
}

export function ModuleBuilderDialog({
  open,
  catalogue,
  existing,
  onClose,
  onSaved,
}: {
  open: boolean
  catalogue: Catalogue
  existing: ModuleDefinition | null
  onClose: () => void
  onSaved: () => void
}) {
  const [name, setName] = useState(existing?.name ?? "")
  const [pluralName, setPluralName] = useState(existing?.pluralName ?? "")
  const [description, setDescription] = useState(existing?.description ?? "")
  const [navGroup, setNavGroup] = useState(existing?.navGroup ?? "Custom")
  const [allowAttachments, setAllowAttachments] = useState(existing?.allowAttachments ?? false)
  const [fields, setFields] = useState<FieldDraft[]>(() => fieldsFromModule(existing))

  const [perm, setPerm] = useState(
    existing?.permissions ?? {
      viewMinRole: "employee",
      createMinRole: "employee",
      editMinRole: "employee",
      deleteMinRole: "tenant_admin",
    },
  )

  const [workflowEnabled, setWorkflowEnabled] = useState(existing?.workflow.enabled ?? false)
  const [states, setStates] = useState<StateDraft[]>(
    existing?.workflow.states.map((s) => ({ ...s })) ?? [
      { key: "open", label: "Open", isInitial: true, isFinal: false },
      { key: "closed", label: "Closed", isInitial: false, isFinal: true },
    ],
  )
  const [transitions, setTransitions] = useState<TransitionDraft[]>(
    existing?.workflow.transitions.map((t) => ({ ...t })) ?? [
      { from: "open", to: "closed", label: "Close", minRole: "employee" },
    ],
  )

  const [reports, setReports] = useState<ReportDraft[]>(
    existing?.reports.map((r) => ({
      label: r.label,
      metrics: r.metrics.map((m) => ({ label: m.label, op: m.op, field: m.field ?? "", groupBy: m.groupBy ?? "" })),
    })) ?? [],
  )

  const [saving, setSaving] = useState(false)
  const [errors, setErrors] = useState<string[]>([])

  const roleOptions = catalogue.roles
  const numericFields = useMemo(
    () =>
      fields.filter((f) => catalogue.fieldTypes.find((t) => t.type === f.type)?.numeric).map((f) => f.key || f.label),
    [fields, catalogue],
  )
  const allFieldKeys = useMemo(() => fields.map((f) => f.key || f.label).filter(Boolean), [fields])

  function updateField(i: number, patch: Partial<FieldDraft>) {
    setFields((prev) => prev.map((f, idx) => (idx === i ? { ...f, ...patch } : f)))
  }
  function removeField(i: number) {
    setFields((prev) => prev.filter((_, idx) => idx !== i))
  }

  async function save() {
    setSaving(true)
    setErrors([])
    const payload = {
      id: existing?.id ?? undefined,
      name,
      pluralName,
      description,
      navGroup,
      allowAttachments,
      status: existing?.status ?? "draft",
      fields: fields.map((f, idx) => {
        const typeDef = catalogue.fieldTypes.find((t) => t.type === f.type)
        return {
          label: f.label,
          type: f.type,
          required: f.required,
          helpText: f.helpText,
          showInList: f.showInList,
          sortOrder: idx,
          options: typeDef?.hasOptions
            ? f.optionsText
                .split("\n")
                .map((s) => s.trim())
                .filter(Boolean)
                .map((label) => ({ value: label, label }))
            : [],
          config: {
            ...(f.type === "formula" ? { formula: f.formula } : {}),
            ...(f.type === "currency" ? { currencyCode: f.currencyCode } : {}),
            ...(f.type === "entity" ? { targetEntity: f.targetEntity } : {}),
          },
        }
      }),
      permissions: perm,
      workflow: {
        enabled: workflowEnabled,
        states,
        transitions,
      },
      reports: reports.map((r) => ({
        label: r.label,
        metrics: r.metrics.map((m) => ({
          label: m.label,
          op: m.op,
          field: m.field || null,
          groupBy: m.groupBy || null,
        })),
      })),
    }

    try {
      const res = await fetch("/api/admin/custom-modules", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      })
      const json = await res.json().catch(() => null)
      if (!res.ok) {
        setErrors(json?.errors ?? [json?.error ?? "Could not save the module."])
        return
      }
      onSaved()
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-hidden p-0">
        <DialogHeader className="border-b p-4">
          <DialogTitle>{existing ? `Edit ${existing.name}` : "New custom module"}</DialogTitle>
          <DialogDescription>
            Define the entity, its fields, who can act on records, its workflow and reports.
          </DialogDescription>
        </DialogHeader>

        <Tabs defaultValue="details" className="flex flex-col">
          <TabsList className="mx-4 mt-3 w-fit">
            <TabsTrigger value="details">Details</TabsTrigger>
            <TabsTrigger value="fields">Fields</TabsTrigger>
            <TabsTrigger value="permissions">Permissions</TabsTrigger>
            <TabsTrigger value="workflow">Workflow</TabsTrigger>
            <TabsTrigger value="reports">Reports</TabsTrigger>
          </TabsList>

          <div className="max-h-[55vh] overflow-y-auto p-4">
            <TabsContent value="details" className="mt-0 flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="m-name">Name</Label>
                <Input id="m-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Asset" />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="m-plural">Plural name</Label>
                <Input
                  id="m-plural"
                  value={pluralName}
                  onChange={(e) => setPluralName(e.target.value)}
                  placeholder="Assets"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="m-desc">Description</Label>
                <Textarea
                  id="m-desc"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="What this module tracks."
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="m-nav">Navigation group</Label>
                <Input id="m-nav" value={navGroup} onChange={(e) => setNavGroup(e.target.value)} />
              </div>
              <div className="flex items-center justify-between rounded-md border p-3">
                <div>
                  <Label htmlFor="m-attach">Allow attachments</Label>
                  <p className="text-xs text-muted-foreground">Records may carry uploaded files.</p>
                </div>
                <Switch id="m-attach" checked={allowAttachments} onCheckedChange={setAllowAttachments} />
              </div>
            </TabsContent>

            <TabsContent value="fields" className="mt-0 flex flex-col gap-3">
              {fields.map((f, i) => {
                const typeDef = catalogue.fieldTypes.find((t) => t.type === f.type)
                return (
                  <Card key={i} className="flex flex-col gap-3 p-3">
                    <div className="flex items-center gap-2">
                      <GripVertical className="h-4 w-4 text-muted-foreground" />
                      <Input
                        value={f.label}
                        onChange={(e) => updateField(i, { label: e.target.value })}
                        placeholder="Field label"
                        className="flex-1"
                      />
                      <Select value={f.type} onValueChange={(v) => updateField(i, { type: v })}>
                        <SelectTrigger className="w-40">
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
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label="Remove field"
                        onClick={() => removeField(i)}
                      >
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    </div>

                    {typeDef?.hasOptions && (
                      <div className="flex flex-col gap-1.5">
                        <Label className="text-xs">Options (one per line)</Label>
                        <Textarea
                          value={f.optionsText}
                          onChange={(e) => updateField(i, { optionsText: e.target.value })}
                          rows={3}
                        />
                      </div>
                    )}
                    {f.type === "formula" && (
                      <div className="flex flex-col gap-1.5">
                        <Label className="text-xs">Formula (use numeric field keys)</Label>
                        <Input
                          value={f.formula}
                          onChange={(e) => updateField(i, { formula: e.target.value })}
                          placeholder="quantity * unit_price"
                          className="font-mono text-sm"
                        />
                        <p className="text-xs text-muted-foreground">
                          Numeric fields: {numericFields.filter(Boolean).join(", ") || "none yet"}
                        </p>
                      </div>
                    )}
                    {f.type === "currency" && (
                      <Input
                        value={f.currencyCode}
                        onChange={(e) => updateField(i, { currencyCode: e.target.value.toUpperCase() })}
                        placeholder="USD"
                        className="w-28"
                      />
                    )}
                    {f.type === "entity" && (
                      <Input
                        value={f.targetEntity}
                        onChange={(e) => updateField(i, { targetEntity: e.target.value })}
                        placeholder="Target entity (e.g. contact)"
                      />
                    )}
                    <Input
                      value={f.helpText}
                      onChange={(e) => updateField(i, { helpText: e.target.value })}
                      placeholder="Help text (optional)"
                      className="text-sm"
                    />
                    <div className="flex flex-wrap items-center gap-4">
                      {!typeDef?.computed && (
                        <label className="flex items-center gap-2 text-sm">
                          <Switch
                            checked={f.required}
                            onCheckedChange={(v) => updateField(i, { required: v })}
                          />
                          Required
                        </label>
                      )}
                      <label className="flex items-center gap-2 text-sm">
                        <Switch
                          checked={f.showInList}
                          onCheckedChange={(v) => updateField(i, { showInList: v })}
                        />
                        Show in list
                      </label>
                    </div>
                  </Card>
                )
              })}
              <Button variant="outline" onClick={() => setFields((p) => [...p, { ...BLANK_FIELD }])}>
                <Plus className="mr-1.5 h-4 w-4" />
                Add field
              </Button>
            </TabsContent>

            <TabsContent value="permissions" className="mt-0 flex flex-col gap-4">
              {(
                [
                  ["viewMinRole", "View records"],
                  ["createMinRole", "Create records"],
                  ["editMinRole", "Edit records"],
                  ["deleteMinRole", "Delete records"],
                ] as const
              ).map(([key, label]) => (
                <div key={key} className="flex items-center justify-between gap-4">
                  <Label>{label}</Label>
                  <Select
                    value={(perm as any)[key]}
                    onValueChange={(v) => setPerm((p) => ({ ...p, [key]: v }))}
                  >
                    <SelectTrigger className="w-56">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {roleOptions.map((r) => (
                        <SelectItem key={r.role} value={r.role}>
                          {r.label} and above
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ))}
              <p className="text-xs text-muted-foreground">
                Create, edit and delete access can never be broader than view access — the server
                re-checks this on save.
              </p>
            </TabsContent>

            <TabsContent value="workflow" className="mt-0 flex flex-col gap-4">
              <div className="flex items-center justify-between rounded-md border p-3">
                <div>
                  <Label htmlFor="wf">Enable workflow</Label>
                  <p className="text-xs text-muted-foreground">
                    Records move through states via role-gated transitions.
                  </p>
                </div>
                <Switch id="wf" checked={workflowEnabled} onCheckedChange={setWorkflowEnabled} />
              </div>

              {workflowEnabled && (
                <>
                  <div className="flex flex-col gap-2">
                    <Label className="text-sm">States</Label>
                    {states.map((s, i) => (
                      <div key={i} className="flex items-center gap-2">
                        <Input
                          value={s.label}
                          onChange={(e) =>
                            setStates((prev) =>
                              prev.map((x, idx) =>
                                idx === i
                                  ? { ...x, label: e.target.value, key: e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") }
                                  : x,
                              ),
                            )
                          }
                          placeholder="State label"
                          className="flex-1"
                        />
                        <label className="flex items-center gap-1 text-xs">
                          <input
                            type="radio"
                            name="initial"
                            checked={s.isInitial}
                            onChange={() =>
                              setStates((prev) => prev.map((x, idx) => ({ ...x, isInitial: idx === i })))
                            }
                          />
                          Initial
                        </label>
                        <label className="flex items-center gap-1 text-xs">
                          <input
                            type="checkbox"
                            checked={s.isFinal}
                            onChange={(e) =>
                              setStates((prev) => prev.map((x, idx) => (idx === i ? { ...x, isFinal: e.target.checked } : x)))
                            }
                          />
                          Final
                        </label>
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label="Remove state"
                          onClick={() => setStates((prev) => prev.filter((_, idx) => idx !== i))}
                        >
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      </div>
                    ))}
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setStates((p) => [...p, { key: "", label: "", isInitial: false, isFinal: false }])}
                    >
                      <Plus className="mr-1.5 h-4 w-4" />
                      Add state
                    </Button>
                  </div>

                  <div className="flex flex-col gap-2">
                    <Label className="text-sm">Transitions</Label>
                    {transitions.map((t, i) => (
                      <div key={i} className="flex flex-wrap items-center gap-2">
                        <Select
                          value={t.from}
                          onValueChange={(v) =>
                            setTransitions((prev) => prev.map((x, idx) => (idx === i ? { ...x, from: v } : x)))
                          }
                        >
                          <SelectTrigger className="w-32"><SelectValue placeholder="From" /></SelectTrigger>
                          <SelectContent>
                            {states.map((s) => (
                              <SelectItem key={s.key} value={s.key}>{s.label || s.key}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <span className="text-muted-foreground">→</span>
                        <Select
                          value={t.to}
                          onValueChange={(v) =>
                            setTransitions((prev) => prev.map((x, idx) => (idx === i ? { ...x, to: v } : x)))
                          }
                        >
                          <SelectTrigger className="w-32"><SelectValue placeholder="To" /></SelectTrigger>
                          <SelectContent>
                            {states.map((s) => (
                              <SelectItem key={s.key} value={s.key}>{s.label || s.key}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <Select
                          value={t.minRole}
                          onValueChange={(v) =>
                            setTransitions((prev) => prev.map((x, idx) => (idx === i ? { ...x, minRole: v } : x)))
                          }
                        >
                          <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            {roleOptions.map((r) => (
                              <SelectItem key={r.role} value={r.role}>{r.label}+</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label="Remove transition"
                          onClick={() => setTransitions((prev) => prev.filter((_, idx) => idx !== i))}
                        >
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      </div>
                    ))}
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        setTransitions((p) => [...p, { from: states[0]?.key ?? "", to: states[1]?.key ?? "", label: "", minRole: "employee" }])
                      }
                    >
                      <Plus className="mr-1.5 h-4 w-4" />
                      Add transition
                    </Button>
                  </div>
                </>
              )}
            </TabsContent>

            <TabsContent value="reports" className="mt-0 flex flex-col gap-4">
              {reports.map((r, ri) => (
                <Card key={ri} className="flex flex-col gap-3 p-3">
                  <div className="flex items-center gap-2">
                    <Input
                      value={r.label}
                      onChange={(e) =>
                        setReports((prev) => prev.map((x, idx) => (idx === ri ? { ...x, label: e.target.value } : x)))
                      }
                      placeholder="Report name"
                      className="flex-1"
                    />
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="Remove report"
                      onClick={() => setReports((prev) => prev.filter((_, idx) => idx !== ri))}
                    >
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </div>
                  {r.metrics.map((m, mi) => (
                    <div key={mi} className="flex flex-wrap items-center gap-2 pl-2">
                      <Input
                        value={m.label}
                        onChange={(e) =>
                          setReports((prev) =>
                            prev.map((x, idx) =>
                              idx === ri
                                ? { ...x, metrics: x.metrics.map((y, j) => (j === mi ? { ...y, label: e.target.value } : y)) }
                                : x,
                            ),
                          )
                        }
                        placeholder="Metric"
                        className="w-36"
                      />
                      <Select
                        value={m.op}
                        onValueChange={(v) =>
                          setReports((prev) =>
                            prev.map((x, idx) =>
                              idx === ri
                                ? { ...x, metrics: x.metrics.map((y, j) => (j === mi ? { ...y, op: v } : y)) }
                                : x,
                            ),
                          )
                        }
                      >
                        <SelectTrigger className="w-28"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {catalogue.reportOps.map((op) => (
                            <SelectItem key={op} value={op}>{op}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      {m.op !== "count" && (
                        <Select
                          value={m.field}
                          onValueChange={(v) =>
                            setReports((prev) =>
                              prev.map((x, idx) =>
                                idx === ri
                                  ? { ...x, metrics: x.metrics.map((y, j) => (j === mi ? { ...y, field: v } : y)) }
                                  : x,
                              ),
                            )
                          }
                        >
                          <SelectTrigger className="w-36"><SelectValue placeholder="Field" /></SelectTrigger>
                          <SelectContent>
                            {numericFields.filter(Boolean).map((k) => (
                              <SelectItem key={k} value={k}>{k}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      )}
                      <Select
                        value={m.groupBy || "none"}
                        onValueChange={(v) =>
                          setReports((prev) =>
                            prev.map((x, idx) =>
                              idx === ri
                                ? { ...x, metrics: x.metrics.map((y, j) => (j === mi ? { ...y, groupBy: v === "none" ? "" : v } : y)) }
                                : x,
                            ),
                          )
                        }
                      >
                        <SelectTrigger className="w-36"><SelectValue placeholder="Group by" /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="none">No grouping</SelectItem>
                          {allFieldKeys.map((k) => (
                            <SelectItem key={k} value={k}>{k}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  ))}
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-fit"
                    onClick={() =>
                      setReports((prev) =>
                        prev.map((x, idx) =>
                          idx === ri ? { ...x, metrics: [...x.metrics, { label: "", op: "count", field: "", groupBy: "" }] } : x,
                        ),
                      )
                    }
                  >
                    <Plus className="mr-1.5 h-4 w-4" />
                    Add metric
                  </Button>
                </Card>
              ))}
              <Button
                variant="outline"
                onClick={() => setReports((p) => [...p, { label: "", metrics: [{ label: "Total", op: "count", field: "", groupBy: "" }] }])}
              >
                <Plus className="mr-1.5 h-4 w-4" />
                Add report
              </Button>
            </TabsContent>
          </div>
        </Tabs>

        {errors.length > 0 && (
          <div className="mx-4 flex flex-col gap-1 rounded-md border border-destructive/50 bg-destructive/5 p-3">
            <div className="flex items-center gap-2 text-sm font-medium text-destructive">
              <AlertCircle className="h-4 w-4" />
              Could not save
            </div>
            <ul className="list-inside list-disc text-xs text-destructive">
              {errors.map((e, i) => (
                <li key={i}>{e}</li>
              ))}
            </ul>
          </div>
        )}

        <DialogFooter className="border-t p-4">
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={save} disabled={saving || !name.trim()}>
            {saving ? "Saving…" : existing ? "Save changes" : "Create module"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
