"use client"

import useSWR, { mutate } from "swr"
import { useMemo, useState } from "react"
import { fetcher } from "@/lib/fetcher"
import { inr, inr0 } from "@/lib/finance-calc"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent } from "@/components/ui/card"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { ExcelExportButton } from "@/components/excel-export-button"
import type { BadgeVariant } from "@/lib/finance-schema"
import {
  Coins, Wallet, TrendingUp, BookOpen, CheckCircle2, AlertTriangle, Layers, Link2,
  FilterX, Lock, Loader2Icon, Users, FolderKanban, CalendarRange, ScrollText, Landmark, ShieldCheck, RefreshCw,
} from "lucide-react"

type Row = Record<string, any>
type Side = "Debit" | "Credit"
type View = "ledger" | "party" | "project" | "monthly" | "reconciliation" | "bank" | "integrity"

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
]
const QUARTERS = ["Q1", "Q2", "Q3", "Q4"]

const RECON_BADGE: Record<string, BadgeVariant> = {
  Reconciled: "default",
  Matched: "default",
  "Needs Review": "secondary",
  Mismatch: "destructive",
  Unreconciled: "outline",
  Pending: "secondary",
}

const emptyFilters = {
  search: "",
  financial_year: "",
  month: "",
  quarter: "",
  date_from: "",
  date_to: "",
  account_id: "",
  account_group: "",
  account_type: "",
  transaction_type: "",
  voucher_type: "",
  party: "",
  party_type: "",
  project: "",
  source_module: "",
  reconciliation_status: "",
  side: "",
  balance_type: "",
}
type Filters = typeof emptyFilters

function fmtDate(v: any) {
  if (!v) return "—"
  const d = new Date(v)
  if (Number.isNaN(d.getTime())) return String(v)
  return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })
}

/** Money with its Dr/Cr side, em dash when zero. */
function Amt({ value, side }: { value: number; side?: Side }) {
  if (!value) return <span className="text-muted-foreground">—</span>
  return (
    <span className="tabular-nums">
      {inr(value)}
      {side ? <span className="ml-1 text-xs text-muted-foreground">{side === "Debit" ? "Dr" : "Cr"}</span> : null}
    </span>
  )
}

