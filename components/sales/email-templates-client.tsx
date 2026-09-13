"use client"

import { useMemo, useState } from "react"
import useSWR from "swr"
import { toast } from "sonner"
import { fetcher } from "@/lib/fetcher"
import { formatDate } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Copy, History, MoreHorizontal, Plus, Search } from "lucide-react"
import { Checkbox } from "@/components/ui/checkbox"
import { EmailTemplateDialog } from "@/components/sales/email-template-dialog"
import { TemplateVersionsDialog } from "@/components/sales/email-template-versions-dialog"
import { ExcelExportButton } from "@/components/excel-export-button"
import { ImportButton } from "@/components/import-button"
import { SelectAllCheckbox, SelectionToolbar, useDeleteManager, useRowSelection } from "@/components/sales/bulk-delete"
import { TEMPLATE_STATUSES, type TemplateStatus } from "@/lib/sales/email-template-engine"

export type EmailTemplateRow = {
  id: number
  name: string
  subject: string
  body: string
  category: string | null
  description: string | null
  template_key: string | null
  module: string | null
  status: TemplateStatus
  version: number
  sent_count: number
  opened_count: number
  created_by_name: string | null
  created_at: string
  updated_at: string
  attachment_pathname?: string | null
  attachment_name?: string | null
  attachment_type?: string | null
  attachment_size?: number | null
}

const STATUS_STYLES: Record<TemplateStatus, string> = {
  Active: "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  Draft: "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400",
  Archived: "border-muted-foreground/20 bg-muted text-muted-foreground",
}

function pct(part: number, whole: number) {
  return whole > 0 ? Math.round((part / whole) * 100) : 0
}

