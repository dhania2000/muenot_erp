"use client"

import { useMemo, useState } from "react"
import useSWR from "swr"
import { fetcher } from "@/lib/fetcher"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import {
  FolderOpen,
  FolderPlus,
  Folder,
  FileText,
  Upload,
  Search,
  Clock,
  AlertTriangle,
  CheckCircle2,
  Files,
} from "lucide-react"
import type {
  DmsDocument,
  DmsFolder,
  DmsCategory,
  DmsTag,
} from "@/lib/dms/types"
import { DocumentDetailSheet } from "./document-detail-sheet"

type ListResponse = { documents: DmsDocument[]; isAdmin: boolean; userId: number }
type Stats = {
  total: number
  active: number
  pendingApproval: number
  expiringSoon: number
  expired: number
}

const STATUS_STYLES: Record<string, string> = {
  active: "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  draft: "border-slate-500/40 bg-slate-500/10 text-slate-600 dark:text-slate-400",
  archived: "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400",
}
const APPROVAL_STYLES: Record<string, string> = {
  pending: "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400",
  approved: "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  rejected: "border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-400",
}

export function DmsClient() {
  const [q, setQ] = useState("")
  const [folderId, setFolderId] = useState<string>("all")
  const [categoryId, setCategoryId] = useState<string>("")
  const [status, setStatus] = useState<string>("")
  const [openDocId, setOpenDocId] = useState<number | null>(null)

  const listKey = useMemo(() => {
    const p = new URLSearchParams()
    if (q.trim()) p.set("q", q.trim())
    if (folderId === "root") p.set("folderId", "root")
    else if (folderId !== "all") p.set("folderId", folderId)
    if (categoryId) p.set("categoryId", categoryId)
    if (status) p.set("status", status)
    return `/api/dms/documents?${p.toString()}`
  }, [q, folderId, categoryId, status])

  const { data, isLoading, mutate } = useSWR<ListResponse>(listKey, fetcher)
  const { data: statsData, mutate: mutateStats } = useSWR<{ stats: Stats }>("/api/dms/stats", fetcher)
  const { data: foldersData, mutate: mutateFolders } = useSWR<{ folders: DmsFolder[] }>("/api/dms/folders", fetcher)
  const { data: catData } = useSWR<{ categories: DmsCategory[] }>("/api/dms/categories", fetcher)
  const { data: tagData } = useSWR<{ tags: DmsTag[] }>("/api/dms/tags", fetcher)

  const documents = data?.documents ?? []
  const folders = foldersData?.folders ?? []
  const categories = catData?.categories ?? []
  const tags = tagData?.tags ?? []
  const stats = statsData?.stats

  function refreshAll() {
    mutate()
    mutateStats()
    mutateFolders()
  }

  return (
    <div className="flex flex-col gap-6 p-6 md:p-8">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-3">
            <FolderOpen className="size-7 text-primary" />
            <h1 className="text-2xl font-semibold">Document Management</h1>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            Centralized documents across HR, Finance, CRM, Projects and Procurement — versions, permissions, sharing and audit.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <NewFolderDialog folders={folders} onDone={mutateFolders} />
          <UploadDialog folders={folders} categories={categories} onDone={refreshAll} />
        </div>
      </div>

      {stats && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          <StatCard icon={<Files className="size-4" />} label="Total" value={stats.total} />
          <StatCard icon={<CheckCircle2 className="size-4" />} label="Active" value={stats.active} tone="emerald" />
          <StatCard icon={<Clock className="size-4" />} label="Pending Approval" value={stats.pendingApproval} tone="amber" />
          <StatCard icon={<AlertTriangle className="size-4" />} label="Expiring Soon" value={stats.expiringSoon} tone="amber" />
          <StatCard icon={<AlertTriangle className="size-4" />} label="Expired" value={stats.expired} tone="red" />
        </div>
      )}

      <div className="flex flex-col gap-6 lg:flex-row">
        {/* Folder rail */}
        <aside className="w-full shrink-0 lg:w-56">
          <div className="rounded-lg border bg-card p-2">
            <FolderItem active={folderId === "all"} onClick={() => setFolderId("all")} icon={<Files className="size-4" />} label="All documents" />
            <FolderItem active={folderId === "root"} onClick={() => setFolderId("root")} icon={<Folder className="size-4" />} label="Unfiled" />
            <div className="my-1 border-t" />
            {folders.map((f) => (
              <FolderItem
                key={f.id}
                active={folderId === String(f.id)}
                onClick={() => setFolderId(String(f.id))}
                icon={<Folder className="size-4" />}
                label={f.name}
                count={f.documentCount}
              />
            ))}
            {folders.length === 0 && (
              <p className="px-2 py-3 text-xs text-muted-foreground">No folders yet.</p>
            )}
          </div>
        </aside>

        {/* Main */}
        <div className="min-w-0 flex-1 space-y-4">
          <div className="flex flex-wrap items-end gap-3 rounded-lg border bg-card p-4">
            <div className="relative min-w-[220px] flex-1">
              <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
              <Input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search title, reference or description"
                className="pl-8"
              />
            </div>
            <div className="grid gap-1.5">
              <Label className="text-xs text-muted-foreground">Category</Label>
              <Select value={categoryId || "all"} onValueChange={(v) => setCategoryId(v === "all" ? "" : v)}>
                <SelectTrigger className="w-[160px]">
                  <SelectValue placeholder="All" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All categories</SelectItem>
                  {categories.map((c) => (
                    <SelectItem key={c.id} value={String(c.id)}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label className="text-xs text-muted-foreground">Status</Label>
              <Select value={status || "all"} onValueChange={(v) => setStatus(v === "all" ? "" : v)}>
                <SelectTrigger className="w-[140px]">
                  <SelectValue placeholder="All" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All</SelectItem>
                  <SelectItem value="active">Active</SelectItem>
                  <SelectItem value="draft">Draft</SelectItem>
                  <SelectItem value="archived">Archived</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Button
              variant="ghost"
              className="h-9"
              onClick={() => {
                setQ("")
                setCategoryId("")
                setStatus("")
                setFolderId("all")
              }}
            >
              Reset
            </Button>
          </div>

          <div className="overflow-auto rounded-lg border">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-left">
                <tr>
                  <th className="whitespace-nowrap p-3 font-medium">Reference</th>
                  <th className="whitespace-nowrap p-3 font-medium">Title</th>
                  <th className="whitespace-nowrap p-3 font-medium">Category</th>
                  <th className="whitespace-nowrap p-3 font-medium">Status</th>
                  <th className="whitespace-nowrap p-3 font-medium">Approval</th>
                  <th className="whitespace-nowrap p-3 font-medium">Expiry</th>
                  <th className="whitespace-nowrap p-3 font-medium">Access</th>
                </tr>
              </thead>
              <tbody>
                {isLoading && (
                  <tr>
                    <td colSpan={7} className="p-8 text-center text-muted-foreground">
                      Loading documents…
                    </td>
                  </tr>
                )}
                {!isLoading && documents.length === 0 && (
                  <tr>
                    <td colSpan={7} className="p-10 text-center text-muted-foreground">
                      <FileText className="mx-auto mb-2 size-8 opacity-40" />
                      No documents match the current filters.
                    </td>
                  </tr>
                )}
                {documents.map((d) => (
                  <tr
                    key={d.id}
                    className="cursor-pointer border-t align-middle hover:bg-muted/30"
                    onClick={() => setOpenDocId(d.id)}
                  >
                    <td className="whitespace-nowrap p-3 font-mono text-xs">{d.docRef}</td>
                    <td className="p-3">
                      <div className="font-medium">{d.title}</div>
                      {d.description && (
                        <div className="line-clamp-1 text-xs text-muted-foreground">{d.description}</div>
                      )}
                    </td>
                    <td className="whitespace-nowrap p-3">{d.categoryName || "—"}</td>
                    <td className="whitespace-nowrap p-3">
                      <Badge variant="outline" className={STATUS_STYLES[d.status] || ""}>
                        {d.status}
                      </Badge>
                    </td>
                    <td className="whitespace-nowrap p-3">
                      {d.approvalStatus === "none" ? (
                        <span className="text-xs text-muted-foreground">—</span>
                      ) : (
                        <Badge variant="outline" className={APPROVAL_STYLES[d.approvalStatus] || ""}>
                          {d.approvalStatus}
                        </Badge>
                      )}
                    </td>
                    <td className="whitespace-nowrap p-3">
                      {d.expiresAt ? (
                        <span className={d.expired ? "text-red-600 dark:text-red-400" : "text-muted-foreground"}>
                          {formatDate(d.expiresAt)}
                        </span>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="whitespace-nowrap p-3">
                      <span className="text-xs capitalize text-muted-foreground">{d.access ?? "view"}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {openDocId != null && (
        <DocumentDetailSheet
          docId={openDocId}
          folders={folders}
          categories={categories}
          knownTags={tags}
          currentUserId={data?.userId ?? 0}
          onClose={() => setOpenDocId(null)}
          onChanged={refreshAll}
        />
      )}
    </div>
  )
}

function StatCard({
  icon,
  label,
  value,
  tone,
}: {
  icon: React.ReactNode
  label: string
  value: number
  tone?: "emerald" | "amber" | "red"
}) {
  const toneClass =
    tone === "emerald"
      ? "text-emerald-600 dark:text-emerald-400"
      : tone === "amber"
        ? "text-amber-600 dark:text-amber-400"
        : tone === "red"
          ? "text-red-600 dark:text-red-400"
          : "text-foreground"
  return (
    <div className="rounded-lg border bg-card p-4">
      <div className="flex items-center gap-2 text-muted-foreground">
        {icon}
        <span className="text-xs">{label}</span>
      </div>
      <div className={`mt-2 text-2xl font-semibold ${toneClass}`}>{value}</div>
    </div>
  )
}

function FolderItem({
  active,
  onClick,
  icon,
  label,
  count,
}: {
  active: boolean
  onClick: () => void
  icon: React.ReactNode
  label: string
  count?: number
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm transition-colors ${
        active ? "bg-primary/10 text-primary" : "hover:bg-muted"
      }`}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {typeof count === "number" && count > 0 && (
        <span className="text-xs text-muted-foreground">{count}</span>
      )}
    </button>
  )
}

function NewFolderDialog({ folders, onDone }: { folders: DmsFolder[]; onDone: () => void }) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState("")
  const [parentId, setParentId] = useState("root")
  const [busy, setBusy] = useState(false)

  async function submit() {
    if (!name.trim()) {
      toast.error("Folder name is required.")
      return
    }
    setBusy(true)
    try {
      const res = await fetch("/api/dms/folders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), parentId: parentId === "root" ? null : Number(parentId) }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body?.error || "Could not create folder")
      toast.success("Folder created")
      setName("")
      setParentId("root")
      setOpen(false)
      onDone()
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline">
          <FolderPlus className="mr-1.5 size-4" /> New folder
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New folder</DialogTitle>
          <DialogDescription>Organize documents into a folder.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 py-2">
          <div className="grid gap-1.5">
            <Label>Name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Contracts" autoFocus />
          </div>
          <div className="grid gap-1.5">
            <Label>Parent folder</Label>
            <Select value={parentId} onValueChange={setParentId}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="root">None (top level)</SelectItem>
                {folders.map((f) => (
                  <SelectItem key={f.id} value={String(f.id)}>
                    {f.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={busy}>
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function UploadDialog({
  folders,
  categories,
  onDone,
}: {
  folders: DmsFolder[]
  categories: DmsCategory[]
  onDone: () => void
}) {
  const [open, setOpen] = useState(false)
  const [title, setTitle] = useState("")
  const [description, setDescription] = useState("")
  const [folderId, setFolderId] = useState("root")
  const [categoryId, setCategoryId] = useState("none")
  const [tags, setTags] = useState("")
  const [expiresAt, setExpiresAt] = useState("")
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)

  function reset() {
    setTitle("")
    setDescription("")
    setFolderId("root")
    setCategoryId("none")
    setTags("")
    setExpiresAt("")
    setFile(null)
  }

  async function submit() {
    if (!title.trim()) {
      toast.error("Title is required.")
      return
    }
    setBusy(true)
    try {
      const fd = new FormData()
      fd.set("title", title.trim())
      if (description.trim()) fd.set("description", description.trim())
      if (folderId !== "root") fd.set("folderId", folderId)
      if (categoryId !== "none") fd.set("categoryId", categoryId)
      if (tags.trim()) fd.set("tags", tags.trim())
      if (expiresAt) fd.set("expiresAt", expiresAt)
      if (file) fd.set("file", file)
      const res = await fetch("/api/dms/documents", { method: "POST", body: fd })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body?.error || "Upload failed")
      toast.success("Document created")
      reset()
      setOpen(false)
      onDone()
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v)
        if (!v) reset()
      }}
    >
      <DialogTrigger asChild>
        <Button>
          <Upload className="mr-1.5 size-4" /> Upload document
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-auto">
        <DialogHeader>
          <DialogTitle>Upload document</DialogTitle>
          <DialogDescription>Create a document record and attach the first file version.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 py-2">
          <div className="grid gap-1.5">
            <Label>Title</Label>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Document title" autoFocus />
          </div>
          <div className="grid gap-1.5">
            <Label>Description</Label>
            <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label>Folder</Label>
              <Select value={folderId} onValueChange={setFolderId}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="root">Unfiled</SelectItem>
                  {folders.map((f) => (
                    <SelectItem key={f.id} value={String(f.id)}>
                      {f.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label>Category</Label>
              <Select value={categoryId} onValueChange={setCategoryId}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">None</SelectItem>
                  {categories.map((c) => (
                    <SelectItem key={c.id} value={String(c.id)}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label>Tags</Label>
              <Input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="comma,separated" />
            </div>
            <div className="grid gap-1.5">
              <Label>Expires</Label>
              <Input type="date" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} />
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label>File</Label>
            <Input type="file" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            <p className="text-xs text-muted-foreground">Optional — you can add file versions later.</p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={busy}>
            {busy ? "Uploading…" : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function formatDate(value: string | null): string {
  if (!value) return "—"
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return value
  return d.toLocaleDateString()
}
