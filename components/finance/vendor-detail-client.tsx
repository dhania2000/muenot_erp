"use client"

import { useState } from "react"
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
  ArrowLeft, ShieldCheck, ShieldAlert, RefreshCw, Loader2Icon, CheckCircle2,
  XCircle, Wallet, Clock, Receipt, Banknote, Landmark, BookOpen, FileText,
  Building2, CreditCard, Pencil,
} from "lucide-react"

type Row = Record<string, any>
type Vendor360 = {
  vendor: Row
  bills: Row[]
  payments: Row[]
  ledger: Row[]
  stats: {
    totalBilled: number; totalPaid: number; outstanding: number; overdue: number
    billCount: number; openBills: number; paymentCount: number
    lastBillDate: string | null; lastPaymentDate: string | null
    ageing: { current: number; d30: number; d60: number; d90: number; d90plus: number }
  }
  compliance: {
    checklist: { key: string; label: string; done: boolean; hint?: string }[]
    kycScore: number; financeReady: boolean; gstVerified: boolean
  }
  audit: Row[]
}

const GST_BADGE: Record<string, BadgeVariant> = {
  Verified: "default", Unverified: "outline", Invalid: "destructive",
  "Not Found": "destructive", Cancelled: "destructive", Suspended: "destructive",
  Inactive: "secondary", Provisional: "secondary",
}
const STATUS_BADGE: Record<string, BadgeVariant> = {
  Active: "default", Inactive: "outline", "On Hold": "secondary", Archived: "destructive",
}
const PAY_BADGE: Record<string, BadgeVariant> = {
  Paid: "default", "Partially Paid": "secondary", Unpaid: "outline", Overdue: "destructive",
}

function fmtDate(v: any) {
  if (!v) return "—"
  const d = new Date(v)
  if (Number.isNaN(d.getTime())) return String(v)
  return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })
}

