"use client"

import { useState } from "react"
import useSWR from "swr"
import Link from "next/link"
import { AlertTriangle, RefreshCw, Download, ChevronRight, ShieldAlert, CircleSlash } from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Input } from "@/components/ui/input"

type Severity = "critical" | "high" | "medium" | "low" | "ok"
type ScopeLevel = "group" | "company" | "branch" | "department"

interface RiskItem {
  id: string
  label: string
  detail?: string | null
  severity: Severity
  amount?: number | null
  occurredAt?: string | null
  sensitive?: Record<string, string>
}
type Category = "operational" | "finance" | "hr" | "contracts"
interface SourceResult {
  key: string
  label: string
  category: Category
  available: boolean
  scopeApplied: boolean
  withheld: boolean
  count: number
  severity: Severity
  asOf: string | null
  drillHref: string
  note?: string | null
  items: RiskItem[]
}
interface Dashboard {
  scope: { level: ScopeLevel; value?: string | null }
  computedAt: string
  masked: boolean
  totals: {
    openItems: number
    critical: number
    high: number
    sourcesAvailable: number
    sourcesMissing: number
    sourcesWithheld: number
  }
  categories: Record<string, { openItems: number; critical: number; sources: number }>
  sources: SourceResult[]
}
interface ApiResponse {
  ok: boolean
  dashboard: Dashboard
  meta: {
    fromCache: boolean
    stale: boolean
    staleThresholdMs: number
    canViewSensitive: boolean
    restricted: boolean
    narrowed: boolean
    allowed: { level: ScopeLevel; values: string[] } | null
  }
}

class ApiError extends Error {}

const fetcher = async (url: string): Promise<ApiResponse> => {
  const r = await fetch(url)
  const body = await r.json().catch(() => ({}))
  if (!r.ok) throw new ApiError(body?.error || `Request failed (${r.status})`)
  return body
}

const CATEGORIES: Category[] = ["operational", "finance", "hr", "contracts"]

const SEV_STYLES: Record<Severity, string> = {
  critical: "bg-destructive/15 text-destructive border-destructive/30",
  high: "bg-orange-500/15 text-orange-600 border-orange-500/30 dark:text-orange-400",
  medium: "bg-amber-500/15 text-amber-600 border-amber-500/30 dark:text-amber-400",
  low: "bg-muted text-muted-foreground border-border",
  ok: "bg-emerald-500/15 text-emerald-600 border-emerald-500/30 dark:text-emerald-400",
}

const CATEGORY_LABELS: Record<string, string> = {
  operational: "Operational & security",
  finance: "Finance & tax compliance",
  hr: "HR documents, attendance & training",
  contracts: "Contract obligations",
}

function SeverityBadge({ severity }: { severity: Severity }) {
  return (
    <Badge variant="outline" className={SEV_STYLES[severity]}>
      {severity}
    </Badge>
  )
}

