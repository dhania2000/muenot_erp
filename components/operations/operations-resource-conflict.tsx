"use client"

import { useMemo, useState } from "react"
import useSWR from "swr"
import { fetcher } from "@/lib/fetcher"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  AlertTriangle,
  CalendarOff,
  Gauge,
  Layers,
  RefreshCw,
  ShieldAlert,
  CheckCircle2,
} from "lucide-react"

type ConflictType = "over_allocation" | "overlap" | "capacity_exceeded" | "on_leave"

type Conflict = {
  type: ConflictType
  severity: "warning" | "critical"
  resource_id: string | null
  resource_name: string | null
  message: string
  detail: string
}

type ConflictResponse = {
  conflicts: Conflict[]
  summary: {
    total: number
    over_allocation: number
    overlap: number
    capacity_exceeded: number
    on_leave: number
    analyzed_allocations: number
  }
}

const TYPE_META: Record<ConflictType, { label: string; icon: typeof AlertTriangle }> = {
  over_allocation: { label: "Over-allocation", icon: Gauge },
  overlap: { label: "Overlapping assignment", icon: Layers },
  capacity_exceeded: { label: "Capacity exceeded", icon: ShieldAlert },
  on_leave: { label: "On approved leave", icon: CalendarOff },
}

function severityVariant(severity: Conflict["severity"]): "destructive" | "secondary" {
  return severity === "critical" ? "destructive" : "secondary"
}

