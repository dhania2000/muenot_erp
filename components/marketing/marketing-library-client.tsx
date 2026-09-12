"use client"

import { useState } from "react"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { FileImage, FileText, Film, Mail, LayoutTemplate, Search, Upload } from "lucide-react"
import { MarketingHeader, StatCard } from "@/components/marketing/marketing-shared"

type AssetType = "Image" | "Document" | "Video" | "Email Template" | "Landing Page"

type Asset = {
  id: string
  name: string
  type: AssetType
  size: string
  updated: string
}

const TYPE_ICON: Record<AssetType, React.ComponentType<{ className?: string }>> = {
  Image: FileImage,
  Document: FileText,
  Video: Film,
  "Email Template": Mail,
  "Landing Page": LayoutTemplate,
}

const SEED: Asset[] = []

const FILTERS: (AssetType | "All")[] = ["All", "Image", "Document", "Video", "Email Template", "Landing Page"]

export function MarketingLibraryClient() {
  const [filter, setFilter] = useState<AssetType | "All">("All")
  const [q, setQ] = useState("")

  const filtered = SEED.filter(
    (a) => (filter === "All" || a.type === filter) && a.name.toLowerCase().includes(q.toLowerCase()),
  )

  return (
    <main className="flex flex-col gap-6 p-6">
      <MarketingHeader
        eyebrow="Marketing"
        title="Library"
        description="A central store for reusable marketing assets, templates, and brand collateral."
        action={
          <Button>
            <Upload className="size-4" />
            Upload Asset
          </Button>
        }
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatCard label="Total Assets" value={SEED.length} icon={FileImage} />
        <StatCard label="Email Templates" value={SEED.filter((a) => a.type === "Email Template").length} icon={Mail} />
        <StatCard label="Storage Used" value="0 MB" hint="of 5 GB" icon={Upload} />
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative max-w-xs flex-1">
          <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input placeholder="Search assets..." value={q} onChange={(e) => setQ(e.target.value)} className="pl-8" />
        </div>
        <div className="flex flex-wrap gap-2">
          {FILTERS.map((f) => (
            <Button key={f} variant={filter === f ? "default" : "outline"} size="sm" onClick={() => setFilter(f)}>
              {f}
            </Button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {filtered.map((a) => {
          const Icon = TYPE_ICON[a.type]
          return (
            <Card key={a.id}>
              <CardContent className="flex flex-col gap-3 pt-6">
                <div className="flex aspect-video items-center justify-center rounded-md bg-muted">
                  <Icon className="size-8 text-muted-foreground" />
                </div>
                <div className="flex flex-col gap-1">
                  <span className="truncate text-sm font-medium" title={a.name}>
                    {a.name}
                  </span>
                  <div className="flex items-center justify-between">
                    <Badge variant="outline">{a.type}</Badge>
                    <span className="text-xs text-muted-foreground">{a.size}</span>
                  </div>
                  <span className="text-xs text-muted-foreground">Updated {a.updated}</span>
                </div>
              </CardContent>
            </Card>
          )
        })}
        {filtered.length === 0 && (
          <div className="col-span-full rounded-lg border border-dashed p-10 text-center text-sm text-muted-foreground">
            No assets match your filters.
          </div>
        )}
      </div>
    </main>
  )
}
