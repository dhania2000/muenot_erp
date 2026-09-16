"use client"

import useSWR from "swr"
import { fetcher } from "@/lib/fetcher"
import { inr, inr0 } from "@/lib/finance-calc"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Alert, AlertDescription } from "@/components/ui/alert"
import type { BadgeVariant } from "@/lib/finance-schema"
import {
  ArrowLeft, Loader2Icon, Landmark, Coins, Clock, CalendarDays, FileText,
  BookOpen, Wallet, TrendingUp, ExternalLink,
} from "lucide-react"

type Row = Record<string, any>
type LoanDetail = {
  loan: Row
  schedule: Row[]
  stats: {
    principal: number
    emi: number
    totalInterest: number
    totalPayable: number
    outstandingPrincipal: number
    outstandingInterest: number
    installments: number
    firstDueDate: string | null
    lastDueDate: string | null
  }
}

const STATUS_BADGE: Record<string, BadgeVariant> = {
  Active: "default", Closed: "outline", "Written Off": "destructive", Cancelled: "destructive",
}
const DIRECTION_BADGE: Record<string, BadgeVariant> = {
  "Loan / Advance Given": "default", "Loan Taken": "secondary",
}

function fmtDate(v: any) {
  if (!v) return "—"
  const d = new Date(v)
  if (Number.isNaN(d.getTime())) return String(v).slice(0, 10)
  return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })
}

function BackLink() {
  return (
    <Button variant="ghost" size="sm" className="w-fit" render={<a href="/modules/finance/loans-advances" />}>
      <ArrowLeft data-icon="inline-start" />
      Back to Loans &amp; Advances
    </Button>
  )
}

