"use client"

import useSWR from "swr"
import { fetcher } from "@/lib/fetcher"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { CalendarClock, Scale } from "lucide-react"
import { currency, DIRECTION_COPY, Stat, StatusBadge, type Direction } from "./shared"

type Row = {
  period: string
  quarter: string
  base: number
  deducted: number
  interest: number
  late_fee: number
  total_liability: number
  deposited: number
  paid: number
  balance: number
  due_date: string
  status: string
}
type QuarterRow = {
  quarter: string
  base: number
  tds: number
  payments: number
  balance: number
  return_form: string | null
  return_id: string | null
  return_status: string
  return_due_date: string
}
type Liability = {
  financial_year: string
  direction: Direction
  deposit_applicable: boolean
  rows: Row[]
  totals: {
    base: number
    deducted: number
    interest: number
    late_fee: number
    total_liability: number
    deposited: number
    paid: number
    balance: number
  }
  quarterly: QuarterRow[]
}

export function LiabilityStage({ direction, fy }: { direction: Direction; fy: string }) {
  const copy = DIRECTION_COPY[direction]
  const { data } = useSWR<Liability>(`/api/finance/tds/liability?fy=${fy}&direction=${direction}`, fetcher)
  const rows = data?.rows ?? []
  const quarterly = data?.quarterly ?? []
  const depositApplicable = data?.deposit_applicable ?? direction !== "receivable"
  // Only show interest / late-fee columns once something has actually accrued.
  const hasCharges = depositApplicable && ((data?.totals.interest ?? 0) > 0 || (data?.totals.late_fee ?? 0) > 0)
  // Columns: Month, Quarter, Base, TDS/Credit (+ Interest, Late fee, Total, Paid, Balance, Due date for deductor) + Status.
  const colSpan = depositApplicable ? (hasCharges ? 11 : 9) : 4

  return (
    <div className="flex flex-col gap-6">
      <p className="text-sm text-muted-foreground">
        {depositApplicable
          ? "Month-by-month TDS liability for the year: tax deducted, statutory interest and late fee, the total payable, and the balance still due by the 7th of the next month (30 April for March)."
          : "Month-by-month TDS credit available to you (Form 26AS). Receivable TDS is a credit you claim, not a deposit you owe."}
      </p>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label={depositApplicable ? "Deducted" : "Credit available"} value={currency(data?.totals.deducted)} />
        {hasCharges ? (
          <Stat label="Interest + late fee" value={currency((data?.totals.interest ?? 0) + (data?.totals.late_fee ?? 0))} hint="234E / 201(1A)" />
        ) : null}
        {depositApplicable ? (
          <Stat label="Total liability" value={currency(data?.totals.total_liability)} hint="TDS + interest + late fee" />
        ) : null}
        {depositApplicable ? <Stat label="Paid via challan" value={currency(data?.totals.paid)} /> : null}
        {depositApplicable ? (
          <Stat label="Balance payable" value={currency(data?.totals.balance)} hint="Liability − paid" />
        ) : null}
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Scale className="h-4 w-4" />
            {copy.label} · Monthly liability · FY {fy}
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Month</TableHead>
                  <TableHead>Quarter</TableHead>
                  <TableHead className="text-right">Base</TableHead>
                  <TableHead className="text-right">{depositApplicable ? "Deducted" : "Credit"}</TableHead>
                  {hasCharges ? <TableHead className="text-right">Interest</TableHead> : null}
                  {hasCharges ? <TableHead className="text-right">Late fee</TableHead> : null}
                  {depositApplicable ? <TableHead className="text-right">Total liability</TableHead> : null}
                  {depositApplicable ? <TableHead className="text-right">Paid</TableHead> : null}
                  {depositApplicable ? <TableHead className="text-right">Balance</TableHead> : null}
                  {depositApplicable ? <TableHead>Due date</TableHead> : null}
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={colSpan} className="py-8 text-center text-sm text-muted-foreground">
                      No TDS activity in this financial year.
                    </TableCell>
                  </TableRow>
                ) : (
                  rows.map((r) => (
                    <TableRow key={r.period}>
                      <TableCell className="font-medium">{r.period}</TableCell>
                      <TableCell className="text-muted-foreground">{r.quarter}</TableCell>
                      <TableCell className="text-right">{currency(r.base)}</TableCell>
                      <TableCell className="text-right">{currency(r.deducted)}</TableCell>
                      {hasCharges ? <TableCell className="text-right">{currency(r.interest)}</TableCell> : null}
                      {hasCharges ? <TableCell className="text-right">{currency(r.late_fee)}</TableCell> : null}
                      {depositApplicable ? <TableCell className="text-right">{currency(r.total_liability)}</TableCell> : null}
                      {depositApplicable ? <TableCell className="text-right">{currency(r.paid)}</TableCell> : null}
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

      {depositApplicable ? (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <CalendarClock className="h-4 w-4" />
              Quarterly summary · FY {fy}
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Quarter</TableHead>
                    <TableHead className="text-right">Base</TableHead>
                    <TableHead className="text-right">TDS</TableHead>
                    <TableHead className="text-right">Paid</TableHead>
                    <TableHead className="text-right">Balance</TableHead>
                    <TableHead>Return</TableHead>
                    <TableHead>Due date</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {quarterly.map((q) => (
                    <TableRow key={q.quarter}>
                      <TableCell className="font-medium">{q.quarter}</TableCell>
                      <TableCell className="text-right">{currency(q.base)}</TableCell>
                      <TableCell className="text-right">{currency(q.tds)}</TableCell>
                      <TableCell className="text-right">{currency(q.payments)}</TableCell>
                      <TableCell className="text-right font-medium">{currency(q.balance)}</TableCell>
                      <TableCell className="text-muted-foreground">
                        {q.return_form ?? "—"}
                        {q.return_id ? <span className="ml-1 text-xs">({q.return_id})</span> : null}
                      </TableCell>
                      <TableCell className="text-muted-foreground">{String(q.return_due_date).slice(0, 10)}</TableCell>
                      <TableCell>
                        <StatusBadge status={q.return_status} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      ) : null}
    </div>
  )
}
