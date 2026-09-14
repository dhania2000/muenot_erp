"use client"

import useSWR from "swr"
import { useMemo, useState } from "react"
import { toast } from "sonner"
import { fetcher } from "@/lib/fetcher"
import { inr0 } from "@/lib/finance-calc"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import {
  RefreshCw,
  Lock,
  LockOpen,
  Landmark,
  TrendingUp,
  TrendingDown,
  CalendarClock,
  CheckCircle2,
} from "lucide-react"

type ClosingStatus = {
  financial_year: string
  status: "Open" | "Closed"
  net_profit: number
  total_income: number
  total_expense: number
  voucher_no: string | null
  closed_at: string | null
}

type ListResponse = { closings: ClosingStatus[]; financialYears: string[] }
type StatusResponse = { status: ClosingStatus; financialYears: string[] }

const currency = (n: number) => inr0(Number(n) || 0)

function fmtDate(v: string | null) {
  if (!v) return "—"
  const d = new Date(v)
  if (Number.isNaN(d.getTime())) return v
  return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })
}

function StatusBadge({ status }: { status: "Open" | "Closed" }) {
  return status === "Closed" ? (
    <Badge variant="secondary" className="gap-1">
      <Lock className="size-3.5" />
      Closed
    </Badge>
  ) : (
    <Badge variant="outline" className="gap-1">
      <LockOpen className="size-3.5" />
      Open
    </Badge>
  )
}

