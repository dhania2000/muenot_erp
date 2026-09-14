"use client"

import useSWR from "swr"
import { fetcher } from "@/lib/fetcher"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Scale } from "lucide-react"
import { currency, DIRECTION_COPY, Stat, StatusBadge, type Direction } from "./shared"

type Row = {
  period: string
  quarter: string
  deducted: number
  deposited: number
  balance: number
  due_date: string
  status: string
}
type Liability = {
  financial_year: string
  direction: Direction
  deposit_applicable: boolean
  rows: Row[]
  totals: { deducted: number; deposited: number; balance: number }
}

export function LiabilityStage({ direction, fy }: { direction: Direction; fy: string }) {
  const copy = DIRECTION_COPY[direction]
  const { data } = useSWR<Liability>(`/api/finance/tds/liability?fy=${fy}&direction=${direction}`, fetcher)
  const rows = data?.rows ?? []
  const depositApplicable = data?.deposit_applicable ?? direction !== "receivable"

  return (
    <div className="flex flex-col gap-6">
      <p className="text-sm text-muted-foreground">
        {depositApplicable
          ? "Month-by-month TDS liability for the year: what was deducted, what has been deposited via challan, and the balance still payable by the 7th of the next month."
          : "Month-by-month TDS credit available to you (Form 26AS). Receivable TDS is a credit you claim, not a deposit you owe."}
      </p>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Stat label={depositApplicable ? "Deducted" : "Credit available"} value={currency(data?.totals.deducted)} />
        {depositApplicable ? <Stat label="Deposited" value={currency(data?.totals.deposited)} /> : null}
        {depositApplicable ? (
          <Stat label="Balance payable" value={currency(data?.totals.balance)} hint="Deducted − deposited" />
        ) : null}
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Scale className="h-4 w-4" />
            {copy.label} · FY {fy}
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Month</TableHead>
                  <TableHead>Quarter</TableHead>
                  <TableHead className="text-right">{depositApplicable ? "Deducted" : "Credit"}</TableHead>
                  {depositApplicable ? <TableHead className="text-right">Deposited</TableHead> : null}
                  {depositApplicable ? <TableHead className="text-right">Balance</TableHead> : null}
                  {depositApplicable ? <TableHead>Due date</TableHead> : null}
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={depositApplicable ? 7 : 3} className="py-8 text-center text-sm text-muted-foreground">
                      No TDS activity in this financial year.
                    </TableCell>
                  </TableRow>
                ) : (
                  rows.map((r) => (
                    <TableRow key={r.period}>
                      <TableCell className="font-medium">{r.period}</TableCell>
                      <TableCell className="text-muted-foreground">{r.quarter}</TableCell>
                      <TableCell className="text-right">{currency(r.deducted)}</TableCell>
                      {depositApplicable ? <TableCell className="text-right">{currency(r.deposited)}</TableCell> : null}
                      {depositApplicable ? (
                        <TableCell className="text-right font-medium">{currency(r.balance)}</TableCell>
                      ) : null}
                      {depositApplicable ? (
                        <TableCell className="text-muted-foreground">{String(r.due_date).slice(0, 10)}</TableCell>
                      ) : null}
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
