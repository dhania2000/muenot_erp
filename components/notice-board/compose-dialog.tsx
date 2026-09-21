"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Checkbox } from "@/components/ui/checkbox"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Loader2, Paperclip, Send, Save, X, Users, FileText } from "lucide-react"
import {
  type AudienceConfig, type AudienceType, type Meta, type Priority,
  AUDIENCE_LABELS, PriorityBadge,
} from "./shared"

type Attachment = { id: number; file_name: string; file_size: number; existing?: boolean }

type FormState = {
  heading: string
  description: string
  category: string
  priority: Priority
  to_type: "employees" | "clients"
  audience_type: AudienceType
  audience_config: AudienceConfig
  include_inactive: boolean
  start_date: string
  end_date: string
  publish_date: string
  effective_date: string
  review_date: string
  acknowledgement_required: boolean
  notify_in_app: boolean
  notify_email: boolean
  pinned: boolean
  keep_pinned_after_expiry: boolean
}

const emptyForm: FormState = {
  heading: "", description: "", category: "General", priority: "normal",
  to_type: "employees", audience_type: "all", audience_config: {}, include_inactive: false,
  start_date: "", end_date: "", publish_date: "", effective_date: "", review_date: "",
  acknowledgement_required: false, notify_in_app: true, notify_email: false,
  pinned: false, keep_pinned_after_expiry: false,
}

function toDateInput(v: string | null | undefined) {
  if (!v) return ""
  const d = new Date(String(v).replace(" ", "T"))
  if (Number.isNaN(d.getTime())) return ""
  return d.toISOString().slice(0, 10)
}
function toDateTimeInput(v: string | null | undefined) {
  if (!v) return ""
  const d = new Date(String(v).replace(" ", "T"))
  if (Number.isNaN(d.getTime())) return ""
  const off = d.getTimezoneOffset()
  return new Date(d.getTime() - off * 60000).toISOString().slice(0, 16)
}
/** datetime-local "YYYY-MM-DDTHH:mm" -> MySQL "YYYY-MM-DD HH:mm:ss" */
function toMysqlDateTime(local: string) {
  if (!local) return null
  const [d, t] = local.split("T")
  if (!d || !t) return null
  return `${d} ${t.length === 5 ? `${t}:00` : t}`
}

