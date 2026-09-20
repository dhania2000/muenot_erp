"use client"
import { useEffect, useState } from "react"
import { AlertTriangle, Mail, RefreshCw, CheckCircle2, XCircle } from "lucide-react"
import { cn } from "@/lib/utils"
import { AutomationTabs } from "./automation-tabs"

type Activity = {
  uid: string
  module: string
  recipient: string
  name: string | null
  subject: string
  status: string
  sentAt: string | null
}

type EmailResponse = {
  activity: Activity[]
  summary: { total: number; sent: number; failed: number; draft: number }
  modules: { module: string; count: number }[]
  senders: { department: string; configured: boolean }[]
}

function formatDate(value: string | null) {
  if (!value) return "—"
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return value
  return d.toLocaleString()
}

function statusClass(status: string) {
  const s = status.toLowerCase()
  if (/sent|opened|delivered/.test(s)) return "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"
  if (/fail|bounce|error/.test(s)) return "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300"
  if (/draft|queued|scheduled|pending/.test(s)) return "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300"
  return "bg-muted text-muted-foreground"
}

export function EmailCenter() {
  const [data, setData] = useState<EmailResponse | null>(null)
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(true)
  const [module, setModule] = useState("all")
  const [status, setStatus] = useState("all")
  const [search, setSearch] = useState("")

  useEffect(() => {
    const controller = new AbortController()
    async function load() {
      try {
        const params = new URLSearchParams()
        if (module !== "all") params.set("module", module)
        if (status !== "all") params.set("status", status)
        if (search.trim()) params.set("search", search.trim())
        const res = await fetch(`/api/admin/automation/email?${params.toString()}`, {
          cache: "no-store",
          signal: controller.signal,
        })
        const body = await res.json()
        if (!res.ok) throw new Error(body.error || "Unable to load email activity")
        if (!controller.signal.aborted) {
          setData(body)
          setError("")
        }
      } catch (e) {
        if (!controller.signal.aborted && (e as Error).name !== "AbortError")
          setError(e instanceof Error ? e.message : "Unable to load email activity")
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
  }, [module, status, search])

  const summaryCards = [
    { label: "Total emails", value: data?.summary.total ?? 0 },
    { label: "Sent / opened", value: data?.summary.sent ?? 0 },
    { label: "Failed / bounced", value: data?.summary.failed ?? 0 },
    { label: "Queued / draft", value: data?.summary.draft ?? 0 },
  ]

  return (
    <main className="space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold">Email Center</h1>
        <p className="text-sm text-muted-foreground">
          Centralized delivery monitor over every module&apos;s outbound email. Read-only — it does not replace the
          per-module email pages or send mail itself. Refreshes every 20 seconds.
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

      <section className="rounded-lg border p-4">
        <h2 className="text-sm font-semibold">Sender configuration</h2>
        <p className="text-xs text-muted-foreground">
          Per-department SMTP/provider status. Credentials are never exposed — only whether a sender is configured.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          {data && data.senders.length > 0 ? (
            data.senders.map((s) => (
              <span
                key={s.department}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium capitalize",
                  s.configured
                    ? "border-emerald-300 text-emerald-700 dark:border-emerald-800 dark:text-emerald-300"
                    : "border-muted text-muted-foreground",
                )}
              >
                {s.configured ? <CheckCircle2 className="size-3.5" /> : <XCircle className="size-3.5" />}
                {s.department}
                <span className="text-muted-foreground">{s.configured ? "configured" : "not configured"}</span>
              </span>
            ))
          ) : (
            <span className="text-xs text-muted-foreground">No sender configuration available.</span>
          )}
        </div>
      </section>

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
          Status
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            className="h-9 rounded-md border bg-background px-2 text-sm text-foreground"
          >
            <option value="all">All</option>
            <option value="sent">Sent</option>
            <option value="failed">Failed</option>
            <option value="draft">Draft</option>
            <option value="queued">Queued</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
          Search
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="recipient or subject"
            className="h-9 w-56 rounded-md border bg-background px-2 text-sm text-foreground"
          />
        </label>
        <button
          type="button"
          onClick={() => {
            setModule("all")
            setStatus("all")
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
              <th className="px-3 py-2 font-medium">Recipient</th>
              <th className="px-3 py-2 font-medium">Subject</th>
              <th className="px-3 py-2 font-medium">Module</th>
              <th className="px-3 py-2 font-medium">Status</th>
              <th className="px-3 py-2 font-medium">Sent</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {loading && !data ? (
              <tr>
                <td colSpan={5} className="px-3 py-10 text-center text-muted-foreground">
                  Loading email activity…
                </td>
              </tr>
            ) : data && data.activity.length > 0 ? (
              data.activity.map((a) => (
                <tr key={a.uid} className="hover:bg-accent/40">
                  <td className="px-3 py-2">
                    <div className="font-medium">{a.recipient}</div>
                    {a.name && <p className="text-xs text-muted-foreground">{a.name}</p>}
                  </td>
                  <td className="px-3 py-2">{a.subject}</td>
                  <td className="px-3 py-2 text-muted-foreground">{a.module}</td>
                  <td className="px-3 py-2">
                    <span className={cn("inline-flex rounded-full px-2 py-0.5 text-xs font-medium", statusClass(a.status))}>
                      {a.status}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">{formatDate(a.sentAt)}</td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={5} className="px-3 py-10 text-center text-muted-foreground">
                  <Mail className="mx-auto mb-2 size-6 opacity-50" />
                  No email activity matches the current filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </main>
  )
}
