"use client"

import useSWR from "swr"
import { Fragment, useMemo, useState } from "react"
import { fetcher } from "@/lib/fetcher"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
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
import { CheckCircle2, AlertTriangle, RefreshCw, Scale, TrendingUp, BookOpen, Waves } from "lucide-react"
import { inr0 } from "@/lib/finance-calc"

type StatementType = "trial-balance" | "profit-loss" | "balance-sheet" | "cash-flow"

type StatementLine = {
  account_id: string
  account_code: string | null
  account_name: string
  group: string
  amount: number
}
type StatementGroup = { group: string; side: string; total: number; lines: StatementLine[] }
type TrialBalanceRow = {
  account_id: string
  account_code: string | null
  account_name: string
  group: string
  debit: number
  credit: number
}

type ApiResponse = {
  type?: StatementType
  fy?: string | null
  data?: any
  financialYears: string[]
}

const currency = (n: number) => inr0(Number(n) || 0)

const TABS: { key: StatementType; label: string; icon: typeof Scale }[] = [
  { key: "trial-balance", label: "Trial Balance", icon: Scale },
  { key: "profit-loss", label: "Profit & Loss", icon: TrendingUp },
  { key: "balance-sheet", label: "Balance Sheet", icon: BookOpen },
  { key: "cash-flow", label: "Cash Flow", icon: Waves },
]

function BalancedBadge({ ok, label }: { ok: boolean; label: string }) {
  return (
    <Badge variant={ok ? "secondary" : "destructive"} className="gap-1">
      {ok ? <CheckCircle2 className="size-3.5" /> : <AlertTriangle className="size-3.5" />}
      {label}
    </Badge>
  )
}

function SectionRows({ groups }: { groups: StatementGroup[] }) {
  return (
    <>
      {groups.map((g) => (
        <Fragment key={`g-${g.group}`}>
          <TableRow className="bg-muted/40">
            <TableCell colSpan={2} className="font-medium">
              {g.group}
            </TableCell>
            <TableCell className="text-right font-medium">{currency(g.total)}</TableCell>
          </TableRow>
          {g.lines.map((l) => (
            <TableRow key={`${g.group}-${l.account_id}`}>
              <TableCell className="pl-8 text-muted-foreground">{l.account_code || "—"}</TableCell>
              <TableCell>{l.account_name}</TableCell>
              <TableCell className="text-right tabular-nums">{currency(l.amount)}</TableCell>
            </TableRow>
          ))}
        </Fragment>
      ))}
    </>
  )
}

