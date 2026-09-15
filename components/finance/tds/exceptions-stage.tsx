"use client"

import useSWR from "swr"
import { useState } from "react"
import { fetcher } from "@/lib/fetcher"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { ShieldCheck, ShieldAlert, AlertTriangle, Info, ChevronDown, ChevronRight, ExternalLink } from "lucide-react"
import { currency, Stat, StageHeading, type Direction } from "./shared"

type Severity = "error" | "warning" | "info"
type ExceptionRow = {
  label: string
  detail?: string
  amount?: number
  href?: string
  [k: string]: unknown
}
type ExceptionCategory = {
  key: string
  label: string
  severity: Severity
  description: string
  count: number
  amount: number
  rows: ExceptionRow[]
}
type ExceptionReport = {
  financial_year: string
  direction: Direction
  categories: ExceptionCategory[]
  categories_flagged: number
  total_exceptions: number
  errors: number
  warnings: number
}

const SEVERITY_META: Record<Severity, { icon: typeof AlertTriangle; variant: "destructive" | "secondary" | "outline"; label: string }> = {
  error: { icon: ShieldAlert, variant: "destructive", label: "Blocker" },
  warning: { icon: AlertTriangle, variant: "secondary", label: "Warning" },
  info: { icon: Info, variant: "outline", label: "Info" },
}

function CategoryCard({ cat }: { cat: ExceptionCategory }) {
  const [open, setOpen] = useState(false)
  const meta = SEVERITY_META[cat.severity]
  const Icon = meta.icon
  const hasRows = cat.rows.length > 0

  return (
    <Card>
      <CardHeader className="p-0">
        <button
          type="button"
          onClick={() => hasRows && setOpen((o) => !o)}
          className="flex w-full items-center justify-between gap-3 p-4 text-left disabled:cursor-default"
          disabled={!hasRows}
          aria-expanded={open}
        >
          <div className="flex items-start gap-3">
            <Icon
              className={
                cat.severity === "error"
                  ? "mt-0.5 h-5 w-5 shrink-0 text-destructive"
                  : cat.severity === "warning"
                    ? "mt-0.5 h-5 w-5 shrink-0 text-amber-600"
                    : "mt-0.5 h-5 w-5 shrink-0 text-muted-foreground"
              }
            />
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-2">
                <span className="font-medium">{cat.label}</span>
                <Badge variant={meta.variant}>{meta.label}</Badge>
              </div>
              <p className="text-sm text-muted-foreground">{cat.description}</p>
            </div>
          </div>
          <div className="flex items-center gap-3 pl-2">
            <div className="text-right">
              <div className="text-lg font-semibold tabular-nums">{cat.count}</div>
              {cat.amount ? <div className="text-xs text-muted-foreground">{currency(cat.amount)}</div> : null}
            </div>
            {hasRows ? (
              open ? (
                <ChevronDown className="h-4 w-4 text-muted-foreground" />
              ) : (
                <ChevronRight className="h-4 w-4 text-muted-foreground" />
              )
            ) : null}
          </div>
        </button>
      </CardHeader>
      {open && hasRows ? (
        <CardContent className="p-0">
          <div className="overflow-x-auto border-t">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Item</TableHead>
                  <TableHead>Detail</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {cat.rows.map((r, i) => (
                  <TableRow key={`${cat.key}-${i}`}>
                    <TableCell className="font-medium">
                      {r.href ? (
                        <a href={r.href} className="inline-flex items-center gap-1 text-primary hover:underline">
                          {r.label}
                          <ExternalLink className="h-3 w-3" />
                        </a>
                      ) : (
                        r.label
                      )}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">{r.detail ?? "—"}</TableCell>
                    <TableCell className="text-right">{r.amount ? currency(r.amount) : "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      ) : null}
    </Card>
  )
}

export function ExceptionsStage({ direction, fy }: { direction: Direction; fy: string }) {
  const { data, isLoading } = useSWR<ExceptionReport>(
    `/api/finance/tds/exceptions?fy=${fy}&direction=${direction}`,
    fetcher,
  )
  const [filter, setFilter] = useState<"all" | "flagged">("flagged")

  const categories = data?.categories ?? []
  const shown = filter === "flagged" ? categories.filter((c) => c.count > 0) : categories
  const clean = !isLoading && (data?.total_exceptions ?? 0) === 0

  return (
    <div className="flex flex-col gap-6">
      <StageHeading
        icon={<ShieldAlert className="h-5 w-5 text-muted-foreground" />}
        title="Exception Center"
      >
        <div className="flex gap-2">
          <Button size="sm" variant={filter === "flagged" ? "default" : "outline"} onClick={() => setFilter("flagged")}>
            Flagged only
          </Button>
          <Button size="sm" variant={filter === "all" ? "default" : "outline"} onClick={() => setFilter("all")}>
            All checks
          </Button>
        </div>
      </StageHeading>

      <p className="text-sm text-muted-foreground">
        Every filing blocker and data-quality risk for FY {fy}, derived from the same engine that computes the return.
        <strong> Blockers</strong> (PAN, TAN, section, challan, unpaid) must be cleared before filing; <strong>warnings</strong>{" "}
        (rate, threshold, late payment/filing, reconciliation variance) should be reviewed. Nothing here is fabricated —
        each row links back to its source record.
      </p>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Total exceptions" value={String(data?.total_exceptions ?? 0)} />
        <Stat label="Blockers" value={String(data?.errors ?? 0)} hint="Must fix before filing" />
        <Stat label="Warnings" value={String(data?.warnings ?? 0)} hint="Review recommended" />
        <Stat label="Categories flagged" value={String(data?.categories_flagged ?? 0)} />
      </div>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Running exception checks…</p>
      ) : clean ? (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <ShieldCheck className="h-4 w-4 text-emerald-600" />
              No exceptions
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              All {categories.length} compliance checks pass for FY {fy}. This filing is ready to export.
            </p>
          </CardContent>
        </Card>
      ) : shown.length === 0 ? (
        <p className="text-sm text-muted-foreground">No categories match the current filter.</p>
      ) : (
        <div className="flex flex-col gap-3">
          {shown.map((cat) => (
            <CategoryCard key={cat.key} cat={cat} />
          ))}
        </div>
      )}
    </div>
  )
}
