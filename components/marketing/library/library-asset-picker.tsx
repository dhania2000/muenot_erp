"use client"

import { useState } from "react"
import useSWR from "swr"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { FileText, ImageIcon, Film, Music, Loader2, Search } from "lucide-react"
import { jsonFetcher, type LibraryAsset } from "./library-shared"

/**
 * Reusable Asset Picker (Phase 45-47). Any module can drop this in to let a
 * user select an existing Library asset — enforcing central storage and reuse
 * instead of re-uploading. Returns the selected asset to the caller, which is
 * responsible for creating the reference via /api/marketing/library/reference.
 */
export function LibraryAssetPicker({
  open,
  onOpenChange,
  onSelect,
  assetType,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  onSelect: (asset: LibraryAsset) => void
  assetType?: string
}) {
  const [q, setQ] = useState("")
  const params = new URLSearchParams({ picker: "1", pageSize: "40" })
  if (q.trim()) params.set("q", q.trim())
  if (assetType) params.set("type", assetType)
  const { data, isLoading } = useSWR<{ assets: LibraryAsset[] }>(
    open ? `/api/marketing/library?${params.toString()}` : null,
    jsonFetcher,
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-hidden sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Select from Library</DialogTitle>
          <DialogDescription>Reuse a centrally stored asset instead of uploading a new copy.</DialogDescription>
        </DialogHeader>
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search assets…" className="pl-8" />
        </div>
        <div className="grid max-h-[55vh] grid-cols-2 gap-2 overflow-y-auto sm:grid-cols-3">
          {isLoading ? (
            <div className="col-span-full flex justify-center py-10">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : data?.assets.length ? (
            data.assets.map((a) => (
              <button
                key={a.id}
                type="button"
                onClick={() => {
                  onSelect(a)
                  onOpenChange(false)
                }}
                className="flex flex-col overflow-hidden rounded-md border text-left transition-colors hover:border-primary hover:bg-accent"
              >
                <div className="flex h-24 items-center justify-center bg-muted/40">
                  {a.kind === "image" ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={a.previewUrl || "/placeholder.svg"} alt={a.name} className="h-full w-full object-cover" crossOrigin="anonymous" />
                  ) : a.kind === "video" ? (
                    <Film className="size-8 text-muted-foreground" />
                  ) : a.kind === "audio" ? (
                    <Music className="size-8 text-muted-foreground" />
                  ) : a.kind === "pdf" || a.kind === "document" ? (
                    <FileText className="size-8 text-muted-foreground" />
                  ) : (
                    <ImageIcon className="size-8 text-muted-foreground" />
                  )}
                </div>
                <div className="flex flex-col gap-1 p-2">
                  <span className="truncate text-xs font-medium" title={a.name}>{a.name}</span>
                  <div className="flex items-center justify-between">
                    <Badge variant="outline" className="text-[10px]">{a.assetType}</Badge>
                    <span className="text-[10px] text-muted-foreground">{a.fileSizeLabel}</span>
                  </div>
                </div>
              </button>
            ))
          ) : (
            <p className="col-span-full py-10 text-center text-sm text-muted-foreground">No assets found.</p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