export function OperationsResourceConflict() {
  const { data, isLoading, mutate, isValidating } = useSWR<ConflictResponse>(
    "/api/operations/resource-conflicts",
    fetcher,
    { refreshInterval: 60000 },
  )

  const summaryCards = useMemo(() => {
    const s = data?.summary
    return [
      { label: "Total Conflicts", value: s?.total ?? 0, icon: AlertTriangle },
      { label: "Over-allocated", value: s?.over_allocation ?? 0, icon: Gauge },
      { label: "Overlapping", value: s?.overlap ?? 0, icon: Layers },
      { label: "Capacity Exceeded", value: s?.capacity_exceeded ?? 0, icon: ShieldAlert },
      { label: "On Approved Leave", value: s?.on_leave ?? 0, icon: CalendarOff },
    ]
  }, [data])

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Resource Conflict</h1>
          <p className="text-sm text-muted-foreground">
            Live detection of over-allocation, overlapping assignments, exceeded capacity, and approved-leave clashes across
            active allocations.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => mutate()} disabled={isValidating}>
          <RefreshCw className={`size-4 ${isValidating ? "animate-spin" : ""}`} />
          Re-analyze
        </Button>
      </div>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
        {summaryCards.map((c) => (
          <Card key={c.label}>
            <CardContent className="flex flex-col gap-2 pt-6">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-muted-foreground">{c.label}</span>
                <c.icon className="size-4 text-muted-foreground" />
              </div>
              <span className="text-2xl font-semibold tracking-tight">{c.value}</span>
            </CardContent>
          </Card>
        ))}
      </div>

      <ConflictChecker onChecked={() => mutate()} />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            Detected Conflicts
            {data?.summary ? (
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                {data.summary.analyzed_allocations} active allocations analyzed
              </span>
            ) : null}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <p className="text-sm text-muted-foreground">Analyzing allocations…</p>
          ) : !data || data.conflicts.length === 0 ? (
            <div className="flex items-center gap-2 rounded-md border border-dashed p-6 text-sm text-muted-foreground">
              <CheckCircle2 className="size-4 text-emerald-600" />
              No resource conflicts detected across active allocations.
            </div>
          ) : (
            <ul className="flex flex-col gap-3">
              {data.conflicts.map((conflict, index) => {
                const meta = TYPE_META[conflict.type]
                return (
                  <li key={index} className="flex items-start gap-3 rounded-md border p-3">
                    <meta.icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                    <div className="flex flex-col gap-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-medium">{conflict.message}</span>
                        <Badge variant={severityVariant(conflict.severity)} className="capitalize">
                          {conflict.severity}
                        </Badge>
                        <Badge variant="outline">{meta.label}</Badge>
                      </div>
                      <p className="text-sm text-muted-foreground">{conflict.detail}</p>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

type ResourceOption = { resource_id: string; resource_name: string; working_capacity: number | null }

function ConflictChecker({ onChecked }: { onChecked: () => void }) {
  const { data: resourcesData } = useSWR<{ rows?: any[] } | any[]>("/api/operations?kind=resources", fetcher)
  const resources: ResourceOption[] = useMemo(() => {
    const rows = Array.isArray(resourcesData) ? resourcesData : (resourcesData?.rows ?? [])
    return rows
      .map((r: any) => ({
        resource_id: String(r.id ?? r.resource_id ?? ""),
        resource_name: String(r.resource_name ?? r.name ?? r.full_name ?? ""),
        working_capacity: r.working_capacity != null ? Number(r.working_capacity) : null,
      }))
      .filter((r: ResourceOption) => r.resource_name)
  }, [resourcesData])

  const [resourceName, setResourceName] = useState("")
  const [fromDate, setFromDate] = useState("")
  const [toDate, setToDate] = useState("")
  const [percent, setPercent] = useState("100")
  const [checking, setChecking] = useState(false)
  const [result, setResult] = useState<{ conflicts: Conflict[]; hasConflicts: boolean } | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function runCheck() {
    setError(null)
    setResult(null)
    if (!resourceName || !fromDate) {
      setError("Select a resource and a start date to check.")
      return
    }
    setChecking(true)
    try {
      const selected = resources.find((r) => r.resource_name === resourceName)
      const res = await fetch("/api/operations/resource-conflicts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          resource_id: selected?.resource_id || null,
          resource_name: resourceName,
          from_date: fromDate,
          to_date: toDate || null,
          allocation_percent: Number(percent) || 0,
        }),
      })
      const json = await res.json()
      if (!res.ok) {
        setError(json.error ?? "Failed to check conflicts.")
        return
      }
      setResult(json)
      onChecked()
    } catch {
      setError("Failed to check conflicts.")
    } finally {
      setChecking(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Check Allocation Before Saving</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="rc-resource">Resource</Label>
            <Input
              id="rc-resource"
              list="rc-resource-list"
              value={resourceName}
              onChange={(e) => setResourceName(e.target.value)}
              placeholder="Select or type a resource"
            />
            <datalist id="rc-resource-list">
              {resources.map((r) => (
                <option key={`${r.resource_id}-${r.resource_name}`} value={r.resource_name} />
              ))}
            </datalist>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="rc-from">From date</Label>
            <Input id="rc-from" type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="rc-to">To date</Label>
            <Input id="rc-to" type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="rc-percent">Allocation %</Label>
            <Input
              id="rc-percent"
              type="number"
              min={0}
              max={100}
              value={percent}
              onChange={(e) => setPercent(e.target.value)}
            />
          </div>
        </div>

        <div className="flex items-center gap-3">
          <Button onClick={runCheck} disabled={checking} size="sm">
            {checking ? "Checking…" : "Check for conflicts"}
          </Button>
          {error ? <span className="text-sm text-destructive">{error}</span> : null}
        </div>

        {result ? (
          result.hasConflicts ? (
            <div className="flex flex-col gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3">
              <div className="flex items-center gap-2 text-sm font-medium text-destructive">
                <AlertTriangle className="size-4" />
                {result.conflicts.length} conflict{result.conflicts.length === 1 ? "" : "s"} found — review before saving this
                allocation.
              </div>
              <ul className="flex flex-col gap-1.5 pl-6">
                {result.conflicts.map((c, i) => (
                  <li key={i} className="list-disc text-sm text-muted-foreground">
                    <span className="font-medium text-foreground">{TYPE_META[c.type].label}:</span> {c.detail}
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <div className="flex items-center gap-2 rounded-md border border-emerald-500/40 bg-emerald-500/5 p-3 text-sm text-emerald-700">
              <CheckCircle2 className="size-4" />
              No conflicts — this allocation is safe to save.
            </div>
          )
        ) : null}
      </CardContent>
    </Card>
  )
}