export function VendorDetailClient({ vendorId }: { vendorId: string }) {
  const { data, error, isLoading, mutate } = useSWR<Vendor360>(
    `/api/finance/vendors/${encodeURIComponent(vendorId)}`,
    fetcher,
  )
  const [reverifying, setReverifying] = useState(false)
  const [notice, setNotice] = useState<{ kind: "ok" | "warn" | "err"; text: string } | null>(null)

  async function reverify() {
    setReverifying(true)
    setNotice(null)
    try {
      const res = await fetch(`/api/finance/vendors/${encodeURIComponent(vendorId)}`, { method: "POST" })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) {
        setNotice({ kind: "err", text: json.error || "Re-verification failed." })
      } else if (json.changes?.length) {
        setNotice({ kind: "warn", text: `${json.verificationStatus}. Detected: ${json.changes.join("; ")}` })
      } else {
        setNotice({ kind: "ok", text: `GSTIN re-verified — ${json.verificationStatus}.` })
      }
      await mutate()
    } catch {
      setNotice({ kind: "err", text: "Network error during re-verification." })
    } finally {
      setReverifying(false)
    }
  }

  if (isLoading) {
    return (
      <main className="flex min-h-[60vh] items-center justify-center p-6">
        <Loader2Icon className="size-6 animate-spin text-muted-foreground" />
      </main>
    )
  }
  if (error || !data?.vendor) {
    return (
      <main className="space-y-4 p-6">
        <BackLink />
        <Alert variant="destructive">
          <AlertDescription>Vendor could not be loaded. It may have been deleted.</AlertDescription>
        </Alert>
      </main>
    )
  }

  const { vendor: v, bills, payments, ledger, stats, compliance, audit } = data
  const gstStatus = String(v.gst_verification_status || "Unverified")

  return (
    <main className="space-y-6 p-6">
      <BackLink />

      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight text-balance">{v.customer_name}</h1>
            <Badge variant={STATUS_BADGE[v.status] || "outline"}>{v.status || "—"}</Badge>
            <Badge variant={GST_BADGE[gstStatus] || "outline"}>GST: {gstStatus}</Badge>
            {compliance.financeReady ? (
              <Badge variant="default"><ShieldCheck data-icon="inline-start" />Finance-ready</Badge>
            ) : (
              <Badge variant="secondary"><ShieldAlert data-icon="inline-start" />Setup incomplete</Badge>
            )}
          </div>
          <p className="font-mono text-sm text-muted-foreground">{v.party_id}</p>
          <p className="text-sm text-muted-foreground">
            {[v.vendor_category, v.city, v.state].filter(Boolean).join(" · ") || "Vendor master"}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" onClick={reverify} disabled={reverifying || !v.gstin}>
            {reverifying ? <Loader2Icon className="animate-spin" data-icon="inline-start" /> : <RefreshCw data-icon="inline-start" />}
            {reverifying ? "Verifying..." : "Reverify GSTIN"}
          </Button>
          <Button variant="outline" render={<a href="/modules/finance/customers-vendors" />}>
            <Pencil data-icon="inline-start" />
            Manage
          </Button>
        </div>
      </div>

      {notice && (
        <Alert variant={notice.kind === "err" ? "destructive" : "default"}>
          <AlertDescription>{notice.text}</AlertDescription>
        </Alert>
      )}

      {/* KPIs */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Kpi label="Outstanding" value={inr0(stats.outstanding)} icon={Wallet} tone={stats.outstanding > 0 ? "warn" : "ok"} />
        <Kpi label="Overdue" value={inr0(stats.overdue)} icon={Clock} tone={stats.overdue > 0 ? "err" : "ok"} sub={`${stats.openBills} open bill(s)`} />
        <Kpi label="Total billed" value={inr0(stats.totalBilled)} icon={Receipt} sub={`${stats.billCount} bill(s)`} />
        <Kpi label="Total paid" value={inr0(stats.totalPaid)} icon={Banknote} sub={`${stats.paymentCount} payment(s)`} />
      </div>

      <Tabs defaultValue="overview">
        <TabsList className="flex-wrap">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="bills">Bills ({bills.length})</TabsTrigger>
          <TabsTrigger value="payments">Payments ({payments.length})</TabsTrigger>
          <TabsTrigger value="ledger">Ledger</TabsTrigger>
          <TabsTrigger value="compliance">Compliance</TabsTrigger>
          <TabsTrigger value="audit">Audit ({audit.length})</TabsTrigger>
        </TabsList>

        {/* Overview */}
        <TabsContent value="overview" className="space-y-4">
          <div className="grid gap-4 lg:grid-cols-2">
            <SectionCard title="Ageing of payables" icon={Clock}>
              {stats.outstanding <= 0 ? (
                <p className="text-sm text-muted-foreground">No outstanding payables — this vendor is fully settled.</p>
              ) : (
                <div className="space-y-2">
                  <AgeBar label="Not due" amount={stats.ageing.current} total={stats.outstanding} tone="ok" />
                  <AgeBar label="1–30 days" amount={stats.ageing.d30} total={stats.outstanding} tone="warn" />
                  <AgeBar label="31–60 days" amount={stats.ageing.d60} total={stats.outstanding} tone="warn" />
                  <AgeBar label="61–90 days" amount={stats.ageing.d90} total={stats.outstanding} tone="err" />
                  <AgeBar label="90+ days" amount={stats.ageing.d90plus} total={stats.outstanding} tone="err" />
                </div>
              )}
            </SectionCard>

            <SectionCard title="KYC readiness" icon={ShieldCheck}>
              <div className="mb-3 flex items-center gap-3">
                <Progress value={compliance.kycScore} className="h-2" />
                <span className="text-sm font-medium tabular-nums">{compliance.kycScore}%</span>
              </div>
              <ul className="space-y-1.5 text-sm">
                {compliance.checklist.map((c) => (
                  <li key={c.key} className="flex items-center justify-between gap-2">
                    <span className="flex items-center gap-2">
                      {c.done ? <CheckCircle2 className="size-4 text-emerald-600" /> : <XCircle className="size-4 text-muted-foreground" />}
                      {c.label}
                    </span>
                    {c.hint && <span className="text-xs text-muted-foreground">{c.hint}</span>}
                  </li>
                ))}
              </ul>
            </SectionCard>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <SectionCard title="Contact" icon={Building2}>
              <Facts rows={[
                ["Legal name", v.legal_name],
                ["Contact person", v.contact_person],
                ["Official email", v.official_email],
                ["Invoice email", v.invoice_email],
                ["Mobile", v.mobile],
                ["Registered address", v.registered_address],
                ["City / State", [v.city, v.state].filter(Boolean).join(", ")],
                ["PIN", v.pin_code],
              ]} />
            </SectionCard>
            <SectionCard title="Commercial terms" icon={FileText}>
              <Facts rows={[
                ["Payment terms", v.payment_terms_days ? `${v.payment_terms_days} days` : null],
                ["Credit limit", v.credit_limit ? inr(v.credit_limit) : null],
                ["Currency", v.currency],
                ["Vendor category", v.vendor_category],
                ["Last bill", fmtDate(stats.lastBillDate)],
                ["Last payment", fmtDate(stats.lastPaymentDate)],
              ]} />
            </SectionCard>
          </div>
        </TabsContent>

        {/* Bills */}
        <TabsContent value="bills">
          <DataTable
            empty="No purchase bills recorded for this vendor."
            head={["Bill", "Date", "Due", "Gross", "Paid", "Outstanding", "Status"]}
            align={[, , , "right", "right", "right"]}
            rows={bills.map((b) => [
              <span key="po" className="font-mono text-xs">{b.po_number}</span>,
              fmtDate(b.bill_date),
              fmtDate(b.due_date),
              inr(b.gross_bill_amount),
              inr(b.amount_paid),
              inr(b.outstanding_amount),
              <Badge key="s" variant={PAY_BADGE[b.payment_status] || "outline"}>{b.payment_status || "—"}</Badge>,
            ])}
          />
        </TabsContent>

        {/* Payments */}
        <TabsContent value="payments">
          <DataTable
            empty="No payments recorded against this vendor."
            head={["Payment", "Date", "Amount", "Mode", "Reference", "Against"]}
            align={[, , "right"]}
            rows={payments.map((p) => [
              <span key="id" className="font-mono text-xs">{p.payment_id}</span>,
              fmtDate(p.payment_date),
              inr(p.amount),
              p.payment_mode || "—",
              p.reference_no || "—",
              p.invoice_ref || "—",
            ])}
          />
        </TabsContent>

        {/* Ledger */}
        <TabsContent value="ledger">
          <DataTable
            empty="No ledger entries for this vendor."
            head={["Date", "Voucher", "Reference", "Debit", "Credit", "Balance"]}
            align={[, , , "right", "right", "right"]}
            rows={ledger.map((l) => [
              fmtDate(l.transaction_date),
              l.voucher_type || "—",
              l.reference_no || "—",
              Number(l.debit) ? inr(l.debit) : "—",
              Number(l.credit) ? inr(l.credit) : "—",
              <span key="b">{inr(l.balance)} <span className="text-xs text-muted-foreground">{l.balance_type || ""}</span></span>,
            ])}
          />
        </TabsContent>

        {/* Compliance */}
        <TabsContent value="compliance" className="space-y-4">
          <div className="grid gap-4 lg:grid-cols-2">
            <SectionCard title="GST verification snapshot" icon={Landmark}>
              <Facts rows={[
                ["GSTIN", v.gstin],
                ["Verification status", gstStatus],
                ["Portal status", v.gst_status],
                ["Trade name", v.gst_trade_name],
                ["Taxpayer type", v.gst_taxpayer_type],
                ["Constitution", v.business_constitution],
                ["Registration date", v.gst_registration_date],
                ["Cancellation date", v.gst_cancellation_date],
                ["e-Way block", v.gst_block_status],
                ["Verified at", v.gst_verified_at],
                ["Source", v.gst_verification_source],
              ]} />
            </SectionCard>
            <div className="space-y-4">
              <SectionCard title="Tax configuration" icon={FileText}>
                <Facts rows={[
                  ["PAN", v.pan],
                  ["TAN", v.tan],
                  ["Registration type", v.gst_registration_type],
                  ["TDS applicable", v.tds_applicable ? "Yes" : "No"],
                  ["TDS section", v.tds_section],
                  ["TDS rate", v.tds_rate ? `${v.tds_rate}%` : null],
                ]} />
              </SectionCard>
              <SectionCard title="Bank & payout" icon={CreditCard}>
                <Facts rows={[
                  ["Bank", v.bank_name],
                  ["Branch", v.bank_branch],
                  ["Account no.", v.bank_account_no],
                  ["IFSC", v.ifsc],
                  ["Account holder", v.account_holder_name],
                  ["UPI ID", v.upi_id],
                ]} />
              </SectionCard>
            </div>
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
    <Button variant="ghost" size="sm" className="-ml-2" render={<a href="/modules/finance/customers-vendors" />}>
      <ArrowLeft data-icon="inline-start" />
      All vendors
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

function AgeBar({ label, amount, total, tone }: { label: string; amount: number; total: number; tone: "ok" | "warn" | "err" }) {
  const pct = total > 0 ? Math.round((amount / total) * 100) : 0
  const bar = tone === "err" ? "bg-destructive" : tone === "warn" ? "bg-amber-500" : "bg-emerald-500"
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-sm">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-medium tabular-nums">{inr(amount)}</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
        <div className={`h-full rounded-full ${bar}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
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
