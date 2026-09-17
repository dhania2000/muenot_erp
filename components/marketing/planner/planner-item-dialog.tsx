"use client"

import { useEffect, useMemo, useState } from "react"
import { toast } from "sonner"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogClose,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Loader2 } from "lucide-react"
import { PLANNER_PRIORITIES } from "@/lib/marketing/planner-constants"
import { plannerFetch, toDateInput, toDateTimeLocal, type Lookups, type PlannerItem } from "./planner-shared"

const NONE = "__none__"

type FormState = {
  title: string
  description: string
  content_type: string
  channel: string
  priority: string
  start_date: string
  due_date: string
  publish_at: string
  campaign_id: string
  journey_id: string
  segment_id: string
  email_template_id: string
  whatsapp_template_name: string
  owner_id: string
  assignee_id: string
  estimated_budget: string
  actual_spend: string
  tags: string
  color: string
  brief: string
}

function emptyForm(lookups?: Lookups): FormState {
  return {
    title: "",
    description: "",
    content_type: lookups?.contentTypes?.[0] || "Other",
    channel: lookups?.channels?.[0] || "Email",
    priority: "Normal",
    start_date: "",
    due_date: "",
    publish_at: "",
    campaign_id: NONE,
    journey_id: NONE,
    segment_id: NONE,
    email_template_id: NONE,
    whatsapp_template_name: NONE,
    owner_id: NONE,
    assignee_id: NONE,
    estimated_budget: "",
    actual_spend: "",
    tags: "",
    color: "",
    brief: "",
  }
}

function fromItem(item: PlannerItem): FormState {
  return {
    title: item.title || "",
    description: item.description || "",
    content_type: item.content_type || "Other",
    channel: item.channel || "Email",
    priority: item.priority || "Normal",
    start_date: toDateInput(item.start_date),
    due_date: toDateInput(item.due_date),
    publish_at: toDateTimeLocal(item.publish_at),
    campaign_id: item.campaign_id ? String(item.campaign_id) : NONE,
    journey_id: item.journey_id ? String(item.journey_id) : NONE,
    segment_id: item.segment_id ? String(item.segment_id) : NONE,
    email_template_id: item.email_template_id ? String(item.email_template_id) : NONE,
    whatsapp_template_name: item.whatsapp_template_name || NONE,
    owner_id: item.owner_id ? String(item.owner_id) : NONE,
    assignee_id: item.assignee_id ? String(item.assignee_id) : NONE,
    estimated_budget: item.estimated_budget != null ? String(item.estimated_budget) : "",
    actual_spend: item.actual_spend != null ? String(item.actual_spend) : "",
    tags: Array.isArray(item.tags) ? item.tags.join(", ") : "",
    color: item.color || "",
    brief: item.brief?.notes ? String(item.brief.notes) : "",
  }
}

