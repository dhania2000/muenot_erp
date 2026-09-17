"use client"

import { useMemo, useState } from "react"
import useSWR from "swr"
import { toast } from "sonner"
import {
  Copy,
  FileText,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
  Archive,
  ArchiveRestore,
  Trash2,
} from "lucide-react"
import { fetcher } from "@/lib/fetcher"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent } from "@/components/ui/card"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  OPERATIONS_EMAIL_CATEGORIES,
  OPERATIONS_TEMPLATE_STATUSES,
  type OperationsEmailTemplate,
} from "@/lib/operations-email-template-shared"
import { OperationsEmailTemplateDialog } from "@/components/operations/operations-email-template-dialog"

type ApiResponse = { templates: OperationsEmailTemplate[]; canManage: boolean }

const STATUS_STYLES: Record<string, string> = {
  Active: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/20",
  Draft: "bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/20",
  Inactive: "bg-slate-500/15 text-slate-600 dark:text-slate-400 border-slate-500/20",
  Archived: "bg-rose-500/15 text-rose-600 dark:text-rose-400 border-rose-500/20",
}

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <Card>
      <CardContent className="p-4">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
        <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
      </CardContent>
    </Card>
  )
}

export function OperationsEmailTemplatesClient() {
  const [search, setSearch] = useState("")
  const [status, setStatus] = useState("all")
  const [category, setCategory] = useState("all")
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<OperationsEmailTemplate | null>(null)

  const { data, isLoading, mutate } = useSWR<ApiResponse>(
    "/api/operations/email-templates?includeArchived=1",
    fetcher,
  )
  const templates = data?.templates ?? []
  const canManage = data?.canManage ?? false

  const stats = useMemo(() => {
    const s = { total: templates.length, active: 0, draft: 0, archived: 0 }
    for (const t of templates) {
      if (t.status === "Active") s.active++
      else if (t.status === "Draft") s.draft++
      else if (t.status === "Archived") s.archived++
    }
    return s
  }, [templates])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return templates.filter((t) => {
      if (status !== "all" && t.status !== status) return false
      if (category !== "all" && t.category !== category) return false
      if (!q) return true
      return (
        t.name.toLowerCase().includes(q) ||
        t.subject.toLowerCase().includes(q) ||
        (t.template_key || "").toLowerCase().includes(q) ||
        (t.template_uid || "").toLowerCase().includes(q)
      )
    })
  }, [templates, search, status, category])

  function openCreate() {
    setEditing(null)
    setDialogOpen(true)
  }
  function openEdit(t: OperationsEmailTemplate) {
    setEditing(t)
    setDialogOpen(true)
  }

  async function setStatusFor(t: OperationsEmailTemplate, next: string) {
    const res = await fetch(`/api/operations/email-templates/${t.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: next }),
    })
    if (res.ok) {
      toast.success(`Template ${next.toLowerCase()}`)
      mutate()
    } else {
      const j = await res.json().catch(() => ({}))
      toast.error(j.error || "Unable to update status")
    }
  }

  async function duplicate(t: OperationsEmailTemplate) {
    const res = await fetch(`/api/operations/email-templates/${t.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "duplicate" }),
    })
    if (res.ok) {
      toast.success("Template duplicated")
      mutate()
    } else {
      const j = await res.json().catch(() => ({}))
      toast.error(j.error || "Unable to duplicate")
    }
  }

  async function remove(t: OperationsEmailTemplate) {
    const res = await fetch(`/api/operations/email-templates/${t.id}`, { method: "DELETE" })
    if (res.ok) {
      toast.success("Template archived")
      mutate()
    } else {
      const j = await res.json().catch(() => ({}))
      toast.error(j.error || "Unable to delete")
    }
  }

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Total" value={stats.total} />
        <StatCard label="Active" value={stats.active} />
        <StatCard label="Draft" value={stats.draft} />
        <StatCard label="Archived" value={stats.archived} />
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-1 flex-col gap-2 sm:flex-row sm:items-center">
          <div className="relative sm:max-w-xs sm:flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search name, ID, key or subject"
              className="pl-9"
            />
          </div>
          <div className="flex gap-2">
            <Select value={status} onValueChange={setStatus}>
              <SelectTrigger className="w-[130px]">
                <SelectValue placeholder="Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                {OPERATIONS_TEMPLATE_STATUSES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {s}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={category} onValueChange={setCategory}>
              <SelectTrigger className="w-[140px]">
                <SelectValue placeholder="Category" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All categories</SelectItem>
                {OPERATIONS_EMAIL_CATEGORIES.map((c) => (
                  <SelectItem key={c} value={c}>
                    {c}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        {canManage && (
          <Button onClick={openCreate} className="shrink-0">
            <Plus className="size-4" />
            New template
          </Button>
        )}
      </div>

      <div className="overflow-hidden rounded-lg border border-border">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-3 font-medium">Template</th>
                <th className="px-4 py-3 font-medium">Category</th>
                <th className="px-4 py-3 font-medium">Audience</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 text-right font-medium">Ver</th>
                <th className="px-4 py-3 text-right font-medium">Uses</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {isLoading && (
                <tr>
                  <td colSpan={7} className="px-4 py-10 text-center text-muted-foreground">
                    Loading templates…
                  </td>
                </tr>
              )}
              {!isLoading && filtered.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-12 text-center">
                    <FileText className="mx-auto mb-3 size-8 text-muted-foreground/50" />
                    <p className="text-sm font-medium">No templates found</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {templates.length === 0
                        ? "Create your first operations email template to get started."
                        : "Try adjusting your search or filters."}
                    </p>
                  </td>
                </tr>
              )}
              {filtered.map((t) => (
                <tr
                  key={t.id}
                  className="border-b border-border last:border-0 hover:bg-muted/30"
                >
                  <td className="px-4 py-3">
                    <div className="flex flex-col">
                      <span className="font-medium text-foreground">{t.name}</span>
                      <span className="text-xs text-muted-foreground">
                        <span className="font-mono">{t.template_uid}</span>
                        {t.template_key ? ` · ${t.template_key}` : ""}
                      </span>
                      <span className="mt-0.5 line-clamp-1 text-xs text-muted-foreground/80">
                        {t.subject}
                      </span>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <Badge variant="secondary" className="font-normal">
                      {t.category}
                    </Badge>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">{t.audience}</td>
                  <td className="px-4 py-3">
                    <Badge variant="outline" className={STATUS_STYLES[t.status]}>
                      {t.status}
                    </Badge>
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">
                    v{t.version}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">
                    {t.usage_count}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon-sm" aria-label="Template actions">
                          <MoreHorizontal className="size-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => openEdit(t)}>
                          <Pencil className="size-4" />
                          {canManage ? "Edit" : "View"}
                        </DropdownMenuItem>
                        {canManage && (
                          <>
                            <DropdownMenuItem onClick={() => duplicate(t)}>
                              <Copy className="size-4" />
                              Duplicate
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            {t.status !== "Active" && (
                              <DropdownMenuItem onClick={() => setStatusFor(t, "Active")}>
                                <ArchiveRestore className="size-4" />
                                Activate
                              </DropdownMenuItem>
                            )}
                            {t.status === "Active" && (
                              <DropdownMenuItem onClick={() => setStatusFor(t, "Inactive")}>
                                <Archive className="size-4" />
                                Deactivate
                              </DropdownMenuItem>
                            )}
                            {t.status !== "Archived" ? (
                              <DropdownMenuItem
                                onClick={() => remove(t)}
                                className="text-destructive focus:text-destructive"
                              >
                                <Trash2 className="size-4" />
                                Archive
                              </DropdownMenuItem>
                            ) : (
                              <DropdownMenuItem onClick={() => setStatusFor(t, "Draft")}>
                                <ArchiveRestore className="size-4" />
                                Restore to draft
                              </DropdownMenuItem>
                            )}
                          </>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <OperationsEmailTemplateDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        template={editing}
        canManage={canManage}
        onSaved={() => {
          setDialogOpen(false)
          mutate()
        }}
      />
    </div>
  )
}
