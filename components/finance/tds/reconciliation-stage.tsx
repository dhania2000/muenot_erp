"use client"

import useSWR from "swr"
import { useState } from "react"
import { fetcher } from "@/lib/fetcher"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { GitCompareArrows, ExternalLink, ShieldCheck, ShieldAlert, Check, X } from "lucide-react"
import { currency, Stat, StatusBadge, type Direction } from "./shared"

type Row = {
  quarter: string
  deducted: number
  deposited: number
  returned: number
  certified: number
  deposit_variance: number
  return_variance: number
  status: string
}
type Recon = {
  financial_year: string
  deposit_applicable: boolean
  rows: Row[]
  totals: { deducted: number; deposited: number; returned: number; certified: number }
}

type TraceRow = {
  source_module: string
  source_ref: string
  source_href: string
  doc_date: string
  quarter: string
  party_name: string
  party_href: string
  pan: string
  section: string
  deducted: number
  deposited: number
  bank_posted: boolean
  returned: boolean
  certified: boolean
  status: string
}
type Trace = {
  rows: TraceRow[]
  totals: { deducted: number; deposited: number; returned: number; certified: number; matched: number; exceptions: number }
  status_counts: Record<string, number>
}
type DupGroup = {
  dup_key: string
  source_module: string
  party_name: string
  section: string
  occurrences: number
  total_tds: number
  refs: string[]
}
type Dups = { scanned: number; duplicates: DupGroup[] }

function variance(n: number) {
  if (Math.abs(n) <= 0.5) return <span className="text-muted-foreground">—</span>
  return <span className="font-medium text-destructive">{currency(n)}</span>
}

function LayerDot({ on }: { on: boolean }) {
  return on ? (
    <Check className="mx-auto h-4 w-4 text-emerald-600" aria-label="Yes" />
  ) : (
    <X className="mx-auto h-4 w-4 text-muted-foreground/50" aria-label="No" />
  )
}

