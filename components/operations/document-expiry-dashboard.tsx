"use client"

import { useMemo, useState } from "react"
import useSWR from "swr"
import {
  CalendarClock,
  AlertTriangle,
  CircleCheck,
  CircleX,
  BellRing,
  RefreshCw,
  Loader2,
  ExternalLink,
} from "lucide-react"
import Link from "next/link"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Input } from "@/components/ui/input"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { statusBadgeClass, type ExpiryItem } from "@/lib/expiry/model"
import { cn } from "@/lib/utils"

type Overview = {
  timeZone: string
  generatedAt: string
  items: ExpiryItem[]
  kpis: { total: number; valid: number; expiringSoon: number; expired: number; escalated: number }
  byCategory: { category: string; total: number; expiringSoon: number; expired: number }[]
  byStatus: { status: string; count: number }[]
}

const fetcher = (url: string) => fetch(url).then((r) => r.json())

type StatusFilter = "all" | "Expired" | "Expiring Soon" | "Valid"

const renewalBadgeClass: Record<string, string> = {
  "Renewal Overdue": "bg-destructive/10 text-destructive border-destructive/20",
  "Renewal Due": "bg-amber-500/10 text-amber-600 border-amber-500/20 dark:text-amber-400",
  Current: "bg-emerald-500/10 text-emerald-600 border-emerald-500/20 dark:text-emerald-400",
  "Not Applicable": "bg-muted text-muted-foreground border-border",
}

function daysLabel(days: number): string {
  if (days < 0) return `${Math.abs(days)}d overdue`
  if (days === 0) return "Today"
  return `in ${days}d`
}