export function EmailTemplatesClient({ canManage }: { canManage: boolean }) {
  const { data, isLoading, mutate } = useSWR<{ templates: EmailTemplateRow[] }>(
    "/api/sales/email-templates",
    fetcher,
  )
  const [search, setSearch] = useState("")
  const [statusFilter, setStatusFilter] = useState<string>("all")
  const [categoryFilter, setCategoryFilter] = useState<string>("all")
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<EmailTemplateRow | null>(null)
  const [historyFor, setHistoryFor] = useState<EmailTemplateRow | null>(null)

  const templates = data?.templates ?? []

  const categories = useMemo(
    () => [...new Set(templates.map((t) => t.category).filter(Boolean) as string[])].sort(),
    [templates],
  )

  const stats = useMemo(() => {
    const active = templates.filter((t) => t.status === "Active").length
    const drafts = templates.filter((t) => t.status === "Draft").length
    const sent = templates.reduce((s, t) => s + Number(t.sent_count || 0), 0)
    const opened = templates.reduce((s, t) => s + Number(t.opened_count || 0), 0)
    return { total: templates.length, active, drafts, sent, openRate: pct(opened, sent) }
  }, [templates])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return templates.filter((t) => {
      if (statusFilter !== "all" && t.status !== statusFilter) return false
      if (categoryFilter !== "all" && t.category !== categoryFilter) return false
      if (!q) return true
      return [t.name, t.subject, t.category, t.template_key].filter(Boolean).some((f) => f!.toLowerCase().includes(q))
    })
  }, [templates, search, statusFilter, categoryFilter])

  const { selected, toggle, toggleAll, clear } = useRowSelection()
  const del = useDeleteManager({
    endpoint: (id) => `/api/sales/email-templates/${id}`,
    labels: { singular: "template", plural: "templates" },
    mutate,
    onDeleted: clear,
  })

  async function setStatus(t: EmailTemplateRow, status: TemplateStatus) {
    const res = await fetch(`/api/sales/email-templates/${t.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ statusOnly: true, status }),
    })
    if (res.ok) {
      toast.success(`Template ${status.toLowerCase()}`)
      mutate()
    } else {
      toast.error("Unable to update status")
    }
  }

  async function duplicate(t: EmailTemplateRow) {
    const res = await fetch("/api/sales/email-templates", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: `${t.name} (copy)`,
        subject: t.subject,
        body: t.body,
        category: t.category,
        description: t.description,
        module: t.module,
        status: "Draft",
      }),
    })
    if (res.ok) {
      toast.success("Template duplicated as draft")
      mutate()
    } else {
      toast.error("Unable to duplicate template")
    }
  }

  const cards = [
    { label: "Templates", value: String(stats.total), hint: `${stats.active} active` },
    { label: "Drafts", value: String(stats.drafts), hint: "not yet live", accent: "text-amber-600 dark:text-amber-400" },
    { label: "Emails sent", value: String(stats.sent), hint: "using templates" },
    { label: "Open rate", value: `${stats.openRate}%`, hint: "across sent", accent: "text-blue-600 dark:text-blue-400" },
  ]

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {cards.map((c) => (
          <div key={c.label} className="rounded-xl border bg-card p-4">
            <p className="text-xs text-muted-foreground">{c.label}</p>
            <p className={`mt-1 text-2xl font-semibold ${c.accent || ""}`}>{c.value}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">{c.hint}</p>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search templates..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-56 pl-8"
            />
          </div>
          <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v || "all")}>
            <SelectTrigger className="w-36">
              <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              {TEMPLATE_STATUSES.map((s) => (
                <SelectItem key={s} value={s}>
                  {s}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {categories.length > 0 && (
            <Select value={categoryFilter} onValueChange={(v) => setCategoryFilter(v || "all")}>
              <SelectTrigger className="w-40">
                <SelectValue placeholder="Category" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All categories</SelectItem>
                {categories.map((c) => (
                  <SelectItem key={c} value={c}>
                    {c}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
        <div className="flex items-center gap-2">
          {canManage && <ImportButton moduleKey="sales-email-templates" onImported={() => mutate()} />}
          <ExcelExportButton
            rows={filtered}
            filename="sales-email-templates"
            columns={[
              { header: "Name", value: (r) => r.name },
              { header: "Subject", value: (r) => r.subject },
              { header: "Category", value: (r) => r.category },
              { header: "Status", value: (r) => r.status },
              { header: "Version", value: (r) => r.version },
              { header: "Sent", value: (r) => r.sent_count },
              { header: "Created By", value: (r) => r.created_by_name },
              { header: "Updated At", value: (r) => r.updated_at },
            ]}
          />
          {canManage && (
            <Button
              onClick={() => {
                setEditing(null)
                setDialogOpen(true)
              }}
            >
              <Plus data-icon="inline-start" />
              Create template
            </Button>
          )}
        </div>
      </div>

      {canManage && selected.size > 0 && (
        <SelectionToolbar
          count={selected.size}
          noun="template"
          onClear={clear}
          onDelete={() => del.requestBulk([...selected])}
        />
      )}

      <div className="rounded-md border border-border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              {canManage && (
                <TableHead className="w-10">
                  <SelectAllCheckbox ids={filtered.map((t) => t.id)} selected={selected} onToggleAll={toggleAll} />
                </TableHead>
              )}
              <TableHead>Name</TableHead>
              <TableHead>Subject</TableHead>
              <TableHead>Category</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Sent</TableHead>
              <TableHead>Updated</TableHead>
              {canManage && <TableHead className="text-right">Actions</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading && (
              <TableRow>
                <TableCell colSpan={8} className="py-10 text-center text-sm text-muted-foreground">
                  Loading templates...
                </TableCell>
              </TableRow>
            )}
            {!isLoading && filtered.length === 0 && (
              <TableRow>
                <TableCell colSpan={8} className="py-10 text-center text-sm text-muted-foreground">
                  No templates match your filters.
                </TableCell>
              </TableRow>
            )}
            {filtered.map((t) => (
              <TableRow key={t.id} data-state={selected.has(t.id) ? "selected" : undefined}>
                {canManage && (
                  <TableCell>
                    <Checkbox
                      aria-label={`Select template ${t.name}`}
                      checked={selected.has(t.id)}
                      onCheckedChange={() => toggle(t.id)}
                    />
                  </TableCell>
                )}
                <TableCell className="font-medium">
                  <div className="flex flex-col">
                    <span>{t.name}</span>
                    <span className="text-xs text-muted-foreground">
                      v{t.version}
                      {t.template_key ? ` · ${t.template_key}` : ""}
                    </span>
                  </div>
                </TableCell>
                <TableCell className="max-w-xs truncate text-muted-foreground">{t.subject}</TableCell>
                <TableCell>
                  {t.category ? (
                    <Badge variant="outline">{t.category}</Badge>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell>
                  <Badge variant="outline" className={STATUS_STYLES[t.status]}>
                    {t.status}
                  </Badge>
                </TableCell>
                <TableCell className="text-right tabular-nums text-muted-foreground">{t.sent_count}</TableCell>
                <TableCell className="text-muted-foreground">{formatDate(t.updated_at)}</TableCell>
                {canManage && (
                  <TableCell className="text-right">
                    <DropdownMenu>
                      <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label="Actions" />}>
                        <MoreHorizontal className="size-4" />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem
                          onClick={() => {
                            setEditing(t)
                            setDialogOpen(true)
                          }}
                        >
                          Edit template
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => setHistoryFor(t)}>
                          <History className="size-4" data-icon="inline-start" />
                          Version history
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => duplicate(t)}>
                          <Copy className="size-4" data-icon="inline-start" />
                          Duplicate
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        {t.status !== "Active" && (
                          <DropdownMenuItem onClick={() => setStatus(t, "Active")}>Set active</DropdownMenuItem>
                        )}
                        {t.status !== "Draft" && (
                          <DropdownMenuItem onClick={() => setStatus(t, "Draft")}>Move to draft</DropdownMenuItem>
                        )}
                        {t.status !== "Archived" && (
                          <DropdownMenuItem onClick={() => setStatus(t, "Archived")}>Archive</DropdownMenuItem>
                        )}
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          variant="destructive"
                          onClick={() => del.requestSingle(t.id, `template "${t.name}"`)}
                        >
                          Delete template
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <EmailTemplateDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        template={editing}
        onSaved={() => {
          setDialogOpen(false)
          toast.success(editing ? "Template updated" : "Template created")
          mutate()
        }}
      />

      <TemplateVersionsDialog
        template={historyFor}
        canManage={canManage}
        onOpenChange={(open) => !open && setHistoryFor(null)}
        onRestored={() => {
          setHistoryFor(null)
          toast.success("Version restored")
          mutate()
        }}
      />

      {del.dialog}
    </div>
  )
}
