"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import useSWR from "swr"
import { toast } from "sonner"
import { fetcher } from "@/lib/fetcher"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Checkbox } from "@/components/ui/checkbox"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { RichTextEditor } from "./rich-text-editor"
import {
  type MetaResponse, type ArticleDetail, type ContentType, type AudienceType,
  CONTENT_TYPE_META, AUDIENCE_LABELS, formatBytes,
} from "./kb-lib"
import { Plus, X, Upload, FileText, Users, Loader2, Paperclip, Link2, Trash2 } from "lucide-react"

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  editing: ArticleDetail | null
  onSaved: () => void
  initialContentType?: ContentType
}

type ErpLinkForm = { source_module: string; source_record_id: string; label: string }

const CONTENT_TYPES = Object.keys(CONTENT_TYPE_META) as ContentType[]
const AUDIENCE_TYPES: AudienceType[] = ["all", "department", "designation", "employees", "management", "admin"]

function toDateInput(value: string | null | undefined) {
  if (!value) return ""
  const d = new Date(String(value).replace(" ", "T"))
  if (Number.isNaN(d.getTime())) return ""
  return d.toISOString().slice(0, 10)
}
function toDateTimeInput(value: string | null | undefined) {
  if (!value) return ""
  const d = new Date(String(value).replace(" ", "T"))
  if (Number.isNaN(d.getTime())) return ""
  const off = d.getTimezoneOffset()
  return new Date(d.getTime() - off * 60000).toISOString().slice(0, 16)
}

const blankState = {
  heading: "",
  summary: "",
  content: "",
  content_type: "article" as ContentType,
  to_type: "employees" as "employees" | "clients",
  category_id: "",
  new_category: "",
  subcategory: "",
  tags: "",
  audience_type: "all" as AudienceType,
  departments: [] as string[],
  designations: [] as string[],
  employeeIds: [] as number[],
  owner_name: "",
  publish_date: "",
  effective_date: "",
  review_date: "",
  expiry_date: "",
  acknowledgement_required: false,
  notify_in_app: true,
  notify_email: false,
  pinned: false,
  keep_pinned_after_expiry: false,
  important: false,
  related_ids: [] as number[],
  change_summary: "",
}

