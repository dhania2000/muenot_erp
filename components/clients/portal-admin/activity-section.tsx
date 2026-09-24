"use client"

import { useMemo, useState } from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { EmptyState, SearchInput, SectionHeader } from "./shared"
import { ACTIVITY_LOG, ACTIVITY_CATEGORY_META } from "./data"
import { Download, History } from "lucide-react"

export function ActivitySection() {
  const [query, setQuery] = useState("")
  const [category, setCategory] = useState("all")

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return ACTIVITY_LOG.filter((a) => {
      if (category !== "all" && a.category !== category) return false
      if (!q) return true
      return [a.actor, a.action, a.target, a.client].some((v) => v.toLowerCase().includes(q))
    })
  }, [query, category])

  return (
    <div className="grid gap-4">
      <SectionHeader
        title="Audit & Activity Log"
        description="A chronological, tamper-evident record of every action taken across the client portal."
        actions={
          <Button size="sm" variant="outline" onClick={() => toast.success("Audit log exported")}>
            <Download className="size-4" /> Export log
          </Button>
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        <SearchInput value={query} onChange={setQuery} placeholder="Search activity…" className="w-full sm:w-72" />
        <Select value={category} onValueChange={setCategory}>
          <SelectTrigger className="w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All categories</SelectItem>
            {Object.entries(ACTIVITY_CATEGORY_META).map(([key, meta]) => (
              <SelectItem key={key} value={key}>{meta.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {filtered.length === 0 ? (
        <EmptyState icon={History} title="No activity" description="Portal actions will be recorded here." />
      ) : (
        <div className="rounded-xl border border-border bg-card">
          <ol className="divide-y divide-border">
            {filtered.map((a) => {
              const meta = ACTIVITY_CATEGORY_META[a.category]
              return (
                <li key={a.id} className="flex items-start gap-3 px-4 py-3">
                  <span className={`mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg ${meta.className}`}>
                    <meta.icon className="size-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm">
                      <span className="font-medium">{a.actor}</span> {a.action}{" "}
                      <span className="font-medium">{a.target}</span>
                    </p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {a.client} · {a.ip} · {meta.label}
                    </p>
                  </div>
                  <time className="shrink-0 text-xs text-muted-foreground">{a.timestamp}</time>
                </li>
              )
            })}
          </ol>
        </div>
      )}
    </div>
  )
}
