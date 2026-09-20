"use client"
import { useEffect, useState } from "react"
import { AlertTriangle, Bell, RefreshCw } from "lucide-react"
import Link from "next/link"
import { cn } from "@/lib/utils"
import { AutomationTabs } from "./automation-tabs"

type Delivery = {
  id: number
  userId: number
  recipient: string
  actorName: string | null
  module: string | null
  action: string
  title: string
  body: string | null
  link: string | null
  read: boolean
  createdAt: string
}

type NotificationResponse = {
  deliveries: Delivery[]
  summary: { total: number; unread: number }
  modules: { module: string; count: number }[]
  actions: { action: string; count: number }[]
}

function formatDate(value: string) {
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return value
  return d.toLocaleString()
}

export function NotificationCenter() {
  const [data, setData] = useState<NotificationResponse | null>(null)
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(true)
  const [module, setModule] = useState("all")
  const [action, setAction] = useState("all")
  const [read, setRead] = useState("all")
  const [search, setSearch] = useState("")

  useEffect(() => {
    const controller = new AbortController()
    async function load() {
      try {
        const params = new URLSearchParams()
        if (module !== "all") params.set("module", module)
        if (action !== "all") params.set("action", action)
        if (read !== "all") params.set("read", read)
        if (search.trim()) params.set("search", search.trim())
        const res = await fetch(`/api/admin/automation/notifications?${params.toString()}`, {
          cache: "no-store",
          signal: controller.signal,
        })
        const body = await res.json()
        if (!res.ok) throw new Error(body.error || "Unable to load notifications")
        if (!controller.signal.aborted) {
          setData(body)
          setError("")
        }
      } catch (e) {
        if (!controller.signal.aborted && (e as Error).name !== "AbortError")
          setError(e instanceof Error ? e.message : "Unable to load notifications")
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
  }, [module, action, read, search])

  const summaryCards = [
    { label: "Total deliveries", value: data?.summary.total ?? 0 },
    { label: "Unread", value: data?.summary.unread ?? 0 },
    { label: "Modules", value: data?.modules.length ?? 0 },
    { label: "Action types", value: data?.actions.length ?? 0 },
  ]

  return (
    <main className="space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold">Notification Center</h1>
        <p className="text-sm text-muted-foreground">
          Delivery monitor over every notification sent across modules. Refreshes every 20 seconds.
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
            <p className="mt-1 text-2xl font-semibold tabular-nums">{card.value}</p>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
          Module
          <select
            value={module}
            onChange={(e) => setModule(e.target.value)}
            className="h-9 rounded-md border bg-background px-2 text-sm text-foreground"
          >
            <option value="all">All</option>
            {data?.modules.map((m) => (
              <option key={m.module} value={m.module}>
                {m.module} ({m.count})
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
          Action
          <select
            value={action}
            onChange={(e) => setAction(e.target.value)}
            className="h-9 rounded-md border bg-background px-2 text-sm text-foreground"
          >
            <option value="all">All</option>
            {data?.actions.map((a) => (
              <option key={a.action} value={a.action}>
                {a.action} ({a.count})
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
          Read state
          <select
            value={read}
            onChange={(e) => setRead(e.target.value)}
            className="h-9 rounded-md border bg-background px-2 text-sm text-foreground"
          >
            <option value="all">All</option>
            <option value="unread">Unread</option>
            <option value="read">Read</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
          Search
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="title, body or recipient"
            className="h-9 w-56 rounded-md border bg-background px-2 text-sm text-foreground"
          />
        </label>
        <button
          type="button"
          onClick={() => {
            setModule("all")
            setAction("all")
            setRead("all")
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
              <th className="px-3 py-2 font-medium">Notification</th>
              <th className="px-3 py-2 font-medium">Recipient</th>
              <th className="px-3 py-2 font-medium">Module</th>
              <th className="px-3 py-2 font-medium">Action</th>
              <th className="px-3 py-2 font-medium">State</th>
              <th className="px-3 py-2 font-medium">Created</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {loading && !data ? (
              <tr>
                <td colSpan={6} className="px-3 py-10 text-center text-muted-foreground">
                  Loading notifications…
                </td>
              </tr>
            ) : data && data.deliveries.length > 0 ? (
              data.deliveries.map((d) => (
                <tr key={d.id} className="hover:bg-accent/40">
                  <td className="px-3 py-2">
                    <div className="font-medium">
                      {d.link ? (
                        <Link href={d.link} className="hover:underline">
                          {d.title}
                        </Link>
                      ) : (
                        d.title
                      )}
                    </div>
                    {d.body && <p className="text-xs text-muted-foreground line-clamp-2">{d.body}</p>}
                    {d.actorName && <p className="text-xs text-muted-foreground">by {d.actorName}</p>}
                  </td>
                  <td className="px-3 py-2">{d.recipient}</td>
                  <td className="px-3 py-2 text-muted-foreground">{d.module ?? "system"}</td>
                  <td className="px-3 py-2 text-muted-foreground">{d.action}</td>
                  <td className="px-3 py-2">
                    <span
                      className={cn(
                        "inline-flex rounded-full px-2 py-0.5 text-xs font-medium",
                        d.read
                          ? "bg-muted text-muted-foreground"
                          : "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
                      )}
                    >
                      {d.read ? "read" : "unread"}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">{formatDate(d.createdAt)}</td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={6} className="px-3 py-10 text-center text-muted-foreground">
                  <Bell className="mx-auto mb-2 size-6 opacity-50" />
                  No notifications match the current filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-muted-foreground">
        This administration view aggregates deliveries from the global notifications table. It is read-only and does not
        replace the per-user notification bell.
      </p>
    </main>
  )
}
