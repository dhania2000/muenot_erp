"use client"

import { useState } from "react"
import useSWR from "swr"
import { fetcher } from "@/lib/fetcher"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Search, Pin, Loader2, BellRing, CheckCheck } from "lucide-react"
import {
  type FeedNotice, type Meta,
  PriorityBadge, formatDate,
} from "./shared"

type FeedResponse = {
  notices: FeedNotice[]
  counts: { active: number; unread: number; important: number; urgent: number; ackPending: number }
  hasEmployeeRecord: boolean
  canManage: boolean
}

function CountPill({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <div className="rounded-lg border bg-card px-3 py-2">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`text-xl font-semibold tabular-nums ${tone ?? ""}`}>{value}</p>
    </div>
  )
}

export function FeedView({ meta, onView }: { meta: Meta | undefined; onView: (id: number) => void }) {
  const [q, setQ] = useState("")
  const [category, setCategory] = useState("")
  const [priority, setPriority] = useState("")

  const params = new URLSearchParams({ page: "1", pageSize: "50" })
  if (q.trim()) params.set("q", q.trim())
  if (category) params.set("category", category)
  if (priority) params.set("priority", priority)

  const { data, isLoading } = useSWR<FeedResponse>(`/api/notice-board?${params.toString()}`, fetcher, { keepPreviousData: true })
  const counts = data?.counts

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-5">
        <CountPill label="Active" value={counts?.active ?? 0} />
        <CountPill label="Unread" value={counts?.unread ?? 0} tone="text-blue-500" />
        <CountPill label="Important" value={counts?.important ?? 0} tone="text-amber-600 dark:text-amber-400" />
        <CountPill label="Urgent" value={counts?.urgent ?? 0} tone="text-destructive" />
        <CountPill label="Ack Pending" value={counts?.ackPending ?? 0} />
      </div>

      {data && !data.hasEmployeeRecord && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-sm text-amber-700 dark:text-amber-400">
          Your account is not linked to an employee record, so targeted notices may not appear. Contact HR to link your profile.
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-48 flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search notices…" className="pl-8" />
        </div>
        <Select value={category || "all"} onValueChange={(v) => setCategory(v === "all" ? "" : v)}>
          <SelectTrigger className="w-40"><SelectValue placeholder="Category" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All categories</SelectItem>
            {(meta?.categories ?? []).map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={priority || "all"} onValueChange={(v) => setPriority(v === "all" ? "" : v)}>
          <SelectTrigger className="w-36"><SelectValue placeholder="Priority" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All priorities</SelectItem>
            <SelectItem value="normal">Normal</SelectItem>
            <SelectItem value="important">Important</SelectItem>
            <SelectItem value="urgent">Urgent</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {isLoading && !data ? (
        <div className="flex items-center justify-center py-20 text-muted-foreground">
          <Loader2 className="mr-2 size-5 animate-spin" /> Loading notices…
        </div>
      ) : data && data.notices.length === 0 ? (
        <div className="rounded-lg border border-dashed py-16 text-center text-muted-foreground">
          <BellRing className="mx-auto mb-2 size-6 opacity-60" />
          No notices to show.
        </div>
      ) : (
        <ul className="grid gap-2.5">
          {data?.notices.map((n) => {
            const unread = n.status === "published" && !n.is_read
            return (
              <li key={n.id}>
                <button
                  onClick={() => onView(n.id)}
                  className={`flex w-full flex-col gap-1.5 rounded-lg border bg-card p-4 text-left transition-colors hover:bg-muted/40 ${unread ? "border-l-2 border-l-primary" : ""}`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <span className="flex items-center gap-2 font-medium">
                      {n.pinned && <Pin className="size-3.5 shrink-0 text-muted-foreground" />}
                      {n.heading}
                    </span>
                    <div className="flex shrink-0 items-center gap-1.5">
                      {unread && <Badge className="bg-primary/10 text-primary">New</Badge>}
                      <PriorityBadge priority={n.priority} />
                    </div>
                  </div>
                  <p className="line-clamp-2 text-sm text-muted-foreground">{n.description}</p>
                  <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <Badge variant="secondary" className="font-normal">{n.category}</Badge>
                    {n.status === "expired" && <Badge variant="outline">Expired</Badge>}
                    <span>{formatDate(n.published_at ?? n.created_at)}</span>
                    {n.created_by_name && <span>· {n.created_by_name}</span>}
                    {n.acknowledgement_required && (
                      n.is_acknowledged
                        ? <span className="flex items-center gap-1 text-emerald-600 dark:text-emerald-400"><CheckCheck className="size-3.5" /> Acknowledged</span>
                        : <Badge variant="outline" className="text-amber-600 dark:text-amber-400">Ack required</Badge>
                    )}
                  </div>
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
