"use client"

import useSWR from "swr"
import { useState } from "react"
import { fetcher } from "@/lib/fetcher"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { FileCheck2, Landmark } from "lucide-react"
import { inr0 } from "@/lib/finance-calc"

const currency = (n: any) => inr0(Number(n) || 0)
const thisMonth = () => new Date().toISOString().slice(0, 7)

type Summary = {
  period: string
  totals: { invoice_count: number; total_base: number; total_tds: number }
  sections: { section: string; invoice_count: number; base: number; tds: number; avg_rate: number }[]
  filing: { filing_id: string; status: string; challan_no: string | null; filed_at: string | null } | null
}

export function TdsFilingClient() {
  const [period, setPeriod] = useState(thisMonth())
  const [challan, setChallan] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")

  const { data, mutate } = useSWR<{ summary: Summary }>(`/api/finance/tds-filing?period=${period}`, fetcher)
  const { data: filingsData, mutate: mutateFilings } = useSWR<{ filings: any[] }>("/api/finance/tds-filing", fetcher)
  const s = data?.summary
  const filings = filingsData?.filings ?? []

  async function file() {
    setBusy(true)
    setError("")
    try {
      const res = await fetch("/api/finance/tds-filing", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ period, challan_no: challan }),
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
    <main className="flex flex-col gap-6 p-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">TDS Filing</h1>
          <p className="text-sm text-muted-foreground">
            Section-wise TDS deducted by customers, derived from posted sales invoices.
          </p>
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted-foreground" htmlFor="period">
            Tax period
          </label>
          <Input id="period" type="month" value={period} onChange={(e) => setPeriod(e.target.value)} className="w-40" />
        </div>
      </header>

      {error ? <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p> : null}

      <div className="grid grid-cols-3 gap-4">
        <Stat label="Documents" value={String(s?.totals.invoice_count ?? 0)} />
        <Stat label="Base amount" value={currency(s?.totals.total_base)} />
        <Stat label="TDS deducted" value={currency(s?.totals.total_tds)} />
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-base">Return for {period}</CardTitle>
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
                className="h-9 w-48"
              />
              <Button onClick={file} disabled={busy || !s || s.totals.invoice_count === 0}>
                {busy ? "Filing…" : "File TDS return"}
              </Button>
            </div>
          )}
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Section</TableHead>
                <TableHead className="text-right">Documents</TableHead>
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
            <Landmark className="h-4 w-4" />
            Filing history
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
                    No returns filed yet.
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
    </main>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <CardContent className="flex flex-col gap-1 p-4">
        <div className="text-sm text-muted-foreground">{label}</div>
        <div className="text-xl font-semibold">{value}</div>
      </CardContent>
    </Card>
  )
}