export function LoanDetailClient({ loanId }: { loanId: string }) {
  const { data, error, isLoading } = useSWR<LoanDetail>(
    `/api/finance/loans-advances/${encodeURIComponent(loanId)}`,
    fetcher,
  )

  if (isLoading) {
    return (
      <main className="flex min-h-[60vh] items-center justify-center p-6">
        <Loader2Icon className="size-6 animate-spin text-muted-foreground" />
      </main>
    )
  }
  if (error || !data?.loan) {
    return (
      <main className="space-y-4 p-6">
        <BackLink />
        <Alert variant="destructive">
          <AlertDescription>This loan / advance could not be loaded. It may have been deleted.</AlertDescription>
        </Alert>
      </main>
    )
  }

  const { loan: l, schedule, stats } = data
  const status = String(l.status || "Active")
  const direction = String(l.direction || "")
  const postingStatus = String(l.posting_status || "")

  const kpis: { label: string; value: string; icon: React.ComponentType<{ className?: string }> }[] = [
    { label: "Principal", value: inr0(stats.principal), icon: Landmark },
    { label: "EMI / installment", value: inr0(stats.emi), icon: Coins },
    { label: "Outstanding principal", value: inr0(stats.outstandingPrincipal), icon: Clock },
    { label: "Total payable", value: inr0(stats.totalPayable), icon: TrendingUp },
  ]

  const terms: { label: string; value: React.ReactNode }[] = [
    { label: "Type", value: l.loan_type || "—" },
    { label: "Party", value: l.party_name || "—" },
    { label: "Party type", value: l.party_type || "—" },
    { label: "Interest rate", value: `${Number(l.interest_rate) || 0}% p.a.` },
    { label: "Interest method", value: l.interest_method || "Reducing Balance" },
    { label: "Tenure", value: l.tenure_months ? `${l.tenure_months} months` : "—" },
    { label: "Frequency", value: l.installment_frequency || "Monthly" },
    { label: "Installments", value: stats.installments || "—" },
    { label: "Start date", value: fmtDate(l.disbursement_date) },
    { label: "End date", value: fmtDate(l.end_date) },
    { label: "Financial year", value: l.financial_year || "—" },
    { label: "Total interest", value: inr(stats.totalInterest) },
    { label: "Bank / account", value: l.bank_account_name || l.funding_source || "—" },
    { label: "Purpose", value: l.purpose || "—" },
  ]

  return (
    <main className="space-y-6 p-6">
      <BackLink />

      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight text-balance">{l.party_name || l.loan_id}</h1>
            <Badge variant={STATUS_BADGE[status] || "outline"}>{status}</Badge>
            {direction && <Badge variant={DIRECTION_BADGE[direction] || "outline"}>{direction}</Badge>}
            {l.loan_type && <Badge variant="outline">{l.loan_type}</Badge>}
          </div>
          <p className="font-mono text-sm text-muted-foreground">{l.loan_id}</p>
        </div>
        {l.document_url && (
          <Button variant="outline" size="sm" render={<a href={l.document_url} target="_blank" rel="noopener noreferrer" />}>
            <FileText data-icon="inline-start" />
            Document
            <ExternalLink data-icon="inline-end" />
          </Button>
        )}
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {kpis.map((k) => (
          <Card key={k.label}>
            <CardContent className="flex flex-col gap-2 pt-6">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-muted-foreground">{k.label}</span>
                <k.icon className="size-4 text-muted-foreground" />
              </div>
              <span className="text-xl font-semibold tracking-tight">{k.value}</span>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Loan terms */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Wallet className="size-4 text-muted-foreground" />
            Loan / advance terms
          </CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3 lg:grid-cols-4">
          {terms.map((t) => (
            <div key={t.label} className="space-y-1">
              <dt className="text-xs text-muted-foreground">{t.label}</dt>
              <dd className="text-sm font-medium">{t.value}</dd>
            </div>
          ))}
          {(postingStatus || l.voucher_no) && (
            <div className="space-y-1">
              <dt className="text-xs text-muted-foreground">Accounting</dt>
              <dd className="flex flex-wrap items-center gap-2 text-sm font-medium">
                {postingStatus && (
                  <Badge variant={postingStatus.toLowerCase() === "posted" ? "default" : "outline"}>
                    <BookOpen data-icon="inline-start" />
                    {postingStatus}
                  </Badge>
                )}
                {l.voucher_no && <span className="font-mono text-xs text-muted-foreground">{l.voucher_no}</span>}
              </dd>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Repayment schedule */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center justify-between text-base">
            <span className="flex items-center gap-2">
              <CalendarDays className="size-4 text-muted-foreground" />
              Repayment schedule
            </span>
            <Badge variant="secondary">{schedule.length} installments</Badge>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {schedule.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground">
              No repayment schedule yet. Add a principal, interest rate and tenure to this loan to generate one.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th className="p-2 font-medium">#</th>
                    <th className="p-2 font-medium">Due date</th>
                    <th className="p-2 text-right font-medium">Opening</th>
                    <th className="p-2 text-right font-medium">EMI</th>
                    <th className="p-2 text-right font-medium">Principal</th>
                    <th className="p-2 text-right font-medium">Interest</th>
                    <th className="p-2 text-right font-medium">Closing</th>
                  </tr>
                </thead>
                <tbody>
                  {schedule.map((r) => (
                    <tr key={r.installment_no} className="border-b hover:bg-muted/40">
                      <td className="p-2 font-mono text-xs">{r.installment_no}</td>
                      <td className="p-2">{fmtDate(r.due_date)}</td>
                      <td className="p-2 text-right">{inr(r.opening_balance)}</td>
                      <td className="p-2 text-right font-medium">{inr(r.emi)}</td>
                      <td className="p-2 text-right">{inr(r.principal_component)}</td>
                      <td className="p-2 text-right">{inr(r.interest_component)}</td>
                      <td className="p-2 text-right">{inr(r.closing_balance)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 font-medium">
                    <td className="p-2" colSpan={3}>
                      Total
                    </td>
                    <td className="p-2 text-right">{inr(stats.totalPayable)}</td>
                    <td className="p-2 text-right">{inr(stats.principal)}</td>
                    <td className="p-2 text-right">{inr(stats.totalInterest)}</td>
                    <td className="p-2 text-right">—</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {l.notes && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Notes</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="whitespace-pre-wrap text-sm text-muted-foreground">{l.notes}</p>
          </CardContent>
        </Card>
      )}
    </main>
  )
}
