"use client"

import useSWR from "swr"
import { fetcher } from "@/lib/fetcher"
import { inr, inr0 } from "@/lib/finance-calc"
import { exportRowsToExcel } from "@/lib/excel-export"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { Alert, AlertDescription } from "@/components/ui/alert"
import type { BadgeVariant } from "@/lib/finance-schema"
import { resolveClassification } from "@/lib/finance-classification"
import {
  ArrowLeft, Loader2Icon, Pencil, BookOpen, ShieldCheck, Coins, Scale,
  ArrowLeftRight, TrendingUp, TrendingDown, ReceiptText, CornerDownRight,
  FileText, ExternalLink, Landmark, Download, Layers, Tags,
} from "lucide-react"

type Row = Record<string, any>
type Side = "Debit" | "Credit"

/**
 * Map a General Ledger line's originating module to the route + search that
 * opens the source document. Every posting carries `source_module` from the
 * engine that wrote it (Purchase Bills, Sales Invoices, Expenses, Bank & Cash,
 * Payments, GST, TDS, Journal), so a ledger row can jump straight back to where
 * it came from — no parallel bookkeeping, just a link into the existing module.
 */
function sourceRoute(sourceModule?: string): string | null {
  const s = String(sourceModule ?? "").toLowerCase()
  if (!s) return null
  if (s.includes("purchase")) return "/modules/finance/purchase-bills"
  if (s.includes("credit note")) return "/modules/finance/credit-notes"
  if (s.includes("freelance")) return "/modules/finance/freelance-invoices"
  if (s.includes("fte")) return "/modules/finance/fte-invoices"
  if (s.includes("sales") || s.includes("invoice")) return "/modules/finance/sales-invoices"
  if (s.includes("expense")) return "/modules/finance/expenses"
  if (s.includes("bank") || s.includes("cash")) return "/modules/finance/bank-transactions"
  if (s.includes("payment") || s.includes("receipt")) return "/modules/finance/payments"
  if (s.includes("gst")) return "/modules/finance/gst-filing"
  if (s.includes("tds")) return "/modules/finance/tds-filing"
  if (s.includes("journal") || s.includes("opening")) return "/modules/finance/journal-entries"
  return null
}

/** A ledger line's source as a link into its originating module, or plain text. */
function SourceCell({ line }: { line: Row }) {
  const label = String(line.source_module || "").trim()
  const ref = String(line.source_reference || "").trim()
  const route = sourceRoute(label)
  const text = [label, ref].filter(Boolean).join(" · ") || "—"
  if (!route) return <span className="text-muted-foreground">{text}</span>
  const href = ref ? `${route}?search=${encodeURIComponent(ref)}` : route
  return (
    <a href={href} className="inline-flex items-center gap-1 text-primary hover:underline">
      {text}
      <ExternalLink className="size-3 shrink-0" />
    </a>
  )
}

type Account360 = {
  account: Row
  parent: { account_id: string; account_name: string; account_code: string | null } | null
  children: Row[]
  stats: {
    openingBalance: number; openingSide: Side
    totalDebit: number; totalCredit: number; net: number
    currentBalance: number; currentSide: Side
    closingBalance: number; closingSide: Side
    entryCount: number; firstDate: string | null; lastDate: string | null
    nature: Side
  }
  ledger: Row[]
  journal: Row[]
  transactions: Row[]
  roles?: { role: string; label: string; overridden: boolean }[]
}

const STATUS_BADGE: Record<string, BadgeVariant> = {
  Active: "default", Inactive: "outline", Archived: "destructive",
}
const RECON_BADGE: Record<string, BadgeVariant> = {
  Reconciled: "default", Pending: "secondary", Unreconciled: "outline",
}
const POST_BADGE: Record<string, BadgeVariant> = {
  Posted: "default", Unposted: "outline",
}
const APPROVAL_BADGE: Record<string, BadgeVariant> = {
  Approved: "default", Pending: "secondary", Rejected: "destructive",
}

function natureVariant(side?: string): BadgeVariant {
  return side === "Debit" ? "default" : "secondary"
}

function fmtDate(v: any) {
  if (!v) return "—"
  const d = new Date(v)
  if (Number.isNaN(d.getTime())) return String(v)
  return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })
}