export function PlannerItemDialog({
  open,
  onOpenChange,
  lookups,
  item,
  onSaved,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  lookups?: Lookups
  item?: PlannerItem | null
  onSaved: (item: PlannerItem) => void
}) {
  const editing = !!item
  const [form, setForm] = useState<FormState>(() => emptyForm(lookups))
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) return
    setForm(item ? fromItem(item) : emptyForm(lookups))
  }, [open, item, lookups])

  const set = (patch: Partial<FormState>) => setForm((f) => ({ ...f, ...patch }))

  const idOrNull = (v: string) => (v && v !== NONE ? Number(v) : null)

  const contentTypes = useMemo(() => lookups?.contentTypes ?? [], [lookups])
  const channels = useMemo(() => lookups?.channels ?? [], [lookups])

  async function submit() {
    if (!form.title.trim()) {
      toast.error("Title is required")
      return
    }
    setSaving(true)
    const payload: Record<string, any> = {
      title: form.title.trim(),
      description: form.description.trim() || null,
      content_type: form.content_type,
      channel: form.channel,
      priority: form.priority,
      start_date: form.start_date || null,
      due_date: form.due_date || null,
      publish_at: form.publish_at ? form.publish_at.replace("T", " ") + ":00" : null,
      campaign_id: idOrNull(form.campaign_id),
      journey_id: idOrNull(form.journey_id),
      segment_id: idOrNull(form.segment_id),
      email_template_id: idOrNull(form.email_template_id),
      whatsapp_template_name: form.whatsapp_template_name !== NONE ? form.whatsapp_template_name : null,
      owner_id: idOrNull(form.owner_id),
      estimated_budget: form.estimated_budget ? Number(form.estimated_budget) : null,
      actual_spend: form.actual_spend ? Number(form.actual_spend) : null,
      tags: form.tags
        ? form.tags
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean)
        : [],
      color: form.color || null,
      brief: form.brief.trim() ? { notes: form.brief.trim() } : null,
    }
    if (!editing) payload.assignee_id = idOrNull(form.assignee_id)

    try {
      let saved: PlannerItem
      if (editing && item) {
        const res = await plannerFetch(`/api/marketing/planner/${item.id}`, {
          method: "PATCH",
          body: JSON.stringify({ ...payload, row_version: item.row_version }),
        })
        saved = res.item
      } else {
        const res = await plannerFetch(`/api/marketing/planner`, {
          method: "POST",
          body: JSON.stringify(payload),
        })
        saved = res.item
      }
      toast.success(editing ? "Item updated" : "Item created")
      onSaved(saved)
      onOpenChange(false)
    } catch (err: any) {
      toast.error(err?.message || "Save failed")
    } finally {
      setSaving(false)
    }
  }

  const showEmail = form.channel === "Email"
  const showWhatsApp = form.channel === "WhatsApp"

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{editing ? `Edit ${item?.item_code ?? "item"}` : "New planner item"}</DialogTitle>
          <DialogDescription>
            {editing
              ? "Update the content details, schedule and ownership."
              : "Capture a new piece of content for the marketing calendar."}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-1">
          <Field label="Title" required>
            <Input
              value={form.title}
              onChange={(e) => set({ title: e.target.value })}
              placeholder="e.g. Q3 product launch newsletter"
              autoFocus
            />
          </Field>

          <Field label="Description">
            <Textarea
              value={form.description}
              onChange={(e) => set({ description: e.target.value })}
              placeholder="Short summary of this item"
              rows={2}
            />
          </Field>

          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Content type">
              <PickSelect value={form.content_type} onChange={(v) => set({ content_type: v })} options={contentTypes} />
            </Field>
            <Field label="Channel">
              <PickSelect value={form.channel} onChange={(v) => set({ channel: v })} options={channels} />
            </Field>
            <Field label="Priority">
              <PickSelect
                value={form.priority}
                onChange={(v) => set({ priority: v })}
                options={PLANNER_PRIORITIES as unknown as string[]}
              />
            </Field>
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Start date">
              <Input type="date" value={form.start_date} onChange={(e) => set({ start_date: e.target.value })} />
            </Field>
            <Field label="Due date">
              <Input type="date" value={form.due_date} onChange={(e) => set({ due_date: e.target.value })} />
            </Field>
            <Field label="Publish at">
              <Input
                type="datetime-local"
                value={form.publish_at}
                onChange={(e) => set({ publish_at: e.target.value })}
              />
            </Field>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Owner">
              <LookupSelect
                value={form.owner_id}
                onChange={(v) => set({ owner_id: v })}
                options={(lookups?.employees ?? []).map((e) => ({ value: String(e.id), label: e.name }))}
                placeholder="Unassigned"
              />
            </Field>
            {!editing ? (
              <Field label="Primary assignee">
                <LookupSelect
                  value={form.assignee_id}
                  onChange={(v) => set({ assignee_id: v })}
                  options={(lookups?.employees ?? []).map((e) => ({ value: String(e.id), label: e.name }))}
                  placeholder="Unassigned"
                />
              </Field>
            ) : (
              <Field label="Tags">
                <Input
                  value={form.tags}
                  onChange={(e) => set({ tags: e.target.value })}
                  placeholder="comma, separated"
                />
              </Field>
            )}
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Campaign">
              <LookupSelect
                value={form.campaign_id}
                onChange={(v) => set({ campaign_id: v })}
                options={(lookups?.campaigns ?? []).map((c) => ({ value: String(c.id), label: c.name }))}
                placeholder="None"
              />
            </Field>
            <Field label="Journey">
              <LookupSelect
                value={form.journey_id}
                onChange={(v) => set({ journey_id: v })}
                options={(lookups?.journeys ?? []).map((j) => ({ value: String(j.id), label: j.name }))}
                placeholder="None"
              />
            </Field>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Segment">
              <LookupSelect
                value={form.segment_id}
                onChange={(v) => set({ segment_id: v })}
                options={(lookups?.segments ?? []).map((s) => ({ value: String(s.id), label: s.name }))}
                placeholder="None"
              />
            </Field>
            {showEmail ? (
              <Field label="Email template">
                <LookupSelect
                  value={form.email_template_id}
                  onChange={(v) => set({ email_template_id: v })}
                  options={(lookups?.emailTemplates ?? []).map((t) => ({ value: String(t.id), label: t.name }))}
                  placeholder="None"
                />
              </Field>
            ) : showWhatsApp ? (
              <Field label="WhatsApp template">
                <LookupSelect
                  value={form.whatsapp_template_name}
                  onChange={(v) => set({ whatsapp_template_name: v })}
                  options={(lookups?.whatsappTemplates ?? []).map((t) => ({
                    value: t.name,
                    label: `${t.name} (${t.language})`,
                  }))}
                  placeholder="None"
                />
              </Field>
            ) : (
              <Field label="Color">
                <Input
                  type="color"
                  value={form.color || "#6366f1"}
                  onChange={(e) => set({ color: e.target.value })}
                  className="h-9 w-full"
                />
              </Field>
            )}
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Estimated budget">
              <Input
                type="number"
                min="0"
                value={form.estimated_budget}
                onChange={(e) => set({ estimated_budget: e.target.value })}
                placeholder="0"
              />
            </Field>
            <Field label="Actual spend">
              <Input
                type="number"
                min="0"
                value={form.actual_spend}
                onChange={(e) => set({ actual_spend: e.target.value })}
                placeholder="0"
              />
            </Field>
          </div>

          <Field label="Creative brief">
            <Textarea
              value={form.brief}
              onChange={(e) => set({ brief: e.target.value })}
              placeholder="Goals, key message, reference links…"
              rows={3}
            />
          </Field>
        </div>

        <DialogFooter>
          <DialogClose render={<Button variant="outline">Cancel</Button>} />
          <Button onClick={submit} disabled={saving}>
            {saving ? <Loader2 className="size-4 animate-spin" /> : null}
            {editing ? "Save changes" : "Create item"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label className="text-xs font-medium text-muted-foreground">
        {label}
        {required ? <span className="text-destructive"> *</span> : null}
      </Label>
      {children}
    </div>
  )
}

function PickSelect({
  value,
  onChange,
  options,
}: {
  value: string
  onChange: (v: string) => void
  options: string[]
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="w-full">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o} value={o}>
            {o}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

function LookupSelect({
  value,
  onChange,
  options,
  placeholder,
}: {
  value: string
  onChange: (v: string) => void
  options: { value: string; label: string }[]
  placeholder: string
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="w-full">
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NONE}>{placeholder}</SelectItem>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
