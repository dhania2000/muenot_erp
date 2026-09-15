"use client"

import useSWR from "swr"
import { fetcher } from "@/lib/fetcher"
import { Badge } from "@/components/ui/badge"
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { inr } from "@/lib/finance-calc"
import {
  FileText, BookOpen, Layers, BarChart3, ArrowRight, ExternalLink, CheckCircle2, AlertTriangle, Loader2Icon,
} from "lucide-react"

type JournalTrace = {
  voucherNo: string
  voucherType: string
  journalDate: string
  financialYear: string
  narration: string
  postingStatus: string
  approvalStatus: string
  source: {
    present: boolean
    isManual: boolean
    sourceModule: string
    entityType: string | null
    entityId: string | null
    reference: string
    href: string | null
    missing: boolean
  }
  journal: {
    present: boolean
    lines: {
      journalEntryId: string
      accountName: string
      accountGroup: string
      debit: number
      credit: number
      gst: number
      tds: number
    }[]
    totalDebit: number
    totalCredit: number
    balanced: boolean
  }
  ledger: {
    present: boolean
    lines: {
      ledgerId: string
      accountName: string
      debit: number
      credit: number
      balance: number
      balanceType: string
      reconciliationStatus: string
    }[]
    totalDebit: number
    totalCredit: number
    matchesJournal: boolean
  }
  reports: { accountGroup: string; accountType: string; statement: string; href: string; amount: number }[]
}

/**
 * Ledger drill-down (Phases 49 & 50). Opens the full read-only trace for a
 * posted voucher — Source document → Journal Entry → General Ledger → Financial
 * Report — reusing the existing `/journal-entries/trace` projection so the GL
 * and Journal Entries always tell the same story.
 */
