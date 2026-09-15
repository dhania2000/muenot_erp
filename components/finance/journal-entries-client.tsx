"use client"

import { Fragment, useMemo, useState } from "react"
import useSWR from "swr"
import { fetcher } from "@/lib/fetcher"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent } from "@/components/ui/card"
import { ExcelExportButton } from "@/components/excel-export-button"
import { ManualJournalDialog, type EditableJournal } from "@/components/finance/manual-journal-dialog"
import { inr, inr0 } from "@/lib/finance-calc"
import {
  Plus, FilterX, Trash2, ChevronRight, ChevronDown, Lock, Coins, Wallet, ArrowLeftRight, BookOpen,
  Send, Check, X, Pencil, Undo2, Ban,
} from "lucide-react"

type Row = Record<string, any>

type JournalGroup = {
  voucherNo: string
  journalDate: string
  voucherType: string
  narration: string
  referenceNo: string
  sourceModule: string
  financialYear: string
  isManual: boolean
  status: string
  postingStatus: string
  totalDebit: number
  totalCredit: number
  lines: Row[]
}

type BadgeVariant = "default" | "secondary" | "destructive" | "outline"

const STATUS_BADGE: Record<string, BadgeVariant> = {
  Draft: "outline",
  "Pending Approval": "secondary",
  Approved: "default",
  Posted: "default",
  Rejected: "destructive",
  Cancelled: "destructive",
  Reversed: "secondary",
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
        referenceNo: String(row.reference_no ?? ""),
        sourceModule: String(row.source_module ?? "Manual"),
        financialYear: String(row.financial_year ?? ""),
        isManual: String(row.source_module ?? "Manual") === "Manual",
        status: String(row.approval_status ?? ""),
        postingStatus: String(row.posting_status ?? ""),
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

/** Which workflow actions apply to a manual journal in a given status. */
function actionsFor(status: string): Array<"submit" | "approve" | "reject" | "post" | "cancel" | "reverse" | "edit" | "delete"> {
  switch (status) {
    case "Draft":
      return ["submit", "edit", "cancel", "delete"]
    case "Pending Approval":
      return ["approve", "reject", "edit", "cancel"]
    case "Rejected":
      return ["submit", "edit", "cancel", "delete"]
    case "Approved":
      return ["post", "cancel"]
    case "Posted":
      return ["reverse"]
    case "Cancelled":
      return ["delete"]
    default:
      return []
  }
}

export function JournalEntriesClient() {
  const [search, setSearch] = useState("")
  const [financialYear, setFinancialYear] = useState("")
  const [sourceFilter, setSourceFilter] = useState<"all" | "manual" | "system">("all")
  const [statusFilter, setStatusFilter] = useState("")
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editJournal, setEditJournal] = useState<EditableJournal | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

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
    const bySource =
      sourceFilter === "all" ? all : sourceFilter === "manual" ? all.filter((g) => g.isManual) : all.filter((g) => !g.isManual)
    const byStatus = statusFilter ? bySource.filter((g) => g.status === statusFilter) : bySource
    return byStatus.sort((a, b) => (a.journalDate < b.journalDate ? 1 : a.journalDate > b.journalDate ? -1 : b.voucherNo.localeCompare(a.voucherNo)))
  }, [rows, sourceFilter, statusFilter])

  const activeFilterCount = [search, financialYear, sourceFilter !== "all" ? sourceFilter : "", statusFilter].filter(Boolean).length

  function toggle(key: string) {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  async function runAction(
    group: JournalGroup,
    action: "submit" | "approve" | "reject" | "post" | "cancel" | "reverse",
  ) {
    if (!group.isManual) return
    const prompts: Record<string, string> = {
      submit: `Submit journal ${group.voucherNo} for approval?`,
      approve: `Approve journal ${group.voucherNo}?`,
      reject: `Reject journal ${group.voucherNo}?`,
      post: `Post journal ${group.voucherNo} to the general ledger? This makes it live in the books.`,
      cancel: `Cancel journal ${group.voucherNo}? It will not post to the ledger.`,
      reverse: `Reverse posted journal ${group.voucherNo}? A contra entry will unwind it from the ledger.`,
    }
    let reason: string | null = null
    if (action === "reject") {
      reason = window.prompt(`Reason for rejecting ${group.voucherNo} (optional):`, "") ?? ""
    } else if (!confirm(prompts[action])) {
      return
    }
    setBusyId(group.voucherNo)
    try {
      const res = await fetch("/api/finance/journal-entries/manual", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ journalId: group.voucherNo, action, reason }),
      })
      if (!res.ok) {
        const json = await res.json().catch(() => ({}))
        alert(json.error || `Could not ${action} the journal.`)
        return
      }
      mutate()
    } finally {
      setBusyId(null)
    }
  }

  async function removeJournal(group: JournalGroup) {
    if (!group.isManual) return
    if (!confirm(`Delete journal ${group.voucherNo}? This cannot be undone.`)) return
    setBusyId(group.voucherNo)
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
      setBusyId(null)
    }
  }

  function openEdit(group: JournalGroup) {
    setEditJournal({
      journalId: group.voucherNo,
      journalDate: group.journalDate,
      voucherType: group.voucherType,
      referenceNo: group.referenceNo,
      narration: group.narration,
      lines: group.lines.map((l) => ({
        accountId: String(l.account_id ?? ""),
        debit: num(l.debit),
        credit: num(l.credit),
        narration: String(l.narration ?? ""),
      })),
    })
    setDialogOpen(true)
  }

  function openNew() {
    setEditJournal(null)
    setDialogOpen(true)
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
              { header: "Status", value: (r: Row) => r.approval_status },
              { header: "Posting", value: (r: Row) => r.posting_status },
              { header: "Source", value: (r: Row) => r.source_module },
              { header: "Narration", value: (r: Row) => r.narration },
            ]}
          />
          <Button onClick={openNew}>
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
        <CardContent className="grid gap-3 pt-6 sm:grid-cols-2 lg:grid-cols-5">
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
            aria-label="Status"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
          >
            <option value="">All statuses</option>
            {["Draft", "Pending Approval", "Approved", "Posted", "Rejected", "Cancelled", "Reversed"].map((s) => (
              <option key={s} value={s}>
                {s}
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
                setStatusFilter("")
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
                  <th className="p-2 font-medium">Status</th>
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
                  const busy = busyId === g.voucherNo
                  const acts = g.isManual ? actionsFor(g.status) : []
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
                        <td className="p-2">
                          {g.status ? (
                            <Badge variant={STATUS_BADGE[g.status] ?? "outline"}>{g.status}</Badge>
                          ) : (
                            "—"
                          )}
                        </td>
                        <td className="p-2">
                          <Badge variant={g.isManual ? "outline" : "secondary"}>{g.sourceModule}</Badge>
                        </td>
                        <td className="p-2 text-right tabular-nums">{inr(g.totalDebit)}</td>
                        <td className="p-2 text-right tabular-nums">{inr(g.totalCredit)}</td>
                        <td className="p-2">
                          <div className="flex items-center justify-end gap-1">
                            {!g.isManual && (
                              <span
                                className="inline-flex items-center gap-1 text-xs text-muted-foreground"
                                title="System posting — reverse it through its source document"
                              >
                                <Lock className="size-3.5" />
                              </span>
                            )}
                            {acts.includes("submit") && (
                              <Button variant="ghost" size="icon" aria-label="Submit for approval" title="Submit for approval" disabled={busy} onClick={() => runAction(g, "submit")}>
                                <Send className="size-4" />
                              </Button>
                            )}
                            {acts.includes("approve") && (
                              <Button variant="ghost" size="icon" aria-label="Approve" title="Approve" disabled={busy} onClick={() => runAction(g, "approve")}>
                                <Check className="size-4 text-emerald-600" />
                              </Button>
                            )}
                            {acts.includes("reject") && (
                              <Button variant="ghost" size="icon" aria-label="Reject" title="Reject" disabled={busy} onClick={() => runAction(g, "reject")}>
                                <X className="size-4 text-destructive" />
                              </Button>
                            )}
                            {acts.includes("post") && (
                              <Button variant="ghost" size="icon" aria-label="Post to ledger" title="Post to general ledger" disabled={busy} onClick={() => runAction(g, "post")}>
                                <BookOpen className="size-4 text-primary" />
                              </Button>
                            )}
                            {acts.includes("reverse") && (
                              <Button variant="ghost" size="icon" aria-label="Reverse" title="Reverse posting" disabled={busy} onClick={() => runAction(g, "reverse")}>
                                <Undo2 className="size-4" />
                              </Button>
                            )}
                            {acts.includes("edit") && (
                              <Button variant="ghost" size="icon" aria-label="Edit" title="Edit journal" disabled={busy} onClick={() => openEdit(g)}>
                                <Pencil className="size-4" />
                              </Button>
                            )}
                            {acts.includes("cancel") && (
                              <Button variant="ghost" size="icon" aria-label="Cancel" title="Cancel journal" disabled={busy} onClick={() => runAction(g, "cancel")}>
                                <Ban className="size-4" />
                              </Button>
                            )}
                            {acts.includes("delete") && (
                              <Button variant="ghost" size="icon" aria-label="Delete" title="Delete journal" disabled={busy} onClick={() => removeJournal(g)}>
                                <Trash2 className="size-4" />
                              </Button>
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

      <ManualJournalDialog open={dialogOpen} onOpenChange={setDialogOpen} onSaved={() => mutate()} editJournal={editJournal} />
    </main>
  )
}
