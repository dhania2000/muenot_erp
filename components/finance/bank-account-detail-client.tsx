"use client"

import useSWR from "swr"
import { fetcher } from "@/lib/fetcher"
import { inr, inr0 } from "@/lib/finance-calc"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Progress } from "@/components/ui/progress"
import type { BadgeVariant } from "@/lib/finance-schema"
import {
  ArrowLeft, Loader2Icon, Wallet, Banknote, Landmark, BookOpen, Pencil,
  TrendingUp, TrendingDown, Scale, CheckCircle2, AlertTriangle, CreditCard,
  ArrowLeftRight, Building2,
} from "lucide-react"

type Row = Record<string, any>
type Account360 = {
  account: Row
  transactions: Row[]
  stats: {
    txnCount: number; totalCredit: number; totalDebit: number; netMovement: number
    reconciledCount: number; reconciledAmount: number
    unreconciledCount: number; unreconciledAmount: number; reconciledPct: number
    lastTransactionDate: string | null
    openingBalance: number; bookBalance: number; statementBalance: number
    difference: number; reconciled: boolean
  }
  audit: Row[]
}

const ACTIVE_BADGE: Record<string, BadgeVariant> = {
  Active: "default", Inactive: "outline", Closed: "destructive",
}
const RECON_BADGE: Record<string, BadgeVariant> = {
  Reconciled: "default", Pending: "secondary", Unreconciled: "outline", Excluded: "secondary",
}

function fmtDate(v: any) {
  if (!v) return "—"
  const d = new Date(v)
  if (Number.isNaN(d.getTime())) return String(v)
  return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })
}

