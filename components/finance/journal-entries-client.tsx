"use client"

import { Fragment, useMemo, useState } from "react"
import useSWR from "swr"
import { fetcher } from "@/lib/fetcher"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent } from "@/components/ui/card"
import { ExcelExportButton } from "@/components/excel-export-button"
import { ManualJournalDialog } from "@/components/finance/manual-journal-dialog"
import { inr, inr0 } from "@/lib/finance-calc"
import {
  Plus, FilterX, Trash2, ChevronRight, ChevronDown, Lock, Coins, Wallet, ArrowLeftRight, BookOpen,
} from "lucide-react"

type Row = Record<string, any>

type JournalGroup = {
  voucherNo: string
  journalDate: string
  voucherType: string
  narration: string
  sourceModule: string
  referenceNo: string
  financialYear: string
  isManual: boolean
  totalDebit: number
  totalCredit: number
  lines: Row[]
}

const num = (v: any) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100

// Fall back to the per-line journal_entry_id when a legacy row has no voucher_no
// so ungrouped historical lines still each appear as their own single voucher.
const groupKeyOf = (row: Row) => String(row.voucher_no || row.journal_entry_id || row.id)

function buildGroups(rows: Row[]): JournalGroup[] {
  const map = new Map<string, JournalGroup>()
  for (const row of rows) {
    const key = groupKeyOf(row)
    let g = map.get(key)
    if (!g) {
      g = {
        voucherNo: key,
        journalDate: String(row.journal_date ?? ""),
        voucherType: String(row.voucher_type ?? "Journal"),
        narration: String(row.narration ?? ""),
        sourceModule: String(row.source_module ?? "Manual"),
        referenceNo: String(row.reference_no ?? ""),
        financialYear: String(row.financial_year ?? ""),
        isManual: String(row.source_module ?? "Manual") === "Manual",
        totalDebit: 0,
        totalCredit: 0,
        lines: [],
      }
      map.set(key, g)
    }
    g.totalDebit = round2(g.totalDebit + num(row.debit))
    g.totalCredit = round2(g.totalCredit + num(row.credit))
    g.lines.push(row)
  }
  return Array.from(map.values())
}

