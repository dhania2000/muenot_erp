"use client"

import useSWR from "swr"
import { useState } from "react"
import { fetcher } from "@/lib/fetcher"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { FileCheck2, Landmark, Users } from "lucide-react"
import { currency, thisMonth, DIRECTION_COPY, Stat, type Direction } from "./shared"

type Summary = {
  period: string
  totals: { invoice_count: number; total_base: number; total_tds: number }
  sections: { section: string; invoice_count: number; base: number; tds: number; avg_rate: number }[]
  filing: { filing_id: string; status: string; challan_no: string | null; filed_at: string | null } | null
}
type DetailRow = {
  source: string
  doc_id: string
  doc_ref: string
  doc_date: string
  party_name: string
  pan: string
  section: string
  base: number
  rate: number
  tds: number
}

const SOURCE_BADGE: Record<string, "default" | "secondary" | "outline"> = {
  "Purchase Bill": "default",
  Expense: "secondary",
  "Sales Invoice": "outline",
  "FTE Invoice": "default",
  "Freelance Invoice": "secondary",
}
const HAS_SOURCE: Record<Direction, boolean> = { receivable: false, payable: true, employee: true }
const HAS_PAN: Record<Direction, boolean> = { receivable: false, payable: true, employee: false }

export function FilingStage({ direction }: { direction: Direction }) {
  const [period, setPeriod] = useState(thisMonth())
  const [challan, setChallan] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const copy = DIRECTION_COPY[direction]

  const { data, mutate } = useSWR<{ summary: Summary; detail: DetailRow[] }>(
    `/api/finance/tds-filing?period=${period}&direction=${direction}`,
    fetcher,
  )
  const { data: filingsData, mutate: mutateFilings } = useSWR<{ filings: any[] }>(
    `/api/finance/tds-filing?direction=${direction}`,
    fetcher,
  )
  const s = data?.summary
  const detail = data?.detail ?? []
  const filings = filingsData?.filings ?? []

  async function file() {
    setBusy(true)
    setError("")
    try {
      const res = await fetch("/api/finance/tds-filing", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ period, challan_no: challan, direction }),
      })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error || "Filing failed")
      setChallan("")
      mutate()
      mutateFilings()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          Section-wise TDS derived from the source ledgers for a calendar month. Locking a month freezes its numbers.
        </p>
        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted-foreground" htmlFor="period">
            Tax period
          </label>
          <Input id="period" type="month" value={period} onChange={(e) => setPeriod(e.target.value)} className="w-40" />
        </div>
      </div>

      {error ? <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p> : null}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Stat label="Documents" value={String(s?.totals.invoice_count ?? 0)} />
        <Stat label="Base amount" value={currency(s?.totals.total_base)} />
        <Stat label="TDS" value={currency(s?.totals.total_tds)} />
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-2">
          <CardTitle className="text-base">
            {copy.label} · {period}
          </CardTitle>
          {s?.filing ? (
            <Badge variant="default" className="gap-1">
              <FileCheck2 className="h-3.5 w-3.5" />
              Filed · {s.filing.filing_id}
            </Badge>
          ) : (
            <div className="flex items-center gap-2">
              <Input
                placeholder="Challan no. (optional)"
                value={challan}
                onChange={(e) => setChallan(e.target.value)}
                className="h-9 w-40"
              />
              <Button onClick={file} disabled={busy || !s || s.totals.invoice_count === 0}>
                {busy ? "Filing…" : "Lock month"}
              </Button>
            </div>
          )}
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Section</TableHead>
                <TableHead className="text-right">Docs</TableHead>
                <TableHead className="text-right">Base</TableHead>
                <TableHead className="text-right">Avg rate</TableHead>
                <TableHead className="text-right">TDS</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {!s || s.sections.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="py-8 text-center text-sm text-muted-foreground">
                    No TDS entries in this period.
                  </TableCell>
                </TableRow>
              ) : (
                s.sections.map((r) => (
                  <TableRow key={r.section}>
                    <TableCell className="font-medium">{r.section}</TableCell>
                    <TableCell className="text-right">{r.invoice_count}</TableCell>
                    <TableCell className="text-right">{currency(r.base)}</TableCell>
                    <TableCell className="text-right">{r.avg_rate}%</TableCell>
                    <TableCell className="text-right font-medium">{currency(r.tds)}</TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Users className="h-4 w-4" />
            {copy.partyLabel}-wise detail
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Document</TableHead>
                  {HAS_SOURCE[direction] ? <TableHead>Source</TableHead> : null}
                  <TableHead>{copy.partyLabel}</TableHead>
                  {HAS_PAN[direction] ? <TableHead>PAN</TableHead> : null}
                  <TableHead>Section</TableHead>
                  <TableHead className="text-right">Base</TableHead>
                  <TableHead className="text-right">Rate</TableHead>
                  <TableHead className="text-right">TDS</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {detail.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={8} className="py-8 text-center text-sm text-muted-foreground">
                      No {copy.partyLabel.toLowerCase()} TDS entries in this period.
                    </TableCell>
                  </TableRow>
                ) : (
                  detail.map((r, i) => (
                    <TableRow key={`${r.doc_id}-${i}`}>
                      <TableCell>
                        <div className="font-mono text-xs">{r.doc_ref || r.doc_id}</div>
                        <div className="text-xs text-muted-foreground">{String(r.doc_date).slice(0, 10)}</div>
                      </TableCell>
                      {HAS_SOURCE[direction] ? (
                        <TableCell>
                          <Badge variant={SOURCE_BADGE[r.source] ?? "outline"}>{r.source}</Badge>
                        </TableCell>
                      ) : null}
                      <TableCell className="font-medium">{r.party_name}</TableCell>
                      {HAS_PAN[direction] ? (
                        <TableCell className="font-mono text-xs text-muted-foreground">{r.pan || "—"}</TableCell>
                      ) : null}
                      <TableCell>{r.section}</TableCell>
                      <TableCell className="text-right">{currency(r.base)}</TableCell>
                      <TableCell className="text-right">{r.rate}%</TableCell>
                      <TableCell className="text-right font-medium">{currency(r.tds)}</TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Landmark className="h-4 w-4" />
            Locked months
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Filing ID</TableHead>
                <TableHead>Period</TableHead>
                <TableHead className="text-right">Base</TableHead>
                <TableHead className="text-right">TDS</TableHead>
                <TableHead>Challan</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filings.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="py-8 text-center text-sm text-muted-foreground">
                    No months locked yet.
                  </TableCell>
                </TableRow>
              ) : (
                filings.map((f) => (
                  <TableRow key={f.id}>
                    <TableCell className="font-mono text-xs">{f.filing_id}</TableCell>
                    <TableCell>{f.period}</TableCell>
                    <TableCell className="text-right">{currency(f.total_base)}</TableCell>
                    <TableCell className="text-right">{currency(f.total_tds)}</TableCell>
                    <TableCell className="text-muted-foreground">{f.challan_no || "—"}</TableCell>
                    <TableCell>
                      <Badge variant="default">{f.status}</Badge>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}
