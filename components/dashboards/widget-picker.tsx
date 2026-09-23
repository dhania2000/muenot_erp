"use client"

import { useMemo, useState } from "react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { ScrollArea } from "@/components/ui/scroll-area"
import { BarChart3, LayoutGrid, Plus, Table2, Search } from "lucide-react"
import type { WidgetCatalogEntry } from "@/lib/dashboards/types"

const TYPE_ICON = {
  kpi: LayoutGrid,
  chart: BarChart3,
  table: Table2,
} as const

export function WidgetPicker({
  open,
  onOpenChange,
  catalog,
  onAdd,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  catalog: WidgetCatalogEntry[]
  onAdd: (entry: WidgetCatalogEntry) => void
}) {
  const [q, setQ] = useState("")

  const groups = useMemo(() => {
    const term = q.trim().toLowerCase()
    const filtered = term
      ? catalog.filter(
          (c) =>
            c.title.toLowerCase().includes(term) ||
            c.module.toLowerCase().includes(term) ||
            c.description.toLowerCase().includes(term),
        )
      : catalog
    const map = new Map<string, WidgetCatalogEntry[]>()
    for (const entry of filtered) {
      const list = map.get(entry.module) ?? []
      list.push(entry)
      map.set(entry.module, list)
    }
    return Array.from(map.entries())
  }, [catalog, q])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] gap-0 overflow-hidden p-0 sm:max-w-2xl">
        <DialogHeader className="border-b p-4">
          <DialogTitle>Add a widget</DialogTitle>
          <DialogDescription>Only widgets you have permission to view are listed.</DialogDescription>
          <div className="relative mt-2">
            <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              autoFocus
              placeholder="Search widgets..."
              value={q}
              onChange={(e) => setQ(e.target.value)}
              className="pl-8"
            />
          </div>
        </DialogHeader>
        <ScrollArea className="max-h-[55vh]">
          <div className="space-y-5 p-4">
            {groups.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">No widgets match “{q}”.</p>
            ) : (
              groups.map(([module, entries]) => (
                <div key={module}>
                  <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    {module}
                  </h3>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {entries.map((entry) => {
                      const Icon = TYPE_ICON[entry.type]
                      return (
                        <div
                          key={entry.key}
                          className="flex items-start justify-between gap-2 rounded-lg border p-3 hover:bg-muted/40"
                        >
                          <div className="min-w-0">
                            <div className="flex items-center gap-1.5">
                              <Icon className="size-3.5 shrink-0 text-muted-foreground" />
                              <span className="truncate text-sm font-medium">{entry.title}</span>
                            </div>
                            <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{entry.description}</p>
                            <Badge variant="secondary" className="mt-1.5 text-[10px] capitalize">
                              {entry.type}
                            </Badge>
                          </div>
                          <Button
                            type="button"
                            size="icon"
                            variant="ghost"
                            className="size-7 shrink-0"
                            aria-label={`Add ${entry.title}`}
                            onClick={() => onAdd(entry)}
                          >
                            <Plus className="size-4" />
                          </Button>
                        </div>
                      )
                    })}
                  </div>
                </div>
              ))
            )}
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  )
}