/** Balance with its Dr/Cr side, or an em dash when zero. */
function balanceCell(amount: number, side: Side) {
  if (!amount) return <span className="text-muted-foreground">—</span>
  return (
    <span>
      {inr(amount)} <span className="text-xs text-muted-foreground">{side === "Debit" ? "Dr" : "Cr"}</span>
    </span>
  )
}

function exportAccountLedger(account: Row, ledger: Row[]) {
  exportRowsToExcel(`account-ledger-${account.account_id}`, ledger, [
    { header: "Date", value: (row) => row.transaction_date ?? "" },
    { header: "Voucher", value: (row) => row.voucher_no ?? "" },
    { header: "Source", value: (row) => row.source_module ?? "" },
    { header: "Reference", value: (row) => row.source_reference ?? "" },
    { header: "Description", value: (row) => row.description ?? "" },
    { header: "Debit", value: (row) => Number(row.debit ?? 0) },
    { header: "Credit", value: (row) => Number(row.credit ?? 0) },
  ])
}

export function AccountDetailClient({ accountId }: { accountId: string }) {
  const { data, error, isLoading } = useSWR<Account360>(
    `/api/finance/chart-of-accounts/${encodeURIComponent(accountId)}`,
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
          <AlertDescription>This account could not be loaded. It may have been deleted or merged.</AlertDescription>
        </Alert>
      </main>
    )
  }

  const { account: a, parent, children, stats, ledger, journal, transactions } = data
  const roles = data.roles ?? []
  const status = String(a.active_status || "Active")
  const isSystem = Number(a.is_system) === 1

  // Reporting classification for this head, resolved from the same fields (and
  // any pinned override) the Balance Sheet / P&L / Cash Flow statements read.
  const cls = resolveClassification(a)
  const clsGroup = cls.section === "ProfitAndLoss" ? cls.pnlGroup : cls.bsGroup
  const clsOverridden = cls.section === "ProfitAndLoss" ? cls.pnlOverridden : cls.bsOverridden
  const clsStatement = cls.section === "ProfitAndLoss" ? "Profit & Loss" : "Balance Sheet"

  return (
    <main className="space-y-6 p-6">
      <BackLink />

      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight text-balance">{a.account_name}</h1>
            <Badge variant={STATUS_BADGE[status] || "outline"}>{status}</Badge>
            <Badge variant="outline">{a.account_group || "—"}</Badge>
            <Badge variant={natureVariant(stats.nature)}>{stats.nature}</Badge>
            {isSystem && (
              <Badge variant="outline" className="gap-1">
                <ShieldCheck className="size-3" />
                System
              </Badge>
            )}
            <Badge variant="secondary" className="gap-1">
              <Layers className="size-3" />
              {clsGroup}
            </Badge>
            {roles.map((r) => (
              <Badge key={r.role} variant="outline" className="gap-1">
                <Tags className="size-3" />
                {r.label}
              </Badge>
            ))}
          </div>
          <p className="font-mono text-sm text-muted-foreground">
            {a.account_id}
            {a.account_code ? ` · ${a.account_code}` : ""}
          </p>
          <p className="text-sm text-muted-foreground">
            {[a.account_type, parent ? `under ${parent.account_name}` : null].filter(Boolean).join(" · ") ||
              "Chart of Accounts head"}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            disabled={ledger.length === 0}
            onClick={() => exportAccountLedger(a, ledger)}
          >
            <Download data-icon="inline-start" />
            Export ledger
          </Button>
          <Button
            variant="outline"
            render={<a href={`/modules/finance/general-ledger?search=${encodeURIComponent(a.account_id)}`} />}
          >
            <BookOpen data-icon="inline-start" />
            Open in General Ledger
          </Button>
          <Button variant="outline" render={<a href="/modules/finance/chart-of-accounts" />}>
            <Pencil data-icon="inline-start" />
            Manage
          </Button>
        </div>
      </div>

      {/* Balance KPIs */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Kpi label="Opening balance" icon={Coins} value={inr0(stats.openingBalance)} sub={`${stats.openingSide} · master`} />
        <Kpi label="Total debit" icon={TrendingUp} value={inr0(stats.totalDebit)} sub="Posted ledger" />
        <Kpi label="Total credit" icon={TrendingDown} value={inr0(stats.totalCredit)} sub="Posted ledger" />
        <Kpi
          label="Current balance"
          icon={Scale}
          value={inr0(stats.currentBalance)}
          sub={`${stats.currentSide} · ${stats.entryCount} entries`}
        />
      </div>

      <Tabs defaultValue="balance">
        <TabsList className="flex-wrap">
          <TabsTrigger value="balance">Balance</TabsTrigger>
          <TabsTrigger value="ledger">Ledger ({ledger.length})</TabsTrigger>
          <TabsTrigger value="journal">Journal ({journal.length})</TabsTrigger>
          <TabsTrigger value="transactions">Transactions ({transactions.length})</TabsTrigger>
          <TabsTrigger value="reports">Reports</TabsTrigger>
        </TabsList>

        {/* Balance — the account detail facts (requirement 40) + closing math. */}
        <TabsContent value="balance" className="space-y-4">
          <div className="grid gap-4 lg:grid-cols-2">
            <SectionCard title="Account details" icon={ReceiptText}>
              <Facts
                rows={[
                  ["Account name", a.account_name],
                  ["Account ID", a.account_id],
                  ["Code", a.account_code],
                  ["Type", a.account_group],
                  ["Sub type", a.account_type],
                  ["Nature", stats.nature],
                  ["Parent", parent ? `${parent.account_code ? parent.account_code + " · " : ""}${parent.account_name}` : "—"],
                  ["Status", status],
                  ["Financial year", a.financial_year],
                ]}
              />
            </SectionCard>
            <SectionCard title="Balance summary" icon={Scale}>
              <dl className="space-y-1.5 text-sm">
                <FactLine label="Opening balance" value={<>{inr(stats.openingBalance)} <Side side={stats.openingSide} /></>} />
                <FactLine label="Opening date" value={fmtDate(a.opening_balance_date)} />
                <FactLine label="Total debit" value={inr(stats.totalDebit)} />
                <FactLine label="Total credit" value={inr(stats.totalCredit)} />
                <FactLine label="Net movement" value={<>{inr(Math.abs(stats.net))} <Side side={stats.net >= 0 ? "Debit" : "Credit"} /></>} />
                <div className="flex items-center justify-between gap-4 border-t pt-2">
                  <dt className="font-medium">Current balance</dt>
                  <dd className="font-semibold tabular-nums">{inr(stats.currentBalance)} <Side side={stats.currentSide} /></dd>
                </div>
                <div className="flex items-center justify-between gap-4">
                  <dt className="font-medium">Closing balance</dt>
                  <dd className="font-semibold tabular-nums">{inr(stats.closingBalance)} <Side side={stats.closingSide} /></dd>
                </div>
              </dl>
              <p className="mt-3 text-xs text-muted-foreground">
                Balances are derived live from posted General Ledger entries. Draft entries never affect them, and
                reversed or cancelled postings net out automatically.
              </p>
            </SectionCard>
          </div>

          <SectionCard title="Reporting classification" icon={Layers}>
            <div className="grid gap-4 sm:grid-cols-3">
              <div className="space-y-1">
                <p className="text-xs font-medium text-muted-foreground">Statement</p>
                <p className="text-sm font-medium">{clsStatement}</p>
              </div>
              <div className="space-y-1">
                <p className="text-xs font-medium text-muted-foreground">
                  {cls.section === "ProfitAndLoss" ? "P&L group" : "Balance Sheet group"}
                </p>
                <p className="flex items-center gap-1.5 text-sm font-medium">
                  {clsGroup}
                  {clsOverridden && (
                    <span className="text-[10px] font-medium uppercase text-muted-foreground">pinned</span>
                  )}
                </p>
              </div>
              <div className="space-y-1">
                <p className="text-xs font-medium text-muted-foreground">Cash Flow activity</p>
                <p className="flex items-center gap-1.5 text-sm font-medium">
                  {cls.cashFlowGroup}
                  {cls.cashFlowOverridden && (
                    <span className="text-[10px] font-medium uppercase text-muted-foreground">pinned</span>
                  )}
                </p>
              </div>
            </div>
            <div className="mt-4 space-y-1.5">
              <p className="text-xs font-medium text-muted-foreground">Posting roles</p>
              {roles.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  Not mapped to any posting role. Assign one from Account mapping on the Chart of Accounts screen.
                </p>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {roles.map((r) => (
                    <Badge key={r.role} variant="secondary" className="gap-1">
                      <Tags className="size-3" />
                      {r.label}
                      {r.overridden && <span className="text-[10px] uppercase text-muted-foreground">custom</span>}
                    </Badge>
                  ))}
                </div>
              )}
            </div>
            <p className="mt-3 text-xs text-muted-foreground">
              Auto-derived from this account&apos;s type, code and name and shared with the Balance Sheet, Profit &amp; Loss
              and Cash Flow statements. A pinned group overrides the auto value; roles come from the posting-engine mapping.
            </p>
          </SectionCard>

          {children.length > 0 && (
            <SectionCard title={`Child accounts (${children.length})`} icon={CornerDownRight}>
              <DataTable
                empty="No child accounts."
                head={["Code", "Account", "Type", "Nature", "Status"]}
                rows={children.map((c) => [
                  <span key="code" className="font-mono text-xs">{c.account_code || "—"}</span>,
                  <a
                    key="name"
                    href={`/modules/finance/chart-of-accounts/${encodeURIComponent(c.account_id)}`}
                    className="font-medium text-primary hover:underline"
                  >
                    {c.account_name}
                  </a>,
                  c.account_group || "—",
                  <Badge key="nat" variant={natureVariant(c.nature)}>{c.nature || "—"}</Badge>,
                  <Badge key="st" variant={STATUS_BADGE[String(c.active_status)] || "outline"}>
                    {c.active_status || "Active"}
                  </Badge>,
                ])}
              />
            </SectionCard>
          )}
        </TabsContent>

        {/* Ledger — the account's own GL lines with running balance, each row
            linking back to the source document and its journal voucher. */}
        <TabsContent value="ledger">
          <DataTable
            empty="No posted ledger entries for this account yet."
            head={["Ledger", "Date", "Voucher", "Particulars", "Source", "Journal", "Debit", "Credit", "Balance"]}
            align={[, , , , , , "right", "right", "right"]}
            rows={ledger.map((l) => [
              <span key="id" className="font-mono text-xs">{l.ledger_id}</span>,
              fmtDate(l.transaction_date),
              l.voucher_type || l.voucher_no || "—",
              l.party_name || l.description || "—",
              <SourceCell key="src" line={l} />,
              l.journal_entry_id ? (
                <a
                  key="je"
                  href={`/modules/finance/journal-entries?search=${encodeURIComponent(String(l.journal_entry_id))}`}
                  className="font-mono text-xs text-primary hover:underline"
                >
                  {l.journal_entry_id}
                </a>
              ) : (
                <span key="je" className="text-muted-foreground">—</span>
              ),
              Number(l.debit) ? inr(l.debit) : "—",
              Number(l.credit) ? inr(l.credit) : "—",
              balanceCell(Number(l.balance), (l.balance_type as Side) || stats.nature),
            ])}
          />
        </TabsContent>

        {/* Journal — journal entries referencing this account. */}
        <TabsContent value="journal">
          <DataTable
            empty="No journal entries reference this account yet."
            head={["Journal ID", "Date", "Voucher", "Narration", "Debit", "Credit", "Approval", "Posting"]}
            align={[, , , , "right", "right"]}
            rows={journal.map((j) => [
              <span key="id" className="font-mono text-xs">{j.journal_entry_id}</span>,
              fmtDate(j.journal_date),
              j.voucher_type || j.reference_type || "—",
              <span key="n" className="line-clamp-2 max-w-[22rem]">{j.narration || j.source_module || "—"}</span>,
              Number(j.debit) ? inr(j.debit) : "—",
              Number(j.credit) ? inr(j.credit) : "—",
              <Badge key="a" variant={APPROVAL_BADGE[String(j.approval_status)] || "outline"}>
                {j.approval_status || "Pending"}
              </Badge>,
              <Badge key="p" variant={POST_BADGE[String(j.posting_status)] || "outline"}>
                {j.posting_status || "Unposted"}
              </Badge>,
            ])}
          />
        </TabsContent>

        {/* Transactions — source documents rolled up by voucher. */}
        <TabsContent value="transactions">
          <DataTable
            empty="No source transactions have posted to this account yet."
            head={["Voucher", "Date", "Source", "Reference", "Debit", "Credit", "Lines"]}
            align={[, , , , "right", "right", "right"]}
            rows={transactions.map((t, i) => [
              <span key="v" className="font-mono text-xs">{t.voucher_no || "—"}</span>,
              fmtDate(t.date),
              t.source_module || "—",
              t.source_reference || "—",
              Number(t.debit) ? inr(t.debit) : "—",
              Number(t.credit) ? inr(t.credit) : "—",
              <span key={`l${i}`} className="tabular-nums">{Number(t.lines) || 0}</span>,
            ])}
          />
        </TabsContent>

        {/* Reports — a compact per-account statement + jump-offs. */}
        <TabsContent value="reports" className="space-y-4">
          <div className="grid gap-4 lg:grid-cols-2">
            <SectionCard title="Account statement" icon={FileText}>
              <dl className="space-y-1.5 text-sm">
                <FactLine label="Period" value={stats.firstDate ? `${fmtDate(stats.firstDate)} → ${fmtDate(stats.lastDate)}` : "No postings"} />
                <FactLine label="Opening balance" value={<>{inr(stats.openingBalance)} <Side side={stats.openingSide} /></>} />
                <FactLine label="Total debit" value={inr(stats.totalDebit)} />
                <FactLine label="Total credit" value={inr(stats.totalCredit)} />
                <FactLine label="Posted entries" value={String(stats.entryCount)} />
                <div className="flex items-center justify-between gap-4 border-t pt-2">
                  <dt className="font-medium">Closing balance</dt>
                  <dd className="font-semibold tabular-nums">{inr(stats.closingBalance)} <Side side={stats.closingSide} /></dd>
                </div>
              </dl>
            </SectionCard>
            <SectionCard title="Open in reports" icon={ExternalLink}>
              <div className="flex flex-col gap-2">
                <ReportLink
                  href={`/modules/finance/general-ledger?search=${encodeURIComponent(a.account_id)}`}
                  icon={BookOpen}
                  label="General Ledger"
                  sub="Every posted line for this account"
                />
                <ReportLink
                  href={`/modules/finance/journal-entries?search=${encodeURIComponent(a.account_id)}`}
                  icon={ReceiptText}
                  label="Journal Entries"
                  sub="Journal vouchers touching this account"
                />
                <ReportLink
                  href="/modules/finance/financial-reports"
                  icon={Landmark}
                  label="Financial Reports"
                  sub="Trial balance, P&L and balance sheet"
                />
              </div>
            </SectionCard>
          </div>
        </TabsContent>
      </Tabs>
    </main>
  )
}