export function ArticleEditor({ open, onOpenChange, editing, onSaved, initialContentType }: Props) {
  const { data: meta } = useSWR<MetaResponse>(open ? "/api/knowledge-base/meta" : null, fetcher)
  const [form, setForm] = useState(blankState)
  const [erpLinks, setErpLinks] = useState<ErpLinkForm[]>([])
  const [attachments, setAttachments] = useState<{ id: number; file_name: string; file_size: number }[]>([])
  const [draftKey] = useState(() => crypto.randomUUID().slice(0, 32))
  const [uploading, setUploading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [preview, setPreview] = useState<{ count: number; sample: string[] } | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const isEditing = !!editing

  // Hydrate form from the article being edited, or reset for a new one.
  useEffect(() => {
    if (!open) return
    if (editing) {
      const a = editing.article
      const cfg = (() => {
        try { return typeof (a as any).audience_config === "string" ? JSON.parse((a as any).audience_config) : (a as any).audience_config } catch { return {} }
      })() || {}
      setForm({
        ...blankState,
        heading: a.heading || "",
        summary: a.summary || "",
        content: a.content || "",
        content_type: a.content_type,
        to_type: a.to_type,
        category_id: a.category_id ? String(a.category_id) : "",
        subcategory: a.subcategory || "",
        tags: (a.tags || []).join(", "),
        audience_type: a.audience_type,
        departments: cfg.departments || [],
        designations: cfg.designations || [],
        employeeIds: cfg.employeeIds || [],
        owner_name: a.owner_name || "",
        publish_date: toDateTimeInput(a.publish_date),
        effective_date: toDateInput(a.effective_date),
        review_date: toDateInput(a.review_date),
        expiry_date: toDateInput(a.expiry_date),
        acknowledgement_required: !!a.acknowledgement_required,
        notify_in_app: a.notify_in_app !== 0,
        notify_email: !!a.notify_email,
        pinned: !!a.pinned,
        keep_pinned_after_expiry: !!a.keep_pinned_after_expiry,
        important: !!a.important,
        related_ids: editing.related.map((r) => r.id),
        change_summary: "",
      })
      setErpLinks(editing.erpLinks.map((e) => ({ source_module: e.source_module, source_record_id: e.source_record_id, label: e.label || "" })))
      setAttachments(editing.attachments.map((x) => ({ id: x.id, file_name: x.file_name, file_size: x.file_size })))
    } else {
      setForm({ ...blankState, content_type: initialContentType ?? "article" })
      setErpLinks([])
      setAttachments([])
    }
    setPreview(null)
  }, [open, editing, initialContentType])

  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }))

  const audienceConfig = useMemo(
    () => ({ departments: form.departments, designations: form.designations, employeeIds: form.employeeIds }),
    [form.departments, form.designations, form.employeeIds],
  )

  // Live audience preview for employee-targeted content.
  useEffect(() => {
    if (!open || form.to_type !== "employees") { setPreview(null); return }
    const controller = new AbortController()
    const t = setTimeout(async () => {
      try {
        const res = await fetch("/api/knowledge-base/audience-preview", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ audience_type: form.audience_type, audience_config: audienceConfig }),
          signal: controller.signal,
        })
        if (res.ok) setPreview(await res.json())
      } catch { /* aborted */ }
    }, 350)
    return () => { controller.abort(); clearTimeout(t) }
  }, [open, form.to_type, form.audience_type, audienceConfig])

  const toggleInArray = <T,>(arr: T[], value: T): T[] =>
    arr.includes(value) ? arr.filter((v) => v !== value) : [...arr, value]

  const uploadFiles = async (files: FileList | null) => {
    if (!files?.length) return
    setUploading(true)
    for (const file of Array.from(files)) {
      const fd = new FormData()
      fd.append("file", file)
      fd.append("draftKey", draftKey)
      try {
        const res = await fetch("/api/knowledge-base/attachments", { method: "POST", body: fd })
        const data = await res.json()
        if (res.ok) setAttachments((a) => [...a, { id: data.id, file_name: data.file_name, file_size: data.file_size }])
        else toast.error(data.error || "Upload failed")
      } catch { toast.error("Upload failed") }
    }
    setUploading(false)
    if (fileRef.current) fileRef.current.value = ""
  }

  const removeAttachment = async (id: number) => {
    setAttachments((a) => a.filter((x) => x.id !== id))
    await fetch(`/api/knowledge-base/attachments?id=${id}`, { method: "DELETE" }).catch(() => {})
  }

  const buildPayload = (action?: string) => ({
    id: editing?.article.id,
    expected_version: editing?.article.version,
    action,
    heading: form.heading,
    summary: form.summary,
    content: form.content,
    content_type: form.content_type,
    to_type: form.to_type,
    category_id: form.category_id ? Number(form.category_id) : undefined,
    new_category: form.new_category || undefined,
    subcategory: form.subcategory || undefined,
    tags: form.tags,
    audience_type: form.audience_type,
    audience_config: audienceConfig,
    department: form.audience_type === "department" ? form.departments[0] ?? null : null,
    owner_name: form.owner_name || undefined,
    publish_date: form.publish_date || null,
    effective_date: form.effective_date || null,
    review_date: form.review_date || null,
    expiry_date: form.expiry_date || null,
    acknowledgement_required: form.acknowledgement_required,
    notify_in_app: form.notify_in_app,
    notify_email: form.notify_email,
    pinned: form.pinned,
    keep_pinned_after_expiry: form.keep_pinned_after_expiry,
    important: form.important,
    related_ids: form.related_ids,
    erp_links: erpLinks.filter((e) => e.source_module && e.source_record_id),
    draft_key: draftKey,
    change_summary: form.change_summary || undefined,
  })

  const submit = async (action?: string) => {
    if (!form.heading.trim()) return toast.error("Title is required")
    setSaving(true)
    try {
      const res = await fetch("/api/knowledge-base", {
        method: isEditing ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildPayload(action)),
      })
      const data = await res.json()
      if (!res.ok) { toast.error(data.error || "Save failed"); setSaving(false); return }
      toast.success(
        isEditing ? "Article updated"
          : action === "publish" ? "Article published"
          : action === "submit" ? "Submitted for review"
          : "Draft saved",
      )
      onSaved()
      onOpenChange(false)
    } catch {
      toast.error("Save failed")
    }
    setSaving(false)
  }

  const chip = (label: string, onRemove: () => void) => (
    <Badge key={label} variant="secondary" className="gap-1 font-normal">
      {label}
      <button type="button" onClick={onRemove} aria-label={`Remove ${label}`}><X className="size-3" /></button>
    </Badge>
  )

  const multiSelect = (
    placeholder: string,
    options: { value: string; label: string }[],
    selected: string[],
    onToggle: (v: string) => void,
  ) => (
    <div className="grid gap-2">
      <Select value="" onValueChange={onToggle}>
        <SelectTrigger><SelectValue placeholder={placeholder} /></SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {selected.includes(o.value) ? "✓ " : ""}{o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {selected.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {selected.map((v) => chip(options.find((o) => o.value === v)?.label || v, () => onToggle(v)))}
        </div>
      )}
    </div>
  )

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-2xl">
        <SheetHeader className="border-b px-5 py-4">
          <SheetTitle>{isEditing ? "Edit Article" : "New Article"}</SheetTitle>
          <SheetDescription>
            {isEditing ? `Editing ${editing?.article.article_code || editing?.article.heading}` : "Create knowledge base content for your team."}
          </SheetDescription>
        </SheetHeader>

        <Tabs defaultValue="content" className="flex min-h-0 flex-1 flex-col">
          <TabsList className="mx-5 mt-3 w-fit">
            <TabsTrigger value="content">Content</TabsTrigger>
            <TabsTrigger value="audience">Audience</TabsTrigger>
            <TabsTrigger value="options">Options</TabsTrigger>
            <TabsTrigger value="files">Files & Links</TabsTrigger>
          </TabsList>

          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
            {/* ---- Content ---- */}
            <TabsContent value="content" className="mt-0 grid gap-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="grid gap-1.5 text-sm font-medium">
                  Content Type
                  <Select value={form.content_type} onValueChange={(v) => set({ content_type: v as ContentType })}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {CONTENT_TYPES.map((t) => <SelectItem key={t} value={t}>{CONTENT_TYPE_META[t].label}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </label>
                <div className="grid gap-1.5 text-sm font-medium">
                  Audience Channel
                  <div className="flex h-8 items-center gap-5 text-sm font-normal">
                    <label className="flex items-center gap-2">
                      <input type="radio" checked={form.to_type === "employees"} onChange={() => set({ to_type: "employees" })} /> Employees
                    </label>
                    <label className="flex items-center gap-2">
                      <input type="radio" checked={form.to_type === "clients"} onChange={() => set({ to_type: "clients" })} /> Clients
                    </label>
                  </div>
                </div>
              </div>

              <label className="grid gap-1.5 text-sm font-medium">
                Title
                <Input value={form.heading} maxLength={200} onChange={(e) => set({ heading: e.target.value })} placeholder="Enter a clear, descriptive title" />
              </label>

              <label className="grid gap-1.5 text-sm font-medium">
                Summary <span className="font-normal text-muted-foreground">(optional — auto-generated if blank)</span>
                <Textarea rows={2} value={form.summary} onChange={(e) => set({ summary: e.target.value })} placeholder="A short one-line summary shown in listings" />
              </label>

              <div className="grid gap-1.5 text-sm font-medium">
                Content
                <RichTextEditor value={form.content} onChange={(html) => set({ content: html })} />
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <label className="grid gap-1.5 text-sm font-medium">
                  Category
                  <Select value={form.category_id || "none"} onValueChange={(v) => set({ category_id: v === "none" ? "" : v, new_category: "" })}>
                    <SelectTrigger><SelectValue placeholder="Uncategorized" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">Uncategorized</SelectItem>
                      {(meta?.categories || []).map((c) => <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </label>
                <label className="grid gap-1.5 text-sm font-medium">
                  Or new category
                  <Input value={form.new_category} onChange={(e) => set({ new_category: e.target.value, category_id: "" })} placeholder="Create category" />
                </label>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <label className="grid gap-1.5 text-sm font-medium">
                  Subcategory <span className="font-normal text-muted-foreground">(optional)</span>
                  <Input value={form.subcategory} onChange={(e) => set({ subcategory: e.target.value })} placeholder="e.g. Onboarding" />
                </label>
                <label className="grid gap-1.5 text-sm font-medium">
                  Tags <span className="font-normal text-muted-foreground">(comma separated)</span>
                  <Input value={form.tags} onChange={(e) => set({ tags: e.target.value })} placeholder="leave, payroll, compliance" />
                </label>
              </div>
            </TabsContent>

            {/* ---- Audience ---- */}
            <TabsContent value="audience" className="mt-0 grid gap-4">
              {form.to_type === "clients" ? (
                <p className="rounded-lg border bg-muted/30 p-4 text-sm text-muted-foreground">
                  This content is published to the client portal. Employee audience targeting does not apply.
                </p>
              ) : (
                <>
                  <label className="grid gap-1.5 text-sm font-medium">
                    Audience
                    <Select value={form.audience_type} onValueChange={(v) => set({ audience_type: v as AudienceType })}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {AUDIENCE_TYPES.map((t) => <SelectItem key={t} value={t}>{AUDIENCE_LABELS[t]}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </label>

                  {form.audience_type === "department" && multiSelect(
                    "Select departments",
                    (meta?.departments || []).map((d) => ({ value: d, label: d })),
                    form.departments,
                    (v) => set({ departments: toggleInArray(form.departments, v) }),
                  )}
                  {form.audience_type === "designation" && multiSelect(
                    "Select designations",
                    (meta?.designations || []).map((d) => ({ value: d, label: d })),
                    form.designations,
                    (v) => set({ designations: toggleInArray(form.designations, v) }),
                  )}
                  {form.audience_type === "employees" && multiSelect(
                    "Select employees",
                    (meta?.employees || []).map((e) => ({ value: String(e.id), label: `${e.name}${e.department ? ` · ${e.department}` : ""}` })),
                    form.employeeIds.map(String),
                    (v) => set({ employeeIds: toggleInArray(form.employeeIds, Number(v)) }),
                  )}

                  <div className="flex items-center gap-2 rounded-lg border bg-muted/30 p-3 text-sm">
                    <Users className="size-4 text-muted-foreground" />
                    {preview
                      ? <span><span className="font-semibold text-foreground">{preview.count}</span> recipient{preview.count === 1 ? "" : "s"}{preview.sample.length ? ` — ${preview.sample.slice(0, 3).join(", ")}${preview.count > 3 ? "…" : ""}` : ""}</span>
                      : <span className="text-muted-foreground">Calculating audience…</span>}
                  </div>

                  <label className="flex items-center gap-2.5 text-sm">
                    <Checkbox checked={form.acknowledgement_required} onCheckedChange={(v) => set({ acknowledgement_required: !!v })} />
                    Require acknowledgement (employees must confirm they have read this)
                  </label>
                </>
              )}
            </TabsContent>

            {/* ---- Options ---- */}
            <TabsContent value="options" className="mt-0 grid gap-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="grid gap-1.5 text-sm font-medium">
                  Owner <span className="font-normal text-muted-foreground">(optional)</span>
                  <Input value={form.owner_name} onChange={(e) => set({ owner_name: e.target.value })} placeholder="Content owner" />
                </label>
                <label className="grid gap-1.5 text-sm font-medium">
                  Publish date <span className="font-normal text-muted-foreground">(schedule)</span>
                  <Input type="datetime-local" value={form.publish_date} onChange={(e) => set({ publish_date: e.target.value })} />
                </label>
                <label className="grid gap-1.5 text-sm font-medium">
                  Effective date
                  <Input type="date" value={form.effective_date} onChange={(e) => set({ effective_date: e.target.value })} />
                </label>
                <label className="grid gap-1.5 text-sm font-medium">
                  Review date
                  <Input type="date" value={form.review_date} onChange={(e) => set({ review_date: e.target.value })} />
                </label>
                <label className="grid gap-1.5 text-sm font-medium">
                  Expiry date
                  <Input type="date" value={form.expiry_date} onChange={(e) => set({ expiry_date: e.target.value })} />
                </label>
              </div>

              <Separator />

              <div className="grid gap-3">
                <span className="text-sm font-medium">Flags & notifications</span>
                <label className="flex items-center gap-2.5 text-sm">
                  <Checkbox checked={form.pinned} onCheckedChange={(v) => set({ pinned: !!v })} /> Pin to top
                </label>
                {form.pinned && (
                  <label className="ml-6 flex items-center gap-2.5 text-sm text-muted-foreground">
                    <Checkbox checked={form.keep_pinned_after_expiry} onCheckedChange={(v) => set({ keep_pinned_after_expiry: !!v })} /> Keep pinned after expiry
                  </label>
                )}
                <label className="flex items-center gap-2.5 text-sm">
                  <Checkbox checked={form.important} onCheckedChange={(v) => set({ important: !!v })} /> Mark as important
                </label>
                <label className="flex items-center gap-2.5 text-sm">
                  <Checkbox checked={form.notify_in_app} onCheckedChange={(v) => set({ notify_in_app: !!v })} /> Send in-app notification on publish
                </label>
                <label className="flex items-center gap-2.5 text-sm">
                  <Checkbox checked={form.notify_email} onCheckedChange={(v) => set({ notify_email: !!v })} /> Send email notification on publish
                </label>
              </div>

              {isEditing && (
                <>
                  <Separator />
                  <label className="grid gap-1.5 text-sm font-medium">
                    Change summary <span className="font-normal text-muted-foreground">(recorded in version history)</span>
                    <Input value={form.change_summary} onChange={(e) => set({ change_summary: e.target.value })} placeholder="What changed in this revision?" />
                  </label>
                </>
              )}
            </TabsContent>

            {/* ---- Files & links ---- */}
            <TabsContent value="files" className="mt-0 grid gap-5">
              <div className="grid gap-2">
                <span className="text-sm font-medium">Attachments</span>
                <input ref={fileRef} type="file" multiple hidden onChange={(e) => uploadFiles(e.target.files)} />
                <button
                  type="button"
                  onClick={() => fileRef.current?.click()}
                  className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed py-8 text-sm text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground"
                >
                  {uploading ? <Loader2 className="size-5 animate-spin" /> : <Upload className="size-5" />}
                  {uploading ? "Uploading…" : "Click to upload files (max 20 MB each)"}
                </button>
                {attachments.length > 0 && (
                  <ul className="grid gap-1.5">
                    {attachments.map((a) => (
                      <li key={a.id} className="flex items-center gap-2 rounded-md border bg-card px-3 py-2 text-sm">
                        <Paperclip className="size-3.5 text-muted-foreground" />
                        <span className="flex-1 truncate">{a.file_name}</span>
                        <span className="text-xs text-muted-foreground">{formatBytes(a.file_size)}</span>
                        <button type="button" onClick={() => removeAttachment(a.id)} aria-label="Remove attachment">
                          <Trash2 className="size-3.5 text-muted-foreground hover:text-destructive" />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <Separator />

              <div className="grid gap-2">
                <span className="text-sm font-medium">Related articles</span>
                {multiSelect(
                  "Link related articles",
                  (meta?.articles || []).filter((a) => a.id !== editing?.article.id).map((a) => ({ value: String(a.id), label: a.heading })),
                  form.related_ids.map(String),
                  (v) => set({ related_ids: toggleInArray(form.related_ids, Number(v)) }),
                )}
              </div>

              <Separator />

              <div className="grid gap-2">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">ERP record links</span>
                  <Button type="button" variant="outline" size="sm" onClick={() => setErpLinks((l) => [...l, { source_module: "", source_record_id: "", label: "" }])}>
                    <Plus className="size-3.5" /> Add link
                  </Button>
                </div>
                {erpLinks.map((link, i) => (
                  <div key={i} className="grid gap-2 rounded-md border bg-card p-2.5 sm:grid-cols-[1fr_1fr_1fr_auto]">
                    <Input placeholder="Module (e.g. hr)" value={link.source_module} onChange={(e) => setErpLinks((l) => l.map((x, j) => j === i ? { ...x, source_module: e.target.value } : x))} />
                    <Input placeholder="Record ID" value={link.source_record_id} onChange={(e) => setErpLinks((l) => l.map((x, j) => j === i ? { ...x, source_record_id: e.target.value } : x))} />
                    <Input placeholder="Label" value={link.label} onChange={(e) => setErpLinks((l) => l.map((x, j) => j === i ? { ...x, label: e.target.value } : x))} />
                    <Button type="button" variant="ghost" size="icon" onClick={() => setErpLinks((l) => l.filter((_, j) => j !== i))} aria-label="Remove link">
                      <X className="size-4" />
                    </Button>
                  </div>
                ))}
                {erpLinks.length === 0 && (
                  <p className="flex items-center gap-2 text-xs text-muted-foreground"><Link2 className="size-3.5" /> Link this article to ERP records for cross-referencing.</p>
                )}
              </div>
            </TabsContent>
          </div>
        </Tabs>

        <div className="flex items-center justify-end gap-2 border-t bg-card px-5 py-3.5">
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>Cancel</Button>
          {isEditing ? (
            <Button onClick={() => submit()} disabled={saving}>
              {saving ? <Loader2 className="size-4 animate-spin" /> : <FileText className="size-4" />} Save changes
            </Button>
          ) : (
            <>
              <Button variant="outline" onClick={() => submit("draft")} disabled={saving}>Save draft</Button>
              <Button variant="outline" onClick={() => submit("submit")} disabled={saving}>Submit for review</Button>
              <Button onClick={() => submit("publish")} disabled={saving}>
                {saving ? <Loader2 className="size-4 animate-spin" /> : null} Publish
              </Button>
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}