export function YearEndClosingClient() {
  const [fy, setFy] = useState<string>("")
  const [pending, setPending] = useState<null | { action: "close" | "reopen"; fy: string; status: ClosingStatus }>(null)
  const [submitting, setSubmitting] = useState(false)

  const listKey = "/api/finance/year-end-closing"
  const {
    data: list,
    isLoading: listLoading,
    isValidating: listValidating,
    mutate: mutateList,
  } = useSWR<ListResponse>(listKey, fetcher, { keepPreviousData: true })

  const financialYears = list?.financialYears ?? []
  const closings = list?.closings ?? []

  // Default the selector to the latest financial year once data arrives.
  const selectedFy = fy || financialYears[0] || ""

  const statusKey = selectedFy ? `/api/finance/year-end-closing?fy=${encodeURIComponent(selectedFy)}` : null
  const {
    data: statusData,
    isLoading: statusLoading,
    isValidating: statusValidating,
    mutate: mutateStatus,
  } = useSWR<StatusResponse>(statusKey, fetcher, { keepPreviousData: true })

  const status = statusData?.status

  const closedCount = useMemo(() => closings.filter((c) => c.status === "Closed").length, [closings])

  async function runAction(action: "close" | "reopen", target: string) {
    setSubmitting(true)
    try {
      const res = await fetch(listKey, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ financial_year: target, action }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error || "Request failed")
      toast.success(action === "close" ? `FY ${target} closed successfully` : `FY ${target} re-opened`)
      await Promise.all([mutateList(), mutateStatus()])
    } catch (err) {
      toast.error((err as Error).message || "Action failed")
    } finally {
      setSubmitting(false)
      setPending(null)
    }
  }

  return (
    <div className="flex flex-col gap-6 p-4 md:p-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Year-End Closing</h1>
        <p className="text-sm text-muted-foreground">
          Close a financial year by transferring the net Profit &amp; Loss result to Retained Earnings. Posting runs
          through the same Journal &amp; General Ledger pipeline every other module uses — closings are exact,
          idempotent and reversible.
        </p>
      </header>

      {/* Summary cards */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-2 pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Years Closed</CardTitle>
            <Lock className="size-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-semibold tabular-nums">{closedCount}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-2 pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Ledger Years</CardTitle>
            <CalendarClock className="size-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-semibold tabular-nums">{financialYears.length}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-2 pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              {selectedFy ? `FY ${selectedFy} Net` : "Net Result"}
            </CardTitle>
            {status && status.net_profit >= 0 ? (
              <TrendingUp className="size-4 text-emerald-600" />
            ) : (
              <TrendingDown className="size-4 text-destructive" />
            )}
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-semibold tabular-nums">
              {status ? currency(Math.abs(status.net_profit)) : "—"}
            </div>
            <p className="text-xs text-muted-foreground">
              {status ? (status.net_profit >= 0 ? "Net Profit" : "Net Loss") : "Select a year"}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-2 pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Retained Earnings</CardTitle>
            <Landmark className="size-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-semibold tabular-nums">3910</div>
            <p className="text-xs text-muted-foreground">Equity carry-forward head</p>
          </CardContent>
        </Card>
      </div>

      {/* Selected-year closing panel */}
      <Card>
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-1">
            <CardTitle className="text-base">Close a Financial Year</CardTitle>
            <CardDescription>
              Review the net result that will be transferred to Retained Earnings, then close the year.
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Select value={selectedFy} onValueChange={setFy}>
              <SelectTrigger className="w-40" aria-label="Financial year">
                <SelectValue placeholder="Financial year" />
              </SelectTrigger>
              <SelectContent>
                {financialYears.length === 0 ? (
                  <SelectItem value="none" disabled>
                    No ledger activity
                  </SelectItem>
                ) : (
                  financialYears.map((y) => (
                    <SelectItem key={y} value={y}>
                      FY {y}
                    </SelectItem>
                  ))
                )}
              </SelectContent>
            </Select>
            <Button
              variant="outline"
              size="icon"
              onClick={() => {
                mutateList()
                mutateStatus()
              }}
              aria-label="Refresh"
            >
              <RefreshCw className={`size-4 ${listValidating || statusValidating ? "animate-spin" : ""}`} />
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {!selectedFy ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              No financial years with ledger activity yet.
            </p>
          ) : statusLoading && !status ? (
            <p className="py-8 text-center text-sm text-muted-foreground">Loading…</p>
          ) : !status ? (
            <p className="py-8 text-center text-sm text-muted-foreground">No data.</p>
          ) : (
            <div className="flex flex-col gap-4">
              <div className="flex flex-wrap items-center gap-3">
                <span className="text-sm font-medium">FY {status.financial_year}</span>
                <StatusBadge status={status.status} />
                {status.voucher_no ? (
                  <span className="text-xs text-muted-foreground">Voucher {status.voucher_no}</span>
                ) : null}
                {status.closed_at ? (
                  <span className="text-xs text-muted-foreground">Closed {fmtDate(status.closed_at)}</span>
                ) : null}
              </div>

              <div className="grid gap-3 sm:grid-cols-3">
                <div className="rounded-lg border p-3">
                  <p className="text-xs text-muted-foreground">Total Income</p>
                  <p className="text-lg font-semibold tabular-nums text-emerald-600">
                    {currency(status.total_income)}
                  </p>
                </div>
                <div className="rounded-lg border p-3">
                  <p className="text-xs text-muted-foreground">Total Expense</p>
                  <p className="text-lg font-semibold tabular-nums text-destructive">
                    {currency(status.total_expense)}
                  </p>
                </div>
                <div className="rounded-lg border p-3">
                  <p className="text-xs text-muted-foreground">
                    {status.net_profit >= 0 ? "Net Profit" : "Net Loss"} → Retained Earnings
                  </p>
                  <p className="text-lg font-semibold tabular-nums">{currency(Math.abs(status.net_profit))}</p>
                </div>
              </div>

              <div className="flex flex-wrap gap-2">
                {status.status === "Closed" ? (
                  <Button
                    variant="outline"
                    disabled={submitting}
                    onClick={() => setPending({ action: "reopen", fy: status.financial_year, status })}
                  >
                    <LockOpen className="size-4" />
                    Re-open Year
                  </Button>
                ) : (
                  <Button
                    disabled={submitting}
                    onClick={() => setPending({ action: "close", fy: status.financial_year, status })}
                  >
                    <Lock className="size-4" />
                    Close Year
                  </Button>
                )}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* History of recorded closings */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Closing History</CardTitle>
          <CardDescription>Every financial year that has been closed, newest first.</CardDescription>
        </CardHeader>
        <CardContent>
          {listLoading && closings.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">Loading…</p>
          ) : closings.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-10 text-center">
              <CheckCircle2 className="size-6 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">No years have been closed yet.</p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Financial Year</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Income</TableHead>
                  <TableHead className="text-right">Expense</TableHead>
                  <TableHead className="text-right">Net Result</TableHead>
                  <TableHead>Voucher</TableHead>
                  <TableHead>Closed On</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {closings.map((c) => (
                  <TableRow
                    key={c.financial_year}
                    className="cursor-pointer"
                    onClick={() => setFy(c.financial_year)}
                  >
                    <TableCell className="font-medium">FY {c.financial_year}</TableCell>
                    <TableCell>
                      <StatusBadge status={c.status} />
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{currency(c.total_income)}</TableCell>
                    <TableCell className="text-right tabular-nums">{currency(c.total_expense)}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {c.net_profit >= 0 ? currency(c.net_profit) : `(${currency(Math.abs(c.net_profit))})`}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{c.voucher_no || "—"}</TableCell>
                    <TableCell className="text-muted-foreground">{fmtDate(c.closed_at)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <AlertDialog open={!!pending} onOpenChange={(open) => !open && !submitting && setPending(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pending?.action === "close"
                ? `Close FY ${pending?.fy}?`
                : `Re-open FY ${pending?.fy}?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pending?.action === "close" ? (
                <>
                  This posts a balanced closing voucher that zeroes the Profit &amp; Loss accounts and carries the{" "}
                  {pending?.status && pending.status.net_profit >= 0 ? "net profit" : "net loss"} of{" "}
                  <span className="font-medium text-foreground">
                    {pending?.status ? currency(Math.abs(pending.status.net_profit)) : ""}
                  </span>{" "}
                  into Retained Earnings. It is reversible.
                </>
              ) : (
                <>
                  This reverses the closing voucher for FY {pending?.fy}, restoring the Profit &amp; Loss balances and
                  marking the year open again.
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={submitting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={submitting}
              onClick={(e) => {
                e.preventDefault()
                if (pending) runAction(pending.action, pending.fy)
              }}
            >
              {submitting ? "Working…" : pending?.action === "close" ? "Close Year" : "Re-open Year"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