function relativeAge(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  const mins = Math.round(ms / 60000)
  if (mins < 1) return "just now"
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.round(hrs / 24)}d ago`
}

export function RiskComplianceClient() {
  const [level, setLevel] = useState<ScopeLevel>("group")
  const [value, setValue] = useState("")
  const [refreshing, setRefreshing] = useState(false)
  const [refreshError, setRefreshError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)

  const needsValue = level !== "group" && !value.trim()
  const params = new URLSearchParams({ level })
  if (level !== "group" && value.trim()) params.set("value", value.trim())
  const key = needsValue ? null : `/api/admin/risk-compliance?${params.toString()}`

  const { data, error, isLoading, mutate } = useSWR<ApiResponse>(key, fetcher, {
    revalidateOnFocus: false,
  })

  async function handleRefresh() {
    setRefreshing(true)
    setRefreshError(null)
    try {
      const r = await fetch("/api/admin/risk-compliance/refresh", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": `refresh-${crypto.randomUUID()}` },
        body: JSON.stringify({ level, value: level === "group" ? null : value.trim() }),
      })
      if (!r.ok) {
        const body = await r.json().catch(() => ({}))
        setRefreshError(body?.error || "Refresh failed")
        return
      }
      await mutate()
    } finally {
      setRefreshing(false)
    }
  }

  const dash = data?.dashboard
  const meta = data?.meta
  const grouped: Record<Category, SourceResult[]> = { operational: [], finance: [], hr: [], contracts: [] }
  dash?.sources.forEach((s) => grouped[s.category]?.push(s))

  const exportParams = new URLSearchParams({ level })
  if (level !== "group" && value) exportParams.set("value", value)

  return (
    <section className="mx-auto w-full max-w-7xl px-4 py-6 md:px-6 lg:px-8">
      <header className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2 text-primary">
            <ShieldAlert className="size-5" aria-hidden="true" />
            <span className="text-sm font-medium">Risk & compliance</span>
          </div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">Risk & compliance dashboard</h1>
          <p className="max-w-2xl text-sm text-muted-foreground">
            Aggregated approvals, security, finance/tax and HR compliance signals across your organization. Drill into any
            source for the underlying records.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Select value={level} onValueChange={(v) => setLevel(v as ScopeLevel)}>
            <SelectTrigger className="w-[150px]" aria-label="Aggregation scope">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="group">Group</SelectItem>
              <SelectItem value="company">Company</SelectItem>
              <SelectItem value="branch">Branch</SelectItem>
              <SelectItem value="department">Department</SelectItem>
            </SelectContent>
          </Select>
          {level !== "group" && (
            <Input
              placeholder={`${level} value`}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              className="w-[160px]"
              aria-label={`${level} filter value`}
            />
          )}
          <Button variant="outline" size="sm" onClick={handleRefresh} disabled={refreshing || needsValue}>
            <RefreshCw className={`mr-1.5 size-4 ${refreshing ? "animate-spin" : ""}`} aria-hidden="true" />
            Refresh
          </Button>
          <Button variant="outline" size="sm" asChild>
            <a href={`/api/admin/risk-compliance/export?${exportParams.toString()}`}>
              <Download className="mr-1.5 size-4" aria-hidden="true" />
              Export
            </a>
          </Button>
        </div>
      </header>

      {meta?.stale && (
        <div
          className="mt-4 flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-400"
          role="status"
        >
          <AlertTriangle className="size-4 shrink-0" aria-hidden="true" />
          <span>
            These metrics are stale{dash ? ` (computed ${relativeAge(dash.computedAt)})` : ""}. Click Refresh to recompute
            from source systems.
          </span>
        </div>
      )}

      {dash?.masked && (
        <p className="mt-2 text-xs text-muted-foreground">
          Sensitive fields (counterparties, emails, employee identifiers) are masked. Tenant owners can export unmasked.
        </p>
      )}

      {meta?.restricted && dash && (
        <p className="mt-2 text-xs text-muted-foreground" role="status">
          Your data scope limits this view to {dash.scope.level} <span className="font-medium text-foreground">{dash.scope.value}</span>
          {meta.narrowed ? " (narrowed from your request)" : ""}.
          {meta.allowed && meta.allowed.values.length > 1 ? ` Allowed: ${meta.allowed.values.join(", ")}.` : ""}
        </p>
      )}

      {needsValue && (
        <p className="mt-6 text-sm text-muted-foreground">Enter a {level} value to load this view.</p>
      )}
      {refreshError && (
        <p className="mt-4 text-sm text-destructive" role="alert">
          {refreshError}
        </p>
      )}
      {error && (
        <p className="mt-6 text-sm text-destructive" role="alert">
          {error instanceof ApiError ? error.message : "Failed to load dashboard."}
        </p>
      )}
      {isLoading && <p className="mt-6 text-sm text-muted-foreground">Loading risk signals…</p>}

      {dash && (
        <>
          <div className="mt-6 grid grid-cols-2 gap-3 md:grid-cols-4">
            <SummaryStat label="Open items" value={dash.totals.openItems} />
            <SummaryStat label="Critical sources" value={dash.totals.critical} tone="critical" />
            <SummaryStat label="Sources online" value={dash.totals.sourcesAvailable} tone="ok" />
            <SummaryStat label="Sources missing" value={dash.totals.sourcesMissing} tone={dash.totals.sourcesMissing ? "warn" : "muted"} />
          </div>

          <div className="mt-6 flex flex-col gap-6">
            {CATEGORIES.filter((cat) => grouped[cat].length > 0).map((cat) => (
              <div key={cat}>
                <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                  {CATEGORY_LABELS[cat]}
                </h2>
                <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
                  {grouped[cat].map((s) => (
                    <Card key={s.key} className={!s.available ? "border-dashed opacity-90" : ""}>
                      <CardHeader className="pb-2">
                        <div className="flex items-start justify-between gap-2">
                          <div>
                            <CardTitle className="text-base">{s.label}</CardTitle>
                            <CardDescription>
                              {s.available ? (
                                <span>
                                  {s.count} open · {s.asOf ? relativeAge(s.asOf) : "no recent data"}
                                </span>
                              ) : (
                                <span className="inline-flex items-center gap-1 text-muted-foreground">
                                  <CircleSlash className="size-3.5" aria-hidden="true" /> Source unavailable
                                </span>
                              )}
                            </CardDescription>
                          </div>
                          {s.available ? (
                            <SeverityBadge severity={s.severity} />
                          ) : (
                            <Badge variant="outline" className="border-border text-muted-foreground">
                              n/a
                            </Badge>
                          )}
                        </div>
                      </CardHeader>
                      <CardContent className="pt-0">
                        {!s.available && <p className="text-xs text-muted-foreground">{s.note}</p>}
                        {s.available && s.withheld && (
                          <p className="mb-2 text-xs text-amber-600 dark:text-amber-400">{s.note}</p>
                        )}
                        {s.available && s.items.length > 0 && (
                          <>
                            <button
                              type="button"
                              onClick={() => setExpanded(expanded === s.key ? null : s.key)}
                              className="mb-2 inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
                              aria-expanded={expanded === s.key}
                            >
                              <ChevronRight
                                className={`size-3.5 transition-transform ${expanded === s.key ? "rotate-90" : ""}`}
                                aria-hidden="true"
                              />
                              {expanded === s.key ? "Hide" : "View"} items
                            </button>
                            {expanded === s.key && (
                              <ul className="mb-2 flex flex-col gap-1.5 border-l border-border pl-3">
                                {s.items.map((it) => (
                                  <li key={it.id} className="text-xs">
                                    <div className="flex items-center justify-between gap-2">
                                      <span className="font-medium text-foreground">{it.label}</span>
                                      {it.amount != null && (
                                        <span className="tabular-nums text-muted-foreground">
                                          {it.amount.toLocaleString()}
                                        </span>
                                      )}
                                    </div>
                                    {it.detail && <p className="text-muted-foreground">{it.detail}</p>}
                                    {it.sensitive && Object.keys(it.sensitive).length > 0 && (
                                      <p className="text-muted-foreground">
                                        {Object.entries(it.sensitive)
                                          .map(([k, v]) => `${k}: ${v}`)
                                          .join(" · ")}
                                      </p>
                                    )}
                                  </li>
                                ))}
                              </ul>
                            )}
                          </>
                        )}
                        <Link
                          href={s.drillHref}
                          className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
                        >
                          Open source module
                          <ChevronRight className="size-3.5" aria-hidden="true" />
                        </Link>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  )
}

function SummaryStat({
  label,
  value,
  tone = "default",
}: {
  label: string
  value: number
  tone?: "default" | "critical" | "ok" | "warn" | "muted"
}) {
  const toneClass =
    tone === "critical"
      ? "text-destructive"
      : tone === "ok"
        ? "text-emerald-600 dark:text-emerald-400"
        : tone === "warn"
          ? "text-amber-600 dark:text-amber-400"
          : "text-foreground"
  return (
    <Card>
      <CardContent className="flex flex-col gap-1 p-4">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</span>
        <span className={`text-2xl font-semibold tabular-nums ${toneClass}`}>{value}</span>
      </CardContent>
    </Card>
  )
}
