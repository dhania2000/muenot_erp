"use client"
import { useEffect, useMemo, useState } from "react"
import { AlertTriangle, RefreshCw, Radio } from "lucide-react"
import { cn } from "@/lib/utils"
import { AutomationTabs } from "./automation-tabs"

type AutomationEvent = {
  id: number
  workflowId: number
  workflowName: string | null
  module: string | null
  trigger: string | null
  recordId: number
  subscriberCount: number
  status: string
  step: number
  error: string | null
  createdAt: string
  processedAt: string | null
}

type EventsResponse = {
  events: AutomationEvent[]
  subscribers: {
    id: number
    name: string
    module: string | null
    trigger: string | null
    actionCount: number
    enabled: boolean
    runCount: number
    createdAt: string
  }[]
  history: { id: number; runId: number; step: number; type: string; actorId: number | null; createdAt: string }[]
  failed: AutomationEvent[]
  statusSummary: Record<string, number>
  moduleSummary: Record<string, number>
  total: number
}

const STATUS_STYLES: Record<string, string> = {
  completed: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  failed: "bg-destructive/10 text-destructive",
  rejected: "bg-destructive/10 text-destructive",
  cancelled: "bg-muted text-muted-foreground",
  skipped: "bg-muted text-muted-foreground",
  queued: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
  waiting: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
  approval: "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
  external: "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
}

function statusClass(status: string) {
  return STATUS_STYLES[status] ?? "bg-muted text-muted-foreground"
}

function formatDate(value: string | null) {
  if (!value) return "—"
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return value
  return d.toLocaleString()
}

export function EventMonitor() {
  const [data, setData] = useState<EventsResponse | null>(null)
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(true)
  const [status, setStatus] = useState("all")
  const [module, setModule] = useState("all")
  const [search, setSearch] = useState("")

  useEffect(() => {
    const controller = new AbortController()
    async function load() {
      try {
        const params = new URLSearchParams()
        if (status !== "all") params.set("status", status)
        if (module !== "all") params.set("module", module)
        if (search.trim()) params.set("search", search.trim())
        const res = await fetch(`/api/admin/automation/events?${params.toString()}`, {
          cache: "no-store",
          signal: controller.signal,
        })
        const body = await res.json()
        if (!res.ok) throw new Error(body.error || "Unable to load events")
        if (!controller.signal.aborted) {
          setData(body)
          setError("")
        }
      } catch (e) {
        if (!controller.signal.aborted && (e as Error).name !== "AbortError")
          setError(e instanceof Error ? e.message : "Unable to load events")
      } finally {
        if (!controller.signal.aborted) setLoading(false)
      }
    }
    void load()
    const timer = setInterval(load, 20000)
    return () => {
      controller.abort()
      clearInterval(timer)
    }
  }, [status, module, search])

  const moduleOptions = useMemo(() => {
    const keys = new Set<string>()
    for (const k of Object.keys(data?.moduleSummary ?? {})) keys.add(k)
    for (const s of data?.subscribers ?? []) if (s.module) keys.add(s.module)
    return Array.from(keys).sort()
  }, [data])

  const statusOptions = useMemo(() => Object.keys(data?.statusSummary ?? {}).sort(), [data])

  const summaryCards = [
    { label: "Recent events", value: data?.total ?? 0 },
    { label: "Failed", value: data?.failed.length ?? 0, alert: true },
    { label: "Active subscribers", value: data?.subscribers.filter((s) => s.enabled).length ?? 0 },
    { label: "History entries", value: data?.history.length ?? 0 },
  ]

  return (
    <main className="space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold">Event Monitor</h1>
        <p className="text-sm text-muted-foreground">
          Live view of workflow event instances for this tenant. Refreshes every 20 seconds.
        </p>
      </div>
      <AutomationTabs />

      {error && (
        <p role="alert" className="flex items-center gap-2 text-sm text-destructive">
          <AlertTriangle className="size-4" /> {error}
        </p>
      )}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {summaryCards.map((card) => (
          <div key={card.label} className="rounded-lg border p-4">
            <p className="text-xs text-muted-foreground">{card.label}</p>
            <p
              className={cn(
                "mt-1 text-2xl font-semibold tabular-nums",
                card.alert && card.value > 0 && "text-destructive",
              )}
            >
              {card.value}
            </p>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
          Status
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            className="h-9 rounded-md border bg-background px-2 text-sm text-foreground"
          >
            <option value="all">All</option>
            {statusOptions.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
          Module
          <select
            value={module}
            onChange={(e) => setModule(e.target.value)}
            className="h-9 rounded-md border bg-background px-2 text-sm text-foreground"
          >
            <option value="all">All</option>
            {moduleOptions.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
          Search (run or record #)
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            inputMode="numeric"
            placeholder="e.g. 42"
            className="h-9 rounded-md border bg-background px-2 text-sm text-foreground"
          />
        </label>
        <button
          type="button"
          onClick={() => {
            setStatus("all")
            setModule("all")
            setSearch("")
          }}
          className="inline-flex h-9 items-center gap-2 rounded-md border px-3 text-sm font-medium transition-colors hover:bg-accent"
        >
          <RefreshCw className="size-4" /> Reset
        </button>
      </div>

      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left text-xs uppercase text-muted-foreground">
            <tr>
              <th className="px-3 py-2 font-medium">Run</th>
              <th className="px-3 py-2 font-medium">Workflow</th>
              <th className="px-3 py-2 font-medium">Module</th>
              <th className="px-3 py-2 font-medium">Trigger</th>
              <th className="px-3 py-2 font-medium">Record</th>
              <th className="px-3 py-2 font-medium">Status</th>
              <th className="px-3 py-2 font-medium">Step</th>
              <th className="px-3 py-2 font-medium">Created</th>
              <th className="px-3 py-2 font-medium">Processed</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {loading && !data ? (
              <tr>
                <td colSpan={9} className="px-3 py-10 text-center text-muted-foreground">
                  Loading events…
                </td>
              </tr>
            ) : data && data.events.length > 0 ? (
              data.events.map((e) => (
                <tr key={e.id} className="hover:bg-accent/40">
                  <td className="px-3 py-2 font-mono text-xs">#{e.id}</td>
                  <td className="px-3 py-2">{e.workflowName ?? `Workflow #${e.workflowId}`}</td>
                  <td className="px-3 py-2 text-muted-foreground">{e.module ?? "—"}</td>
                  <td className="px-3 py-2 text-muted-foreground">{e.trigger ?? "—"}</td>
                  <td className="px-3 py-2 font-mono text-xs">{e.recordId || "—"}</td>
                  <td className="px-3 py-2">
                    <span className={cn("inline-flex rounded-full px-2 py-0.5 text-xs font-medium", statusClass(e.status))}>
                      {e.status}
                    </span>
                    {e.error && <p className="mt-1 text-xs text-destructive">{e.error}</p>}
                  </td>
                  <td className="px-3 py-2 tabular-nums">{e.step}</td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">{formatDate(e.createdAt)}</td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">{formatDate(e.processedAt)}</td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={9} className="px-3 py-10 text-center text-muted-foreground">
                  <Radio className="mx-auto mb-2 size-6 opacity-50" />
                  No events match the current filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-muted-foreground">
        Events are workflow run instances observed from the existing engine. This view is read-only and scoped to your
        tenant.
      </p>
    </main>
  )
}