export function BankAccountDetailClient({ accountId }: { accountId: string }) {
  const { data, error, isLoading } = useSWR<Account360>(
    `/api/finance/bank-cash/${encodeURIComponent(accountId)}`,
    fetcher,
  )

  if (isLoading) {
    return (
      <main className="flex min-h-[60vh] items-center justify-center p-6">
        <Loader2Icon className="size-6 animate-spin text-muted-foreground" />
      </main>
    )
  }
  if (error || !data?.account) {
    return (
      <main className="space-y-4 p-6">
        <BackLink />
        <Alert variant="destructive">
          <AlertDescription>Account could not be loaded. It may have been deleted.</AlertDescription>
        </Alert>
      </main>
    )
  }

  const { account: a, transactions, stats, audit } = data
  const activeStatus = String(a.active_status || "Active")
  const reconStatus = String(a.reconciliation_status || "Pending")
  const isCash = String(a.account_type) === "Cash"

  return (
    <main className="space-y-6 p-6">
      <BackLink />

      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight text-balance">{a.account_name}</h1>
            <Badge variant={ACTIVE_BADGE[activeStatus] || "outline"}>{activeStatus}</Badge>
            <Badge variant="outline">{a.account_type || "—"}</Badge>
            {!!a.primary_account && <Badge variant="secondary">Primary</Badge>}
            {stats.reconciled ? (
              <Badge variant="default"><CheckCircle2 data-icon="inline-start" />Reconciled</Badge>
            ) : (
              <Badge variant="secondary"><AlertTriangle data-icon="inline-start" />Difference {inr0(stats.difference)}</Badge>
            )}
          </div>
          <p className="font-mono text-sm text-muted-foreground">{a.finance_account_id}</p>
          <p className="text-sm text-muted-foreground">
            {[a.bank_name, a.branch, a.currency].filter(Boolean).join(" · ") || "Bank & cash account"}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" render={<a href={`/modules/finance/bank-transactions?account=${encodeURIComponent(a.finance_account_id)}`} />}>
            <ArrowLeftRight data-icon="inline-start" />
            Transactions
          </Button>
          <Button variant="outline" render={<a href="/modules/finance/bank-cash" />}>
            <Pencil data-icon="inline-start" />
            Manage
          </Button>
        </div>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Kpi label="Book balance" value={inr0(stats.bookBalance)} icon={Wallet} tone={stats.bookBalance < 0 ? "err" : "ok"} sub="Opening + credits − debits" />
        <Kpi label="Statement balance" value={inr0(stats.statementBalance)} icon={Banknote} sub={`As last entered`} />
        <Kpi label="Difference" value={inr0(stats.difference)} icon={Scale} tone={Math.abs(stats.difference) > 0.01 ? "warn" : "ok"} sub={stats.reconciled ? "Fully reconciled" : "Needs reconciliation"} />
        <Kpi label="Transactions" value={String(stats.txnCount)} icon={ArrowLeftRight} sub={`${stats.reconciledCount} reconciled`} />
      </div>

      <Tabs defaultValue="overview">
        <TabsList className="flex-wrap">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="transactions">Transactions ({transactions.length})</TabsTrigger>
          <TabsTrigger value="details">Account details</TabsTrigger>
          <TabsTrigger value="audit">Audit ({audit.length})</TabsTrigger>
        </TabsList>

        {/* Overview */}
        <TabsContent value="overview" className="space-y-4">
          <div className="grid gap-4 lg:grid-cols-2">
            <SectionCard title="Cash flow" icon={TrendingUp}>
              <div className="space-y-3">
                <FlowRow label="Money in (credits)" amount={stats.totalCredit} icon={TrendingUp} tone="ok" />
                <FlowRow label="Money out (debits)" amount={stats.totalDebit} icon={TrendingDown} tone="err" />
                <div className="flex items-center justify-between border-t pt-2 text-sm">
                  <span className="font-medium">Net movement</span>
                  <span className={`font-semibold tabular-nums ${stats.netMovement < 0 ? "text-destructive" : "text-emerald-600"}`}>
                    {inr(stats.netMovement)}
                  </span>
                </div>
                <div className="flex items-center justify-between text-sm text-muted-foreground">
                  <span>Opening balance</span>
                  <span className="tabular-nums">{inr(stats.openingBalance)}</span>
                </div>
              </div>
            </SectionCard>

            <SectionCard title="Reconciliation" icon={Scale}>
              <div className="mb-3 flex items-center gap-3">
                <Progress value={stats.reconciledPct} className="h-2" />
                <span className="text-sm font-medium tabular-nums">{stats.reconciledPct}%</span>
              </div>
              <dl className="space-y-1.5 text-sm">
                <FactLine label="Status" value={<Badge variant={RECON_BADGE[reconStatus] || "outline"}>{reconStatus}</Badge>} />
                <FactLine label="Reconciled" value={`${stats.reconciledCount} · ${inr(stats.reconciledAmount)}`} />
                <FactLine label="Unreconciled" value={`${stats.unreconciledCount} · ${inr(stats.unreconciledAmount)}`} />
                <FactLine label="Last reconciled" value={fmtDate(a.last_reconciliation_date)} />
                <FactLine label="Last transaction" value={fmtDate(stats.lastTransactionDate)} />
              </dl>
            </SectionCard>
          </div>
        </TabsContent>

        {/* Transactions */}
        <TabsContent value="transactions">
          <DataTable
            empty="No transactions posted to this account yet."
            head={["Txn", "Date", "Type", "Party", "Reference", "Debit", "Credit", "Reconciliation"]}
            align={[, , , , , "right", "right"]}
            rows={transactions.map((t) => [
              <span key="id" className="font-mono text-xs">{t.transaction_id}</span>,
              fmtDate(t.transaction_date),
              t.transaction_type || t.voucher_type || "—",
              t.party_name || "—",
              t.reference_no || t.cheque_utr_reference || "—",
              Number(t.debit) ? inr(t.debit) : "—",
              Number(t.credit) ? inr(t.credit) : "—",
              <Badge key="s" variant={RECON_BADGE[String(t.reconciliation_status)] || "outline"}>
                {t.reconciliation_status || "Pending"}
              </Badge>,
            ])}
          />
        </TabsContent>

        {/* Account details */}
        <TabsContent value="details" className="space-y-4">
          <div className="grid gap-4 lg:grid-cols-2">
            <SectionCard title={isCash ? "Account" : "Bank details"} icon={isCash ? Building2 : Landmark}>
              <Facts rows={[
                ["Account type", a.account_type],
                ["Bank name", a.bank_name],
                ["Branch", a.branch],
                ["Account number", a.account_number],
                ["IFSC", a.ifsc],
                ["UPI / Wallet ID", a.upi_wallet_id],
                ["Currency", a.currency],
              ]} />
            </SectionCard>
            <SectionCard title="Balances" icon={CreditCard}>
              <Facts rows={[
                ["Opening balance", inr(a.opening_balance)],
                ["Opening date", fmtDate(a.opening_balance_date)],
                ["Current book balance", inr(a.current_book_balance)],
                ["Bank statement balance", inr(a.bank_statement_balance)],
                ["Difference", inr(a.difference)],
                ["Primary account", a.primary_account ? "Yes" : "No"],
                ["Active status", a.active_status],
                ["Remarks", a.remarks],
              ]} />
            </SectionCard>
          </div>
        </TabsContent>

        {/* Audit */}
        <TabsContent value="audit">
          <SectionCard title="Audit trail" icon={BookOpen}>
            {audit.length === 0 ? (
              <p className="text-sm text-muted-foreground">No recorded events yet.</p>
            ) : (
              <ol className="space-y-3">
                {audit.map((e) => (
                  <li key={e.id} className="flex gap-3 border-b border-dashed pb-3 last:border-0">
                    <div className="mt-1 size-2 shrink-0 rounded-full bg-primary" />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium">{e.summary}</p>
                      <p className="text-xs text-muted-foreground">
                        {fmtDate(e.created_at)} · {e.actor_name || "System"} · {e.event_type}
                      </p>
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </SectionCard>
        </TabsContent>
      </Tabs>
    </main>
  )
}

function BackLink() {
  return (
    <Button variant="ghost" size="sm" className="-ml-2" render={<a href="/modules/finance/bank-cash" />}>
      <ArrowLeft data-icon="inline-start" />
      All accounts
    </Button>
  )
}

function Kpi({
  label, value, icon: Icon, sub, tone,
}: {
  label: string; value: string; icon: React.ComponentType<{ className?: string }>; sub?: string
  tone?: "ok" | "warn" | "err"
}) {
  const toneClass = tone === "err" ? "text-destructive" : tone === "warn" ? "text-amber-600" : ""
  return (
    <Card>
      <CardContent className="flex flex-col gap-1 pt-6">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-muted-foreground">{label}</span>
          <Icon className="size-4 text-muted-foreground" />
        </div>
        <span className={`text-xl font-semibold tracking-tight tabular-nums ${toneClass}`}>{value}</span>
        {sub && <span className="text-xs text-muted-foreground">{sub}</span>}
      </CardContent>
    </Card>
  )
}

function SectionCard({
  title, icon: Icon, children,
}: { title: string; icon: React.ComponentType<{ className?: string }>; children: React.ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm font-semibold">
          <Icon className="size-4 text-muted-foreground" />
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  )
}

function FlowRow({
  label, amount, icon: Icon, tone,
}: { label: string; amount: number; icon: React.ComponentType<{ className?: string }>; tone: "ok" | "err" }) {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="flex items-center gap-2 text-muted-foreground">
        <Icon className={`size-4 ${tone === "err" ? "text-destructive" : "text-emerald-600"}`} />
        {label}
      </span>
      <span className="font-medium tabular-nums">{inr(amount)}</span>
    </div>
  )
}

function FactLine({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-dashed py-1 last:border-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right font-medium">{value}</dd>
    </div>
  )
}

function Facts({ rows }: { rows: [string, any][] }) {
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-1.5 text-sm sm:grid-cols-2">
      {rows.map(([label, value]) => (
        <div key={label} className="flex justify-between gap-4 border-b border-dashed py-1">
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="text-right font-medium break-words">
            {value === null || value === undefined || value === "" ? "—" : String(value)}
          </dd>
        </div>
      ))}
    </dl>
  )
}

function DataTable({
  head, rows, align, empty,
}: { head: string[]; rows: React.ReactNode[][]; align?: (("right" | undefined))[]; empty: string }) {
  return (
    <Card>
      <CardContent className="pt-6">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-muted-foreground">
                {head.map((h, i) => (
                  <th key={h} className={`p-2 font-medium ${align?.[i] === "right" ? "text-right" : ""}`}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr><td colSpan={head.length} className="p-6 text-center text-muted-foreground">{empty}</td></tr>
              )}
              {rows.map((cells, r) => (
                <tr key={r} className="border-b hover:bg-muted/40">
                  {cells.map((c, i) => (
                    <td key={i} className={`p-2 ${align?.[i] === "right" ? "text-right tabular-nums" : ""}`}>{c}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  )
}
