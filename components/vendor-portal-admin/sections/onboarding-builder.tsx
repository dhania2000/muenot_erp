"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { toast } from "sonner"
import { GripVertical, Plus, Trash2, Save, Eye } from "lucide-react"
import { SectionHeader, Panel } from "@/components/vendor-portal-admin/shared"
import {
  ONBOARDING_FORM,
  FORM_FIELD_TYPES,
  ONBOARDING_STAGES,
  type FormSection,
  type FormFieldType,
} from "@/lib/vendor-portal/admin-data"

export function OnboardingBuilderSection() {
  const [sections, setSections] = useState<FormSection[]>(() =>
    ONBOARDING_FORM.map((s) => ({ ...s, fields: s.fields.map((f) => ({ ...f })) })),
  )
  const [requireApproval, setRequireApproval] = useState(true)
  const [autoInvite, setAutoInvite] = useState(true)
  const [allowSelfReg, setAllowSelfReg] = useState(true)

  const toggleSection = (sid: string) =>
    setSections((prev) => prev.map((s) => (s.id === sid ? { ...s, enabled: !s.enabled } : s)))

  const toggleField = (sid: string, fid: string, key: "required" | "enabled") =>
    setSections((prev) =>
      prev.map((s) =>
        s.id === sid ? { ...s, fields: s.fields.map((f) => (f.id === fid ? { ...f, [key]: !f[key] } : f)) } : s,
      ),
    )

  const setFieldType = (sid: string, fid: string, type: FormFieldType) =>
    setSections((prev) =>
      prev.map((s) => (s.id === sid ? { ...s, fields: s.fields.map((f) => (f.id === fid ? { ...f, type } : f)) } : s)),
    )

  const addField = (sid: string) =>
    setSections((prev) =>
      prev.map((s) =>
        s.id === sid
          ? {
              ...s,
              fields: [...s.fields, { id: `f-${Date.now()}`, label: "New field", type: "Text", required: false, enabled: true }],
            }
          : s,
      ),
    )

  const removeField = (sid: string, fid: string) =>
    setSections((prev) => prev.map((s) => (s.id === sid ? { ...s, fields: s.fields.filter((f) => f.id !== fid) } : s)))

  return (
    <div className="grid gap-4">
      <SectionHeader
        title="Onboarding Builder"
        description="Configure the multi-step registration form, required fields and the approval workflow vendors follow."
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => toast.info("Opening vendor preview")}>
              <Eye data-icon="inline-start" className="size-4" /> Preview
            </Button>
            <Button size="sm" onClick={() => toast.success("Onboarding template saved")}>
              <Save data-icon="inline-start" className="size-4" /> Save template
            </Button>
          </>
        }
      />

      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        {/* Form sections */}
        <div className="grid gap-3">
          {sections.map((section) => (
            <Panel key={section.id} className="overflow-hidden">
              <div className="flex items-center justify-between gap-2 border-b border-border bg-muted/30 px-3 py-2">
                <div className="flex items-center gap-2">
                  <GripVertical className="size-4 text-muted-foreground" />
                  <Input
                    defaultValue={section.title}
                    className="h-7 w-56 border-transparent bg-transparent px-1 font-medium shadow-none focus-visible:border-input"
                    aria-label="Section title"
                  />
                  <Badge variant="outline" className="text-[10px]">
                    {section.fields.length} fields
                  </Badge>
                </div>
                <label className="flex items-center gap-2 text-xs text-muted-foreground">
                  {section.enabled ? "Enabled" : "Hidden"}
                  <Switch checked={section.enabled} onCheckedChange={() => toggleSection(section.id)} />
                </label>
              </div>

              {section.enabled ? (
                <div className="grid gap-2 p-3">
                  {section.fields.map((field) => (
                    <div
                      key={field.id}
                      className="flex flex-wrap items-center gap-2 rounded-lg border border-border px-2.5 py-2"
                    >
                      <GripVertical className="size-4 shrink-0 text-muted-foreground/50" />
                      <Input
                        defaultValue={field.label}
                        className="h-7 w-40 flex-1 border-transparent bg-transparent px-1 shadow-none focus-visible:border-input"
                        aria-label="Field label"
                      />
                      <Select value={field.type} onValueChange={(v) => setFieldType(section.id, field.id, v as FormFieldType)}>
                        <SelectTrigger size="sm" className="w-40">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {FORM_FIELD_TYPES.map((t) => (
                            <SelectItem key={t} value={t}>
                              {t}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        Required
                        <Switch checked={field.required} onCheckedChange={() => toggleField(section.id, field.id, "required")} />
                      </label>
                      <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        Shown
                        <Switch checked={field.enabled} onCheckedChange={() => toggleField(section.id, field.id, "enabled")} />
                      </label>
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        className="text-muted-foreground hover:text-destructive"
                        onClick={() => removeField(section.id, field.id)}
                        aria-label="Remove field"
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </div>
                  ))}
                  <Button size="sm" variant="outline" className="w-fit" onClick={() => addField(section.id)}>
                    <Plus data-icon="inline-start" className="size-4" /> Add field
                  </Button>
                </div>
              ) : null}
            </Panel>
          ))}
          <Button variant="outline" className="w-fit" onClick={() => toast.info("Add a new section")}>
            <Plus data-icon="inline-start" className="size-4" /> Add section
          </Button>
        </div>

        {/* Workflow config */}
        <div className="grid content-start gap-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Approval workflow</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-3">
              <ToggleRow label="Allow public self-registration" checked={allowSelfReg} onChange={setAllowSelfReg} />
              <ToggleRow label="Auto-send invite on manual create" checked={autoInvite} onChange={setAutoInvite} />
              <ToggleRow label="Require finance/admin approval" checked={requireApproval} onChange={setRequireApproval} />
              <div className="grid gap-1.5">
                <span className="text-sm">Approval levels</span>
                <Select defaultValue="2">
                  <SelectTrigger size="sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="1">Single approval</SelectItem>
                    <SelectItem value="2">Two-level (Reviewer → Finance)</SelectItem>
                    <SelectItem value="3">Three-level</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Onboarding stages</CardTitle>
            </CardHeader>
            <CardContent>
              <ol className="grid gap-1.5">
                {ONBOARDING_STAGES.map((s, i) => (
                  <li key={s} className="flex items-center gap-2 text-sm">
                    <span className="flex size-5 items-center justify-center rounded-full bg-muted text-[11px] font-medium tabular-nums">
                      {i + 1}
                    </span>
                    {s}
                  </li>
                ))}
              </ol>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}

function ToggleRow({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center justify-between gap-3 text-sm">
      <span>{label}</span>
      <Switch checked={checked} onCheckedChange={onChange} />
    </label>
  )
}