export function FinancialStatementsClient() {
  const [type, setType] = useState<StatementType>("trial-balance")
  const [fy, setFy] = useState<string>("")

  const url = useMemo(() => {
    const params = new URLSearchParams({ type })
    if (fy) params.set("fy", fy)
    return `/api/finance/statements?${params.toString()}`
  }, [type, fy])

  const { data, isLoading, isValidating, mutate } = useSWR<ApiResponse>(url, fetcher, {
    keepPreviousData: true,
  })

  const financialYears = data?.financialYears ?? []
  const stmt = data?.data

  return (
    <div className="flex flex-col gap-6 p-4 md:p-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Financial Statements</h1>
        <p className="text-sm text-muted-foreground">
          Trial Balance, Profit &amp; Loss, Balance Sheet and Cash Flow computed live from the Chart of Accounts
          classification and the General Ledger. Read-only — nothing is posted here.
        </p>
      </header>

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-1 rounded-lg border bg-card p-1">
          {TABS.map((t) => {
            const Icon = t.icon
            const active = t.key === type
            return (
              <Button
                key={t.key}
                size="sm"
                variant={active ? "default" : "ghost"}
                className="gap-1.5"
                onClick={() => setType(t.key)}
              >
                <Icon className="size-4" />
                {t.label}
              </Button>
            )
          })}
        </div>

        <div className="ml-auto flex items-center gap-2">
          <Select value={fy || "all"} onValueChange={(v) => setFy(v === "all" ? "" : v)}>
            <SelectTrigger className="w-40">
              <SelectValue placeholder="Financial year" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All periods</SelectItem>
              {financialYears.map((y) => (
                <SelectItem key={y} value={y}>
                  FY {y}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button variant="outline" size="icon" onClick={() => mutate()} aria-label="Refresh">
            <RefreshCw className={`size-4 ${isValidating ? "animate-spin" : ""}`} />
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-2">
          <CardTitle className="text-base">
            {TABS.find((t) => t.key === type)?.label}
            {fy ? <span className="ml-2 text-sm font-normal text-muted-foreground">FY {fy}</span> : null}
          </CardTitle>
          {stmt && type === "trial-balance" ? (
            <BalancedBadge ok={stmt.balanced} label={stmt.balanced ? "Balanced" : "Out of balance"} />
          ) : null}
          {stmt && type === "balance-sheet" ? (
            <BalancedBadge ok={stmt.balanced} label={stmt.balanced ? "Balanced" : "Out of balance"} />
          ) : null}
          {stmt && type === "cash-flow" ? (
            <BalancedBadge ok={stmt.reconciles} label={stmt.reconciles ? "Reconciled" : "Unreconciled"} />
          ) : null}
        </CardHeader>
        <CardContent>
          {isLoading && !stmt ? (
            <p className="py-12 text-center text-sm text-muted-foreground">Loading…</p>
          ) : !stmt ? (
            <p className="py-12 text-center text-sm text-muted-foreground">No data.</p>
          ) : type === "trial-balance" ? (
            <TrialBalanceView data={stmt} />
          ) : type === "profit-loss" ? (
            <ProfitLossView data={stmt} />
          ) : type === "balance-sheet" ? (
            <BalanceSheetView data={stmt} />
          ) : (
            <CashFlowView data={stmt} />
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function TrialBalanceView({ data }: { data: any }) {
  const rows: TrialBalanceRow[] = data.rows ?? []
  if (rows.length === 0) return <p className="py-8 text-center text-sm text-muted-foreground">No ledger activity.</p>
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-24">Code</TableHead>
          <TableHead>Account</TableHead>
          <TableHead className="text-right">Debit</TableHead>
          <TableHead className="text-right">Credit</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => (
          <TableRow key={r.account_id}>
            <TableCell className="text-muted-foreground">{r.account_code || "—"}</TableCell>
            <TableCell>{r.account_name}</TableCell>
            <TableCell className="text-right tabular-nums">{r.debit ? currency(r.debit) : "—"}</TableCell>
            <TableCell className="text-right tabular-nums">{r.credit ? currency(r.credit) : "—"}</TableCell>
          </TableRow>
        ))}
        <TableRow className="border-t-2 font-semibold">
          <TableCell colSpan={2}>Total</TableCell>
          <TableCell className="text-right tabular-nums">{currency(data.total_debit)}</TableCell>
          <TableCell className="text-right tabular-nums">{currency(data.total_credit)}</TableCell>
        </TableRow>
      </TableBody>
    </Table>
  )
}

function ProfitLossView({ data }: { data: any }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-24">Code</TableHead>
          <TableHead>Particulars</TableHead>
          <TableHead className="text-right">Amount</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        <TableRow className="bg-muted/60">
          <TableCell colSpan={3} className="font-semibold">
            Income
          </TableCell>
        </TableRow>
        <SectionRows groups={data.income} />
        <TableRow className="font-medium">
          <TableCell colSpan={2}>Total Income</TableCell>
          <TableCell className="text-right tabular-nums">{currency(data.total_income)}</TableCell>
        </TableRow>

        <TableRow className="bg-muted/60">
          <TableCell colSpan={3} className="font-semibold">
            Expenses
          </TableCell>
        </TableRow>
        <SectionRows groups={data.expense} />
        <TableRow className="font-medium">
          <TableCell colSpan={2}>Total Expenses</TableCell>
          <TableCell className="text-right tabular-nums">{currency(data.total_expense)}</TableCell>
        </TableRow>

        <TableRow className="border-t-2 font-semibold">
          <TableCell colSpan={2}>{data.net_profit >= 0 ? "Net Profit" : "Net Loss"}</TableCell>
          <TableCell className="text-right tabular-nums">{currency(Math.abs(data.net_profit))}</TableCell>
        </TableRow>
      </TableBody>
    </Table>
  )
}

function BalanceSheetView({ data }: { data: any }) {
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <div>
        <h3 className="mb-2 text-sm font-semibold">Assets</h3>
        <Table>
          <TableBody>
            <SectionRows groups={data.assets} />
            <TableRow className="border-t-2 font-semibold">
              <TableCell colSpan={2}>Total Assets</TableCell>
              <TableCell className="text-right tabular-nums">{currency(data.total_assets)}</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </div>
      <div>
        <h3 className="mb-2 text-sm font-semibold">Liabilities &amp; Equity</h3>
        <Table>
          <TableBody>
            <SectionRows groups={data.liabilities} />
            <SectionRows groups={data.equity} />
            <TableRow className="border-t-2 font-semibold">
              <TableCell colSpan={2}>Total Liabilities &amp; Equity</TableCell>
              <TableCell className="text-right tabular-nums">
                {currency(data.total_liabilities + data.total_equity)}
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </div>
    </div>
  )
}

function CashFlowView({ data }: { data: any }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-24">Code</TableHead>
          <TableHead>Particulars</TableHead>
          <TableHead className="text-right">Amount</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        <TableRow>
          <TableCell colSpan={2} className="text-muted-foreground">
            Opening Cash &amp; Bank
          </TableCell>
          <TableCell className="text-right tabular-nums">{currency(data.opening_cash)}</TableCell>
        </TableRow>
        {(data.activities ?? []).map((a: any) => (
          <Fragment key={`act-${a.activity}`}>
            <TableRow className="bg-muted/60">
              <TableCell colSpan={2} className="font-semibold">
                {a.activity} Activities
              </TableCell>
              <TableCell className="text-right font-semibold tabular-nums">{currency(a.total)}</TableCell>
            </TableRow>
            {a.lines.map((l: StatementLine) => (
              <TableRow key={`${a.activity}-${l.account_id}`}>
                <TableCell className="pl-8 text-muted-foreground">{l.account_code || "—"}</TableCell>
                <TableCell>{l.account_name}</TableCell>
                <TableCell className="text-right tabular-nums">{currency(l.amount)}</TableCell>
              </TableRow>
            ))}
          </Fragment>
        ))}
        <TableRow className="font-medium">
          <TableCell colSpan={2}>Net Change in Cash</TableCell>
          <TableCell className="text-right tabular-nums">{currency(data.net_change)}</TableCell>
        </TableRow>
        <TableRow className="border-t-2 font-semibold">
          <TableCell colSpan={2}>Closing Cash &amp; Bank</TableCell>
          <TableCell className="text-right tabular-nums">{currency(data.closing_cash)}</TableCell>
        </TableRow>
      </TableBody>
    </Table>
  )
}
