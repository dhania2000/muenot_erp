"use client"

import { useState } from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { Badge } from "@/components/ui/badge"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { SectionHeader } from "./shared"
import {
  FIELD_TYPE_OPTIONS,
  ONBOARDING_FORM,
  type FieldType,
  type OnboardingFormSection,
} from "./data"
import { Eye, GripVertical, Plus, Save, Trash2 } from "lucide-react"

export function OnboardingSection() {
  const [sections, setSections] = useState<OnboardingFormSection[]>(ONBOARDING_FORM)

  function toggleField(sid: string, fid: string, key: "required" | "enabled") {
    setSections((prev) =>
      prev.map((s) =>
        s.id !== sid
          ? s
          : { ...s, fields: s.fields.map((f) => (f.id === fid ? { ...f, [key]: !f[key] } : f)) },
      ),
    )
  }

  function changeType(sid: string, fid: string, type: FieldType) {
    setSections((prev) =>
      prev.map((s) =>
        s.id !== sid ? s : { ...s, fields: s.fields.map((f) => (f.id === fid ? { ...f, type } : f)) },
      ),
    )
  }

  function addField(sid: string) {
    setSections((prev) =>
      prev.map((s) =>
        s.id !== sid
          ? s
          : {
              ...s,
              fields: [
                ...s.fields,
                { id: `f-${Date.now()}`, label: "New field", type: "text", required: false, enabled: true },
              ],
            },
      ),
    )
    toast.success("Field added")
  }

  function removeField(sid: string, fid: string) {
    setSections((prev) =>
      prev.map((s) => (s.id !== sid ? s : { ...s, fields: s.fields.filter((f) => f.id !== fid) })),
    )
  }

  function addSection() {
    setSections((prev) => [...prev, { id: `s-${Date.now()}`, title: "New section", fields: [] }])
    toast.success("Section added")
  }

  return (
    <div className="grid gap-4">
      <SectionHeader
        title="Onboarding Form Builder"
        description="Design the self-registration form clients complete when requesting portal access."
        actions={
          <>
            <Button size="sm" variant="outline" onClick={() => toast.info("Preview opened")}>
              <Eye className="size-4" /> Preview
            </Button>
            <Button size="sm" onClick={() => toast.success("Onboarding form saved")}>
              <Save className="size-4" /> Save form
            </Button>
          </>
        }
      />

      <div className="grid gap-4">
        {sections.map((s) => (
          <div key={s.id} className="rounded-xl border border-border bg-card">
            <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
              <div className="flex items-center gap-2">
                <GripVertical className="size-4 text-muted-foreground" />
                <Input
                  defaultValue={s.title}
                  className="h-7 w-56 border-transparent bg-transparent px-1 text-sm font-semibold hover:border-border focus:border-border"
                  aria-label="Section title"
                />
                <Badge variant="outline" className="text-[10px]">{s.fields.length} fields</Badge>
              </div>
              <Button size="xs" variant="ghost" onClick={() => addField(s.id)}>
                <Plus className="size-3.5" /> Add field
              </Button>
            </div>
            <div className="divide-y divide-border">
              {s.fields.length === 0 ? (
                <p className="px-4 py-6 text-center text-sm text-muted-foreground">No fields — add one to start.</p>
              ) : (
                s.fields.map((f) => (
                  <div key={f.id} className="flex flex-wrap items-center gap-3 px-4 py-2.5">
                    <GripVertical className="size-4 shrink-0 cursor-grab text-muted-foreground" />
                    <Input
                      defaultValue={f.label}
                      className="h-8 w-44 flex-1 sm:flex-none"
                      aria-label="Field label"
                    />
                    <Select value={f.type} onValueChange={(v) => changeType(s.id, f.id, v as FieldType)}>
                      <SelectTrigger className="h-8 w-40">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {FIELD_TYPE_OPTIONS.map((t) => (
                          <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <Switch checked={f.required} onCheckedChange={() => toggleField(s.id, f.id, "required")} />
                      Required
                    </label>
                    <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <Switch checked={f.enabled} onCheckedChange={() => toggleField(s.id, f.id, "enabled")} />
                      Enabled
                    </label>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      className="ml-auto text-muted-foreground hover:text-destructive"
                      aria-label="Remove field"
                      onClick={() => removeField(s.id, f.id)}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                ))
              )}
            </div>
          </div>
        ))}
      </div>

      <Button variant="outline" className="w-full border-dashed" onClick={addSection}>
        <Plus className="size-4" /> Add section
      </Button>
    </div>
  )
}
