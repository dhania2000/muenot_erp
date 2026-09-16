"use client"

import { useMemo, useState } from "react"
import useSWR from "swr"
import { fetcher } from "@/lib/fetcher"
import { inr, inr0 } from "@/lib/finance-calc"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ExcelExportButton } from "@/components/excel-export-button"
import { RefreshCw, ScanSearch, Users, Coins, ListChecks } from "lucide-react"
import type { BadgeVariant } from "@/lib/finance-schema"

type Row = {
  party_id: string
  related_party: string
  relationship: string
  matched_on: "PAN" | "GSTIN" | "Name"
  source: string
  reference: string
  txn_date: string | null
  amount: number
}

type Result = {
  rows: Row[]
  summary: {
    total_transactions: number
    total_amount: number
    related_parties_with_activity: number
    sources: { source: string; count: number; amount: number }[]
  }
  hasParties: boolean
}

const MATCH_BADGE: Record<Row["matched_on"], BadgeVariant> = {
  PAN: "default",
  GSTIN: "secondary",
  Name: "outline",
}

export function RelatedPartiesTransactions() {
  const { data, isValidating, mutate } = useSWR<Result>(
    "/api/finance/related-parties/transactions",
    fetcher,
    { revalidateOnFocus: true },
  )
  const [search, setSearch] = useState("")
  const [source, setSource] = useState("")

  const rows = data?.rows ?? []
  const summary = data?.summary
  const hasParties = data?.hasParties ?? true

  const sources = useMemo(
    () => Array.from(new Set(rows.map((r) => r.source))).sort(),
    [rows],
  )

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return rows.filter((r) => {
      if (source && r.source !== source) return false
      if (!q) return true
      return (
        r.related_party.toLowerCase().includes(q) ||
        r.relationship.toLowerCase().includes(q) ||
        r.reference.toLowerCase().includes(q)
      )
    })
  }, [rows, search, source])

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 rounded-md bg-primary/10 p-2 text-primary">
            <ScanSearch className="size-5" />
          </div>
          <div>
            <h2 className="text-xl font-semibold tracking-tight">Related-Party Transactions</h2>
            <p className="max-w-2xl text-sm text-muted-foreground">
              Automatically identified from existing Finance transactions — matched to the master
              above by PAN, GSTIN or name within each relationship&apos;s effective period. No manual
              entry: post the underlying transaction and it surfaces here.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <ExcelExportButton
            rows={filtered}
            filename="related-party-transactions"
            columns={[
              { header: "Related Party", value: (r: Row) => r.related_party },
              { header: "Relationship", value: (r: Row) => r.relationship },
              { header: "Matched On", value: (r: Row) => r.matched_on },
              { header: "Source", value: (r: Row) => r.source },
              { header: "Reference", value: (r: Row) => r.reference },
              { header: "Date", value: (r: Row) => r.txn_date ?? "" },
              { header: "Amount", value: (r: Row) => r.amount },
            ]}
          />
          <Button variant="ghost" size="icon" aria-label="Rescan transactions" onClick={() => mutate()}>
            <RefreshCw className={isValidating ? "animate-spin" : ""} />
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Kpi icon={ListChecks} label="Transactions identified" value={String(summary?.total_transactions ?? 0)} />
        <Kpi icon={Coins} label="Total value" value={inr0(summary?.total_amount ?? 0)} />
        <Kpi icon={Users} label="Related parties with activity" value={String(summary?.related_parties_with_activity ?? 0)} />
      </div>

      {summary && summary.sources.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {summary.sources.map((s) => (
            <Badge key={s.source} variant="secondary" className="gap-1.5 font-normal">
              {s.source}
              <span className="tabular-nums text-muted-foreground">
                · {s.count} · {inr0(s.amount)}
              </span>
            </Badge>
          ))}
        </div>
      )}

      <Card>
        <CardContent className="pt-6">
          <div className="mb-3 grid gap-3 sm:grid-cols-3">
            <Input
              placeholder="Search party, relationship or reference..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="sm:col-span-2"
            />
            <select
              className="h-10 rounded-md border bg-background px-3 text-sm"
              aria-label="Source"
              value={source}
              onChange={(e) => setSource(e.target.value)}
            >
              <option value="">All sources</option>
              {sources.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  <th className="p-2 font-medium">Related Party</th>
                  <th className="p-2 font-medium">Relationship</th>
                  <th className="p-2 font-medium">Matched On</th>
                  <th className="p-2 font-medium">Source</th>
                  <th className="p-2 font-medium">Reference</th>
                  <th className="p-2 font-medium">Date</th>
                  <th className="p-2 text-right font-medium">Amount</th>
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="p-6 text-center text-muted-foreground">
                      {!hasParties
                        ? "Add an Active related party above — matching transactions will be identified automatically."
                        : rows.length === 0
                          ? "No related-party transactions found in existing Finance records yet."
                          : "No transactions match the current filters."}
                    </td>
                  </tr>
                ) : (
                  filtered.map((r, i) => (
                    <tr key={`${r.source}-${r.reference}-${i}`} className="border-b hover:bg-muted/40">
                      <td className="p-2 font-medium">{r.related_party}</td>
                      <td className="p-2">{r.relationship}</td>
                      <td className="p-2">
                        <Badge variant={MATCH_BADGE[r.matched_on]}>{r.matched_on}</Badge>
                      </td>
                      <td className="p-2">{r.source}</td>
                      <td className="p-2 font-mono text-xs">{r.reference}</td>
                      <td className="p-2">{r.txn_date ?? "—"}</td>
                      <td className="p-2 text-right tabular-nums">{inr(r.amount)}</td>
                    </tr>
                  ))
                )}
              </tbody>
              {filtered.length > 0 && (
                <tfoot>
                  <tr className="border-t font-semibold">
                    <td className="p-2" colSpan={6}>
                      Total ({filtered.length} transactions)
                    </td>
                    <td className="p-2 text-right tabular-nums">
                      {inr(filtered.reduce((sum, r) => sum + r.amount, 0))}
                    </td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        </CardContent>
      </Card>
    </section>
  )
}

function Kpi({
  icon: Icon,
  label,
  value,
}: {
  icon: React.ComponentType<{ className?: string }>
  label: string
  value: string
}) {
  return (
    <Card>
      <CardContent className="flex flex-col gap-2 pt-6">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-muted-foreground">{label}</span>
          <Icon className="size-4 text-muted-foreground" />
        </div>
        <span className="text-xl font-semibold tracking-tight">{value}</span>
      </CardContent>
    </Card>
  )
}
