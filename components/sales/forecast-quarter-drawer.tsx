"use client"

import useSWR from "swr"
import { fetcher } from "@/lib/fetcher"
import { useFormatCurrency } from "@/components/providers/settings-provider"
import { formatDate } from "@/lib/utils"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Badge } from "@/components/ui/badge"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { CATEGORY_BADGE, RISK_BADGE } from "@/lib/sales/forecast-model"
import type { ForecastOpportunity, QuarterForecast } from "@/components/sales/forecast-client"

const SOURCE_HINT: Record<string, string> = {
  Contract: "Committed contract value",
  Quotation: "Current quotation value",
  Lead: "Lead estimated value",
}

function OpportunityTable({
  rows,
  fmt,
}: {
  rows: ForecastOpportunity[]
  fmt: (v: number | string) => string
}) {
  if (rows.length === 0) {
    return <p className="py-6 text-center text-sm text-muted-foreground">No contributing opportunities.</p>
  }
  return (
    <div className="overflow-x-auto rounded-md border border-border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Opportunity</TableHead>
            <TableHead>Owner</TableHead>
            <TableHead>Category</TableHead>
            <TableHead className="text-right">Prob.</TableHead>
            <TableHead className="text-right">Value</TableHead>
            <TableHead className="text-right">Weighted</TableHead>
            <TableHead>Expected close</TableHead>
            <TableHead>Risk</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((o) => (
            <TableRow key={o.key}>
              <TableCell>
                <div className="flex flex-col gap-0.5">
                  <span className="font-medium">{o.companyName || o.leadCode || o.quotationCode || o.contractCode || "—"}</span>
                  <span className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
                    <span title={SOURCE_HINT[o.source]}>{o.source}</span>
                    {o.leadCode && <span>· {o.leadCode}</span>}
                    {o.quotationCode && <span>· {o.quotationCode}</span>}
                    {o.contractCode && <span>· {o.contractCode}</span>}
                    {o.stage && <span>· {o.stage}</span>}
                  </span>
                </div>
              </TableCell>
              <TableCell className="text-muted-foreground">{o.ownerName || "Unassigned"}</TableCell>
              <TableCell>
                <Badge variant={CATEGORY_BADGE[o.category]}>{o.category}</Badge>
              </TableCell>
              <TableCell className="text-right tabular-nums">{o.probability}%</TableCell>
              <TableCell className="text-right font-medium tabular-nums">{fmt(o.value)}</TableCell>
              <TableCell className="text-right tabular-nums text-muted-foreground">{fmt(o.weightedValue)}</TableCell>
              <TableCell className="text-muted-foreground">{o.closeDate ? formatDate(o.closeDate) : "—"}</TableCell>
              <TableCell>
                <Badge
                  variant={RISK_BADGE[o.risk]}
                  title={o.riskReasons.length ? o.riskReasons.join(", ") : "No risk signals"}
                >
                  {o.risk}
                </Badge>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

export function ForecastQuarterDrawer({
  open,
  onOpenChange,
  quarter,
  fyStartYear,
  fyLabel,
  owner,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  quarter: QuarterForecast | null
  fyStartYear: number
  fyLabel: string
  owner: string
}) {
  const fmt = useFormatCurrency()
  const key =
    open && quarter
      ? `/api/sales/forecast/quarter?fy=${fyStartYear}&q=${quarter.quarter}&owner=${owner}`
      : null
  const { data, isLoading } = useSWR<{ contributors: ForecastOpportunity[]; unscheduled: ForecastOpportunity[] }>(
    key,
    fetcher,
  )

  const contributors = data?.contributors ?? []

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>
            {quarter ? `${quarter.label} ${fyLabel}` : "Quarter detail"}
          </DialogTitle>
          <DialogDescription>
            Every opportunity contributing to this quarter, with its commercial lineage. Each deal is counted once.
          </DialogDescription>
        </DialogHeader>

        {quarter && (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Metric label="Expected" value={fmt(quarter.expected)} />
            <Metric label="Committed" value={fmt(quarter.committed)} />
            <Metric label="Weighted pipeline" value={fmt(quarter.weightedPipeline)} />
            <Metric label="Best case" value={fmt(quarter.bestCase)} />
            <Metric label="Worst case" value={fmt(quarter.worstCase)} />
            <Metric label="Target" value={quarter.target > 0 ? fmt(quarter.target) : "—"} />
            <Metric label="Actual invoiced" value={fmt(quarter.actualInvoiced)} />
            <Metric label="Coverage" value={quarter.coverage != null ? `${quarter.coverage}x` : "—"} />
          </div>
        )}

        {quarter && (
          <p className="rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
            Expected = Committed ({fmt(quarter.committed)}) + Weighted open pipeline ({fmt(quarter.weightedPipeline)})
            {quarter.adjustments.expected ? ` + Manual adjustment (${fmt(quarter.adjustments.expected)})` : ""}. Weighted
            pipeline = each open deal&apos;s value × its probability.
          </p>
        )}

        {isLoading ? (
          <p className="py-6 text-center text-sm text-muted-foreground">Loading contributors...</p>
        ) : (
          <OpportunityTable rows={contributors} fmt={fmt} />
        )}
      </DialogContent>
    </Dialog>
  )
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border bg-card px-3 py-2">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-sm font-semibold tabular-nums">{value}</p>
    </div>
  )
}
