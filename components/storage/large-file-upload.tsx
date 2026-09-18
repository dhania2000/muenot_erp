"use client"

import { useCallback, useRef, useState } from "react"
import { toast } from "sonner"
import { Upload, X, RotateCw, FileCheck2, AlertCircle, Ban } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { cn } from "@/lib/utils"
import { useLargeUpload, type UploadCategory } from "@/hooks/use-large-upload"

const CATEGORIES: { value: UploadCategory; label: string }[] = [
  { value: "video", label: "Video" },
  { value: "image", label: "Image" },
  { value: "document", label: "Document" },
  { value: "zip", label: "ZIP / Archive" },
  { value: "training", label: "Training file" },
  { value: "employee", label: "Employee file" },
  { value: "other", label: "Other" },
]

function formatBytes(bytes: number): string {
  if (!bytes) return "0 B"
  const units = ["B", "KB", "MB", "GB", "TB"]
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

export type LargeFileUploadProps = {
  /** Restrict/hint the category; when omitted the user picks one. */
  category?: UploadCategory
  /** Optional folder within the tenant namespace. */
  path?: string
  /** Called after a file is fully stored, with the tenant-scoped key. */
  onUploaded?: (result: { key: string; file: File }) => void
  accept?: string
  className?: string
}

/**
 * SPEC 30 — Drop-in resumable large-file uploader.
 *
 * Supports videos, images, documents, ZIPs, training and employee files via
 * chunked multipart upload with live progress, per-chunk retry, and cancel.
 */
export function LargeFileUpload({ category, path, onUploaded, accept, className }: LargeFileUploadProps) {
  const { state, upload, cancel, reset } = useLargeUpload()
  const [file, setFile] = useState<File | null>(null)
  const [chosenCategory, setChosenCategory] = useState<UploadCategory>(category ?? "other")
  const [dragOver, setDragOver] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const busy = state.status === "starting" || state.status === "uploading" || state.status === "completing"

  const pick = useCallback((f: File | null) => {
    if (!f) return
    setFile(f)
    reset()
  }, [reset])

  const start = useCallback(async () => {
    if (!file) return
    const res = await upload(file, { category: category ?? chosenCategory, path })
    if (res) {
      toast.success(`${file.name} uploaded`)
      onUploaded?.({ key: res.key, file })
    }
  }, [file, upload, category, chosenCategory, path, onUploaded])

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      setDragOver(false)
      if (busy) return
      pick(e.dataTransfer.files?.[0] ?? null)
    },
    [busy, pick],
  )

  return (
    <div className={cn("flex flex-col gap-4", className)}>
      {/* Drop zone / file picker */}
      <div
        role="button"
        tabIndex={0}
        aria-label="Choose or drop a file to upload"
        onClick={() => !busy && inputRef.current?.click()}
        onKeyDown={(e) => {
          if ((e.key === "Enter" || e.key === " ") && !busy) {
            e.preventDefault()
            inputRef.current?.click()
          }
        }}
        onDragOver={(e) => {
          e.preventDefault()
          if (!busy) setDragOver(true)
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        className={cn(
          "flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed p-8 text-center transition-colors",
          dragOver ? "border-primary bg-primary/5" : "border-border",
          busy ? "pointer-events-none opacity-60" : "cursor-pointer hover:bg-muted/50",
        )}
      >
        <Upload className="size-6 text-muted-foreground" aria-hidden="true" />
        <div className="text-sm font-medium">{file ? file.name : "Drop a file here or click to browse"}</div>
        <div className="text-xs text-muted-foreground">
          {file ? formatBytes(file.size) : "Videos, images, documents, ZIPs, and training or employee files"}
        </div>
        <input
          ref={inputRef}
          type="file"
          accept={accept}
          className="sr-only"
          onChange={(e) => pick(e.target.files?.[0] ?? null)}
        />
      </div>

      {/* Category selector (only when not fixed by the caller) */}
      {!category && (
        <div className="flex items-center gap-3">
          <span className="text-sm text-muted-foreground">Type</span>
          <Select
            value={chosenCategory}
            onValueChange={(v) => setChosenCategory(v as UploadCategory)}
            disabled={busy}
          >
            <SelectTrigger className="w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CATEGORIES.map((c) => (
                <SelectItem key={c.value} value={c.value}>
                  {c.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {/* Progress */}
      {(busy || state.status === "done" || state.status === "error" || state.status === "canceled") && (
        <div className="flex flex-col gap-2">
          <Progress value={state.progress} aria-label="Upload progress" />
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span className="flex items-center gap-1.5">
              {state.status === "done" && <FileCheck2 className="size-3.5 text-emerald-600" aria-hidden="true" />}
              {state.status === "error" && <AlertCircle className="size-3.5 text-destructive" aria-hidden="true" />}
              {state.status === "canceled" && <Ban className="size-3.5" aria-hidden="true" />}
              {state.retrying && <RotateCw className="size-3.5 animate-spin" aria-hidden="true" />}
              {state.status === "starting" && "Starting…"}
              {state.status === "uploading" && (state.retrying ? "Retrying chunk…" : "Uploading…")}
              {state.status === "completing" && "Finalizing…"}
              {state.status === "done" && "Completed"}
              {state.status === "canceled" && "Canceled"}
              {state.status === "error" && (state.error || "Upload failed")}
            </span>
            <span>
              {formatBytes(state.uploadedBytes)} / {formatBytes(state.totalBytes)} ({state.progress}%)
            </span>
          </div>
        </div>
      )}

      {/* Actions */}
      <div className="flex items-center gap-2">
        {!busy && state.status !== "done" && (
          <Button type="button" onClick={start} disabled={!file}>
            {state.status === "error" || state.status === "canceled" ? "Retry upload" : "Upload"}
          </Button>
        )}
        {busy && (
          <Button type="button" variant="destructive" onClick={cancel}>
            <X className="mr-1.5 size-4" aria-hidden="true" />
            Cancel
          </Button>
        )}
        {state.status === "done" && (
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              setFile(null)
              reset()
            }}
          >
            Upload another
          </Button>
        )}
      </div>
    </div>
  )
}
