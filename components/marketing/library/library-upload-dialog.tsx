"use client"

import { useCallback, useRef, useState } from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Badge } from "@/components/ui/badge"
import { UploadCloud, X, CheckCircle2, AlertTriangle, Loader2, FileIcon } from "lucide-react"
import {
  ASSET_TYPES,
  ASSET_CATEGORIES,
  ASSET_STATUSES,
  humanBytes,
  type LibraryFolder,
} from "./library-shared"

type QueueItem = {
  file: File
  status: "pending" | "uploading" | "done" | "error" | "duplicate"
  message?: string
}

export function LibraryUploadDialog({
  open,
  onOpenChange,
  folders,
  defaultFolderId,
  onUploaded,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  folders: LibraryFolder[]
  defaultFolderId?: number | null
  onUploaded: () => void
}) {
  const [queue, setQueue] = useState<QueueItem[]>([])
  const [dragging, setDragging] = useState(false)
  const [busy, setBusy] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const [category, setCategory] = useState<string>("")
  const [assetType, setAssetType] = useState<string>("")
  const [status, setStatus] = useState<string>("Active")
  const [folderId, setFolderId] = useState<string>(defaultFolderId ? String(defaultFolderId) : "")
  const [tags, setTags] = useState<string>("")
  const [description, setDescription] = useState<string>("")

  const addFiles = useCallback((files: FileList | File[]) => {
    const items: QueueItem[] = Array.from(files).map((file) => ({ file, status: "pending" }))
    setQueue((q) => [...q, ...items])
  }, [])

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      setDragging(false)
      if (e.dataTransfer.files?.length) addFiles(e.dataTransfer.files)
    },
    [addFiles],
  )

  function reset() {
    setQueue([])
    setCategory("")
    setAssetType("")
    setStatus("Active")
    setTags("")
    setDescription("")
  }

  async function uploadOne(item: QueueItem, index: number, force: boolean) {
    const fd = new FormData()
    fd.append("file", item.file)
    if (category) fd.append("category", category)
    if (assetType) fd.append("asset_type", assetType)
    if (status) fd.append("status", status)
    if (folderId) fd.append("folder_id", folderId)
    if (tags.trim()) fd.append("tags", tags.trim())
    if (description.trim()) fd.append("description", description.trim())
    if (force) fd.append("force", "1")

    const res = await fetch("/api/marketing/library", { method: "POST", body: fd })
    if (res.status === 409) {
      const data = await res.json().catch(() => ({}))
      setQueue((q) =>
        q.map((it, i) =>
          i === index
            ? { ...it, status: "duplicate", message: `Duplicate of ${data.existing?.assetId || "existing asset"}` }
            : it,
        ),
      )
      return
    }
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      setQueue((q) =>
        q.map((it, i) => (i === index ? { ...it, status: "error", message: data.error || "Upload failed" } : it)),
      )
      return
    }
    setQueue((q) => q.map((it, i) => (i === index ? { ...it, status: "done" } : it)))
  }

  async function runUpload() {
    if (!queue.length) {
      toast.error("Add at least one file")
      return
    }
    setBusy(true)
    let successes = 0
    for (let i = 0; i < queue.length; i++) {
      if (queue[i].status === "done") continue
      setQueue((q) => q.map((it, idx) => (idx === i ? { ...it, status: "uploading" } : it)))
      try {
        await uploadOne(queue[i], i, false)
        successes++
      } catch {
        setQueue((q) => q.map((it, idx) => (idx === i ? { ...it, status: "error", message: "Network error" } : it)))
      }
    }
    setBusy(false)
    if (successes > 0) onUploaded()
    // Re-read latest queue to decide messaging.
    setQueue((q) => {
      const dupes = q.filter((it) => it.status === "duplicate").length
      const done = q.filter((it) => it.status === "done").length
      if (done) toast.success(`${done} asset${done > 1 ? "s" : ""} uploaded`)
      if (dupes) toast.warning(`${dupes} skipped as duplicates — use "Upload anyway" to force`)
      return q
    })
  }

  async function forceDuplicates() {
    setBusy(true)
    for (let i = 0; i < queue.length; i++) {
      if (queue[i].status !== "duplicate") continue
      setQueue((q) => q.map((it, idx) => (idx === i ? { ...it, status: "uploading" } : it)))
      await uploadOne(queue[i], i, true).catch(() => {})
    }
    setBusy(false)
    onUploaded()
    toast.success("Forced duplicate uploads complete")
  }

  const hasDuplicates = queue.some((it) => it.status === "duplicate")

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!busy) {
          onOpenChange(v)
          if (!v) reset()
        }
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Upload Assets</DialogTitle>
          <DialogDescription>
            Drag & drop or browse. Files are validated, de-duplicated by content, and stored centrally.
          </DialogDescription>
        </DialogHeader>

        <div
          onDragOver={(e) => {
            e.preventDefault()
            setDragging(true)
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          onClick={() => inputRef.current?.click()}
          className={`flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed p-8 text-center transition-colors ${
            dragging ? "border-primary bg-primary/5" : "border-muted-foreground/25"
          }`}
        >
          <UploadCloud className="size-8 text-muted-foreground" />
          <p className="text-sm font-medium">Drop files here or click to browse</p>
          <p className="text-xs text-muted-foreground">Single or multiple files, up to 200 MB each</p>
          <input
            ref={inputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              if (e.target.files?.length) addFiles(e.target.files)
              e.target.value = ""
            }}
          />
        </div>

        {queue.length > 0 && (
          <div className="flex flex-col gap-1.5">
            {queue.map((it, i) => (
              <div key={i} className="flex items-center gap-2 rounded-md border p-2 text-sm">
                <FileIcon className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate" title={it.file.name}>
                  {it.file.name}
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">{humanBytes(it.file.size)}</span>
                {it.status === "uploading" && <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" />}
                {it.status === "done" && <CheckCircle2 className="size-4 shrink-0 text-emerald-600" />}
                {it.status === "duplicate" && (
                  <Badge variant="outline" className="shrink-0 gap-1 text-amber-600">
                    <AlertTriangle className="size-3" /> Dup
                  </Badge>
                )}
                {it.status === "error" && (
                  <span className="shrink-0 text-xs text-destructive" title={it.message}>
                    {it.message || "Error"}
                  </span>
                )}
                {(it.status === "pending" || it.status === "error") && !busy && (
                  <button
                    type="button"
                    onClick={() => setQueue((q) => q.filter((_, idx) => idx !== i))}
                    className="shrink-0 text-muted-foreground hover:text-foreground"
                    aria-label="Remove file"
                  >
                    <X className="size-4" />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label>Asset Type</Label>
            <Select value={assetType} onValueChange={setAssetType}>
              <SelectTrigger>
                <SelectValue placeholder="Auto-detect" />
              </SelectTrigger>
              <SelectContent>
                {ASSET_TYPES.map((t) => (
                  <SelectItem key={t} value={t}>
                    {t}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>Category</Label>
            <Select value={category} onValueChange={setCategory}>
              <SelectTrigger>
                <SelectValue placeholder="Select category" />
              </SelectTrigger>
              <SelectContent>
                {ASSET_CATEGORIES.map((c) => (
                  <SelectItem key={c} value={c}>
                    {c}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>Folder</Label>
            <Select value={folderId} onValueChange={setFolderId}>
              <SelectTrigger>
                <SelectValue placeholder="No folder" />
              </SelectTrigger>
              <SelectContent>
                {folders.map((f) => (
                  <SelectItem key={f.id} value={String(f.id)}>
                    {f.path}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>Status</Label>
            <Select value={status} onValueChange={setStatus}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ASSET_STATUSES.filter((s) => s !== "Expired").map((s) => (
                  <SelectItem key={s} value={s}>
                    {s}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1.5 sm:col-span-2">
            <Label>Tags (comma separated)</Label>
            <Input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="Muenot, Corporate, 2026" />
          </div>
          <div className="flex flex-col gap-1.5 sm:col-span-2">
            <Label>Description</Label>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional description applied to all files in this upload"
              rows={2}
            />
          </div>
        </div>

        <DialogFooter className="gap-2">
          {hasDuplicates && (
            <Button type="button" variant="outline" disabled={busy} onClick={forceDuplicates}>
              Upload duplicates anyway
            </Button>
          )}
          <Button type="button" disabled={busy || !queue.length} onClick={runUpload}>
            {busy && <Loader2 className="size-4 animate-spin" />}
            Upload {queue.filter((q) => q.status !== "done").length || ""}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
