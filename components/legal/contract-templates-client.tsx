"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import useSWR from "swr"
import { fetcher } from "@/lib/fetcher"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  FileText,
  Plus,
  Pencil,
  Trash2,
  History,
  MoreHorizontal,
  Search,
  CheckCircle2,
  AlertTriangle,
  ArrowRight,
} from "lucide-react"
import {
  CONTRACT_TYPES,
  CONTRACT_CATEGORIES,
  CONTRACT_SOURCE_META,
  TEMPLATE_STATUSES,
  TEMPLATE_TRANSITIONS,
  variablesForSource,
  sourceMeta,
  type ContractTemplate,
  type ContractTemplateVersion,
} from "@/lib/legal-contracts-shared"
import { TemplateStatusBadge } from "@/components/legal/contract-status-badge"
import { ContractRichEditor, type RichEditorHandle } from "@/components/legal/contract-rich-editor"

const ALL = "__all__"

function sanitizeHtml(html: string): string {
  return html
    .replace(/<\s*(script|style)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, "")
    .replace(/\son\w+\s*=\s*"[^"]*"/gi, "")
    .replace(/\son\w+\s*=\s*'[^']*'/gi, "")
    .replace(/javascript:/gi, "")
}

function StatCard({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <div className="flex flex-col gap-1 rounded-lg border bg-card p-4">
      <span className="text-xs uppercase tracking-wide text-muted-foreground">{label}</span>
      <span className="text-2xl font-semibold tabular-nums text-foreground">{value}</span>
      {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
    </div>
  )
}

export function ContractTemplatesClient() {
  const [q, setQ] = useState("")
  const [statusFilter, setStatusFilter] = useState(ALL)
  const [sourceFilter, setSourceFilter] = useState(ALL)

  const listKey = useMemo(() => {
    const sp = new URLSearchParams()
    if (statusFilter !== ALL) sp.set("status", statusFilter)
    if (sourceFilter !== ALL) sp.set("source", sourceFilter)
    const s = sp.toString()
    return `/api/legal/contract-templates${s ? `?${s}` : ""}`
  }, [statusFilter, sourceFilter])

  const { data, mutate, isLoading } = useSWR<{ templates: ContractTemplate[] }>(listKey, fetcher)

  const [editorOpen, setEditorOpen] = useState(false)
  const [editing, setEditing] = useState<ContractTemplate | null>(null)
  const [versionsFor, setVersionsFor] = useState<ContractTemplate | null>(null)

  const templates = useMemo(() => {
    const rows = data?.templates || []
    if (!q.trim()) return rows
    const needle = q.toLowerCase()
    return rows.filter((t) =>
      `${t.template_uid ?? ""} ${t.name} ${t.contract_type} ${t.category} ${t.description ?? ""}`
        .toLowerCase()
        .includes(needle),
    )
  }, [data, q])

  const stats = useMemo(() => {
    const rows = data?.templates || []
    return {
      total: rows.length,
      published: rows.filter((t) => t.status === "Published").length,
      draft: rows.filter((t) => t.status === "Draft" || t.status === "In Review").length,
      usage: rows.reduce((n, t) => n + (t.usage_count || 0), 0),
    }
  }, [data])

  async function transition(t: ContractTemplate, to: string) {
    const res = await fetch(`/api/legal/contract-templates/${t.id}/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: to }),
    })
    if (res.ok) mutate()
    else alert((await res.json().catch(() => ({}))).error || "Could not change status")
  }

  async function remove(t: ContractTemplate) {
    if (!confirm(`Delete template "${t.name}"? This cannot be undone.`)) return
    await fetch(`/api/legal/contract-templates/${t.id}`, { method: "DELETE" })
    mutate()
  }

  return (
    <div className="flex flex-col gap-6 p-6 md:p-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-3">
            <FileText className="size-7 text-primary" />
            <h1 className="text-2xl font-semibold">Contract Templates</h1>
          </div>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Reusable agreement definitions with smart placeholders that auto-fill from employee, client, vendor,
            candidate, project and company data at generation time.
          </p>
        </div>
        <Button onClick={() => { setEditing(null); setEditorOpen(true) }}>
          <Plus data-icon="inline-start" />
          New template
        </Button>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Templates" value={stats.total} />
        <StatCard label="Published" value={stats.published} hint="Ready to generate from" />
        <StatCard label="In progress" value={stats.draft} hint="Draft / in review" />
        <StatCard label="Times used" value={stats.usage} />
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative max-w-xs flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search templates…" className="pl-9" />
        </div>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-40">
            <SelectValue placeholder="All statuses" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All statuses</SelectItem>
            {TEMPLATE_STATUSES.map((s) => (
              <SelectItem key={s} value={s}>{s}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={sourceFilter} onValueChange={setSourceFilter}>
          <SelectTrigger className="w-44">
            <SelectValue placeholder="All sources" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All sources</SelectItem>
            {CONTRACT_SOURCE_META.map((s) => (
              <SelectItem key={s.key} value={s.key}>{s.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="overflow-x-auto rounded-lg border bg-card">
        <table className="w-full min-w-[900px] text-sm">
          <thead>
            <tr className="border-b text-left text-muted-foreground">
              {["ID", "Name", "Type", "Category", "Source", "Status", "v", "Used", ""].map((x) => (
                <th key={x} className="px-4 py-3 font-medium">{x}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {templates.map((t) => (
              <tr key={t.id} className="border-b last:border-0 hover:bg-muted/40">
                <td className="px-4 py-3 font-mono text-xs text-muted-foreground">{t.template_uid || `#${t.id}`}</td>
                <td className="px-4 py-3">
                  <button className="text-left font-medium hover:underline" onClick={() => { setEditing(t); setEditorOpen(true) }}>
                    {t.name}
                  </button>
                  {t.description && <div className="max-w-xs truncate text-xs text-muted-foreground">{t.description}</div>}
                </td>
                <td className="px-4 py-3">{t.contract_type}</td>
                <td className="px-4 py-3 text-muted-foreground">{t.category}</td>
                <td className="px-4 py-3 text-muted-foreground">{sourceMeta(t.source).label.replace(/ \(.*\)/, "")}</td>
                <td className="px-4 py-3"><TemplateStatusBadge status={t.status} /></td>
                <td className="px-4 py-3 text-muted-foreground">{t.version}</td>
                <td className="px-4 py-3 text-muted-foreground">{t.usage_count}</td>
                <td className="px-4 py-3">
                  <div className="flex justify-end gap-2">
                    <Button variant="outline" size="sm" onClick={() => { setEditing(t); setEditorOpen(true) }} aria-label="Edit template">
                      <Pencil className="size-4" />
                    </Button>
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        render={
                          <Button variant="outline" size="sm" aria-label="More actions">
                            <MoreHorizontal className="size-4" />
                          </Button>
                        }
                      />
                      <DropdownMenuContent align="end">
                        {(TEMPLATE_TRANSITIONS[t.status as keyof typeof TEMPLATE_TRANSITIONS] || []).map((to) => (
                          <DropdownMenuItem key={to} onClick={() => transition(t, to)}>
                            <ArrowRight className="size-4" data-icon="inline-start" />
                            Move to {to}
                          </DropdownMenuItem>
                        ))}
                        <DropdownMenuItem onClick={() => setVersionsFor(t)}>
                          <History className="size-4" data-icon="inline-start" />
                          Version history
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem className="text-destructive" onClick={() => remove(t)}>
                          <Trash2 className="size-4" data-icon="inline-start" />
                          Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </td>
              </tr>
            ))}
            {!isLoading && templates.length === 0 && (
              <tr>
                <td colSpan={9} className="px-4 py-12 text-center text-muted-foreground">
                  No templates yet. Create your first contract template to start generating agreements.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {editorOpen && (
        <TemplateEditorDialog
          template={editing}
          onClose={() => setEditorOpen(false)}
          onSaved={() => { setEditorOpen(false); mutate() }}
        />
      )}
      {versionsFor && <VersionsDialog template={versionsFor} onClose={() => setVersionsFor(null)} />}
    </div>
  )
}

// --- Editor ----------------------------------------------------------------
type FormState = {
  name: string
  description: string
  contractType: string
  category: string
  source: string
  content: string
  status: string
  reviewDate: string
  expiryDate: string
  requiredVariables: string[]
}

function buildForm(t: ContractTemplate | null): FormState {
  return {
    name: t?.name ?? "",
    description: t?.description ?? "",
    contractType: t?.contract_type ?? CONTRACT_TYPES[0],
    category: t?.category ?? CONTRACT_CATEGORIES[0],
    source: t?.source ?? "manual",
    content: t?.content ?? "",
    status: t?.status ?? "Draft",
    reviewDate: t?.review_date?.slice(0, 10) ?? "",
    expiryDate: t?.expiry_date?.slice(0, 10) ?? "",
    requiredVariables: t?.required_variables ?? [],
  }
}

function TemplateEditorDialog({
  template,
  onClose,
  onSaved,
}: {
  template: ContractTemplate | null
  onClose: () => void
  onSaved: () => void
}) {
  const [form, setForm] = useState<FormState>(() => buildForm(template))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")
  const [changeNote, setChangeNote] = useState("")
  const [preview, setPreview] = useState<{ rendered: string; hasUnresolved: boolean } | null>(null)
  const [validation, setValidation] = useState<{ referenced: string[]; unknownVariables: string[]; unbalancedBlocks: string[]; errors: string[] } | null>(null)
  const editorRef = useRef<RichEditorHandle>(null)

  const variables = useMemo(() => variablesForSource(form.source), [form.source])
  const groups = useMemo(() => {
    const map = new Map<string, typeof variables>()
    for (const v of variables) {
      if (!map.has(v.group)) map.set(v.group, [])
      map.get(v.group)!.push(v)
    }
    return Array.from(map.entries())
  }, [variables])

  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (!form.content.trim()) {
      setPreview(null)
      setValidation(null)
      return
    }
    if (debounce.current) clearTimeout(debounce.current)
    debounce.current = setTimeout(async () => {
      const res = await fetch("/api/legal/contract-templates/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: form.content, source: form.source, title: form.name }),
      })
      if (res.ok) {
        const d = await res.json()
        setPreview({ rendered: d.rendered, hasUnresolved: d.hasUnresolved })
        setValidation(d.validation)
      }
    }, 400)
    return () => {
      if (debounce.current) clearTimeout(debounce.current)
    }
  }, [form.content, form.source, form.name])

  function toggleRequired(token: string) {
    setForm((f) => ({
      ...f,
      requiredVariables: f.requiredVariables.includes(token)
        ? f.requiredVariables.filter((t) => t !== token)
        : [...f.requiredVariables, token],
    }))
  }

  async function save(e: React.FormEvent) {
    e.preventDefault()
    setError("")
    if (!form.name.trim()) return setError("Template name is required")
    if (!form.content.trim()) return setError("Contract body is required")
    setSaving(true)
    const payload = {
      name: form.name,
      description: form.description,
      contractType: form.contractType,
      category: form.category,
      source: form.source,
      content: form.content,
      requiredVariables: form.requiredVariables,
      reviewDate: form.reviewDate || null,
      expiryDate: form.expiryDate || null,
      changeNote: changeNote || null,
    }
    const res = await fetch(template ? `/api/legal/contract-templates/${template.id}` : "/api/legal/contract-templates", {
      method: template ? "PATCH" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
    setSaving(false)
    if (res.ok) onSaved()
    else setError((await res.json().catch(() => ({}))).error || "Failed to save template")
  }

  const meta = sourceMeta(form.source)

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[94vh] w-[calc(100vw-1.5rem)] overflow-y-auto sm:max-w-6xl">
        <DialogHeader>
          <DialogTitle>{template ? `Edit ${template.template_uid || template.name}` : "New contract template"}</DialogTitle>
          <DialogDescription>
            Compose the agreement, drop in variables, and preview the merged result live before publishing.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={save} className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,0.85fr)]">
          <div className="flex flex-col gap-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="grid gap-2">
                <Label>Template name</Label>
                <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Master Service Agreement" required />
              </div>
              <div className="grid gap-2">
                <Label>Data source</Label>
                <Select value={form.source} onValueChange={(v) => setForm({ ...form, source: v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {CONTRACT_SOURCE_META.map((s) => (
                      <SelectItem key={s.key} value={s.key}>{s.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="grid gap-2">
                <Label>Contract type</Label>
                <Select value={form.contractType} onValueChange={(v) => setForm({ ...form, contractType: v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {CONTRACT_TYPES.map((x) => <SelectItem key={x} value={x}>{x}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-2">
                <Label>Category</Label>
                <Select value={form.category} onValueChange={(v) => setForm({ ...form, category: v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {CONTRACT_CATEGORIES.map((x) => <SelectItem key={x} value={x}>{x}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="grid gap-2">
              <Label>Description</Label>
              <Input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="When and for whom this template is used" />
              <p className="text-xs text-muted-foreground">{meta.description}</p>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="grid gap-2">
                <Label>Review date</Label>
                <Input type="date" value={form.reviewDate} onChange={(e) => setForm({ ...form, reviewDate: e.target.value })} />
              </div>
              <div className="grid gap-2">
                <Label>Expiry date</Label>
                <Input type="date" value={form.expiryDate} onChange={(e) => setForm({ ...form, expiryDate: e.target.value })} />
              </div>
            </div>

            <div className="grid gap-2">
              <Label>Contract body</Label>
              <ContractRichEditor
                ref={editorRef}
                value={form.content}
                onChange={(html) => setForm((f) => ({ ...f, content: html }))}
                placeholder="Compose the agreement. Use the variable chips below to insert merge fields…"
              />
              <p className="text-xs text-muted-foreground">
                Supports {"{{variable}}"}, {"{{#if variable}}…{{/if}}"} and {"{{#each list}}…{{/each}}"} blocks.
              </p>
            </div>

            <div className="rounded-lg border bg-muted/30 p-3">
              <div className="mb-2 text-xs font-medium text-muted-foreground">Insert variable — click to add at cursor</div>
              <div className="flex max-h-44 flex-col gap-2 overflow-y-auto">
                {groups.map(([group, vars]) => (
                  <div key={group} className="flex flex-wrap items-center gap-1.5">
                    <span className="w-full text-[11px] uppercase tracking-wide text-muted-foreground/70">{group}</span>
                    {vars.map((v) => (
                      <button
                        key={v.token}
                        type="button"
                        title={v.label}
                        onClick={() => editorRef.current?.insertToken(v.token)}
                        className="rounded-md border border-border bg-background px-2 py-1 font-mono text-[11px] text-foreground transition-colors hover:border-primary hover:bg-primary/5"
                      >
                        {v.label}
                      </button>
                    ))}
                  </div>
                ))}
              </div>
            </div>

            {changeNote !== null && template && (
              <div className="grid gap-2">
                <Label>Change note (optional)</Label>
                <Input value={changeNote} onChange={(e) => setChangeNote(e.target.value)} placeholder="Summary of what changed in this version" />
              </div>
            )}
          </div>

          {/* Right: live preview + validation */}
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <Label className="text-sm">Live preview</Label>
              {preview && (
                <span className={`inline-flex items-center gap-1 text-xs ${preview.hasUnresolved ? "text-amber-600" : "text-emerald-600"}`}>
                  {preview.hasUnresolved ? <AlertTriangle className="size-3.5" /> : <CheckCircle2 className="size-3.5" />}
                  {preview.hasUnresolved ? "Has empty placeholders" : "All placeholders resolved"}
                </span>
              )}
            </div>
            <div className="min-h-[360px] flex-1 overflow-y-auto rounded-lg border bg-white p-5 text-sm leading-relaxed text-slate-900 shadow-sm">
              {preview ? (
                <div
                  className="contract-preview [&_h1]:mb-2 [&_h1]:text-lg [&_h1]:font-semibold [&_h2]:mb-1.5 [&_h2]:mt-3 [&_h2]:font-semibold [&_p]:mb-2 [&_ul]:mb-2 [&_ul]:list-disc [&_ul]:pl-6 [&_ol]:mb-2 [&_ol]:list-decimal [&_ol]:pl-6 [&_table]:w-full [&_td]:border [&_td]:border-slate-300 [&_td]:p-1.5"
                  dangerouslySetInnerHTML={{ __html: sanitizeHtml(preview.rendered) || "<p class='text-slate-400'>Nothing to preview yet.</p>" }}
                />
              ) : (
                <p className="text-slate-400">Start typing to see the merged preview.</p>
              )}
            </div>

            {validation && (validation.unknownVariables.length > 0 || validation.unbalancedBlocks.length > 0 || validation.referenced.length > 0) && (
              <div className="flex flex-col gap-3 rounded-lg border bg-card p-3 text-xs">
                {validation.unbalancedBlocks.length > 0 && (
                  <div className="flex items-start gap-2 text-red-600">
                    <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                    <span>Unbalanced blocks: {validation.unbalancedBlocks.join(", ")}</span>
                  </div>
                )}
                {validation.unknownVariables.length > 0 && (
                  <div className="flex items-start gap-2 text-amber-600">
                    <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                    <span>Unknown variables: {validation.unknownVariables.join(", ")}</span>
                  </div>
                )}
                {validation.referenced.length > 0 && (
                  <div>
                    <div className="mb-1.5 font-medium text-muted-foreground">Mark required (blocks generation if empty)</div>
                    <div className="flex flex-wrap gap-1.5">
                      {validation.referenced.map((token) => {
                        const on = form.requiredVariables.includes(token)
                        return (
                          <button
                            key={token}
                            type="button"
                            onClick={() => toggleRequired(token)}
                            className={`rounded-md border px-2 py-0.5 font-mono text-[11px] transition-colors ${on ? "border-primary bg-primary text-primary-foreground" : "border-border bg-background text-muted-foreground hover:border-primary"}`}
                          >
                            {token}
                          </button>
                        )
                      })}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="lg:col-span-2 flex flex-wrap items-center justify-between gap-3 border-t pt-4">
            <div className="text-sm text-destructive">{error}</div>
            <div className="flex items-center gap-2">
              <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
              <Button type="submit" disabled={saving}>
                {saving ? "Saving…" : template ? "Save changes" : "Create template"}
              </Button>
            </div>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}

// --- Version history --------------------------------------------------------
function VersionsDialog({ template, onClose }: { template: ContractTemplate; onClose: () => void }) {
  const { data } = useSWR<{ versions: ContractTemplateVersion[] }>(`/api/legal/contract-templates/${template.id}/versions`, fetcher)
  const versions = data?.versions || []
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[85vh] w-[calc(100vw-2rem)] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Version history — {template.name}</DialogTitle>
          <DialogDescription>Every published change is snapshotted so you can audit what a contract was generated from.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          {versions.length === 0 && <p className="py-8 text-center text-sm text-muted-foreground">No prior versions recorded yet.</p>}
          {versions.map((v) => (
            <div key={v.id} className="rounded-lg border bg-card p-3">
              <div className="flex items-center justify-between">
                <span className="font-medium">Version {v.version}</span>
                <span className="text-xs text-muted-foreground">{v.created_at ? new Date(v.created_at).toLocaleString() : ""}</span>
              </div>
              <div className="mt-1 text-xs text-muted-foreground">
                {v.name} · {v.contract_type} · {v.status}
                {v.changed_by_name ? ` · by ${v.changed_by_name}` : ""}
              </div>
              {v.change_note && <div className="mt-1.5 text-sm">{v.change_note}</div>}
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}