export function GeneralLedgerClient() {
  const [view, setView] = useState<View>("ledger")
  const [filters, setFilters] = useState<Filters>(() => {
    const base = { ...emptyFilters }
    if (typeof window !== "undefined") {
      const params = new URLSearchParams(window.location.search)
      const search = params.get("search")
      const fy = params.get("financial_year")
      if (search) base.search = search
      if (fy) base.financial_year = fy
    }
    return base
  })

  const queryKey = useMemo(() => {
    const params = new URLSearchParams({ view })
    for (const [k, v] of Object.entries(filters)) if (v) params.set(k, v)
    return `/api/finance/general-ledger?${params.toString()}`
  }, [view, filters])

  const { data, isLoading } = useSWR<Row>(queryKey, fetcher, { keepPreviousData: true })

  const cards = data?.cards ?? {}
  const opts = data?.filterOptions ?? {}
  const activeFilterCount = Object.entries(filters).filter(([, v]) => v).length

  function set<K extends keyof Filters>(key: K, value: string) {
    setFilters((f) => ({ ...f, [key]: value }))
  }

  return (
    <main className="space-y-8 p-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-sm text-muted-foreground">Central ledger — auto-posted from Journal Entries</p>
          <h1 className="text-3xl font-semibold tracking-tight text-balance">General Ledger</h1>
        </div>
        <div className="flex items-center gap-2">
          <SyncLedgerButton onSynced={() => mutate(queryKey)} />
          <ExportForView view={view} data={data} />
        </div>
      </div>

      {/* The GL is written only by the posting engine — manual entries go through
          Journal Entries. Preserve the read-only contract. */}
      <div className="flex items-start gap-3 rounded-lg border border-border bg-muted/40 px-4 py-3 text-sm">
        <Lock className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <p className="text-muted-foreground">
          This ledger is the central record of posted accounting transactions. Every row is posted automatically from{" "}
          <a href="/modules/finance/journal-entries" className="font-medium text-primary hover:underline">
            Journal Entries
          </a>
          {" "}and source documents. To make a manual accounting entry, create a balanced journal — it will appear here once posted.
        </p>
      </div>

      {/* Dashboard cards (Phase 17 + 18) */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Kpi label="Total Debit" icon={Coins} value={inr0(cards.totalDebit)} />
        <Kpi label="Total Credit" icon={Wallet} value={inr0(cards.totalCredit)} />
        <Kpi
          label="Net Movement"
          icon={TrendingUp}
          value={inr0(Math.abs(cards.netMovement ?? 0))}
          sub={`${cards.netSide ?? "Debit"} · Debit − Credit`}
        />
        <Kpi label="Entries" icon={BookOpen} value={String(cards.totalRows ?? 0)} />
        <Kpi label="Posted Entries" icon={ScrollText} value={String(cards.postedEntries ?? 0)} sub="Posted vouchers" />
        <Kpi label="Unreconciled" icon={AlertTriangle} value={String(cards.unreconciled ?? 0)} />
        <Kpi label="Accounts Used" icon={Layers} value={String(cards.accountsUsed ?? 0)} />
        <Kpi label="Journal-linked" icon={Link2} value={String(cards.journalLinked ?? 0)} />
      </div>

      {/* Advanced filters (Phase 11, 15, 16) */}
      <Card>
        <CardContent className="grid gap-3 pt-6 sm:grid-cols-2 lg:grid-cols-4">
          <Input
            placeholder="Search ledger / journal / voucher / reference / party / UTR..."
            value={filters.search}
            onChange={(e) => set("search", e.target.value)}
            className="sm:col-span-2 lg:col-span-4"
          />
          <Select label="Financial year" value={filters.financial_year} onChange={(v) => set("financial_year", v)} options={opts.financialYears ?? []} allLabel="All financial years" />
          <Select label="Quarter" value={filters.quarter} onChange={(v) => set("quarter", v)} options={QUARTERS} allLabel="All quarters" />
          <Select label="Month" value={filters.month} onChange={(v) => set("month", v)} options={MONTHS.map((m, i) => ({ value: String(i + 1), label: m }))} allLabel="All months" />
          <div className="flex items-center gap-2">
            <Input type="date" aria-label="From date" value={filters.date_from} onChange={(e) => set("date_from", e.target.value)} />
            <span className="text-xs text-muted-foreground">to</span>
            <Input type="date" aria-label="To date" value={filters.date_to} onChange={(e) => set("date_to", e.target.value)} />
          </div>
          <Select
            label="Account"
            value={filters.account_id}
            onChange={(v) => set("account_id", v)}
            options={(opts.accounts ?? []).map((a: Row) => ({ value: a.id, label: a.name }))}
            allLabel="All accounts"
          />
          <Select label="Account group" value={filters.account_group} onChange={(v) => set("account_group", v)} options={opts.accountGroups ?? []} allLabel="All groups" />
          <Select label="Account type" value={filters.account_type} onChange={(v) => set("account_type", v)} options={opts.accountTypes ?? []} allLabel="All types" />
          <Select label="Transaction type" value={filters.transaction_type} onChange={(v) => set("transaction_type", v)} options={opts.transactionTypes ?? []} allLabel="All transaction types" />
          <Select label="Voucher type" value={filters.voucher_type} onChange={(v) => set("voucher_type", v)} options={opts.voucherTypes ?? []} allLabel="All voucher types" />
          <Select label="Party" value={filters.party} onChange={(v) => set("party", v)} options={opts.parties ?? []} allLabel="All parties" />
          <Select label="Party type" value={filters.party_type} onChange={(v) => set("party_type", v)} options={["Customer", "Vendor", "Employee", "Freelancer", "Other"]} allLabel="All party types" />
          <Select label="Project" value={filters.project} onChange={(v) => set("project", v)} options={opts.projects ?? []} allLabel="All projects" />
          <Select label="Source module" value={filters.source_module} onChange={(v) => set("source_module", v)} options={opts.sourceModules ?? []} allLabel="All sources" />
          <Select label="Reconciliation" value={filters.reconciliation_status} onChange={(v) => set("reconciliation_status", v)} options={opts.reconciliationStatuses ?? []} allLabel="All reconciliation" />
          <Select label="Debit / Credit" value={filters.side} onChange={(v) => set("side", v)} options={["Debit", "Credit"]} allLabel="Debit & Credit" />
          <Select label="Balance type" value={filters.balance_type} onChange={(v) => set("balance_type", v)} options={["Debit", "Credit"]} allLabel="All balance types" />
          {activeFilterCount > 0 && (
            <Button variant="ghost" size="sm" className="justify-self-start" onClick={() => setFilters(emptyFilters)}>
              <FilterX data-icon="inline-start" />
              Clear filters ({activeFilterCount})
            </Button>
          )}
        </CardContent>
      </Card>

      <Tabs value={view} onValueChange={(v) => setView(v as View)}>
        <TabsList className="flex-wrap">
          <TabsTrigger value="ledger"><BookOpen data-icon="inline-start" />Ledger</TabsTrigger>
          <TabsTrigger value="party"><Users data-icon="inline-start" />Party Ledger</TabsTrigger>
          <TabsTrigger value="project"><FolderKanban data-icon="inline-start" />Project Ledger</TabsTrigger>
          <TabsTrigger value="monthly"><CalendarRange data-icon="inline-start" />Monthly</TabsTrigger>
          <TabsTrigger value="reconciliation"><CheckCircle2 data-icon="inline-start" />Reconciliation</TabsTrigger>
          <TabsTrigger value="bank"><Landmark data-icon="inline-start" />Bank Reconciliation</TabsTrigger>
          <TabsTrigger value="integrity"><ShieldCheck data-icon="inline-start" />Integrity</TabsTrigger>
        </TabsList>

        <TabsContent value="ledger">
          <LedgerTab data={data} loading={isLoading} />
        </TabsContent>
        <TabsContent value="party">
          <PartyTab data={data} loading={isLoading} />
        </TabsContent>
        <TabsContent value="project">
          <ProjectTab data={data} loading={isLoading} />
        </TabsContent>
        <TabsContent value="monthly">
          <MonthlyTab data={data} loading={isLoading} />
        </TabsContent>
        <TabsContent value="reconciliation">
          <ReconciliationTab data={data} loading={isLoading} />
        </TabsContent>
        <TabsContent value="bank">
          <BankTab data={data} loading={isLoading} />
        </TabsContent>
        <TabsContent value="integrity">
          <IntegrityTab data={data} loading={isLoading} />
        </TabsContent>
      </Tabs>
    </main>
  )
}

// ---------------------------------------------------------------------------
// Period summary strip — Opening / Debit / Credit / Closing (Phases 12–14).
// ---------------------------------------------------------------------------
function SummaryStrip({ s }: { s: Row | undefined }) {
  if (!s) return null
  return (
    <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
      <SummaryBox label="Opening" value={s.opening} side={s.openingSide} />
      <SummaryBox label="Debit" value={s.debit} />
      <SummaryBox label="Credit" value={s.credit} />
      <SummaryBox label="Closing" value={s.closing} side={s.closingSide} emphasize />
    </div>
  )
}

function SummaryBox({ label, value, side, emphasize }: { label: string; value: number; side?: Side; emphasize?: boolean }) {
  return (
    <div className={`rounded-lg border px-3 py-2 ${emphasize ? "bg-muted/50" : ""}`}>
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p className="text-sm font-semibold tabular-nums">
        {inr(value ?? 0)}
        {side ? <span className="ml-1 text-xs font-normal text-muted-foreground">{side === "Debit" ? "Dr" : "Cr"}</span> : null}
      </p>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------
function LedgerTab({ data, loading }: { data: Row | undefined; loading: boolean }) {
  const rows: Row[] = data?.rows ?? []
  return (
    <TableCard title="Ledger entries" count={rows.length} loading={loading}>
      <SummaryStrip s={data?.summary} />
      <ScrollTable
        head={["Ledger ID", "Journal", "Date", "Account", "Party", "Voucher", "Source", "Debit", "Credit", "Balance", "Reconciliation"]}
        rightCols={[7, 8, 9]}
        empty="No posted ledger entries match the current filters."
        rows={rows.map((l) => [
          <span key="id" className="font-mono text-xs">{l.ledger_id}</span>,
          l.journal_entry_id ? (
            <a key="je" href={`/modules/finance/journal-entries?search=${encodeURIComponent(String(l.voucher_no || l.journal_entry_id))}`} className="font-mono text-xs text-primary hover:underline">
              {l.voucher_no || l.journal_entry_id}
            </a>
          ) : <span key="je" className="text-muted-foreground">—</span>,
          fmtDate(l.transaction_date),
          <div key="acc"><div className="font-medium">{l.account_name || "—"}</div><div className="text-xs text-muted-foreground">{l.account_group || ""}</div></div>,
          l.party_name || "—",
          l.voucher_type || "—",
          [l.source_module, l.source_reference].filter(Boolean).join(" · ") || "—",
          <Amt key="d" value={Number(l.debit)} />,
          <Amt key="c" value={Number(l.credit)} />,
          <Amt key="b" value={Number(l.balance)} side={(l.balance_type as Side) || undefined} />,
          <Badge key="r" variant={RECON_BADGE[String(l.reconciliation_status)] || "outline"}>{l.reconciliation_status || "Unreconciled"}</Badge>,
        ])}
      />
    </TableCard>
  )
}

function PartyTab({ data, loading }: { data: Row | undefined; loading: boolean }) {
  const rows: Row[] = data?.rows ?? []
  return (
    <TableCard title="Party ledger" count={rows.length} loading={loading} hint="Opening / Debit / Credit / Closing per party (Customer, Vendor, Employee, Freelancer)">
      <ScrollTable
        head={["Party", "Type", "Opening", "Debit", "Credit", "Closing"]}
        rightCols={[2, 3, 4, 5]}
        empty="No party postings match the current filters."
        rows={rows.map((r) => [
          <span key="p" className="font-medium">{r.party}</span>,
          <Badge key="t" variant="outline">{r.partyType}</Badge>,
          <Amt key="o" value={Number(r.opening)} side={r.openingSide} />,
          <Amt key="d" value={Number(r.debit)} />,
          <Amt key="c" value={Number(r.credit)} />,
          <Amt key="cl" value={Number(r.closing)} side={r.closingSide} />,
        ])}
      />
    </TableCard>
  )
}

function ProjectTab({ data, loading }: { data: Row | undefined; loading: boolean }) {
  const rows: Row[] = data?.rows ?? []
  return (
    <TableCard title="Project ledger" count={rows.length} loading={loading} hint="Opening / Debit / Credit / Closing per project">
      <ScrollTable
        head={["Project", "Opening", "Debit", "Credit", "Closing"]}
        rightCols={[1, 2, 3, 4]}
        empty="No project-tagged postings match the current filters."
        rows={rows.map((r) => [
          <span key="p" className="font-medium">{r.project}</span>,
          <Amt key="o" value={Number(r.opening)} side={r.openingSide} />,
          <Amt key="d" value={Number(r.debit)} />,
          <Amt key="c" value={Number(r.credit)} />,
          <Amt key="cl" value={Number(r.closing)} side={r.closingSide} />,
        ])}
      />
    </TableCard>
  )
}

function MonthlyTab({ data, loading }: { data: Row | undefined; loading: boolean }) {
  const rows: Row[] = data?.rows ?? []
  return (
    <TableCard title="Monthly ledger" count={rows.length} loading={loading} hint="Each month's closing carries into the next as its opening">
      <ScrollTable
        head={["Month", "Opening", "Debit", "Credit", "Closing"]}
        rightCols={[1, 2, 3, 4]}
        empty="No monthly movement for the current filters."
        rows={rows.map((r) => [
          <span key="m" className="font-medium">{r.label}</span>,
          <Amt key="o" value={Number(r.opening)} side={r.openingSide} />,
          <Amt key="d" value={Number(r.debit)} />,
          <Amt key="c" value={Number(r.credit)} />,
          <Amt key="cl" value={Number(r.closing)} side={r.closingSide} />,
        ])}
      />
    </TableCard>
  )
}

function ReconciliationTab({ data, loading }: { data: Row | undefined; loading: boolean }) {
  const rows: Row[] = data?.rows ?? []
  const counts: Row = data?.counts ?? {}
  return (
    <TableCard title="Reconciliation" count={rows.length} loading={loading}>
      <div className="mb-4 flex flex-wrap gap-2">
        {["Reconciled", "Matched", "Needs Review", "Mismatch", "Unreconciled"].map((s) => (
          <Badge key={s} variant={RECON_BADGE[s] || "outline"} className="gap-1">
            {s}: {counts[s] ?? 0}
          </Badge>
        ))}
      </div>
      <ScrollTable
        head={["Ledger ID", "Date", "Account", "Party", "Journal", "Source", "UTR / Reference", "Debit", "Credit", "Status"]}
        rightCols={[7, 8]}
        empty="No entries to reconcile for the current filters."
        rows={rows.map((l) => [
          <span key="id" className="font-mono text-xs">{l.ledger_id}</span>,
          fmtDate(l.transaction_date),
          l.account_name || "—",
          l.party_name || "—",
          l.journal_entry_id || l.voucher_no || "—",
          [l.source_module, l.source_reference].filter(Boolean).join(" · ") || "—",
          l.cheque_utr_reference || l.reference_no || "—",
          <Amt key="d" value={Number(l.debit)} />,
          <Amt key="c" value={Number(l.credit)} />,
          <Badge key="s" variant={RECON_BADGE[String(l.recon_status)] || "outline"}>{l.recon_status}</Badge>,
        ])}
      />
    </TableCard>
  )
}

function BankTab({ data, loading }: { data: Row | undefined; loading: boolean }) {
  const rows: Row[] = data?.rows ?? []
  const counts: Row = data?.counts ?? {}
  return (
    <TableCard title="Bank reconciliation" count={rows.length} loading={loading} hint="Bank Transactions compared to bank-related ledger entries on amount, date, reference, UTR, account and source">
      <div className="mb-4 flex flex-wrap gap-2">
        {["Matched", "Needs Review", "Mismatch", "Unreconciled", "Reconciled"].map((s) => (
          <Badge key={s} variant={RECON_BADGE[s] || "outline"} className="gap-1">
            {s}: {counts[s] ?? 0}
          </Badge>
        ))}
      </div>
      <ScrollTable
        head={["Bank Txn", "Date", "Account", "Party", "UTR / Ref", "Amount", "Matched Ledger", "Match On", "Status"]}
        rightCols={[5]}
        empty="No bank transactions match the current filters."
        rows={rows.map((t) => [
          <span key="id" className="font-mono text-xs">{t.transactionId}</span>,
          fmtDate(t.date),
          t.account || "—",
          t.party || "—",
          t.utr || t.reference || "—",
          <Amt key="a" value={Number(t.amount)} side={t.side} />,
          t.matched ? (
            <span key="m" className="font-mono text-xs">{t.matched.ledgerId}</span>
          ) : <span key="m" className="text-muted-foreground">No match</span>,
          <MatchChips key="f" fields={t.fields} disabled={!t.matched} />,
          <Badge key="s" variant={RECON_BADGE[String(t.status)] || "outline"}>{t.status}</Badge>,
        ])}
      />
    </TableCard>
  )
}

function MatchChips({ fields, disabled }: { fields: Row; disabled?: boolean }) {
  if (disabled) return <span className="text-muted-foreground">—</span>
  const labels: [string, string][] = [
    ["amount", "Amt"], ["date", "Date"], ["reference", "Ref"], ["utr", "UTR"], ["account", "Acct"], ["source", "Src"],
  ]
  return (
    <div className="flex flex-wrap gap-1">
      {labels.map(([k, label]) => (
        <span
          key={k}
          className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${fields?.[k] ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300" : "bg-muted text-muted-foreground line-through"}`}
        >
          {label}
        </span>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Integrity tab (Phases 21 & 22) — GL ⇄ Journal ⇄ Source reconciliation. Every
// posted voucher's Journal total and originating source-document amount are
// reconciled against the General Ledger; mismatches surface as GL Exceptions.
// ---------------------------------------------------------------------------
function IntegrityTab({ data, loading }: { data: Row | undefined; loading: boolean }) {
  const rows: Row[] = data?.rows ?? []
  const counts: Row = data?.counts ?? {}
  return (
    <TableCard
      title="GL Integrity — Journal & Source reconciliation"
      count={rows.length}
      loading={loading}
      hint="Journal Entries is the primary source; the ledger is the posted record. Each voucher's Journal total and source-document amount are reconciled against the General Ledger — any divergence is a GL Exception."
    >
      <div className="mb-4 flex flex-wrap gap-2">
        <Badge variant={(counts.exceptions ?? 0) > 0 ? "destructive" : "default"} className="gap-1">
          {(counts.exceptions ?? 0) > 0 ? <AlertTriangle className="size-3" /> : <CheckCircle2 className="size-3" />}
          Exceptions: {counts.exceptions ?? 0}
        </Badge>
        <Badge variant="default" className="gap-1">Balanced: {counts.balanced ?? 0}</Badge>
        <Badge variant="secondary" className="gap-1">Journal mismatch: {counts.journalMismatch ?? 0}</Badge>
        <Badge variant="secondary" className="gap-1">Source mismatch: {counts.sourceMismatch ?? 0}</Badge>
        <Badge variant="secondary" className="gap-1">Unbalanced: {counts.unbalanced ?? 0}</Badge>
        <Badge variant="secondary" className="gap-1">Missing journal: {counts.missingJournal ?? 0}</Badge>
      </div>
      <ScrollTable
        head={["Voucher", "Date", "Source", "Journal (Dr / Cr)", "Ledger (Dr / Cr)", "Source Amount", "Status / Issues"]}
        rightCols={[3, 4, 5]}
        empty="No posted vouchers to reconcile for the current filters."
        rows={rows.map((r) => [
          <a
            key="v"
            href={`/modules/finance/journal-entries?search=${encodeURIComponent(String(r.voucherNo))}`}
            className="font-mono text-xs text-primary hover:underline"
          >
            {r.voucherNo}
          </a>,
          fmtDate(r.date),
          [r.sourceModule, r.sourceReference].filter(Boolean).join(" · ") || "Manual",
          <span key="j" className="tabular-nums text-xs">{inr(Number(r.journalDebit))} / {inr(Number(r.journalCredit))}</span>,
          <span key="g" className="tabular-nums text-xs">{inr(Number(r.ledgerDebit))} / {inr(Number(r.ledgerCredit))}</span>,
          r.sourceAmount != null
            ? <span key="s" className="tabular-nums">{inr(Number(r.sourceAmount))}</span>
            : <span key="s" className="text-muted-foreground">—</span>,
          r.status === "Exception" ? (
            <div key="st" className="space-y-1">
              <Badge variant="destructive" className="gap-1"><AlertTriangle className="size-3" />Exception</Badge>
              <ul className="list-disc space-y-0.5 pl-4 text-xs text-muted-foreground">
                {(r.issues ?? []).map((issue: string, idx: number) => <li key={idx}>{issue}</li>)}
              </ul>
            </div>
          ) : (
            <Badge key="st" variant="default" className="gap-1"><CheckCircle2 className="size-3" />Balanced</Badge>
          ),
        ])}
      />
    </TableCard>
  )
}

// ---------------------------------------------------------------------------
// Shared UI primitives
// ---------------------------------------------------------------------------
function Kpi({ label, icon: Icon, value, sub }: { label: string; icon: React.ComponentType<{ className?: string }>; value: string; sub?: string }) {
  return (
    <Card>
      <CardContent className="flex flex-col gap-2 pt-6">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-muted-foreground">{label}</span>
          <Icon className="size-4 text-muted-foreground" />
        </div>
        <span className="text-xl font-semibold tracking-tight">{value}</span>
        {sub ? <span className="text-xs text-muted-foreground">{sub}</span> : null}
      </CardContent>
    </Card>
  )
}

type SelectOption = string | { value: string; label: string }

function Select({ label, value, onChange, options, allLabel }: { label: string; value: string; onChange: (v: string) => void; options: SelectOption[]; allLabel: string }) {
  return (
    <select
      className="h-10 rounded-md border bg-background px-3 text-sm"
      aria-label={label}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="">{allLabel}</option>
      {options.map((o) => {
        const value = typeof o === "string" ? o : o.value
        const text = typeof o === "string" ? o : o.label
        return <option key={value} value={value}>{text}</option>
      })}
    </select>
  )
}

function TableCard({ title, count, loading, hint, children }: { title: string; count: number; loading?: boolean; hint?: string; children: React.ReactNode }) {
  return (
    <Card>
      <CardContent className="pt-6">
        <div className="mb-3 flex items-center justify-between gap-4">
          <div>
            <span className="text-sm font-medium">{title}</span>
            {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
          </div>
          <div className="flex items-center gap-2">
            {loading ? <Loader2Icon className="size-4 animate-spin text-muted-foreground" /> : null}
            <Badge variant="secondary">{count} records</Badge>
          </div>
        </div>
        {children}
      </CardContent>
    </Card>
  )
}

function ScrollTable({ head, rows, rightCols = [], empty }: { head: string[]; rows: React.ReactNode[][]; rightCols?: number[]; empty: string }) {
  const right = new Set(rightCols)
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-left text-muted-foreground">
            {head.map((h, i) => (
              <th key={h} className={`p-2 font-medium ${right.has(i) ? "text-right" : ""}`}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr><td colSpan={head.length} className="p-6 text-center text-muted-foreground">{empty}</td></tr>
          )}
          {rows.map((cells, ri) => (
            <tr key={ri} className="border-b hover:bg-muted/40">
              {cells.map((cell, ci) => (
                <td key={ci} className={`p-2 align-top ${right.has(ci) ? "text-right" : ""}`}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Sync ledger (Phase 35) — reconcile posted Journal Entries into the ledger.
// Idempotent: rebuilds only the ledger rows that are missing, so it is safe to
// press repeatedly. Feedback is shown inline (no toast dependency).
// ---------------------------------------------------------------------------
function SyncLedgerButton({ onSynced }: { onSynced: () => void }) {
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<{ kind: "ok" | "err"; text: string } | null>(null)

  async function run() {
    setBusy(true)
    setNote(null)
    try {
      const res = await fetch("/api/finance/general-ledger/sync", { method: "POST" })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body?.error || "Sync failed")
      const created = Number(body.created ?? 0)
      const failed = Number(body.failed ?? 0)
      setNote({
        kind: failed > 0 ? "err" : "ok",
        text:
          created === 0 && failed === 0
            ? "Ledger already up to date"
            : `${created} posted${failed > 0 ? ` · ${failed} failed` : ""}`,
      })
      onSynced()
    } catch (error) {
      setNote({ kind: "err", text: (error as Error).message })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex items-center gap-2">
      {note ? (
        <span className={`text-xs ${note.kind === "ok" ? "text-emerald-600 dark:text-emerald-400" : "text-destructive"}`}>
          {note.text}
        </span>
      ) : null}
      <Button
        variant="outline"
        onClick={run}
        disabled={busy}
        title="Rebuild any missing ledger rows from posted Journal Entries"
      >
        {busy ? <Loader2Icon className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
        Sync ledger
      </Button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Per-view Excel export — flattens whatever the active view returned.
// ---------------------------------------------------------------------------
function ExportForView({ view, data }: { view: View; data: Row | undefined }) {
  const rows: Row[] = data?.rows ?? []
  const filename = `general-ledger-${view}`
  return <ExcelExportButton rows={rows} filename={filename} />
}