export function DocumentExpiryDashboard() {
  const { data, isLoading, mutate } = useSWR<Overview>("/api/operations/document-expiry", fetcher)
  const [status, setStatus] = useState<StatusFilter>("all")
  const [category, setCategory] = useState<string>("all")
  const [q, setQ] = useState("")
  const [sweeping, setSweeping] = useState(false)

  const items = data?.items ?? []
  const categories = useMemo(
    () => Array.from(new Set(items.map((i) => i.category))).sort(),
    [items],
  )

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return items.filter((i) => {
      if (status !== "all" && i.status !== status) return false
      if (category !== "all" && i.category !== category) return false
      if (needle && !`${i.title} ${i.subtitle ?? ""} ${i.documentNumber ?? ""}`.toLowerCase().includes(needle))
        return false
      return true
    })
  }, [items, status, category, q])

  async function runSweep() {
    setSweeping(true)
    try {
      await fetch("/api/operations/document-expiry", { method: "POST" })
      await mutate()
    } finally {
      setSweeping(false)
    }
  }

  const kpis = data?.kpis
  const kpiCards = [
    { label: "Tracked documents", value: kpis?.total ?? 0, icon: CalendarClock, tone: "text-foreground" },
    { label: "Valid", value: kpis?.valid ?? 0, icon: CircleCheck, tone: "text-emerald-600 dark:text-emerald-400" },
    {
      label: "Expiring soon",
      value: kpis?.expiringSoon ?? 0,
      icon: AlertTriangle,
      tone: "text-amber-600 dark:text-amber-400",
    },
    { label: "Expired", value: kpis?.expired ?? 0, icon: CircleX, tone: "text-destructive" },
    { label: "Escalated", value: kpis?.escalated ?? 0, icon: BellRing, tone: "text-primary" },
  ]

  return (
    <div className="flex flex-1 flex-col gap-6 p-4 md:p-6">
      <header className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div className="flex items-start gap-4">
          <span className="inline-flex size-11 shrink-0 items-center justify-center rounded-xl bg-muted text-primary">
            <CalendarClock className="size-5" />
          </span>
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-semibold tracking-tight">Document Expiry</h1>
              <Badge variant="outline" className="text-[10px] font-medium text-muted-foreground">
                SPEC 88
              </Badge>
            </div>
            <p className="max-w-2xl text-sm text-muted-foreground">
              Unified expiry tracking for contracts, certifications, licenses, insurance, identity and compliance
              documents — with renewal status, escalation and notifications.
            </p>
            {data?.timeZone ? (
              <p className="text-xs text-muted-foreground">Evaluated in {data.timeZone}</p>
            ) : null}
          </div>
        </div>
        <Button onClick={runSweep} disabled={sweeping} variant="outline" size="sm" className="gap-2">
          {sweeping ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
          Run escalation sweep
        </Button>
      </header>

      <section className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {kpiCards.map((k) => (
          <Card key={k.label}>
            <CardContent className="flex flex-col gap-1 p-4">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-muted-foreground">{k.label}</span>
                <k.icon className={cn("size-4", k.tone)} />
              </div>
              <span className={cn("text-2xl font-semibold tabular-nums", k.tone)}>
                {isLoading ? "—" : k.value}
              </span>
            </CardContent>
          </Card>
        ))}
      </section>

      {data?.byCategory?.length ? (
        <section>
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium">By category</CardTitle>
            </CardHeader>
            <CardContent className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {data.byCategory.map((c) => (
                <div
                  key={c.category}
                  className="flex items-center justify-between rounded-lg border border-border bg-card px-3 py-2"
                >
                  <span className="text-sm font-medium">{c.category}</span>
                  <div className="flex items-center gap-2 text-xs">
                    {c.expired > 0 ? (
                      <Badge variant="outline" className={statusBadgeClass("Expired")}>
                        {c.expired} expired
                      </Badge>
                    ) : null}
                    {c.expiringSoon > 0 ? (
                      <Badge variant="outline" className={statusBadgeClass("Expiring Soon")}>
                        {c.expiringSoon} soon
                      </Badge>
                    ) : null}
                    <span className="text-muted-foreground tabular-nums">{c.total} total</span>
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        </section>
      ) : null}

      <section className="flex flex-col gap-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <Tabs value={status} onValueChange={(v) => setStatus(v as StatusFilter)}>
            <TabsList>
              <TabsTrigger value="all">All</TabsTrigger>
              <TabsTrigger value="Expired">Expired</TabsTrigger>
              <TabsTrigger value="Expiring Soon">Expiring</TabsTrigger>
              <TabsTrigger value="Valid">Valid</TabsTrigger>
            </TabsList>
          </Tabs>
          <div className="flex items-center gap-2">
            {categories.length > 1 ? (
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                className="h-9 rounded-md border border-input bg-background px-2 text-sm"
                aria-label="Filter by category"
              >
                <option value="all">All categories</option>
                {categories.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            ) : null}
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search documents…"
              className="h-9 w-full sm:w-56"
              aria-label="Search documents"
            />
          </div>
        </div>

        <Card>
          <CardContent className="p-0">
            {isLoading ? (
              <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" /> Loading expiry data…
              </div>
            ) : filtered.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-1 py-16 text-center">
                <CalendarClock className="size-8 text-muted-foreground" />
                <p className="text-sm font-medium">No matching documents</p>
                <p className="text-xs text-muted-foreground">
                  Documents with upcoming or past expiry dates will appear here.
                </p>
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Document</TableHead>
                    <TableHead>Category</TableHead>
                    <TableHead>Expiry</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Renewal</TableHead>
                    <TableHead className="text-right">Source</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.map((it) => (
                    <TableRow key={`${it.sourceId}:${it.entityId}`}>
                      <TableCell>
                        <div className="flex flex-col">
                          <span className="font-medium leading-tight">{it.title}</span>
                          {it.documentNumber ? (
                            <span className="text-xs text-muted-foreground">{it.documentNumber}</span>
                          ) : null}
                        </div>
                      </TableCell>
                      <TableCell>
                        <span className="text-sm text-muted-foreground">{it.category}</span>
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-col">
                          <span className="text-sm tabular-nums">{it.expiryDate}</span>
                          <span
                            className={cn(
                              "text-xs tabular-nums",
                              it.daysUntil < 0
                                ? "text-destructive"
                                : it.daysUntil <= 7
                                  ? "text-amber-600 dark:text-amber-400"
                                  : "text-muted-foreground",
                            )}
                          >
                            {daysLabel(it.daysUntil)}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className={statusBadgeClass(it.status)}>
                          {it.status}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className={renewalBadgeClass[it.renewalStatus]}>
                          {it.renewalStatus}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right">
                        <Button asChild variant="ghost" size="sm" className="gap-1 text-xs">
                          <Link href={it.link}>
                            {it.sourceLabel}
                            <ExternalLink className="size-3" />
                          </Link>
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </section>
    </div>
  )
}
