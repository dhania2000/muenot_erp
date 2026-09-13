"use client"

import { useState } from "react"
import useSWR from "swr"
import { toast } from "sonner"
import { fetcher } from "@/lib/fetcher"
import { useFormatCurrency } from "@/components/providers/settings-provider"
import { formatDate } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { MoreHorizontal, Plus, TrendingUp, RefreshCw } from "lucide-react"
import { ForecastAdjustmentDialog } from "@/components/sales/forecast-adjustment-dialog"
import { ForecastQuarterDrawer } from "@/components/sales/forecast-quarter-drawer"
import {
  CATEGORY_BADGE,
  HEALTH_BADGE,
  type ForecastCategory,
  type ForecastHealth,
  type RiskLevel,
} from "@/lib/sales/forecast-model"

// ---------------------------------------------------------------------------
// Shared client types (mirror the service payload so components stay in sync)
// ---------------------------------------------------------------------------

export type ForecastOpportunity = {
  key: string
  leadId: number | null
  leadCode: string | null
  companyId: number | null
  companyName: string | null
  ownerId: number | null
  ownerName: string | null
  stage: string | null
  leadStatus: string | null
  probability: number
  source: "Contract" | "Quotation" | "Lead"
  quotationId: number | null
  quotationCode: string | null
  quotationStatus: string | null
  contractId: number | null
  contractCode: string | null
  contractStatus: string | null
  currency: string
  originalValue: number
  value: number
  weightedValue: number
  committed: boolean
  category: ForecastCategory
  closeDate: string | null
  fyStartYear: number | null
  quarter: number | null
  risk: RiskLevel
  riskReasons: string[]
}

export type QuarterForecast = {
  quarter: number
  label: string
  start: string
  end: string
  pipelineValue: number
  weightedPipeline: number
  committed: number
  systemExpected: number
  expected: number
  bestCase: number
  worstCase: number
  target: number
  gap: number
  coverage: number | null
  actualInvoiced: number
  actualCollected: number
  variance: number
  accuracy: number | null
  health: ForecastHealth
  dealCount: number
  atRiskValue: number
  adjustments: { expected: number; bestCase: number; worstCase: number; target: number }
}

export type OwnerForecast = {
  ownerId: number | null
  ownerName: string
  expected: number
  committed: number
  weightedPipeline: number
  dealCount: number
}

export type AdjustmentRecord = {
  id: number
  adjustment_code: string
  fy_start_year: number
  quarter: number
  adjustment_type: "Expected" | "Best Case" | "Worst Case" | "Target"
  amount: number
  owner_id: number | null
  owner_name: string | null
  reason: string
  created_by_name: string | null
  created_at: string
}

type ForecastResult = {
  fyStartYear: number
  fyLabel: string
  startMonthName: string
  baseCurrency: string
  quarters: QuarterForecast[]
  summary: QuarterForecast
  ownerBreakdown: OwnerForecast[]
  adjustments: AdjustmentRecord[]
  fyOptions: number[]
  unscheduledCount: number
  generatedAt: string
}

// ---------------------------------------------------------------------------
// Small presentational helpers
// ---------------------------------------------------------------------------

