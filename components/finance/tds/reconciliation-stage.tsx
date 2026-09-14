"use client"

import useSWR from "swr"
import { fetcher } from "@/lib/fetcher"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { GitCompareArrows } from "lucide-react"
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

function variance(n: number) {
  if (Math.abs(n) <= 0.5) return <span className="text-muted-foreground">—</span>
  return <span className="font-medium text-destructive">{currency(n)}</span>
}

export function ReconciliationStage({ direction, fy }: { direction: Direction; fy: string }) {
  const { data } = useSWR<Recon>(`/api/finance/tds/reconciliation?fy=${fy}&direction=${direction}`, fetcher)
  const rows = data?.rows ?? []
  const depositApplicable = data?.deposit_applicable ?? direction !== "receivable"

  return (
    <div className="flex flex-col gap-6">
      <p className="text-sm text-muted-foreground">
        Three-way reconciliation across the year: TDS <strong>deducted</strong> in the source ledgers vs.{" "}
        <strong>deposited</strong> by challan vs. <strong>reported</strong> in filed returns, with certificates issued.
        Any quarter out of balance is flagged.
      </p>

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
    </div>
  )
}
