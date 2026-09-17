"use client"

import { useEffect, useState } from "react"
import { toast } from "sonner"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import { Card, CardContent } from "@/components/ui/card"
import { GripVertical, Plus, Trash2, ArrowUp, ArrowDown } from "lucide-react"

type FieldMapping = { key: string; label: string }
type Lookups = {
  employees: { id: number; name: string }[]
  fieldMappings: FieldMapping[]
  fieldTypes: string[]
  formTypes: string[]
}

type BuilderField = {
  field_key: string
  label: string
  type: string
  placeholder?: string | null
  required: boolean
  maps_to: string
  options?: string[] | null
}

const NONE_OWNER = "none"

function blankField(i: number): BuilderField {
  return { field_key: `field_${i}`, label: "New field", type: "text", required: false, maps_to: "none", options: null }
}

export function LeadGenFormBuilder({
  open,
  onOpenChange,
  lookups,
  formId,
  onSaved,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  lookups: Lookups
  formId: number | null
  onSaved: () => void
}) {
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [meta, setMeta] = useState<Record<string, any>>({})
  const [fields, setFields] = useState<BuilderField[]>([])

  useEffect(() => {
    if (!open) return
    if (!formId) {
      setMeta({ name: "", type: "Hosted", submit_label: "Submit", auto_create_lead: true, theme_color: "" })
      setFields([
        { field_key: "full_name", label: "Full name", type: "text", required: true, maps_to: "full_name" },
        { field_key: "email", label: "Email", type: "email", required: true, maps_to: "email" },
        { field_key: "phone", label: "Phone", type: "tel", required: false, maps_to: "phone" },
        { field_key: "company_name", label: "Company", type: "text", required: false, maps_to: "company_name" },
        { field_key: "message", label: "How can we help?", type: "textarea", required: false, maps_to: "message" },
      ])
      return
    }
    setLoading(true)
    fetch(`/api/marketing/lead-generation/forms/${formId}`)
      .then((r) => r.json())
      .then((body) => {
        if (body.form) {
          setMeta(body.form)
          setFields(
            (body.form.fields || []).map((f: any) => ({
              field_key: f.field_key,
              label: f.label,
              type: f.type,
              placeholder: f.placeholder,
              required: !!f.required,
              maps_to: f.maps_to || "none",
              options: f.options || null,
            })),
          )
        }
      })
      .finally(() => setLoading(false))
  }, [open, formId])

  function setField(index: number, patch: Partial<BuilderField>) {
    setFields((prev) => prev.map((f, i) => (i === index ? { ...f, ...patch } : f)))
  }
  function move(index: number, dir: -1 | 1) {
    setFields((prev) => {
      const next = [...prev]
      const target = index + dir
      if (target < 0 || target >= next.length) return prev
      ;[next[index], next[target]] = [next[target], next[index]]
      return next
    })
  }

  async function save() {
    if (!meta.name?.trim()) {
      toast.error("Give the form a name")
      return
    }
    setSaving(true)
    try {
      const payload = {
        name: meta.name,
        description: meta.description || null,
        type: meta.type || "Hosted",
        submit_label: meta.submit_label || "Submit",
        success_message: meta.success_message || null,
        redirect_url: meta.redirect_url || null,
        theme_color: meta.theme_color || null,
        campaign: meta.campaign || null,
        lead_source: meta.lead_source || null,
        default_owner_id: meta.default_owner_id || null,
        notify_user_id: meta.notify_user_id || null,
        auto_create_lead: !!meta.auto_create_lead,
        fields: fields.map((f) => ({
          ...f,
          options: f.type === "select" ? f.options : null,
        })),
      }
      const url = formId
        ? `/api/marketing/lead-generation/forms/${formId}`
        : `/api/marketing/lead-generation/forms`
      const res = await fetch(url, {
        method: formId ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast.error(body.error || "Unable to save form")
        return
      }
      toast.success(formId ? "Form updated" : "Form created")
      onSaved()
      onOpenChange(false)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{formId ? "Edit lead form" : "Create lead form"}</DialogTitle>
          <DialogDescription>
            Define the capture fields and where new leads should be routed. Mapped fields sync to Contacts and the Sales
            pipeline automatically.
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <p className="py-10 text-center text-sm text-muted-foreground">Loading form...</p>
        ) : (
          <div className="space-y-6">
            <section className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="name">Form name</Label>
                <Input
                  id="name"
                  value={meta.name || ""}
                  onChange={(e) => setMeta({ ...meta, name: e.target.value })}
                  placeholder="e.g. Website contact request"
                />
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="desc">Description</Label>
                <Textarea
                  id="desc"
                  rows={2}
                  value={meta.description || ""}
                  onChange={(e) => setMeta({ ...meta, description: e.target.value })}
                  placeholder="Shown to visitors under the form title"
                />
              </div>
              <div className="space-y-1.5">
                <Label>Form type</Label>
                <Select value={meta.type || "Hosted"} onValueChange={(v) => setMeta({ ...meta, type: v })}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {lookups.formTypes.map((t) => (
                      <SelectItem key={t} value={t}>
                        {t}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="lead_source">Lead source</Label>
                <Input
                  id="lead_source"
                  value={meta.lead_source || ""}
                  onChange={(e) => setMeta({ ...meta, lead_source: e.target.value })}
                  placeholder="e.g. Website"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="campaign">Campaign</Label>
                <Input
                  id="campaign"
                  value={meta.campaign || ""}
                  onChange={(e) => setMeta({ ...meta, campaign: e.target.value })}
                  placeholder="Optional campaign tag"
                />
              </div>
              <div className="space-y-1.5">
                <Label>Route leads to</Label>
                <Select
                  value={meta.default_owner_id ? String(meta.default_owner_id) : NONE_OWNER}
                  onValueChange={(v) => setMeta({ ...meta, default_owner_id: v === NONE_OWNER ? null : Number(v) })}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Unassigned" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE_OWNER}>Unassigned</SelectItem>
                    {lookups.employees.map((e) => (
                      <SelectItem key={e.id} value={String(e.id)}>
                        {e.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="submit_label">Submit button label</Label>
                <Input
                  id="submit_label"
                  value={meta.submit_label || ""}
                  onChange={(e) => setMeta({ ...meta, submit_label: e.target.value })}
                  placeholder="Submit"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="theme">Accent color</Label>
                <div className="flex items-center gap-2">
                  <Input
                    id="theme"
                    type="color"
                    className="h-9 w-14 p-1"
                    value={meta.theme_color || "#2563eb"}
                    onChange={(e) => setMeta({ ...meta, theme_color: e.target.value })}
                  />
                  <Input
                    value={meta.theme_color || ""}
                    onChange={(e) => setMeta({ ...meta, theme_color: e.target.value })}
                    placeholder="Optional"
                  />
                </div>
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="success">Success message</Label>
                <Input
                  id="success"
                  value={meta.success_message || ""}
                  onChange={(e) => setMeta({ ...meta, success_message: e.target.value })}
                  placeholder="Thanks! We'll be in touch shortly."
                />
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="redirect">Redirect URL (optional)</Label>
                <Input
                  id="redirect"
                  value={meta.redirect_url || ""}
                  onChange={(e) => setMeta({ ...meta, redirect_url: e.target.value })}
                  placeholder="https://... — sent here after submit instead of the success message"
                />
              </div>
              <div className="flex items-center justify-between rounded-md border p-3 sm:col-span-2">
                <div>
                  <p className="text-sm font-medium">Auto-create sales lead</p>
                  <p className="text-xs text-muted-foreground">
                    Each new submission is pushed into the Sales pipeline and assigned to the owner above.
                  </p>
                </div>
                <Switch
                  checked={!!meta.auto_create_lead}
                  onCheckedChange={(c) => setMeta({ ...meta, auto_create_lead: c })}
                />
              </div>
            </section>

            <Separator />

            <section className="space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-sm font-semibold">Form fields</h3>
                  <p className="text-xs text-muted-foreground">
                    Map fields to sync captured values into Contacts and Leads.
                  </p>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setFields((prev) => [...prev, blankField(prev.length + 1)])}
                >
                  <Plus className="size-4" /> Add field
                </Button>
              </div>

              <div className="space-y-3">
                {fields.map((field, index) => (
                  <Card key={index}>
                    <CardContent className="space-y-3 pt-4">
                      <div className="flex items-center gap-2">
                        <GripVertical className="size-4 shrink-0 text-muted-foreground" />
                        <Input
                          value={field.label}
                          onChange={(e) => setField(index, { label: e.target.value })}
                          placeholder="Field label"
                          className="flex-1"
                        />
                        <Button type="button" variant="ghost" size="icon" onClick={() => move(index, -1)}>
                          <ArrowUp className="size-4" />
                          <span className="sr-only">Move up</span>
                        </Button>
                        <Button type="button" variant="ghost" size="icon" onClick={() => move(index, 1)}>
                          <ArrowDown className="size-4" />
                          <span className="sr-only">Move down</span>
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          onClick={() => setFields((prev) => prev.filter((_, i) => i !== index))}
                        >
                          <Trash2 className="size-4 text-destructive" />
                          <span className="sr-only">Remove field</span>
                        </Button>
                      </div>
                      <div className="grid gap-3 pl-6 sm:grid-cols-3">
                        <div className="space-y-1.5">
                          <Label className="text-xs">Type</Label>
                          <Select value={field.type} onValueChange={(v) => setField(index, { type: v })}>
                            <SelectTrigger className="h-8">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {lookups.fieldTypes.map((t) => (
                                <SelectItem key={t} value={t}>
                                  {t}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="space-y-1.5">
                          <Label className="text-xs">Maps to</Label>
                          <Select value={field.maps_to} onValueChange={(v) => setField(index, { maps_to: v })}>
                            <SelectTrigger className="h-8">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {lookups.fieldMappings.map((m) => (
                                <SelectItem key={m.key} value={m.key}>
                                  {m.label}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="flex items-end gap-2 pb-1">
                          <Switch
                            id={`req_${index}`}
                            checked={field.required}
                            onCheckedChange={(c) => setField(index, { required: c })}
                          />
                          <Label htmlFor={`req_${index}`} className="text-xs">
                            Required
                          </Label>
                        </div>
                        {field.type === "select" ? (
                          <div className="space-y-1.5 sm:col-span-3">
                            <Label className="text-xs">Options (one per line)</Label>
                            <Textarea
                              rows={3}
                              value={(field.options || []).join("\n")}
                              onChange={(e) =>
                                setField(index, {
                                  options: e.target.value.split("\n").map((s) => s.trim()).filter(Boolean),
                                })
                              }
                            />
                          </div>
                        ) : null}
                      </div>
                    </CardContent>
                  </Card>
                ))}
                {fields.length === 0 ? (
                  <p className="rounded-md border border-dashed py-6 text-center text-sm text-muted-foreground">
                    No fields yet. Add at least one field.
                  </p>
                ) : null}
              </div>
            </section>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={save} disabled={saving || loading}>
            {saving ? "Saving..." : formId ? "Save changes" : "Create form"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