export function LedgerTraceDrawer({ voucherNo, onClose }: { voucherNo: string | null; onClose: () => void }) {
  const { data, isLoading, error } = useSWR<{ trace: JournalTrace }>(
    voucherNo ? `/api/finance/journal-entries/trace?voucher=${encodeURIComponent(voucherNo)}` : null,
    fetcher,
  )
  const trace = data?.trace ?? null

  return (
    <Sheet open={Boolean(voucherNo)} onOpenChange={(o) => (o ? null : onClose())}>
      <SheetContent className="overflow-y-auto sm:max-w-2xl">
        <SheetHeader>
          <div className="flex flex-wrap items-center gap-2">
            <SheetTitle className="font-mono text-sm">{voucherNo}</SheetTitle>
            {trace ? (
              <>
                <Badge variant={trace.postingStatus === "Posted" ? "default" : "outline"}>
                  {trace.postingStatus || "Unposted"}
                </Badge>
                <Badge variant={trace.source.isManual ? "outline" : "secondary"}>{trace.source.sourceModule}</Badge>
                {trace.voucherType ? <Badge variant="outline">{trace.voucherType}</Badge> : null}
              </>
            ) : null}
          </div>
          <p className="text-xs text-muted-foreground">
            Full drill path — Source → Journal → General Ledger → Financial Report
          </p>
          {trace?.narration ? <p className="text-sm text-muted-foreground">{trace.narration}</p> : null}
        </SheetHeader>

        {isLoading ? (
          <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
            <Loader2Icon className="size-4 animate-spin" /> Building trace…
          </div>
        ) : error || !trace ? (
          <p className="p-6 text-sm text-muted-foreground">
            {error ? "Could not load this trace." : "No trace available for this voucher."}
          </p>
        ) : (
          <div className="space-y-4">
            {/* Consistency verdict across the chain */}
            <div className="flex flex-wrap gap-2">
              <Verdict ok={trace.journal.balanced} okText="Journal balanced" badText="Journal not balanced" />
              <Verdict ok={trace.ledger.present} okText="Posted to ledger" badText="Not in ledger" />
              <Verdict ok={trace.ledger.matchesJournal} okText="Journal ⇄ GL match" badText="Journal ⇄ GL mismatch" />
            </div>

            {/* 1 — Source */}
            <Step icon={FileText} title="Source Transaction" step={1}>
              {trace.source.isManual ? (
                <p className="text-sm text-muted-foreground">Manual Journal Entry — no upstream source document.</p>
              ) : trace.source.missing ? (
                <p className="text-sm text-amber-600 dark:text-amber-400">
                  {trace.source.sourceModule} posting with no linked document reference.
                </p>
              ) : (
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="font-medium">{trace.source.sourceModule}</span>
                  <span className="text-muted-foreground">{trace.source.reference}</span>
                  {trace.source.href ? (
                    <a
                      href={`${trace.source.href}?search=${encodeURIComponent(trace.source.reference)}`}
                      className="inline-flex items-center gap-1 text-primary hover:underline"
                    >
                      Open <ExternalLink className="size-3" />
                    </a>
                  ) : null}
                </div>
              )}
            </Step>

            <Connector />

            {/* 2 — Journal */}
            <Step icon={BookOpen} title="Journal Entry" step={2}>
              <a
                href={`/modules/finance/journal-entries?search=${encodeURIComponent(trace.voucherNo)}`}
                className="mb-2 inline-flex items-center gap-1 text-xs text-primary hover:underline"
              >
                View in Journal Entries <ExternalLink className="size-3" />
              </a>
              <LineTable
                rows={trace.journal.lines.map((l) => ({
                  account: l.accountName,
                  group: l.accountGroup,
                  debit: l.debit,
                  credit: l.credit,
                }))}
                totalDebit={trace.journal.totalDebit}
                totalCredit={trace.journal.totalCredit}
              />
            </Step>

            <Connector />

            {/* 3 — General Ledger */}
            <Step icon={Layers} title="General Ledger" step={3}>
              {trace.ledger.present ? (
                <LineTable
                  rows={trace.ledger.lines.map((l) => ({
                    account: l.accountName,
                    group: `${l.reconciliationStatus} · Bal ${inr(l.balance)} ${l.balanceType === "Debit" ? "Dr" : "Cr"}`,
                    debit: l.debit,
                    credit: l.credit,
                  }))}
                  totalDebit={trace.ledger.totalDebit}
                  totalCredit={trace.ledger.totalCredit}
                />
              ) : (
                <p className="text-sm text-amber-600 dark:text-amber-400">
                  This voucher has not been posted to the ledger yet. Use “Sync ledger” to post it.
                </p>
              )}
            </Step>

            <Connector />

            {/* 4 — Financial Reports */}
            <Step icon={BarChart3} title="Financial Reports" step={4}>
              {trace.reports.length ? (
                <ul className="space-y-1.5">
                  {trace.reports.map((r) => (
                    <li key={r.accountGroup} className="flex items-center justify-between gap-2 text-sm">
                      <span>
                        <span className="font-medium">{r.accountGroup}</span>
                        <a href={r.href} className="ml-2 inline-flex items-center gap-1 text-xs text-primary hover:underline">
                          {r.statement} <ArrowRight className="size-3" />
                        </a>
                      </span>
                      <span className="tabular-nums">
                        {inr(Math.abs(r.amount))}
                        <span className="ml-1 text-xs text-muted-foreground">{r.amount >= 0 ? "Dr" : "Cr"}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">No report classification for this voucher.</p>
              )}
            </Step>
          </div>
        )}
      </SheetContent>
    </Sheet>
  )
}

function Verdict({ ok, okText, badText }: { ok: boolean; okText: string; badText: string }) {
  return (
    <Badge variant={ok ? "default" : "destructive"} className="gap-1">
      {ok ? <CheckCircle2 className="size-3" /> : <AlertTriangle className="size-3" />}
      {ok ? okText : badText}
    </Badge>
  )
}

function Step({
  icon: Icon,
  title,
  step,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>
  title: string
  step: number
  children: React.ReactNode
}) {
  return (
    <div className="rounded-lg border p-3">
      <div className="mb-2 flex items-center gap-2">
        <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted">
          <Icon className="size-3.5 text-muted-foreground" />
        </span>
        <span className="text-sm font-medium">
          <span className="mr-1 text-muted-foreground">{step}.</span>
          {title}
        </span>
      </div>
      {children}
    </div>
  )
}

function Connector() {
  return (
    <div className="flex justify-center">
      <div className="h-4 w-px bg-border" />
    </div>
  )
}

function LineTable({
  rows,
  totalDebit,
  totalCredit,
}: {
  rows: { account: string; group: string; debit: number; credit: number }[]
  totalDebit: number
  totalCredit: number
}) {
  return (
    <div className="overflow-x-auto rounded-md border">
      <table className="w-full text-xs">
        <thead className="bg-muted/50 text-left text-muted-foreground">
          <tr>
            <th className="p-2 font-medium">Account</th>
            <th className="p-2 text-right font-medium">Debit</th>
            <th className="p-2 text-right font-medium">Credit</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((l, i) => (
            <tr key={i} className="border-t align-top">
              <td className="p-2">
                <div className="font-medium">{l.account || "—"}</div>
                <div className="text-muted-foreground">{l.group || ""}</div>
              </td>
              <td className="p-2 text-right tabular-nums">{l.debit ? inr(l.debit) : "—"}</td>
              <td className="p-2 text-right tabular-nums">{l.credit ? inr(l.credit) : "—"}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t bg-muted/30 font-medium">
            <td className="p-2">Totals</td>
            <td className="p-2 text-right tabular-nums">{inr(totalDebit)}</td>
            <td className="p-2 text-right tabular-nums">{inr(totalCredit)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  )
}