export function ComposeDialog({
  open, onOpenChange, editingId, meta, onSaved,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  editingId: number | null
  meta: Meta | undefined
  onSaved: () => void
}) {
  const [form, setForm] = useState<FormState>(emptyForm)
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [uploading, setUploading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [loading, setLoading] = useState(false)
  const [preview, setPreview] = useState<{ count: number; sample: { id: number; name: string }[]; error?: string } | null>(null)
  const [empSearch, setEmpSearch] = useState("")
  const draftKey = useRef<string>("")
  const fileInput = useRef<HTMLInputElement>(null)

  const isEditing = editingId != null
  const isPolicy = form.category === "Policy" || form.category === "Compliance"

  // Reset / prefill whenever the dialog opens.
  useEffect(() => {
    if (!open) return
    draftKey.current = (globalThis.crypto?.randomUUID?.() ?? String(Date.now()))
    setEmpSearch("")
    setPreview(null)
    if (editingId == null) {
      setForm(emptyForm)
      setAttachments([])
      return
    }
    setLoading(true)
    fetch(`/api/notice-board/${editingId}`)
      .then((r) => r.json())
      .then((data) => {
        const n = data.notice
        if (!n) return
        setForm({
          heading: n.heading ?? "", description: n.description ?? "",
          category: n.category ?? "General", priority: n.priority ?? "normal",
          to_type: n.to_type ?? "employees", audience_type: n.audience_type ?? "all",
          audience_config: n.audience_config ?? {}, include_inactive: !!n.include_inactive,
          start_date: toDateInput(n.start_date), end_date: toDateInput(n.end_date),
          publish_date: toDateTimeInput(n.publish_date),
          effective_date: toDateInput(n.effective_date), review_date: toDateInput(n.review_date),
          acknowledgement_required: !!n.acknowledgement_required,
          notify_in_app: !!n.notify_in_app, notify_email: !!n.notify_email,
          pinned: !!n.pinned, keep_pinned_after_expiry: !!n.keep_pinned_after_expiry,
        })
        setAttachments((n.attachments ?? []).map((a: any) => ({ id: a.id, file_name: a.file_name, file_size: a.file_size, existing: true })))
      })
      .finally(() => setLoading(false))
  }, [open, editingId])

  // Live audience preview (debounced) when the audience selection changes.
  const audienceKey = JSON.stringify({
    t: form.to_type, a: form.audience_type, c: form.audience_config, i: form.include_inactive,
  })
  useEffect(() => {
    if (!open || form.to_type === "clients") { setPreview(null); return }
    const id = setTimeout(() => {
      fetch("/api/notice-board/audience-preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          to_type: form.to_type, audience_type: form.audience_type,
          audience_config: form.audience_config, include_inactive: form.include_inactive,
        }),
      })
        .then((r) => r.json())
        .then((d) => setPreview({ count: d.count ?? 0, sample: d.sample ?? [], error: d.error }))
        .catch(() => setPreview(null))
    }, 300)
    return () => clearTimeout(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audienceKey, open])

  const set = (patch: Partial<FormState>) => setForm((f) => ({ ...f, ...patch }))

  function toggleInList(key: keyof AudienceConfig, value: string | number) {
    setForm((f) => {
      const current = (f.audience_config[key] as (string | number)[] | undefined) ?? []
      const exists = current.includes(value as never)
      const next = exists ? current.filter((v) => v !== value) : [...current, value]
      return { ...f, audience_config: { ...f.audience_config, [key]: next } }
    })
  }

  async function uploadFiles(files: FileList) {
    setUploading(true)
    for (const file of Array.from(files)) {
      const fd = new FormData()
      fd.append("file", file)
      fd.append("draftKey", draftKey.current)
      const res = await fetch("/api/notice-board/attachments", { method: "POST", body: fd })
      const data = await res.json().catch(() => ({}))
      if (res.ok) {
        setAttachments((a) => [...a, { id: data.id, file_name: data.file_name, file_size: data.file_size }])
      } else {
        toast.error(data.error || `Could not upload ${file.name}`)
      }
    }
    setUploading(false)
    if (fileInput.current) fileInput.current.value = ""
  }

  async function removeAttachment(att: Attachment) {
    if (!att.existing) {
      await fetch(`/api/notice-board/attachments?id=${att.id}`, { method: "DELETE" }).catch(() => {})
    }
    setAttachments((a) => a.filter((x) => x.id !== att.id))
  }

  const newAttachmentIds = useMemo(() => attachments.filter((a) => !a.existing).map((a) => a.id), [attachments])

  function buildPayload() {
    return {
      heading: form.heading.trim(),
      description: form.description.trim(),
      category: form.category,
      priority: form.priority,
      to_type: form.to_type,
      audience_type: form.to_type === "clients" ? "all" : form.audience_type,
      audience_config: form.to_type === "clients" ? {} : form.audience_config,
      include_inactive: form.include_inactive,
      start_date: form.start_date || null,
      end_date: form.end_date || null,
      publish_date: toMysqlDateTime(form.publish_date),
      effective_date: form.effective_date || null,
      review_date: form.review_date || null,
      acknowledgement_required: form.acknowledgement_required,
      notify_in_app: form.notify_in_app,
      notify_email: form.notify_email,
      pinned: form.pinned,
      keep_pinned_after_expiry: form.keep_pinned_after_expiry,
      attachment_ids: newAttachmentIds,
    }
  }

  function validate(forPublish: boolean): string | null {
    if (!form.heading.trim()) return "Notice heading is required"
    if (forPublish && !form.description.trim()) return "Notice details are required to publish"
    if (form.start_date && form.end_date && form.end_date < form.start_date)
      return "End date must be on or after start date"
    if (forPublish && form.to_type === "employees" && form.audience_type !== "all") {
      if (preview && !preview.error && preview.count === 0)
        return "The selected audience contains no employees"
    }
    return null
  }

  async function save(action: "draft" | "publish") {
    const err = validate(action === "publish")
    if (err) { toast.error(err); return }
    setSaving(true)
    try {
      if (isEditing) {
        const res = await fetch(`/api/notice-board/${editingId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(buildPayload()),
        })
        const data = await res.json().catch(() => ({}))
        if (!res.ok) { toast.error(data.error || "Could not save notice"); return }
        if (action === "publish") {
          const pub = await fetch(`/api/notice-board/${editingId}/publish`, { method: "POST" })
          const pd = await pub.json().catch(() => ({}))
          if (!pub.ok) { toast.error(pd.error || "Saved, but publishing failed"); onSaved(); onOpenChange(false); return }
          toast.success(pd.status === "scheduled" ? "Notice scheduled" : "Notice published")
        } else {
          toast.success("Notice updated")
        }
      } else {
        const res = await fetch("/api/notice-board", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...buildPayload(), action }),
        })
        const data = await res.json().catch(() => ({}))
        if (!res.ok) { toast.error(data.error || "Could not create notice"); return }
        toast.success(
          data.status === "published" ? "Notice published"
            : data.status === "scheduled" ? "Notice scheduled"
              : "Draft saved",
        )
      }
      onSaved()
      onOpenChange(false)
    } finally {
      setSaving(false)
    }
  }

  const filteredEmployees = useMemo(() => {
    const list = meta?.employees ?? []
    const q = empSearch.trim().toLowerCase()
    const base = form.include_inactive ? list : list.filter((e) => e.active)
    if (!q) return base.slice(0, 200)
    return base.filter((e) => e.name.toLowerCase().includes(q) || (e.department ?? "").toLowerCase().includes(q)).slice(0, 200)
  }, [meta?.employees, empSearch, form.include_inactive])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] gap-0 overflow-hidden p-0 sm:max-w-2xl">
        <DialogHeader className="border-b px-6 py-4">
          <DialogTitle>{isEditing ? "Edit Notice" : "Create Notice"}</DialogTitle>
          <DialogDescription>Compose a notice, choose its audience, then save as draft or publish.</DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center py-20 text-muted-foreground">
            <Loader2 className="mr-2 size-5 animate-spin" /> Loading notice…
          </div>
        ) : (
          <div className="max-h-[68vh] overflow-y-auto px-6 py-5">
            <div className="grid gap-5">
              {/* Basics */}
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="grid gap-1.5 text-sm font-medium">
                  Category
                  <Select value={form.category} onValueChange={(v) => set({ category: v })}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {(meta?.categories ?? ["General"]).map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </label>
                <label className="grid gap-1.5 text-sm font-medium">
                  Priority
                  <Select value={form.priority} onValueChange={(v) => set({ priority: v as Priority })}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="normal">Normal</SelectItem>
                      <SelectItem value="important">Important</SelectItem>
                      <SelectItem value="urgent">Urgent</SelectItem>
                    </SelectContent>
                  </Select>
                </label>
              </div>

              <label className="grid gap-1.5 text-sm font-medium">
                Title
                <Input value={form.heading} onChange={(e) => set({ heading: e.target.value })} placeholder="Enter notice title" maxLength={200} />
              </label>

              <label className="grid gap-1.5 text-sm font-medium">
                Content
                <Textarea rows={6} value={form.description} onChange={(e) => set({ description: e.target.value })} placeholder="Write the notice content" />
              </label>

              <Separator />

              {/* Audience */}
              <div className="grid gap-3">
                <div className="flex items-center gap-2 text-sm font-medium"><Users className="size-4" /> Target Audience</div>
                <div className="flex gap-6 text-sm">
                  <label className="flex items-center gap-2">
                    <input type="radio" name="to_type" checked={form.to_type === "employees"} onChange={() => set({ to_type: "employees" })} />
                    Employees
                  </label>
                  <label className="flex items-center gap-2">
                    <input type="radio" name="to_type" checked={form.to_type === "clients"} onChange={() => set({ to_type: "clients" })} />
                    Clients
                  </label>
                </div>

                {form.to_type === "employees" && (
                  <>
                    <Select value={form.audience_type} onValueChange={(v) => set({ audience_type: v as AudienceType, audience_config: {} })}>
                      <SelectTrigger className="w-full sm:w-72"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {(Object.keys(AUDIENCE_LABELS) as AudienceType[]).map((t) => (
                          <SelectItem key={t} value={t}>{AUDIENCE_LABELS[t]}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>

                    {form.audience_type === "department" && (
                      <CheckList options={meta?.departments ?? []} selected={form.audience_config.departments ?? []} onToggle={(v) => toggleInList("departments", v)} />
                    )}
                    {form.audience_type === "designation" && (
                      <CheckList options={meta?.designations ?? []} selected={form.audience_config.designations ?? []} onToggle={(v) => toggleInList("designations", v)} />
                    )}
                    {form.audience_type === "location" && (
                      <CheckList options={meta?.locations ?? []} selected={form.audience_config.locations ?? []} onToggle={(v) => toggleInList("locations", v)} />
                    )}
                    {form.audience_type === "employment_type" && (
                      <CheckList options={meta?.employmentTypes ?? []} selected={form.audience_config.employmentTypes ?? []} onToggle={(v) => toggleInList("employmentTypes", v)} />
                    )}
                    {form.audience_type === "employees" && (
                      <div className="grid gap-2">
                        <Input value={empSearch} onChange={(e) => setEmpSearch(e.target.value)} placeholder="Search employees…" />
                        <div className="max-h-52 overflow-y-auto rounded-md border">
                          {filteredEmployees.length === 0 ? (
                            <p className="p-3 text-sm text-muted-foreground">No employees found.</p>
                          ) : filteredEmployees.map((e) => {
                            const checked = (form.audience_config.employeeIds ?? []).includes(e.id)
                            return (
                              <label key={e.id} className="flex cursor-pointer items-center gap-2.5 border-b px-3 py-2 text-sm last:border-b-0 hover:bg-muted/40">
                                <Checkbox checked={checked} onCheckedChange={() => toggleInList("employeeIds", e.id)} />
                                <span className="flex-1">{e.name}</span>
                                {e.department && <span className="text-xs text-muted-foreground">{e.department}</span>}
                                {!e.active && <Badge variant="secondary" className="font-normal">Inactive</Badge>}
                              </label>
                            )
                          })}
                        </div>
                      </div>
                    )}

                    {form.audience_type !== "all" && (
                      <label className="flex items-center gap-2 text-sm">
                        <Checkbox checked={form.include_inactive} onCheckedChange={(c) => set({ include_inactive: !!c })} />
                        Include inactive employees
                      </label>
                    )}

                    {preview && (
                      <div className="rounded-md border bg-muted/30 p-3 text-sm">
                        {preview.error ? (
                          <span className="text-amber-600 dark:text-amber-400">{preview.error}</span>
                        ) : (
                          <span>
                            <span className="font-medium text-foreground">{preview.count}</span> recipient{preview.count === 1 ? "" : "s"}
                            {preview.sample.length > 0 && (
                              <span className="text-muted-foreground"> — {preview.sample.map((s) => s.name).join(", ")}{preview.count > preview.sample.length ? "…" : ""}</span>
                            )}
                          </span>
                        )}
                      </div>
                    )}
                  </>
                )}
              </div>

              <Separator />

              {/* Scheduling */}
              <div className="grid gap-4 sm:grid-cols-3">
                <label className="grid gap-1.5 text-sm font-medium">
                  Start Date
                  <Input type="date" value={form.start_date} onChange={(e) => set({ start_date: e.target.value })} />
                </label>
                <label className="grid gap-1.5 text-sm font-medium">
                  End Date
                  <Input type="date" value={form.end_date} onChange={(e) => set({ end_date: e.target.value })} />
                </label>
                <label className="grid gap-1.5 text-sm font-medium">
                  Publish At
                  <Input type="datetime-local" value={form.publish_date} onChange={(e) => set({ publish_date: e.target.value })} />
                </label>
              </div>
              <p className="-mt-2 text-xs text-muted-foreground">Leave Publish At empty to publish immediately. A future time schedules the notice.</p>

              {isPolicy && (
                <div className="grid gap-4 sm:grid-cols-2">
                  <label className="grid gap-1.5 text-sm font-medium">
                    Effective Date
                    <Input type="date" value={form.effective_date} onChange={(e) => set({ effective_date: e.target.value })} />
                  </label>
                  <label className="grid gap-1.5 text-sm font-medium">
                    Review Date
                    <Input type="date" value={form.review_date} onChange={(e) => set({ review_date: e.target.value })} />
                  </label>
                </div>
              )}

              <Separator />

              {/* Attachments */}
              <div className="grid gap-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 text-sm font-medium"><Paperclip className="size-4" /> Attachments</div>
                  <Button type="button" variant="outline" size="sm" disabled={uploading} onClick={() => fileInput.current?.click()}>
                    {uploading ? <Loader2 className="mr-2 size-3.5 animate-spin" /> : <Paperclip className="mr-2 size-3.5" />}
                    Add file
                  </Button>
                  <input
                    ref={fileInput}
                    type="file"
                    multiple
                    className="hidden"
                    accept=".pdf,.doc,.docx,.xls,.xlsx,.csv,.ppt,.pptx,.png,.jpg,.jpeg,.gif,.webp"
                    onChange={(e) => e.target.files && uploadFiles(e.target.files)}
                  />
                </div>
                {attachments.length === 0 ? (
                  <p className="text-xs text-muted-foreground">PDF, Office documents and images up to 20 MB.</p>
                ) : (
                  <ul className="grid gap-1.5">
                    {attachments.map((a) => (
                      <li key={a.id} className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm">
                        <FileText className="size-4 text-muted-foreground" />
                        <span className="flex-1 truncate">{a.file_name}</span>
                        <span className="text-xs text-muted-foreground">{(a.file_size / 1024).toFixed(0)} KB</span>
                        <button type="button" onClick={() => removeAttachment(a)} className="text-muted-foreground hover:text-destructive" aria-label="Remove attachment">
                          <X className="size-4" />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <Separator />

              {/* Options */}
              <div className="grid gap-2.5">
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox checked={form.acknowledgement_required} onCheckedChange={(c) => set({ acknowledgement_required: !!c })} />
                  Require acknowledgement
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox checked={form.notify_in_app} onCheckedChange={(c) => set({ notify_in_app: !!c })} />
                  Send in-app notification
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox checked={form.notify_email} onCheckedChange={(c) => set({ notify_email: !!c })} />
                  Send email notification
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox checked={form.pinned} onCheckedChange={(c) => set({ pinned: !!c })} />
                  Pin to top
                </label>
                {form.pinned && (
                  <label className="ml-6 flex items-center gap-2 text-sm">
                    <Checkbox checked={form.keep_pinned_after_expiry} onCheckedChange={(c) => set({ keep_pinned_after_expiry: !!c })} />
                    Keep pinned after expiry
                  </label>
                )}
              </div>

              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                Preview priority: <PriorityBadge priority={form.priority} />
              </div>
            </div>
          </div>
        )}

        <DialogFooter className="border-t px-6 py-4">
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>Cancel</Button>
          <Button type="button" variant="outline" onClick={() => save("draft")} disabled={saving || loading}>
            {saving ? <Loader2 className="mr-2 size-4 animate-spin" /> : <Save className="mr-2 size-4" />}
            Save Draft
          </Button>
          <Button type="button" onClick={() => save("publish")} disabled={saving || loading}>
            {saving ? <Loader2 className="mr-2 size-4 animate-spin" /> : <Send className="mr-2 size-4" />}
            {form.publish_date ? "Schedule" : "Publish"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function CheckList({ options, selected, onToggle }: { options: string[]; selected: string[]; onToggle: (v: string) => void }) {
  if (options.length === 0) return <p className="text-sm text-muted-foreground">No options available from HR data.</p>
  return (
    <div className="grid max-h-48 grid-cols-1 gap-1 overflow-y-auto rounded-md border p-1 sm:grid-cols-2">
      {options.map((o) => (
        <label key={o} className="flex cursor-pointer items-center gap-2.5 rounded px-2.5 py-1.5 text-sm hover:bg-muted/40">
          <Checkbox checked={selected.includes(o)} onCheckedChange={() => onToggle(o)} />
          <span className="truncate">{o}</span>
        </label>
      ))}
    </div>
  )
}