export function JournalEntriesClient() {
  const [search, setSearch] = useState("")
  const [financialYear, setFinancialYear] = useState("")
  const [sourceFilter, setSourceFilter] = useState<"all" | "manual" | "system">("all")
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [dialogOpen, setDialogOpen] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  const queryKey = useMemo(() => {
    const params = new URLSearchParams()
    if (search) params.set("search", search)
    if (financialYear) params.set("financial_year", financialYear)
    return `/api/finance/module/journal-entries?${params.toString()}`
  }, [search, financialYear])

  const { data, mutate } = useSWR<{ rows: Row[]; summary: any; filterOptions: any }>(queryKey, fetcher)

  const rows = data?.rows ?? []
  const summary = data?.summary ?? {}
  const financialYears: string[] = data?.filterOptions?.financialYears ?? []

  const groups = useMemo(() => {
    const all = buildGroups(rows)
    const filtered =
      sourceFilter === "all" ? all : sourceFilter === "manual" ? all.filter((g) => g.isManual) : all.filter((g) => !g.isManual)
    return filtered.sort((a, b) => (a.journalDate < b.journalDate ? 1 : a.journalDate > b.journalDate ? -1 : b.voucherNo.localeCompare(a.voucherNo)))
  }, [rows, sourceFilter])

  const activeFilterCount = [search, financialYear, sourceFilter !== "all" ? sourceFilter : ""].filter(Boolean).length

  function toggle(key: string) {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  async function removeJournal(group: JournalGroup) {
    if (!group.isManual) return
    if (!confirm(`Delete manual journal ${group.voucherNo}? This reverses it out of the ledger and cannot be undone.`)) return
    setDeletingId(group.voucherNo)
    try {
      const res = await fetch(`/api/finance/journal-entries/manual?journal_id=${encodeURIComponent(group.voucherNo)}`, {
        method: "DELETE",
      })
      if (!res.ok) {
        const json = await res.json().catch(() => ({}))
        alert(json.error || "Could not delete the journal.")
        return
      }
      mutate()
    } finally {
      setDeletingId(null)
    }
  }

  const journalCount = groups.length

  const kpis = [
    { label: "Total Debit", value: inr0(summary.total_debit), icon: Coins },
    { label: "Total Credit", value: inr0(summary.total_credit), icon: Wallet },
    { label: "Net Amount", value: inr0(round2(num(summary.total_debit) - num(summary.total_credit))), icon: ArrowLeftRight },
    { label: "Journals", value: journalCount, icon: BookOpen },
  ]

  return (
    <main className="space-y-8 p-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-sm text-muted-foreground">Finance management</p>
          <h1 className="text-3xl font-semibold tracking-tight text-balance">Journal Entries</h1>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ExcelExportButton
            rows={rows}
            filename="journal-entries"
            columns={[
              { header: "Journal", value: (r: Row) => r.voucher_no || r.journal_entry_id },
              { header: "Date", value: (r: Row) => r.journal_date },
              { header: "Account", value: (r: Row) => r.account_name },
              { header: "Account group", value: (r: Row) => r.account_group },
              { header: "Voucher", value: (r: Row) => r.voucher_type },
              { header: "Debit", value: (r: Row) => r.debit },
              { header: "Credit", value: (r: Row) => r.credit },
              { header: "Source", value: (r: Row) => r.source_module },
              { header: "Narration", value: (r: Row) => r.narration },
            ]}
          />
          <Button onClick={() => setDialogOpen(true)}>
            <Plus data-icon="inline-start" />
            New manual journal
          </Button>
        </div>
      </div>

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

      <Card>
        <CardContent className="grid gap-3 pt-6 sm:grid-cols-2 lg:grid-cols-4">
          <Input
            placeholder="Search journal, account, party, narration..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="lg:col-span-2"
          />
          <select
            className="h-10 rounded-md border bg-background px-3 text-sm"
            aria-label="Financial year"
            value={financialYear}
            onChange={(e) => setFinancialYear(e.target.value)}
          >
            <option value="">All financial years</option>
            {financialYears.map((fy) => (
              <option key={fy} value={fy}>
                {fy}
              </option>
            ))}
          </select>
          <select
            className="h-10 rounded-md border bg-background px-3 text-sm"
            aria-label="Source"
            value={sourceFilter}
            onChange={(e) => setSourceFilter(e.target.value as "all" | "manual" | "system")}
          >
            <option value="all">All sources</option>
            <option value="manual">Manual journals</option>
            <option value="system">System postings</option>
          </select>
          {activeFilterCount > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="justify-self-start"
              onClick={() => {
                setSearch("")
                setFinancialYear("")
                setSourceFilter("all")
              }}
            >
              <FilterX data-icon="inline-start" />
              Clear filters ({activeFilterCount})
            </Button>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-6">
          <div className="mb-3 flex items-center justify-between">
            <span className="text-sm font-medium">Journals</span>
            <Badge variant="secondary">{journalCount} vouchers</Badge>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  <th className="w-8 p-2" />
                  <th className="p-2 font-medium">Journal Entry ID</th>
                  <th className="p-2 font-medium">Date</th>
                  <th className="p-2 font-medium">Voucher</th>
                  <th className="p-2 font-medium">Narration</th>
                  <th className="p-2 font-medium">Source</th>
                  <th className="p-2 text-right font-medium">Debit</th>
                  <th className="p-2 text-right font-medium">Credit</th>
                  <th className="p-2 text-right font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {groups.length === 0 && (
                  <tr>
                    <td colSpan={9} className="p-6 text-center text-muted-foreground">
                      No journals match the current filters.
                    </td>
                  </tr>
                )}
                {groups.map((g) => {
                  const isOpen = expanded.has(g.voucherNo)
                  return (
                    <Fragment key={g.voucherNo}>
                      <tr className="border-b hover:bg-muted/40">
                        <td className="p-2">
                          <button
                            type="button"
                            aria-label={isOpen ? "Collapse lines" : "Expand lines"}
                            onClick={() => toggle(g.voucherNo)}
                            className="rounded p-1 hover:bg-muted"
                          >
                            {isOpen ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
                          </button>
                        </td>
                        <td className="p-2 font-mono text-xs">{g.voucherNo}</td>
                        <td className="p-2">{g.journalDate || "—"}</td>
                        <td className="p-2">{g.voucherType}</td>
                        <td className="p-2 max-w-[18rem] truncate" title={g.narration}>
                          {g.narration || "—"}
                        </td>
                        <td className="p-2">
                          <Badge variant={g.isManual ? "outline" : "secondary"}>{g.sourceModule}</Badge>
                        </td>
                        <td className="p-2 text-right tabular-nums">{inr(g.totalDebit)}</td>
                        <td className="p-2 text-right tabular-nums">{inr(g.totalCredit)}</td>
                        <td className="p-2">
                          <div className="flex items-center justify-end">
                            {g.isManual ? (
                              <Button
                                variant="ghost"
                                size="icon"
                                aria-label="Delete manual journal"
                                disabled={deletingId === g.voucherNo}
                                onClick={() => removeJournal(g)}
                              >
                                <Trash2 className="size-4" />
                              </Button>
                            ) : (
                              <span
                                className="inline-flex items-center gap-1 text-xs text-muted-foreground"
                                title="System posting — reverse it through its source document"
                              >
                                <Lock className="size-3.5" />
                              </span>
                            )}
                          </div>
                        </td>
                      </tr>
                      {isOpen && (
                        <tr className="border-b bg-muted/20">
                          <td />
                          <td colSpan={8} className="p-2">
                            <table className="w-full text-xs">
                              <thead>
                                <tr className="text-left text-muted-foreground">
                                  <th className="p-1.5 font-medium">Account</th>
                                  <th className="p-1.5 font-medium">Group</th>
                                  <th className="p-1.5 font-medium">Party</th>
                                  <th className="p-1.5 font-medium">Line narration</th>
                                  <th className="p-1.5 text-right font-medium">Debit</th>
                                  <th className="p-1.5 text-right font-medium">Credit</th>
                                </tr>
                              </thead>
                              <tbody>
                                {g.lines.map((l) => (
                                  <tr key={l.id} className="border-t border-border/50">
                                    <td className="p-1.5">{l.account_name || "—"}</td>
                                    <td className="p-1.5 text-muted-foreground">{l.account_group || "—"}</td>
                                    <td className="p-1.5 text-muted-foreground">{l.party_name || "—"}</td>
                                    <td className="p-1.5 text-muted-foreground">{l.narration || "—"}</td>
                                    <td className="p-1.5 text-right tabular-nums">{num(l.debit) ? inr(l.debit) : "—"}</td>
                                    <td className="p-1.5 text-right tabular-nums">{num(l.credit) ? inr(l.credit) : "—"}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  )
                })}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      <ManualJournalDialog open={dialogOpen} onOpenChange={setDialogOpen} onSaved={() => mutate()} />
    </main>
  )
}