export function ReconciliationStage({ direction, fy }: { direction: Direction; fy: string }) {
  const [view, setView] = useState<"summary" | "trace" | "duplicates">("summary")
  const { data } = useSWR<Recon>(`/api/finance/tds/reconciliation?fy=${fy}&direction=${direction}`, fetcher)
  const rows = data?.rows ?? []
  const depositApplicable = data?.deposit_applicable ?? direction !== "receivable"

  return (
    <div className="flex flex-col gap-6">
      <p className="text-sm text-muted-foreground">
        Reconcile TDS end to end: the quarterly <strong>summary</strong> balances deducted vs. deposited vs. returned;
        the document <strong>trace</strong> follows every source invoice/bill through challan, bank posting, return and
        certificate; <strong>duplicate control</strong> proves each deduction is unique.
      </p>

      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant={view === "summary" ? "default" : "outline"} onClick={() => setView("summary")}>
          Quarterly summary
        </Button>
        <Button size="sm" variant={view === "trace" ? "default" : "outline"} onClick={() => setView("trace")}>
          Document trace
        </Button>
        <Button size="sm" variant={view === "duplicates" ? "default" : "outline"} onClick={() => setView("duplicates")}>
          Duplicate control
        </Button>
      </div>

      {view === "summary" ? (
        <>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <Stat label="Deducted" value={currency(data?.totals.deducted)} />
            <Stat label="Deposited" value={currency(data?.totals.deposited)} />
            <Stat label="Returned" value={currency(data?.totals.returned)} />
            <Stat label="Certified" value={currency(data?.totals.certified)} />
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <GitCompareArrows className="h-4 w-4" />
                Quarterly reconciliation · FY {fy}
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Quarter</TableHead>
                      <TableHead className="text-right">Deducted</TableHead>
                      <TableHead className="text-right">Deposited</TableHead>
                      <TableHead className="text-right">Returned</TableHead>
                      <TableHead className="text-right">Certified</TableHead>
                      {depositApplicable ? <TableHead className="text-right">Deposit gap</TableHead> : null}
                      {depositApplicable ? <TableHead className="text-right">Return gap</TableHead> : null}
                      <TableHead>Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={depositApplicable ? 8 : 6} className="py-8 text-center text-sm text-muted-foreground">
                          No data for this financial year.
                        </TableCell>
                      </TableRow>
                    ) : (
                      rows.map((r) => (
                        <TableRow key={r.quarter}>
                          <TableCell className="font-medium">{r.quarter}</TableCell>
                          <TableCell className="text-right">{currency(r.deducted)}</TableCell>
                          <TableCell className="text-right">{currency(r.deposited)}</TableCell>
                          <TableCell className="text-right">{currency(r.returned)}</TableCell>
                          <TableCell className="text-right">{currency(r.certified)}</TableCell>
                          {depositApplicable ? <TableCell className="text-right">{variance(r.deposit_variance)}</TableCell> : null}
                          {depositApplicable ? <TableCell className="text-right">{variance(r.return_variance)}</TableCell> : null}
                          <TableCell>
                            <StatusBadge status={r.status} />
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                  {rows.length > 0 ? (
                    <TableFooter>
                      <TableRow>
                        <TableCell className="font-medium">Total</TableCell>
                        <TableCell className="text-right font-medium">{currency(data?.totals.deducted)}</TableCell>
                        <TableCell className="text-right font-medium">{currency(data?.totals.deposited)}</TableCell>
                        <TableCell className="text-right font-medium">{currency(data?.totals.returned)}</TableCell>
                        <TableCell className="text-right font-medium">{currency(data?.totals.certified)}</TableCell>
                        {depositApplicable ? <TableCell /> : null}
                        {depositApplicable ? <TableCell /> : null}
                        <TableCell />
                      </TableRow>
                    </TableFooter>
                  ) : null}
                </Table>
              </div>
            </CardContent>
          </Card>
        </>
      ) : null}

      {view === "trace" ? <TraceView direction={direction} fy={fy} depositApplicable={depositApplicable} /> : null}
      {view === "duplicates" ? <DuplicateView direction={direction} fy={fy} /> : null}
    </div>
  )
}

function TraceView({ direction, fy, depositApplicable }: { direction: Direction; fy: string; depositApplicable: boolean }) {
  const { data, isLoading } = useSWR<Trace>(`/api/finance/tds/trace?fy=${fy}&direction=${direction}`, fetcher)
  const rows = data?.rows ?? []
  const t = data?.totals

  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Documents" value={String(rows.length)} />
        <Stat label="Matched" value={String(t?.matched ?? 0)} />
        <Stat label="Exceptions" value={String(t?.exceptions ?? 0)} />
        <Stat label="TDS traced" value={currency(t?.deducted)} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <GitCompareArrows className="h-4 w-4" />
            Source → Filing → Challan → Bank → Return → Certificate
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Source</TableHead>
                  <TableHead>{direction === "receivable" ? "Customer" : "Deductee"}</TableHead>
                  <TableHead>Section</TableHead>
                  <TableHead className="text-right">TDS</TableHead>
                  <TableHead className="text-right">{depositApplicable ? "Deposited" : "Received"}</TableHead>
                  {depositApplicable ? <TableHead className="text-center">Bank</TableHead> : null}
                  {depositApplicable ? <TableHead className="text-center">Return</TableHead> : null}
                  <TableHead className="text-center">{depositApplicable ? "Cert" : "16A"}</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  <TableRow>
                    <TableCell colSpan={9} className="py-8 text-center text-sm text-muted-foreground">
                      Tracing documents…
                    </TableCell>
                  </TableRow>
                ) : rows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={9} className="py-8 text-center text-sm text-muted-foreground">
                      No TDS documents for this financial year.
                    </TableCell>
                  </TableRow>
                ) : (
                  rows.map((r, i) => (
                    <TableRow key={`${r.source_ref}-${i}`}>
                      <TableCell>
                        <div className="flex items-center gap-1.5">
                          {r.source_href ? (
                            <a
                              href={r.source_href}
                              className="inline-flex items-center gap-1 font-mono text-xs text-primary hover:underline"
                            >
                              {r.source_ref}
                              <ExternalLink className="h-3 w-3" />
                            </a>
                          ) : (
                            <span className="font-mono text-xs">{r.source_ref}</span>
                          )}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {r.source_module} · {r.doc_date} · {r.quarter}
                        </div>
                      </TableCell>
                      <TableCell>
                        {r.party_href ? (
                          <a href={r.party_href} className="text-sm text-primary hover:underline">
                            {r.party_name}
                          </a>
                        ) : (
                          <span className="text-sm">{r.party_name}</span>
                        )}
                        <div className="font-mono text-xs text-muted-foreground">
                          {r.pan || <span className="text-destructive">No PAN</span>}
                        </div>
                      </TableCell>
                      <TableCell className="text-sm">{r.section}</TableCell>
                      <TableCell className="text-right">{currency(r.deducted)}</TableCell>
                      <TableCell className="text-right">{currency(r.deposited)}</TableCell>
                      {depositApplicable ? (
                        <TableCell>
                          <LayerDot on={r.bank_posted} />
                        </TableCell>
                      ) : null}
                      {depositApplicable ? (
                        <TableCell>
                          <LayerDot on={r.returned} />
                        </TableCell>
                      ) : null}
                      <TableCell>
                        <LayerDot on={r.certified} />
                      </TableCell>
                      <TableCell>
                        <StatusBadge status={r.status} />
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

function DuplicateView({ direction, fy }: { direction: Direction; fy: string }) {
  const { data, isLoading } = useSWR<Dups>(`/api/finance/tds/duplicates?fy=${fy}&direction=${direction}`, fetcher)
  const dups = data?.duplicates ?? []
  const clean = !isLoading && dups.length === 0

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          {clean ? (
            <ShieldCheck className="h-4 w-4 text-emerald-600" />
          ) : (
            <ShieldAlert className="h-4 w-4 text-amber-600" />
          )}
          Duplicate control · {data?.scanned ?? 0} deductions scanned
        </CardTitle>
      </CardHeader>
      <CardContent className={clean ? "" : "p-0"}>
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Scanning for duplicate TDS events…</p>
        ) : clean ? (
          <p className="text-sm text-muted-foreground">
            No duplicates. Every TDS deduction is unique on (source module, transaction, deductee, section) — the
            derived engine emits one deduction per source document.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Module</TableHead>
                  <TableHead>Deductee</TableHead>
                  <TableHead>Section</TableHead>
                  <TableHead className="text-center">Occurrences</TableHead>
                  <TableHead className="text-right">Total TDS</TableHead>
                  <TableHead>References</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {dups.map((g) => (
                  <TableRow key={g.dup_key}>
                    <TableCell className="text-sm">{g.source_module}</TableCell>
                    <TableCell className="text-sm">{g.party_name}</TableCell>
                    <TableCell className="text-sm">{g.section}</TableCell>
                    <TableCell className="text-center font-medium text-destructive">{g.occurrences}</TableCell>
                    <TableCell className="text-right">{currency(g.total_tds)}</TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">{g.refs.join(", ")}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
