"use client"

import { useMemo, useState } from "react"
import useSWR from "swr"
import { toast } from "sonner"
import { MarketingHeader, StatCard } from "@/components/marketing/marketing-shared"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Checkbox } from "@/components/ui/checkbox"
import { Progress } from "@/components/ui/progress"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import {
  Search,
  Upload,
  FolderPlus,
  Folder,
  Files,
  HardDrive,
  Mail,
  Image as ImageIcon,
  FileText,
  Film,
  Music,
  Archive,
  Trash2,
  ChevronDown,
  Loader2,
  AlertTriangle,
} from "lucide-react"
import {
  ASSET_TYPES,
  ASSET_CATEGORIES,
  ASSET_STATUSES,
  SORT_OPTIONS,
  humanBytes,
  jsonFetcher,
  statusVariant,
  type LibraryAsset,
  type LibraryFolder,
  type StorageStats,
} from "./library/library-shared"
import { LibraryUploadDialog } from "./library/library-upload-dialog"
import { LibraryAssetSheet } from "./library/library-asset-sheet"

const PAGE_SIZE = 24

export function MarketingLibraryClient() {
  const [q, setQ] = useState("")
  const [type, setType] = useState("all")
  const [category, setCategory] = useState("all")
  const [status, setStatus] = useState("all")
  const [folder, setFolder] = useState("all")
  const [sort, setSort] = useState("updated")
  const [dir, setDir] = useState<"asc" | "desc">("desc")
  const [page, setPage] = useState(1)

  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [uploadOpen, setUploadOpen] = useState(false)
  const [newFolderOpen, setNewFolderOpen] = useState(false)
  const [detailId, setDetailId] = useState<number | null>(null)

  const { data: perm } = useSWR<{ canManage: boolean }>("/api/marketing/library/permissions", jsonFetcher)
  const canManage = perm?.canManage ?? false

  const { data: folderData, mutate: mutateFolders } = useSWR<{ folders: LibraryFolder[] }>(
    "/api/marketing/library/folders",
    jsonFetcher,
  )
  const folders = folderData?.folders || []

  const listUrl = useMemo(() => {
    const p = new URLSearchParams({
      stats: "1",
      page: String(page),
      pageSize: String(PAGE_SIZE),
      sort,
      dir,
    })
    if (q.trim()) p.set("q", q.trim())
    if (type !== "all") p.set("type", type)
    if (category !== "all") p.set("category", category)
    if (status !== "all") p.set("status", status)
    if (folder !== "all") p.set("folder", folder)
    return `/api/marketing/library?${p.toString()}`
  }, [q, type, category, status, folder, sort, dir, page])

  const { data, isLoading, mutate } = useSWR<{
    assets: LibraryAsset[]
    total: number
    stats: StorageStats
  }>(listUrl, jsonFetcher, { keepPreviousData: true })

  const assets = data?.assets || []
  const total = data?.total || 0
  const stats = data?.stats
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  function refresh() {
    mutate()
    setSelected(new Set())
  }

  function toggle(id: number) {
    setSelected((s) => {
      const next = new Set(s)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function resetFilters() {
    setQ("")
    setType("all")
    setCategory("all")
    setStatus("all")
    setFolder("all")
    setPage(1)
  }

  async function bulk(action: "archive" | "delete", extra?: Record<string, unknown>) {
    const ids = Array.from(selected)
    if (!ids.length) return
    let ok = 0
    let blocked = 0
    for (const id of ids) {
      if (action === "archive") {
        const res = await fetch(`/api/marketing/library/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: "Archived", ...extra }),
        })
        if (res.ok) ok++
      } else if (action === "delete") {
        const res = await fetch(`/api/marketing/library/${id}`, { method: "DELETE" })
        if (res.status === 409) blocked++
        else if (res.ok) ok++
      }
    }
    refresh()
    if (ok) toast.success(`${ok} asset${ok > 1 ? "s" : ""} ${action === "archive" ? "archived" : "deleted"}`)
    if (blocked) toast.warning(`${blocked} skipped — still referenced by other modules`)
  }

  async function bulkMove(folderId: number | null) {
    const ids = Array.from(selected)
    for (const id of ids) {
      await fetch(`/api/marketing/library/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ folderId }),
      })
    }
    refresh()
    toast.success(`Moved ${ids.length} asset${ids.length > 1 ? "s" : ""}`)
  }

  const emailTemplateCount = stats ? undefined : undefined

  return (
    <div className="flex flex-col gap-6 px-4 sm:px-6 lg:px-8">
      <MarketingHeader
        eyebrow="Marketing"
        title="Digital Asset Library"
        description="Central repository for all marketing and brand assets — versioned, permissioned, and reusable across modules."
        action={
          canManage ? (
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => setNewFolderOpen(true)}>
                <FolderPlus className="size-4" /> New Folder
              </Button>
              <Button onClick={() => setUploadOpen(true)}>
                <Upload className="size-4" /> Upload
              </Button>
            </div>
          ) : null
        }
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <StatCard icon={Files} label="Total Assets" value={stats ? String(stats.assetCount) : "—"} />
        <StatCard
          icon={HardDrive}
          label="Storage Used"
          value={stats ? humanBytes(stats.usedBytes) : "—"}
          hint={stats ? `${stats.percentage}% of ${humanBytes(stats.quotaBytes)}` : undefined}
        />
        <StatCard icon={Folder} label="Folders" value={String(folders.length)} />
      </div>

      {stats && stats.percentage >= 80 && (
        <div className="flex items-center gap-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800">
          <AlertTriangle className="size-4 shrink-0" />
          <span>
            Storage is {stats.percentage}% full ({humanBytes(stats.usedBytes)} of {humanBytes(stats.quotaBytes)}). Consider
            archiving unused assets.
          </span>
          <div className="ml-auto w-32">
            <Progress value={stats.percentage} />
          </div>
        </div>
      )}

      {/* Toolbar */}
      <div className="flex flex-col gap-3">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={q}
            onChange={(e) => {
              setQ(e.target.value)
              setPage(1)
            }}
            placeholder="Search by name, tag, type, owner, ID…"
            className="pl-8"
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <FilterSelect value={type} onChange={(v) => { setType(v); setPage(1) }} placeholder="All Types" options={ASSET_TYPES} />
          <FilterSelect value={category} onChange={(v) => { setCategory(v); setPage(1) }} placeholder="All Categories" options={ASSET_CATEGORIES} />
          <FilterSelect value={status} onChange={(v) => { setStatus(v); setPage(1) }} placeholder="All Statuses" options={ASSET_STATUSES} />
          <Select value={folder} onValueChange={(v) => { setFolder(v); setPage(1) }}>
            <SelectTrigger className="w-auto min-w-36">
              <SelectValue placeholder="All Folders" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Folders</SelectItem>
              {folders.map((f) => (
                <SelectItem key={f.id} value={String(f.id)}>
                  {f.path} ({f.asset_count})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="ml-auto flex items-center gap-2">
            <Select value={sort} onValueChange={setSort}>
              <SelectTrigger className="w-auto min-w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SORT_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button variant="outline" size="icon" onClick={() => setDir((d) => (d === "asc" ? "desc" : "asc"))} title="Toggle direction">
              <ChevronDown className={`size-4 transition-transform ${dir === "asc" ? "rotate-180" : ""}`} />
            </Button>
          </div>
        </div>
        {(q || type !== "all" || category !== "all" || status !== "all" || folder !== "all") && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <span>{total} result{total === 1 ? "" : "s"}</span>
            <Button variant="link" size="sm" className="h-auto p-0" onClick={resetFilters}>
              Clear filters
            </Button>
          </div>
        )}
      </div>

      {/* Bulk action bar */}
      {canManage && selected.size > 0 && (
        <div className="flex items-center gap-3 rounded-lg border bg-muted/40 p-3">
          <span className="text-sm font-medium">{selected.size} selected</span>
          <div className="ml-auto flex gap-2">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm">
                  <Folder className="size-4" /> Move <ChevronDown className="size-3" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuLabel>Move to folder</DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => bulkMove(null)}>No folder</DropdownMenuItem>
                {folders.map((f) => (
                  <DropdownMenuItem key={f.id} onClick={() => bulkMove(f.id)}>
                    {f.path}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            <Button variant="outline" size="sm" onClick={() => bulk("archive")}>
              <Archive className="size-4" /> Archive
            </Button>
            <Button variant="outline" size="sm" className="text-destructive" onClick={() => bulk("delete")}>
              <Trash2 className="size-4" /> Delete
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>
              Clear
            </Button>
          </div>
        </div>
      )}

      {/* Grid */}
      {isLoading && !data ? (
        <div className="flex justify-center py-16">
          <Loader2 className="size-6 animate-spin text-muted-foreground" />
        </div>
      ) : assets.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed py-16 text-center">
          <Files className="size-10 text-muted-foreground" />
          <div>
            <p className="font-medium">No assets found</p>
            <p className="text-sm text-muted-foreground">
              {q || type !== "all" ? "Try adjusting your filters." : "Upload your first asset to get started."}
            </p>
          </div>
          {canManage && !q && type === "all" && (
            <Button onClick={() => setUploadOpen(true)}>
              <Upload className="size-4" /> Upload Asset
            </Button>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          {assets.map((a) => (
            <AssetCard
              key={a.id}
              asset={a}
              selectable={canManage}
              selected={selected.has(a.id)}
              onToggle={() => toggle(a.id)}
              onOpen={() => setDetailId(a.id)}
            />
          ))}
        </div>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-2">
          <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            Previous
          </Button>
          <span className="text-sm text-muted-foreground">
            Page {page} of {totalPages}
          </span>
          <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
            Next
          </Button>
        </div>
      )}

      <LibraryUploadDialog
        open={uploadOpen}
        onOpenChange={setUploadOpen}
        folders={folders}
        defaultFolderId={folder !== "all" ? Number(folder) : null}
        onUploaded={refresh}
      />

      <LibraryAssetSheet
        assetId={detailId}
        open={detailId !== null}
        onOpenChange={(v) => !v && setDetailId(null)}
        folders={folders}
        canManage={canManage}
        onChanged={refresh}
      />

      <NewFolderDialog
        open={newFolderOpen}
        onOpenChange={setNewFolderOpen}
        folders={folders}
        onCreated={() => mutateFolders()}
      />
    </div>
  )
}

function FilterSelect({
  value,
  onChange,
  placeholder,
  options,
}: {
  value: string
  onChange: (v: string) => void
  placeholder: string
  options: string[]
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="w-auto min-w-32">
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="all">{placeholder}</SelectItem>
        {options.map((o) => (
          <SelectItem key={o} value={o}>
            {o}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

function AssetCard({
  asset,
  selectable,
  selected,
  onToggle,
  onOpen,
}: {
  asset: LibraryAsset
  selectable: boolean
  selected: boolean
  onToggle: () => void
  onOpen: () => void
}) {
  return (
    <div className="group relative flex flex-col overflow-hidden rounded-lg border transition-shadow hover:shadow-md">
      {selectable && (
        <div className="absolute left-2 top-2 z-10 opacity-0 transition-opacity group-hover:opacity-100 data-[checked=true]:opacity-100" data-checked={selected}>
          <div className="rounded bg-background/90 p-0.5">
            <Checkbox checked={selected} onCheckedChange={onToggle} aria-label={`Select ${asset.name}`} />
          </div>
        </div>
      )}
      <button type="button" onClick={onOpen} className="flex flex-1 flex-col text-left">
        <div className="flex h-28 items-center justify-center bg-muted/40">
          {asset.kind === "image" ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={asset.previewUrl || "/placeholder.svg"}
              alt={asset.name}
              className="h-full w-full object-cover"
              crossOrigin="anonymous"
              loading="lazy"
            />
          ) : (
            <KindGlyph kind={asset.kind} />
          )}
        </div>
        <div className="flex flex-col gap-1.5 p-2.5">
          <span className="truncate text-sm font-medium" title={asset.name}>
            {asset.name}
          </span>
          <div className="flex flex-wrap items-center gap-1">
            <Badge variant="outline" className="text-[10px]">
              {asset.assetType}
            </Badge>
            <Badge variant={statusVariant(asset.status)} className="text-[10px]">
              {asset.status}
            </Badge>
          </div>
          <div className="flex items-center justify-between text-[11px] text-muted-foreground">
            <span>{asset.fileSizeLabel}</span>
            <span>
              v{asset.version}
              {asset.usageCount > 0 ? ` · ${asset.usageCount} use${asset.usageCount === 1 ? "" : "s"}` : ""}
            </span>
          </div>
        </div>
      </button>
    </div>
  )
}

function KindGlyph({ kind }: { kind: LibraryAsset["kind"] }) {
  const cls = "size-9 text-muted-foreground"
  if (kind === "video") return <Film className={cls} />
  if (kind === "audio") return <Music className={cls} />
  if (kind === "pdf" || kind === "document") return <FileText className={cls} />
  if (kind === "image") return <ImageIcon className={cls} />
  return <FileText className={cls} />
}

function NewFolderDialog({
  open,
  onOpenChange,
  folders,
  onCreated,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  folders: LibraryFolder[]
  onCreated: () => void
}) {
  const [name, setName] = useState("")
  const [parent, setParent] = useState("none")
  const [saving, setSaving] = useState(false)

  async function create() {
    if (!name.trim()) {
      toast.error("Folder name is required")
      return
    }
    setSaving(true)
    const res = await fetch("/api/marketing/library/folders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: name.trim(), parentId: parent === "none" ? null : Number(parent) }),
    })
    setSaving(false)
    if (!res.ok) {
      toast.error("Failed to create folder")
      return
    }
    toast.success("Folder created")
    setName("")
    setParent("none")
    onOpenChange(false)
    onCreated()
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New Folder</DialogTitle>
          <DialogDescription>Organize assets into a folder or nested sub-folder.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label>Folder Name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Brand Guidelines" />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>Parent Folder</Label>
            <Select value={parent} onValueChange={setParent}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Top level</SelectItem>
                {folders.map((f) => (
                  <SelectItem key={f.id} value={String(f.id)}>
                    {f.path}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button onClick={create} disabled={saving}>
            {saving && <Loader2 className="size-4 animate-spin" />} Create Folder
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
