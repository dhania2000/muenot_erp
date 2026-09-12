"use client"
import { useEffect, useMemo, useRef, useState } from "react"
import useSWR from "swr"
import { fetcher } from "@/lib/fetcher"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { FileText, Plus, Pencil, Trash2, History, MoreHorizontal, Search, ShieldCheck, ShieldAlert, CheckCircle2, AlertTriangle } from "lucide-react"
import {
  LETTER_TYPES,
  LETTER_CATEGORIES,
  LETTER_AUDIENCES,
  LETTER_TEMPLATE_STATUSES,
  LETTER_EVENTS,
  LETTER_TEMPLATE_TRANSITIONS,
  eventByKey,
  variablesForEvent,
  type LetterTemplate,
} from "@/lib/hr-letters-shared"
import { TemplateStatusBadge } from "@/components/hr/letter-status-badge"
import { ExcelExportButton } from "@/components/excel-export-button"

type Employee = { id: number; employee_id: string; employee_name: string }

const emptyForm = {
  name: "",
  description: "",
  letter_type: "Offer Letter",
  category: "Onboarding",
  audience: "Employee",
  event_key: "manual",
  subject: "",
  body: "",
  status: "Draft",
}
type FormState = typeof emptyForm

export function LetterTemplatesClient() {
  const [statusFilter, setStatusFilter] = useState("")
  const [q, setQ] = useState("")
  const listKey = `/api/hr/letter-templates${statusFilter ? `?status=${statusFilter}` : ""}`
  const { data, mutate } = useSWR<{ templates: LetterTemplate[] }>(listKey, fetcher)

  const [editorOpen, setEditorOpen] = useState(false)
  const [editing, setEditing] = useState<LetterTemplate | null>(null)
  const [versionsFor, setVersionsFor] = useState<LetterTemplate | null>(null)

  const templates = useMemo(() => {
    const rows = data?.templates || []
    if (!q.trim()) return rows
    const needle = q.toLowerCase()
    return rows.filter((t) =>
      `${t.template_uid} ${t.name} ${t.letter_type} ${t.category} ${t.subject}`.toLowerCase().includes(needle),
    )
  }, [data, q])

  function openNew() {
    setEditing(null)
    setEditorOpen(true)
  }
  function openEdit(t: LetterTemplate) {
    setEditing(t)
    setEditorOpen(true)
  }

  async function transition(t: LetterTemplate, to: string) {
    const res = await fetch(`/api/hr/letter-templates/${t.id}/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: to }),
    })
    if (res.ok) mutate()
    else alert((await res.json().catch(() => ({}))).error || "Could not change status")
  }
  async function remove(t: LetterTemplate) {
    if (!confirm(`Delete template "${t.name}"? This cannot be undone.`)) return
    await fetch(`/api/hr/letter-templates/${t.id}`, { method: "DELETE" })
    mutate()
  }

  return (
    <div className="flex flex-col gap-6 p-6 md:p-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-3">
            <FileText className="size-7 text-primary" />
            <h1 className="text-2xl font-semibold">Letter Templates</h1>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            Reusable formal-document definitions with placeholders that auto-fill from employee, company and event data.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <ImportExport onChanged={mutate} templates={data?.templates || []} />
          <Button onClick={openNew}>
            <Plus data-icon="inline-start" />
            New template
          </Button>
        </div>
      </div>

      <Tabs defaultValue="templates">
        <TabsList>
          <TabsTrigger value="templates">Templates</TabsTrigger>
          <TabsTrigger value="health">Health check</TabsTrigger>
        </TabsList>

        <TabsContent value="templates" className="mt-4 flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-3">
            <div className="relative max-w-xs flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search templates…" className="pl-9" />
            </div>
            <Select value={statusFilter || "all"} onValueChange={(v) => setStatusFilter(v === "all" ? "" : v)}>
              <SelectTrigger className="w-40">
                <SelectValue placeholder="All statuses" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                {LETTER_TEMPLATE_STATUSES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {s}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="overflow-x-auto rounded-lg border bg-card">
            <table className="w-full min-w-[860px] text-sm">
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  {["ID", "Name", "Type", "Category", "Event", "Status", "Usage", ""].map((x) => (
                    <th key={x} className="px-4 py-3 font-medium">
                      {x}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {templates.map((t) => (
                  <tr key={t.id} className="border-b last:border-0 hover:bg-muted/40">
                    <td className="px-4 py-3 font-mono text-xs text-muted-foreground">{t.template_uid}</td>
                    <td className="px-4 py-3">
                      <button className="font-medium hover:underline" onClick={() => openEdit(t)}>
                        {t.name}
                      </button>
                      <div className="text-xs text-muted-foreground">{t.subject}</div>
                    </td>
                    <td className="px-4 py-3">{t.letter_type}</td>
                    <td className="px-4 py-3 text-muted-foreground">{t.category}</td>
                    <td className="px-4 py-3 text-muted-foreground">{eventByKey(t.event_key).label}</td>
                    <td className="px-4 py-3">
                      <TemplateStatusBadge status={t.status} />
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">{t.usage_count}</td>
                    <td className="px-4 py-3">
                      <div className="flex justify-end gap-2">
                        <Button variant="outline" size="sm" onClick={() => openEdit(t)} aria-label="Edit template">
                          <Pencil className="size-4" />
                        </Button>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="outline" size="sm" aria-label="More actions">
                              <MoreHorizontal className="size-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            {(LETTER_TEMPLATE_TRANSITIONS[t.status as keyof typeof LETTER_TEMPLATE_TRANSITIONS] || []).map(
                              (to) => (
                                <DropdownMenuItem key={to} onClick={() => transition(t, to)}>
                                  Move to {to}
                                </DropdownMenuItem>
                              ),
                            )}
                            <DropdownMenuItem onClick={() => setVersionsFor(t)}>
                              <History className="size-4" data-icon="inline-start" />
                              Version history
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              className="text-destructive focus:text-destructive"
                              onClick={() => remove(t)}
                            >
                              <Trash2 className="size-4" data-icon="inline-start" />
                              Delete
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    </td>
                  </tr>
                ))}
                {data && templates.length === 0 && (
                  <tr>
                    <td colSpan={8} className="px-4 py-10 text-center text-muted-foreground">
                      No templates found. Create your first one.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </TabsContent>

        <TabsContent value="health" className="mt-4">
          <HealthCheck />
        </TabsContent>
      </Tabs>

      {editorOpen && (
        <TemplateEditorDialog
          open={editorOpen}
          template={editing}
          onClose={() => setEditorOpen(false)}
          onSaved={() => {
            setEditorOpen(false)
            mutate()
          }}
        />
      )}
      {versionsFor && <VersionsDialog template={versionsFor} onClose={() => setVersionsFor(null)} />}
    </div>
  )
}

// --- Editor with live preview ----------------------------------------------
function TemplateEditorDialog({
  open,
  template,
  onClose,
  onSaved,
}: {
  open: boolean
  template: LetterTemplate | null
  onClose: () => void
  onSaved: () => void
}) {
  const [form, setForm] = useState<FormState>(
    template
      ? {
          name: template.name,
          description: template.description || "",
          letter_type: template.letter_type,
          category: template.category,
          audience: template.audience,
          event_key: template.event_key,
          subject: template.subject,
          body: template.body,
          status: template.status,
        }
      : emptyForm,
  )
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")
  const [preview, setPreview] = useState<{ subject: string; body: string } | null>(null)
  const [validation, setValidation] = useState<{ unknownVariables: string[]; unbalancedBlocks: string[]; errors: string[] } | null>(null)
  const [sampleEmployee, setSampleEmployee] = useState("")
  const bodyRef = useRef<HTMLTextAreaElement>(null)

  const { data: empData } = useSWR<{ employees: Employee[] }>("/api/hr/employees", fetcher)
  const variables = useMemo(() => variablesForEvent(form.event_key), [form.event_key])
  const groups = useMemo(() => {
    const map = new Map<string, typeof variables>()
    for (const v of variables) {
      if (!map.has(v.group)) map.set(v.group, [])
      map.get(v.group)!.push(v)
    }
    return Array.from(map.entries())
  }, [variables])

  // Debounced server render + validation (same engine as generation).
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (!form.subject && !form.body) {
      setPreview(null)
      setValidation(null)
      return
    }
    if (debounce.current) clearTimeout(debounce.current)
    debounce.current = setTimeout(async () => {
      const res = await fetch("/api/hr/letter-templates/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          subject: form.subject,
          body: form.body,
          event_key: form.event_key,
          employeeId: sampleEmployee || null,
        }),
      })
      if (res.ok) {
        const d = await res.json()
        setPreview({ subject: d.subject, body: d.body })
        setValidation(d.validation)
      }
    }, 350)
    return () => {
      if (debounce.current) clearTimeout(debounce.current)
    }
  }, [form.subject, form.body, form.event_key, sampleEmployee])

  function insertToken(token: string) {
    const el = bodyRef.current
    const wrapped = `{{${token}}}`
    if (!el) {
      setForm((f) => ({ ...f, body: `${f.body}${wrapped}` }))
      return
    }
    const start = el.selectionStart ?? el.value.length
    const end = el.selectionEnd ?? el.value.length
    const next = form.body.slice(0, start) + wrapped + form.body.slice(end)
    setForm((f) => ({ ...f, body: next }))
    requestAnimationFrame(() => {
      el.focus()
      const pos = start + wrapped.length
      el.setSelectionRange(pos, pos)
    })
  }

  async function save(e: React.FormEvent) {
    e.preventDefault()
    setError("")
    setSaving(true)
    const res = await fetch(template ? `/api/hr/letter-templates/${template.id}` : "/api/hr/letter-templates", {
      method: template ? "PUT" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(form),
    })
    setSaving(false)
    if (res.ok) onSaved()
    else setError((await res.json().catch(() => ({}))).error || "Failed to save template")
  }

  const evt = eventByKey(form.event_key)

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[92vh] w-[calc(100vw-2rem)] overflow-y-auto sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle>{template ? `Edit ${template.template_uid}` : "New letter template"}</DialogTitle>
          <DialogDescription>
            Compose the document, drop in variables, and preview the merged result live before activating.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={save} className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,0.9fr)]">
          {/* Left: editor */}
          <div className="flex flex-col gap-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="grid gap-2">
                <Label>Template name</Label>
                <Input
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="Standard Offer Letter"
                  required
                />
              </div>
              <div className="grid gap-2">
                <Label>Status</Label>
                <Select value={form.status} onValueChange={(v) => setForm({ ...form, status: v })}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {LETTER_TEMPLATE_STATUSES.map((s) => (
                      <SelectItem key={s} value={s}>
                        {s}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-3">
              <div className="grid gap-2">
                <Label>Letter type</Label>
                <Select value={form.letter_type} onValueChange={(v) => setForm({ ...form, letter_type: v })}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {LETTER_TYPES.map((x) => (
                      <SelectItem key={x} value={x}>
                        {x}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-2">
                <Label>Category</Label>
                <Select value={form.category} onValueChange={(v) => setForm({ ...form, category: v })}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {LETTER_CATEGORIES.map((x) => (
                      <SelectItem key={x} value={x}>
                        {x}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-2">
                <Label>Audience</Label>
                <Select value={form.audience} onValueChange={(v) => setForm({ ...form, audience: v })}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {LETTER_AUDIENCES.map((x) => (
                      <SelectItem key={x} value={x}>
                        {x}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="grid gap-2">
              <Label>Event / source mapping</Label>
              <Select value={form.event_key} onValueChange={(v) => setForm({ ...form, event_key: v })}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {LETTER_EVENTS.map((e) => (
                    <SelectItem key={e.key} value={e.key}>
                      {e.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">{evt.description}</p>
            </div>

            <div className="grid gap-2">
              <Label>Description</Label>
              <Input
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
                placeholder="When and for whom this template is used"
              />
            </div>

            <div className="grid gap-2">
              <Label>Subject / document title</Label>
              <Input
                value={form.subject}
                onChange={(e) => setForm({ ...form, subject: e.target.value })}
                placeholder="Offer of Employment — {{employee_name}}"
                required
              />
            </div>

            <div className="grid gap-2">
              <Label>Body</Label>
              <textarea
                ref={bodyRef}
                value={form.body}
                onChange={(e) => setForm({ ...form, body: e.target.value })}
                rows={14}
                className="flex w-full rounded-lg border border-input bg-transparent px-2.5 py-2 font-mono text-[13px] leading-relaxed outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
                placeholder={"Dear {{employee_name}},\n\nWe are pleased to…\n\n{{#if work_location}}You will be based at {{work_location}}.{{/if}}"}
                required
              />
              <p className="text-xs text-muted-foreground">
                Supports {"{{variable}}"}, {"{{#if variable}}…{{/if}}"} and {"{{#each list}}…{{/each}}"} blocks.
              </p>
            </div>

            <div className="rounded-lg border bg-muted/30 p-3">
              <div className="mb-2 text-xs font-medium text-muted-foreground">Insert variable</div>
              <div className="flex max-h-40 flex-col gap-2 overflow-y-auto">
                {groups.map(([group, vars]) => (
                  <div key={group} className="flex flex-wrap items-center gap-1.5">
                    <span className="w-full text-[11px] uppercase tracking-wide text-muted-foreground/70">{group}</span>
                    {vars.map((v) => (
                      <button
                        type="button"
                        key={v.token}
                        onClick={() => insertToken(v.token)}
                        className="rounded border bg-background px-2 py-1 text-xs hover:bg-accent hover:text-accent-foreground"
                        title={v.token}
                      >
                        {v.label}
                      </button>
                    ))}
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Right: live preview */}
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-medium text-muted-foreground">Live preview</span>
              <Select value={sampleEmployee || "sample"} onValueChange={(v) => setSampleEmployee(v === "sample" ? "" : v)}>
                <SelectTrigger className="h-8 w-48 text-xs">
                  <SelectValue placeholder="Sample data" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="sample">Sample data</SelectItem>
                  {(empData?.employees || []).map((e) => (
                    <SelectItem key={e.id} value={String(e.id)}>
                      {e.employee_id} · {e.employee_name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {validation && (validation.unknownVariables.length > 0 || validation.unbalancedBlocks.length > 0) && (
              <div className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-2.5 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                <div className="flex flex-col gap-0.5">
                  {validation.unknownVariables.length > 0 && (
                    <span>Unknown variables: {validation.unknownVariables.join(", ")}</span>
                  )}
                  {validation.unbalancedBlocks.length > 0 && (
                    <span>Unbalanced blocks: {validation.unbalancedBlocks.join(", ")}</span>
                  )}
                </div>
              </div>
            )}

            <div className="min-h-[520px] rounded-lg border bg-muted/30 p-4">
              <div className="mx-auto max-w-[560px] rounded-md bg-background p-8 shadow-sm ring-1 ring-border">
                {preview?.subject ? (
                  <h2 className="mb-4 font-serif text-lg font-semibold text-foreground text-pretty">{preview.subject}</h2>
                ) : null}
                {preview?.body ? (
                  <div className="whitespace-pre-wrap font-serif text-sm leading-relaxed text-foreground">
                    {preview.body}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">Start typing to see the merged letter here.</p>
                )}
              </div>
            </div>
          </div>

          {error && <p className="lg:col-span-2 text-sm text-destructive">{error}</p>}

          <DialogFooter className="lg:col-span-2">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? "Saving…" : template ? "Save changes" : "Create template"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

// --- Version history --------------------------------------------------------
function VersionsDialog({ template, onClose }: { template: LetterTemplate; onClose: () => void }) {
  const { data } = useSWR<{ versions: any[] }>(`/api/hr/letter-templates/${template.id}/versions`, fetcher)
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
        <DialogContent className="w-[calc(100vw-2rem)] sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Version history — {template.name}</DialogTitle>
          <DialogDescription>Every content change and status move is snapshotted here.</DialogDescription>
        </DialogHeader>
        <div className="max-h-[60vh] overflow-y-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-muted-foreground">
                {["Version", "Change", "Status", "By", "When"].map((x) => (
                  <th key={x} className="px-4 py-2.5 font-medium">
                    {x}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(data?.versions || []).map((v) => (
                <tr key={v.id} className="border-b last:border-0">
                  <td className="px-4 py-2.5 font-mono text-xs">v{v.version}</td>
                  <td className="px-4 py-2.5">{v.change_note || "—"}</td>
                  <td className="px-4 py-2.5">
                    <TemplateStatusBadge status={v.status} />
                  </td>
                  <td className="px-4 py-2.5 text-muted-foreground">{v.changed_by_name || "—"}</td>
                  <td className="px-4 py-2.5 text-muted-foreground">
                    {v.created_at ? new Date(v.created_at).toLocaleString() : "—"}
                  </td>
                </tr>
              ))}
              {data && data.versions.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center text-muted-foreground">
                    No versions recorded yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// --- Health check tab -------------------------------------------------------
function HealthCheck() {
  const { data } = useSWR<{ summary: any; templates: any[] }>("/api/hr/letters/health", fetcher)
  if (!data) return <p className="text-sm text-muted-foreground">Checking templates…</p>
  const s = data.summary
  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-3 sm:grid-cols-4">
        <SummaryCard label="Checked" value={s.total} icon={<FileText className="size-4" />} />
        <SummaryCard label="Active" value={s.active} icon={<ShieldCheck className="size-4" />} />
        <SummaryCard label="Healthy" value={s.healthy} tone="green" icon={<CheckCircle2 className="size-4" />} />
        <SummaryCard label="With issues" value={s.withIssues} tone={s.withIssues ? "amber" : "slate"} icon={<ShieldAlert className="size-4" />} />
      </div>
      <div className="overflow-x-auto rounded-lg border bg-card">
        <table className="w-full min-w-[720px] text-sm">
          <thead>
            <tr className="border-b text-left text-muted-foreground">
              {["Template", "Status", "Health", "Issues"].map((x) => (
                <th key={x} className="px-4 py-3 font-medium">
                  {x}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.templates.map((t) => (
              <tr key={t.id} className="border-b last:border-0">
                <td className="px-4 py-3">
                  <div className="font-medium">{t.name}</div>
                  <div className="font-mono text-xs text-muted-foreground">{t.uid}</div>
                </td>
                <td className="px-4 py-3">
                  <TemplateStatusBadge status={t.status} />
                </td>
                <td className="px-4 py-3">
                  {t.healthy ? (
                    <span className="inline-flex items-center gap-1.5 text-emerald-600">
                      <CheckCircle2 className="size-4" /> Healthy
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1.5 text-amber-600">
                      <AlertTriangle className="size-4" /> Needs attention
                    </span>
                  )}
                </td>
                <td className="px-4 py-3 text-muted-foreground">
                  {t.issues.length ? t.issues.join("; ") : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function SummaryCard({
  label,
  value,
  icon,
  tone = "slate",
}: {
  label: string
  value: number
  icon: React.ReactNode
  tone?: "green" | "amber" | "slate"
}) {
  const toneClass =
    tone === "green" ? "text-emerald-600" : tone === "amber" ? "text-amber-600" : "text-muted-foreground"
  return (
    <div className="flex items-center justify-between rounded-lg border bg-card p-4">
      <div>
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className="text-2xl font-semibold">{value}</div>
      </div>
      <div className={toneClass}>{icon}</div>
    </div>
  )
}

// --- Import / export --------------------------------------------------------
function ImportExport({ onChanged, templates }: { onChanged: () => void; templates: LetterTemplate[] }) {
  const fileRef = useRef<HTMLInputElement>(null)
  async function onImport(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    try {
      const payload = JSON.parse(await file.text())
      const res = await fetch("/api/hr/letter-templates/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })
      const result = await res.json().catch(() => ({}))
      if (res.ok) {
        alert(`Imported — created ${result.created}, updated ${result.updated}, skipped ${result.skipped}`)
        onChanged()
      } else {
        alert(result.error || "Import failed")
      }
    } catch {
      alert("Could not read that file — expected a template JSON bundle.")
    } finally {
      if (fileRef.current) fileRef.current.value = ""
    }
  }
  return (
    <>
      <input ref={fileRef} type="file" accept="application/json" className="hidden" onChange={onImport} />
      <Button variant="outline" onClick={() => fileRef.current?.click()}>
        Import
      </Button>
      <ExcelExportButton
        rows={templates}
        filename="letter-templates"
        columns={[
          { header: "ID", value: (r: any) => r.template_uid },
          { header: "Name", value: (r: any) => r.name },
          { header: "Type", value: (r: any) => r.letter_type },
          { header: "Category", value: (r: any) => r.category },
          { header: "Audience", value: (r: any) => r.audience },
          { header: "Event", value: (r: any) => r.event_key },
          { header: "Status", value: (r: any) => r.status },
          { header: "Subject", value: (r: any) => r.subject },
        ]}
      />
    </>
  )
}