function SummaryCard({
  label,
  value,
  hint,
  accent,
}: {
  label: string
  value: string
  hint?: string
  accent?: boolean
}) {
  return (
    <div className="flex flex-col gap-1 rounded-lg border border-border bg-card p-4">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className={`text-xl font-semibold tabular-nums ${accent ? "text-primary" : ""}`}>{value}</span>
      {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main client
// ---------------------------------------------------------------------------

export function ForecastClient({ canManage }: { canManage: boolean }) {
  const [fy, setFy] = useState<string>("current")
  const [owner, setOwner] = useState<string>("all")
  const [adjOpen, setAdjOpen] = useState(false)
  const [editingAdj, setEditingAdj] = useState<AdjustmentRecord | null>(null)
  const [adjQuarter, setAdjQuarter] = useState(1)
  const [drawerQuarter, setDrawerQuarter] = useState<QuarterForecast | null>(null)

  const fmt = useFormatCurrency()

  const params = new URLSearchParams()
  if (fy !== "current") params.set("fy", fy)
  if (owner !== "all") params.set("owner", owner)
  const qs = params.toString()
  const key = `/api/sales/forecast${qs ? `?${qs}` : ""}`

  const { data, isLoading, mutate } = useSWR<ForecastResult>(key, fetcher)

  const { data: teamData } = useSWR<{ users: { id: number; name: string }[] }>("/api/sales/team", fetcher)
  const users = teamData?.users ?? []

  const summary = data?.summary
  const quarters = data?.quarters ?? []
  const adjustments = data?.adjustments ?? []
  const owners = data?.ownerBreakdown ?? []

  function openNewAdjustment(quarter: number) {
    setEditingAdj(null)
    setAdjQuarter(quarter)
    setAdjOpen(true)
  }

  function openEditAdjustment(a: AdjustmentRecord) {
    setEditingAdj(a)
    setAdjQuarter(a.quarter)
    setAdjOpen(true)
  }

  async function deleteAdjustment(a: AdjustmentRecord) {
    const res = await fetch(`/api/sales/forecast/${a.id}`, { method: "DELETE" })
    if (res.ok) {
      toast.success("Adjustment removed")
      mutate()
    } else {
      toast.error("Unable to remove adjustment")
    }
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Header + filters */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-sm font-medium">
            <TrendingUp className="size-4 text-primary" />
            Sales forecast
          </h2>
          <p className="text-xs text-muted-foreground">
            Calculated live from leads, quotations, contracts and invoices. Every deal is counted once
            {data ? ` · FY ${data.fyLabel} (starts ${data.startMonthName})` : ""}.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Select value={owner} onValueChange={(v) => setOwner(v ?? "all")}>
            <SelectTrigger className="w-44" aria-label="Filter by owner">
              <SelectValue placeholder="All owners" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="all">All owners</SelectItem>
                {users.map((u) => (
                  <SelectItem key={u.id} value={String(u.id)}>
                    {u.name}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          <Select value={fy} onValueChange={(v) => setFy(v ?? "current")}>
            <SelectTrigger className="w-36" aria-label="Financial year">
              <SelectValue placeholder="Financial year" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="current">Current FY</SelectItem>
                {(data?.fyOptions ?? []).map((y) => (
                  <SelectItem key={y} value={String(y)}>
                    FY {y}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          <Button variant="outline" size="icon" aria-label="Refresh" onClick={() => mutate()}>
            <RefreshCw className="size-4" />
          </Button>
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <SummaryCard
          label="Expected (FY)"
          value={summary ? fmt(summary.expected) : "—"}
          hint="Committed + weighted pipeline"
          accent
        />
        <SummaryCard label="Committed" value={summary ? fmt(summary.committed) : "—"} hint="Won & signed" />
        <SummaryCard
          label="Weighted pipeline"
          value={summary ? fmt(summary.weightedPipeline) : "—"}
          hint="Open × probability"
        />
        <SummaryCard label="Best case" value={summary ? fmt(summary.bestCase) : "—"} hint="Full open pipeline" />
        <SummaryCard label="Target" value={summary && summary.target > 0 ? fmt(summary.target) : "—"} hint="Set by managers" />
        <SummaryCard
          label="Actual invoiced"
          value={summary ? fmt(summary.actualInvoiced) : "—"}
          hint={summary?.accuracy != null ? `${summary.accuracy}% of expected` : "From Finance"}
        />
      </div>

      {/* Quarterly table */}
      <div className="rounded-lg border border-border bg-card">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div>
            <h3 className="text-sm font-medium">Quarterly breakdown</h3>
            <p className="text-xs text-muted-foreground">Click a quarter to trace the deals behind its number.</p>
          </div>
          {data && data.unscheduledCount > 0 && (
            <Badge variant="outline" title="Open deals with no expected close date — assign dates to forecast them">
              {data.unscheduledCount} undated
            </Badge>
          )}
        </div>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Quarter</TableHead>
                <TableHead className="text-right">Committed</TableHead>
                <TableHead className="text-right">Weighted</TableHead>
                <TableHead className="text-right">Expected</TableHead>
                <TableHead className="text-right">Best case</TableHead>
                <TableHead className="text-right">Target</TableHead>
                <TableHead className="min-w-36">Coverage vs target</TableHead>
                <TableHead className="text-right">Actual</TableHead>
                <TableHead>Health</TableHead>
                <TableHead className="text-right">Deals</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading && (
                <TableRow>
                  <TableCell colSpan={10} className="py-10 text-center text-sm text-muted-foreground">
                    Calculating forecast...
                  </TableCell>
                </TableRow>
              )}
              {!isLoading &&
                quarters.map((q) => {
                  const pct = q.target > 0 ? Math.min(100, Math.round((q.expected / q.target) * 100)) : 0
                  return (
                    <TableRow
                      key={q.quarter}
                      className="cursor-pointer"
                      onClick={() => setDrawerQuarter(q)}
                    >
                      <TableCell className="font-medium">
                        {q.label}
                        <span className="ml-2 text-xs font-normal text-muted-foreground">
                          {formatDate(q.start)} – {formatDate(q.end)}
                        </span>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{fmt(q.committed)}</TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">
                        {fmt(q.weightedPipeline)}
                      </TableCell>
                      <TableCell className="text-right font-medium tabular-nums">{fmt(q.expected)}</TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">{fmt(q.bestCase)}</TableCell>
                      <TableCell className="text-right tabular-nums">{q.target > 0 ? fmt(q.target) : "—"}</TableCell>
                      <TableCell>
                        {q.target > 0 ? (
                          <div className="flex items-center gap-2">
                            <Progress value={pct} className="h-2" />
                            <span className="w-10 text-right text-xs tabular-nums text-muted-foreground">{pct}%</span>
                          </div>
                        ) : (
                          <span className="text-xs text-muted-foreground">No target</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{fmt(q.actualInvoiced)}</TableCell>
                      <TableCell>
                        <Badge variant={HEALTH_BADGE[q.health]}>{q.health}</Badge>
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">{q.dealCount}</TableCell>
                    </TableRow>
                  )
                })}
              {!isLoading && summary && (
                <TableRow className="border-t-2 border-border bg-muted/40 font-medium">
                  <TableCell>Full year</TableCell>
                  <TableCell className="text-right tabular-nums">{fmt(summary.committed)}</TableCell>
                  <TableCell className="text-right tabular-nums">{fmt(summary.weightedPipeline)}</TableCell>
                  <TableCell className="text-right tabular-nums">{fmt(summary.expected)}</TableCell>
                  <TableCell className="text-right tabular-nums">{fmt(summary.bestCase)}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {summary.target > 0 ? fmt(summary.target) : "—"}
                  </TableCell>
                  <TableCell>
                    {summary.coverage != null ? (
                      <span className="text-xs text-muted-foreground">{summary.coverage}x pipeline coverage</span>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{fmt(summary.actualInvoiced)}</TableCell>
                  <TableCell>
                    <Badge variant={HEALTH_BADGE[summary.health]}>{summary.health}</Badge>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{summary.dealCount}</TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </div>

      {/* Owner breakdown + Adjustments */}
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="rounded-lg border border-border bg-card">
          <div className="border-b border-border px-4 py-3">
            <h3 className="text-sm font-medium">By owner</h3>
            <p className="text-xs text-muted-foreground">Expected revenue contribution per rep this financial year.</p>
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Owner</TableHead>
                <TableHead className="text-right">Committed</TableHead>
                <TableHead className="text-right">Weighted</TableHead>
                <TableHead className="text-right">Expected</TableHead>
                <TableHead className="text-right">Deals</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {owners.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="py-8 text-center text-sm text-muted-foreground">
                    {owner === "all" ? "No forecastable deals yet." : "Switch to All owners to see the breakdown."}
                  </TableCell>
                </TableRow>
              )}
              {owners.map((o) => (
                <TableRow key={o.ownerId ?? "unassigned"}>
                  <TableCell className="font-medium">{o.ownerName}</TableCell>
                  <TableCell className="text-right tabular-nums">{fmt(o.committed)}</TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">
                    {fmt(o.weightedPipeline)}
                  </TableCell>
                  <TableCell className="text-right font-medium tabular-nums">{fmt(o.expected)}</TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">{o.dealCount}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>

        <div className="rounded-lg border border-border bg-card">
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <div>
              <h3 className="text-sm font-medium">Manual adjustments & targets</h3>
              <p className="text-xs text-muted-foreground">Overrides layered on top of the calculation.</p>
            </div>
            {canManage && (
              <Button size="sm" onClick={() => openNewAdjustment(1)}>
                <Plus data-icon="inline-start" />
                Add
              </Button>
            )}
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Quarter</TableHead>
                <TableHead>Type</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead>Scope</TableHead>
                <TableHead>Reason</TableHead>
                {canManage && <TableHead className="w-10" />}
              </TableRow>
            </TableHeader>
            <TableBody>
              {adjustments.length === 0 && (
                <TableRow>
                  <TableCell colSpan={canManage ? 6 : 5} className="py-8 text-center text-sm text-muted-foreground">
                    No manual adjustments for this year.
                  </TableCell>
                </TableRow>
              )}
              {adjustments.map((a) => (
                <TableRow key={a.id}>
                  <TableCell>Q{a.quarter}</TableCell>
                  <TableCell>
                    <Badge variant="outline">{a.adjustment_type}</Badge>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{fmt(a.amount)}</TableCell>
                  <TableCell className="text-muted-foreground">{a.owner_name ?? "Team"}</TableCell>
                  <TableCell className="max-w-48 truncate text-muted-foreground" title={a.reason}>
                    {a.reason}
                  </TableCell>
                  {canManage && (
                    <TableCell className="text-right">
                      <DropdownMenu>
                        <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label="Actions" />}>
                          <MoreHorizontal className="size-4" />
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => openEditAdjustment(a)}>Edit</DropdownMenuItem>
                          <DropdownMenuItem variant="destructive" onClick={() => deleteAdjustment(a)}>
                            Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>

      {data && (
        <ForecastAdjustmentDialog
          open={adjOpen}
          onOpenChange={setAdjOpen}
          fyStartYear={data.fyStartYear}
          fyLabel={data.fyLabel}
          defaultQuarter={adjQuarter}
          editing={editingAdj}
          onSaved={() => {
            setAdjOpen(false)
            toast.success(editingAdj ? "Adjustment updated" : "Adjustment added")
            mutate()
          }}
        />
      )}

      {data && (
        <ForecastQuarterDrawer
          open={drawerQuarter != null}
          onOpenChange={(o) => !o && setDrawerQuarter(null)}
          quarter={drawerQuarter}
          fyStartYear={data.fyStartYear}
          fyLabel={data.fyLabel}
          owner={owner}
        />
      )}
    </div>
  )
}