function BackLink() {
  return (
    <Button variant="ghost" size="sm" className="-ml-2" render={<a href="/modules/finance/chart-of-accounts" />}>
      <ArrowLeft data-icon="inline-start" />
      Chart of Accounts
    </Button>
  )
}

function Side({ side }: { side: Side }) {
  return <span className="text-xs text-muted-foreground">{side === "Debit" ? "Dr" : "Cr"}</span>
}

function Kpi({
  label, value, icon: Icon, sub,
}: {
  label: string; value: string; icon: React.ComponentType<{ className?: string }>; sub?: string
}) {
  return (
    <Card>
      <CardContent className="flex flex-col gap-1 pt-6">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-muted-foreground">{label}</span>
          <Icon className="size-4 text-muted-foreground" />
        </div>
        <span className="text-xl font-semibold tracking-tight tabular-nums">{value}</span>
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

function ReportLink({
  href, icon: Icon, label, sub,
}: { href: string; icon: React.ComponentType<{ className?: string }>; label: string; sub: string }) {
  return (
    <a
      href={href}
      className="flex items-center gap-3 rounded-md border p-3 transition-colors hover:bg-muted/50"
    >
      <Icon className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium">{label}</span>
        <span className="block text-xs text-muted-foreground">{sub}</span>
      </span>
      <ExternalLink className="size-3.5 shrink-0 text-muted-foreground" />
    </a>
  )
}

function FactLine({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-dashed py-1 last:border-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right font-medium tabular-nums">{value}</dd>
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
