"use client"

import { useMemo, useState } from "react"
import useSWR from "swr"
import Link from "next/link"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Search } from "lucide-react"

/** Mirror of lib/platform/feature-entitlements FeatureResolution (client-safe subset). */
type FeatureResolution = {
  key: string
  label: string
  module: string
  kind: "boolean" | "limited" | "metered"
  state: "enabled" | "disabled" | "limited" | "metered"
  available: boolean
  reason?: string
  quota?: string
  limit?: number | null
  usage?: number
  remaining?: number | null
  overage?: boolean
}

const STATE_TONE: Record<string, string> = {
  enabled: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  metered: "bg-sky-500/15 text-sky-600 dark:text-sky-400",
  limited: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  disabled: "bg-muted text-muted-foreground",
}

const KIND_LABEL: Record<string, string> = {
  boolean: "Boolean",
  limited: "Limited",
  metered: "Metered",
}

function StateBadge({ value }: { value: string }) {
  const tone = STATE_TONE[value] ?? "bg-muted text-muted-foreground"
  const label = value.charAt(0).toUpperCase() + value.slice(1)
  return <span className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium ${tone}`}>{label}</span>
}

function formatLimit(f: FeatureResolution): string {
  if (f.kind === "boolean") return f.state === "disabled" ? "Disabled" : "Enabled"
  if (f.limit == null) return "Unlimited"
  return String(f.limit)
}

function formatUsage(f: FeatureResolution): string {
  if (f.kind === "boolean") return "—"
  const usage = f.usage ?? 0
  if (f.limit == null) return `${usage}`
  return `${usage} / ${f.limit}`
}

const fetcher = (url: string) =>
  fetch(url).then((r) => {
    if (!r.ok) throw new Error("Failed to load entitlements")
    return r.json()
  })

export function EntitlementsView() {
  const [query, setQuery] = useState("")
  const { data, error, isLoading } = useSWR<{ features: FeatureResolution[] }>(
    "/api/entitlements/features",
    fetcher,
  )

  const features = useMemo(() => data?.features ?? [], [data])

  const stats = useMemo(() => {
    const total = features.length
    const boolean = features.filter((f) => f.kind === "boolean").length
    const limited = features.filter((f) => f.kind === "limited").length
    const metered = features.filter((f) => f.kind === "metered").length
    return { total, boolean, limited, metered }
  }, [features])

  const filtered = features.filter((f) =>
    query.trim() === ""
      ? true
      : `${f.label} ${f.module} ${f.kind} ${f.state}`.toLowerCase().includes(query.trim().toLowerCase()),
  )

  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">Feature Entitlements</h1>
          <p className="max-w-2xl text-sm text-muted-foreground">
            Plan-level features and quota limits that gate what your subscription can access. Entitlements are
            defined per plan — edit them in the Plans &amp; entitlements console.
          </p>
        </div>
        <Button asChild className="shrink-0">
          <Link href="/platform/plans">Manage in Plans</Link>
        </Button>
      </header>

      <div className="mt-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        {[
          { label: "Features", value: stats.total },
          { label: "Boolean", value: stats.boolean },
          { label: "Limited", value: stats.limited },
          { label: "Metered", value: stats.metered },
        ].map((stat) => (
          <Card key={stat.label}>
            <CardHeader className="pb-2">
              <CardTitle className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {stat.label}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-semibold text-foreground">{isLoading ? "—" : stat.value}</div>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card className="mt-6">
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <CardTitle className="text-base font-medium">Records</CardTitle>
          <div className="relative w-full sm:w-64">
            <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search"
              className="pl-9"
            />
          </div>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto rounded-md border border-border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Feature</TableHead>
                  <TableHead>Module</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Limit</TableHead>
                  <TableHead>Usage</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {error ? (
                  <TableRow>
                    <TableCell colSpan={6} className="h-24 text-center text-muted-foreground">
                      Could not load entitlements.
                    </TableCell>
                  </TableRow>
                ) : isLoading ? (
                  <TableRow>
                    <TableCell colSpan={6} className="h-24 text-center text-muted-foreground">
                      Loading entitlements…
                    </TableCell>
                  </TableRow>
                ) : filtered.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} className="h-24 text-center text-muted-foreground">
                      No entitlements found.
                    </TableCell>
                  </TableRow>
                ) : (
                  filtered.map((f) => (
                    <TableRow key={f.key}>
                      <TableCell>
                        <span className="text-sm font-medium text-foreground">{f.label}</span>
                      </TableCell>
                      <TableCell>
                        <span className="text-sm capitalize text-muted-foreground">{f.module}</span>
                      </TableCell>
                      <TableCell>
                        <span className="text-sm text-foreground">{KIND_LABEL[f.kind] ?? f.kind}</span>
                      </TableCell>
                      <TableCell>
                        <span className="text-sm text-foreground">{formatLimit(f)}</span>
                      </TableCell>
                      <TableCell>
                        <span className="text-sm text-foreground">{formatUsage(f)}</span>
                      </TableCell>
                      <TableCell>
                        <StateBadge value={f.state} />
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
