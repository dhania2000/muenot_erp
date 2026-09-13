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
  totals: {
    invoice_count: number
    taxable: number
    cgst: number
    sgst: number
    igst: number
    cess: number
    total_tax: number
    credit_note_taxable: number
    credit_note_tax: number
  }
  rate_wise: { rate: number; taxable: number; cgst: number; sgst: number; igst: number; cess: number }[]
  supply_split: { supply_type: string; taxable: number; tax: number }[]
  filing: { filing_id: string; status: string; arn: string | null; filed_at: string | null } | null
}

export function GstFilingClient() {
  const [period, setPeriod] = useState(thisMonth())
  const [arn, setArn] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")

  const { data, mutate } = useSWR<{ summary: Summary }>(
    `/api/finance/gst-filing?period=${period}`,
    fetcher,
  )
  const { data: filingsData, mutate: mutateFilings } = useSWR<{ filings: any[] }>(
    "/api/finance/gst-filing",
    fetcher,
  )
  const s = data?.summary
  const filings = filingsData?.filings ?? []

  async function file() {
    setBusy(true)
    setError("")
    try {
      const res = await fetch("/api/finance/gst-filing", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ period, arn }),
      })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error || "Filing failed")
      setArn("")
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
          <h1 className="text-2xl font-semibold tracking-tight">GST Filing</h1>
          <p className="text-sm text-muted-foreground">
            GSTR-1 outward-supply summary derived from posted sales invoices.
          </p>
        </div>
        <div className="flex items-end gap-2">
          <div className="flex flex-col gap-1">
            <label className="text-xs text-muted-foreground" htmlFor="period">
              Tax period
            </label>
            <Input id="period" type="month" value={period} onChange={(e) => setPeriod(e.target.value)} className="w-40" />
          </div>
        </div>
      </header>

      {error ? <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p> : null}

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Documents" value={String(s?.totals.invoice_count ?? 0)} />
        <Stat label="Taxable value" value={currency(s?.totals.taxable)} />
        <Stat label="Total tax" value={currency(s?.totals.total_tax)} />
        <Stat label="Credit notes" value={currency(s?.totals.credit_note_tax)} hint="tax reduced" />
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
                placeholder="ARN (optional)"
                value={arn}
                onChange={(e) => setArn(e.target.value)}
                className="h-9 w-48"
              />
              <Button onClick={file} disabled={busy || !s || s.totals.invoice_count === 0}>
                {busy ? "Filing…" : "File GSTR-1"}
              </Button>
            </div>
          )}
        </CardHeader>
        <CardContent>
          <div className="mb-2 text-sm font-medium">Rate-wise breakup</div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>GST rate</TableHead>
                <TableHead className="text-right">Taxable</TableHead>
                <TableHead className="text-right">CGST</TableHead>
                <TableHead className="text-right">SGST</TableHead>
                <TableHead className="text-right">IGST</TableHead>
                <TableHead className="text-right">Cess</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {!s || s.rate_wise.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="py-8 text-center text-sm text-muted-foreground">
                    No taxable supplies in this period.
                  </TableCell>
                </TableRow>
              ) : (
                s.rate_wise.map((r) => (
                  <TableRow key={r.rate}>
                    <TableCell>{r.rate}%</TableCell>
                    <TableCell className="text-right">{currency(r.taxable)}</TableCell>
                    <TableCell className="text-right">{currency(r.cgst)}</TableCell>
                    <TableCell className="text-right">{currency(r.sgst)}</TableCell>
                    <TableCell className="text-right">{currency(r.igst)}</TableCell>
                    <TableCell className="text-right">{currency(r.cess)}</TableCell>
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
                <TableHead className="text-right">Taxable</TableHead>
                <TableHead className="text-right">Total tax</TableHead>
                <TableHead>ARN</TableHead>
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
                    <TableCell className="text-right">{currency(f.total_taxable)}</TableCell>
                    <TableCell className="text-right">{currency(f.total_tax)}</TableCell>
                    <TableCell className="text-muted-foreground">{f.arn || "—"}</TableCell>
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

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card>
      <CardContent className="flex flex-col gap-1 p-4">
        <div className="text-sm text-muted-foreground">{label}</div>
        <div className="text-xl font-semibold">{value}</div>
        {hint ? <div className="text-xs text-muted-foreground">{hint}</div> : null}
      </CardContent>
    </Card>
  )
}
