"use client"

import { useState } from "react"
import useSWR from "swr"
import { toast } from "sonner"
import { fetcher } from "@/lib/fetcher"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import {
  Plus, Search, MoreHorizontal, BarChart3, Pencil, Copy, Send, Ban, Archive,
  RotateCcw, Trash2, Download, Loader2, Pin, ChevronLeft, ChevronRight,
} from "lucide-react"
import {
  type ManageNotice, type Meta, type Status,
  PriorityBadge, StatusBadge, audienceSummary, formatDate,
} from "./shared"

type ManageResponse = {
  notices: ManageNotice[]
  total: number
  page: number
  pageSize: number
  stats: Record<string, number>
}

const STATUS_FILTERS: { value: string; label: string }[] = [
  { value: "", label: "All statuses" },
  { value: "draft", label: "Drafts" },
  { value: "scheduled", label: "Scheduled" },
  { value: "published", label: "Published" },
  { value: "expired", label: "Expired" },
  { value: "archived", label: "Archived" },
  { value: "cancelled", label: "Cancelled" },
]

function StatCard({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <div className="rounded-lg border bg-card p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`mt-0.5 text-2xl font-semibold tabular-nums ${tone ?? ""}`}>{value}</p>
    </div>
  )
}

export function ManageView({
  meta, onCompose, onEdit, onAnalytics, onView,
}: {
  meta: Meta | undefined
  onCompose: () => void
  onEdit: (id: number) => void
  onAnalytics: (id: number) => void
  onView: (id: number) => void
}) {
  const [status, setStatus] = useState("")
  const [priority, setPriority] = useState("")
  const [category, setCategory] = useState("")
  const [q, setQ] = useState("")
  const [page, setPage] = useState(1)
  const [busyId, setBusyId] = useState<number | null>(null)
  const [confirm, setConfirm] = useState<{ id: number; action: "delete" | "cancel" | "archive"; heading: string } | null>(null)
  const [reason, setReason] = useState("")

  const params = new URLSearchParams({ manage: "1", page: String(page), pageSize: "20" })
  if (status) params.set("status", status)
  if (priority) params.set("priority", priority)
  if (category) params.set("category", category)
  if (q.trim()) params.set("q", q.trim())

  const { data, isLoading, mutate } = useSWR<ManageResponse>(`/api/notice-board?${params.toString()}`, fetcher, {
    keepPreviousData: true,
  })

  const stats = data?.stats ?? {}
  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1

  async function act(id: number, path: string, body?: any, successMsg?: string) {
    setBusyId(id)
    try {
      const res = await fetch(`/api/notice-board/${id}${path}`, {
        method: path ? "POST" : "DELETE",
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) { toast.error(d.error || "Action failed"); return false }
      if (successMsg) toast.success(successMsg)
      mutate()
      return true
    } finally {
      setBusyId(null)
    }
  }

  async function del(id: number) {
    setBusyId(id)
    try {
      const res = await fetch(`/api/notice-board/${id}`, { method: "DELETE" })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) { toast.error(d.error || "Delete failed"); return }
      toast.success(d.deleted ? "Draft deleted" : "Notice archived")
      mutate()
    } finally {
      setBusyId(null)
    }
  }

  async function duplicate(id: number) {
    const ok = await act(id, "/duplicate", undefined, "Duplicated to a new draft")
    if (ok) setStatus("")
  }

  function runConfirm() {
    if (!confirm) return
    const c = confirm
    setConfirm(null)
    if (c.action === "delete") del(c.id)
    else if (c.action === "cancel") act(c.id, "/cancel", { reason: reason.trim() || undefined }, "Notice cancelled")
    else if (c.action === "archive") act(c.id, "/archive", {}, "Notice archived")
    setReason("")
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4 lg:grid-cols-7">
        <StatCard label="Drafts" value={Number(stats.drafts ?? 0)} />
        <StatCard label="Scheduled" value={Number(stats.scheduled ?? 0)} tone="text-blue-500" />
        <StatCard label="Published" value={Number(stats.published ?? 0)} tone="text-emerald-600 dark:text-emerald-400" />
        <StatCard label="Urgent" value={Number(stats.urgent ?? 0)} tone="text-destructive" />
        <StatCard label="Expired" value={Number(stats.expired ?? 0)} tone="text-amber-600 dark:text-amber-400" />
        <StatCard label="Archived" value={Number(stats.archived ?? 0)} />
        <StatCard label="Cancelled" value={Number(stats.cancelled ?? 0)} />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-48 flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={q}
            onChange={(e) => { setQ(e.target.value); setPage(1) }}
            placeholder="Search notices…"
            className="pl-8"
          />
        </div>
        <Select value={status || "all"} onValueChange={(v) => { setStatus(v === "all" ? "" : v); setPage(1) }}>
          <SelectTrigger className="w-40"><SelectValue placeholder="Status" /></SelectTrigger>
          <SelectContent>
            {STATUS_FILTERS.map((s) => <SelectItem key={s.value || "all"} value={s.value || "all"}>{s.label}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={priority || "all"} onValueChange={(v) => { setPriority(v === "all" ? "" : v); setPage(1) }}>
          <SelectTrigger className="w-36"><SelectValue placeholder="Priority" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All priorities</SelectItem>
            <SelectItem value="normal">Normal</SelectItem>
            <SelectItem value="important">Important</SelectItem>
            <SelectItem value="urgent">Urgent</SelectItem>
          </SelectContent>
        </Select>
        <Select value={category || "all"} onValueChange={(v) => { setCategory(v === "all" ? "" : v); setPage(1) }}>
          <SelectTrigger className="w-40"><SelectValue placeholder="Category" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All categories</SelectItem>
            {(meta?.categories ?? []).map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
          </SelectContent>
        </Select>
        <Button variant="outline" asChild>
          <a href={`/api/notice-board/export${status ? `?status=${status}` : ""}`}>
            <Download className="mr-2 size-4" /> Export
          </a>
        </Button>
        <Button onClick={onCompose}>
          <Plus className="mr-2 size-4" /> New Notice
        </Button>
      </div>

      <div className="overflow-hidden rounded-lg border">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/40 text-left text-muted-foreground">
                <th className="px-3 py-2.5 font-medium">Notice</th>
                <th className="px-3 py-2.5 font-medium">Status</th>
                <th className="hidden px-3 py-2.5 font-medium md:table-cell">Audience</th>
                <th className="hidden px-3 py-2.5 font-medium lg:table-cell">Reads</th>
                <th className="hidden px-3 py-2.5 font-medium lg:table-cell">Published</th>
                <th className="px-3 py-2.5 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {isLoading && !data ? (
                <tr><td colSpan={6} className="px-3 py-16 text-center text-muted-foreground"><Loader2 className="mx-auto size-5 animate-spin" /></td></tr>
              ) : data && data.notices.length === 0 ? (
                <tr><td colSpan={6} className="px-3 py-16 text-center text-muted-foreground">No notices match your filters.</td></tr>
              ) : data?.notices.map((n) => (
                <tr key={n.id} className="border-b last:border-b-0 hover:bg-muted/30">
                  <td className="px-3 py-2.5">
                    <button onClick={() => onView(n.id)} className="group flex flex-col items-start text-left">
                      <span className="flex items-center gap-1.5 font-medium">
                        {n.pinned && <Pin className="size-3.5 text-muted-foreground" />}
                        <span className="group-hover:underline">{n.heading}</span>
                      </span>
                      <span className="flex items-center gap-2 text-xs text-muted-foreground">
                        {n.notice_code && <span>{n.notice_code}</span>}
                        <PriorityBadge priority={n.priority} />
                        <span>{n.category}</span>
                      </span>
                    </button>
                  </td>
                  <td className="px-3 py-2.5"><StatusBadge status={n.status} /></td>
                  <td className="hidden px-3 py-2.5 text-muted-foreground md:table-cell">
                    {n.to_type === "clients" ? "All Clients" : audienceSummary(n.to_type, n.audience_type, n.audience_config, meta?.employees)}
                  </td>
                  <td className="hidden px-3 py-2.5 lg:table-cell">
                    {n.recipient_count > 0 ? (
                      <span className="text-muted-foreground">
                        {n.read_count}/{n.recipient_count}
                        {n.acknowledgement_required && <span className="ml-1 text-xs">· {n.ack_count} ack</span>}
                      </span>
                    ) : <span className="text-muted-foreground">—</span>}
                  </td>
                  <td className="hidden px-3 py-2.5 text-muted-foreground lg:table-cell">{formatDate(n.published_at ?? n.publish_date)}</td>
                  <td className="px-3 py-2.5 text-right">
                    <RowActions
                      notice={n}
                      busy={busyId === n.id}
                      onView={() => onView(n.id)}
                      onEdit={() => onEdit(n.id)}
                      onAnalytics={() => onAnalytics(n.id)}
                      onPublish={() => act(n.id, "/publish", undefined, "Notice published")}
                      onDuplicate={() => duplicate(n.id)}
                      onCancel={() => setConfirm({ id: n.id, action: "cancel", heading: n.heading })}
                      onArchive={() => setConfirm({ id: n.id, action: "archive", heading: n.heading })}
                      onRestore={() => act(n.id, "/archive", { restore: true }, "Restored to draft")}
                      onDelete={() => setConfirm({ id: n.id, action: "delete", heading: n.heading })}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="flex items-center justify-between text-sm text-muted-foreground">
        <span>{data ? `${data.total} notice${data.total === 1 ? "" : "s"}` : ""}</span>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            <ChevronLeft className="size-4" />
          </Button>
          <span>Page {page} of {totalPages}</span>
          <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
            <ChevronRight className="size-4" />
          </Button>
        </div>
      </div>

      <AlertDialog open={!!confirm} onOpenChange={(o) => { if (!o) { setConfirm(null); setReason("") } }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirm?.action === "delete" ? "Delete / archive notice?"
                : confirm?.action === "cancel" ? "Cancel notice?" : "Archive notice?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirm?.action === "delete"
                ? `Drafts are deleted permanently; published notices are archived. "${confirm?.heading}"`
                : confirm?.action === "cancel"
                  ? `This retracts "${confirm?.heading}" from recipients.`
                  : `"${confirm?.heading}" will be moved to the archive.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {confirm?.action === "cancel" && (
            <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason (optional)" />
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>Back</AlertDialogCancel>
            <AlertDialogAction onClick={runConfirm}>Confirm</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function RowActions({
  notice, busy, onView, onEdit, onAnalytics, onPublish, onDuplicate, onCancel, onArchive, onRestore, onDelete,
}: {
  notice: ManageNotice
  busy: boolean
  onView: () => void
  onEdit: () => void
  onAnalytics: () => void
  onPublish: () => void
  onDuplicate: () => void
  onCancel: () => void
  onArchive: () => void
  onRestore: () => void
  onDelete: () => void
}) {
  const s: Status = notice.status
  const canPublish = s === "draft" || s === "scheduled"
  const canEdit = s !== "cancelled"
  const canCancel = s === "published" || s === "scheduled"
  const canArchive = s !== "archived" && s !== "draft"
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" disabled={busy} aria-label="Notice actions">
          {busy ? <Loader2 className="size-4 animate-spin" /> : <MoreHorizontal className="size-4" />}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuItem onClick={onView}><Search className="mr-2 size-4" /> View</DropdownMenuItem>
        {canEdit && <DropdownMenuItem onClick={onEdit}><Pencil className="mr-2 size-4" /> Edit</DropdownMenuItem>}
        {canPublish && <DropdownMenuItem onClick={onPublish}><Send className="mr-2 size-4" /> Publish</DropdownMenuItem>}
        <DropdownMenuItem onClick={onAnalytics}><BarChart3 className="mr-2 size-4" /> Analytics</DropdownMenuItem>
        <DropdownMenuItem onClick={onDuplicate}><Copy className="mr-2 size-4" /> Duplicate</DropdownMenuItem>
        <DropdownMenuSeparator />
        {canCancel && <DropdownMenuItem onClick={onCancel}><Ban className="mr-2 size-4" /> Cancel</DropdownMenuItem>}
        {canArchive && <DropdownMenuItem onClick={onArchive}><Archive className="mr-2 size-4" /> Archive</DropdownMenuItem>}
        {s === "archived" && <DropdownMenuItem onClick={onRestore}><RotateCcw className="mr-2 size-4" /> Restore</DropdownMenuItem>}
        <DropdownMenuItem onClick={onDelete} variant="destructive"><Trash2 className="mr-2 size-4" /> Delete</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
