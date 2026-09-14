"use client"

import useSWR from "swr"
import { useState } from "react"
import { fetcher } from "@/lib/fetcher"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { FileCheck2, Landmark, Download } from "lucide-react"
import { inr0 } from "@/lib/finance-calc"
import * as XLSX from "xlsx"

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
  invoices: {
    invoice_id: string
    invoice_date: string | null
    invoice_type: string
    client_name: string
    client_legal_name: string
    client_gstin: string
    gst_registration: string
    gst_type: string
    gst_rate: number
    project_name: string
    place_of_supply: string
    supply_type: string
    status: string
    taxable: number
    cgst: number
    sgst: number
    igst: number
    cess: number
    total: number
  }[]
  excluded?: { in_period: number; draft: number; cancelled: number; proforma: number }
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

  function exportExcel() {
    if (!s) return
    const wb = XLSX.utils.book_new()

    const summaryRows = [
      ["GSTR-1 Outward Supply Summary"],
      ["Tax period", s.period],
      ["Generated on", new Date().toLocaleString()],
      [],
      ["Documents", s.totals.invoice_count],
      ["Taxable value", s.totals.taxable],
      ["CGST", s.totals.cgst],
      ["SGST", s.totals.sgst],
      ["IGST", s.totals.igst],
      ["Cess", s.totals.cess],
      ["Total tax", s.totals.total_tax],
      ["Credit note taxable", s.totals.credit_note_taxable],
      ["Credit note tax reduced", s.totals.credit_note_tax],
    ]
    if (s.filing) {
      summaryRows.push([], ["Filing ID", s.filing.filing_id], ["Status", s.filing.status], ["ARN", s.filing.arn || "—"])
    }
    const wsSummary = XLSX.utils.aoa_to_sheet(summaryRows)
    wsSummary["!cols"] = [{ wch: 26 }, { wch: 22 }]
    XLSX.utils.book_append_sheet(wb, wsSummary, "Summary")

    const rateHeader = ["GST rate (%)", "Taxable", "CGST", "SGST", "IGST", "Cess"]
    const rateRows = s.rate_wise.map((r) => [r.rate, r.taxable, r.cgst, r.sgst, r.igst, r.cess])
    const wsRate = XLSX.utils.aoa_to_sheet([rateHeader, ...rateRows])
    wsRate["!cols"] = [{ wch: 12 }, { wch: 16 }, { wch: 14 }, { wch: 14 }, { wch: 14 }, { wch: 14 }]
    XLSX.utils.book_append_sheet(wb, wsRate, "Rate-wise")

    if (s.supply_split?.length) {
      const supplyHeader = ["Supply type", "Taxable", "Tax"]
      const supplyRows = s.supply_split.map((r) => [r.supply_type, r.taxable, r.tax])
      const wsSupply = XLSX.utils.aoa_to_sheet([supplyHeader, ...supplyRows])
      wsSupply["!cols"] = [{ wch: 24 }, { wch: 16 }, { wch: 16 }]
      XLSX.utils.book_append_sheet(wb, wsSupply, "Supply split")
    }

    if (s.invoices?.length) {
      const invHeader = [
        "Invoice #", "Date", "Type", "Client", "Legal name", "Client GSTIN", "GST registration",
        "GST type", "GST %", "Place of supply", "Status", "Taxable", "CGST", "SGST", "IGST", "Cess", "Total",
      ]
      const invRows = s.invoices.map((r) => [
        r.invoice_id, r.invoice_date ? r.invoice_date.slice(0, 10) : "", r.invoice_type,
        r.client_name, r.client_legal_name, r.client_gstin || "Unregistered", r.gst_registration,
        r.gst_type, `${r.gst_rate}%`, r.place_of_supply, r.status,
        r.taxable, r.cgst, r.sgst, r.igst, r.cess, r.total,
      ])
      const wsInv = XLSX.utils.aoa_to_sheet([invHeader, ...invRows])
      wsInv["!cols"] = [
        { wch: 16 }, { wch: 12 }, { wch: 14 }, { wch: 24 }, { wch: 24 }, { wch: 18 }, { wch: 14 },
        { wch: 12 }, { wch: 8 }, { wch: 18 }, { wch: 10 }, { wch: 14 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 10 }, { wch: 14 },
      ]
      XLSX.utils.book_append_sheet(wb, wsInv, "Invoices")
    }

    XLSX.writeFile(wb, `GSTR-1_${s.period}.xlsx`)
  }

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
            GSTR-1 outward-supply summary auto-derived from every non-Draft sales invoice in the period.
          </p>
        </div>
        <div className="flex items-end gap-2">
          <div className="flex flex-col gap-1">
            <label className="text-xs text-muted-foreground" htmlFor="period">
              Tax period
            </label>
            <Input id="period" type="month" value={period} onChange={(e) => setPeriod(e.target.value)} className="w-40" />
          </div>
          <Button
            variant="outline"
            onClick={exportExcel}
            disabled={!s || s.totals.invoice_count === 0}
            className="gap-2"
          >
            <Download className="h-4 w-4" />
            Export Excel
          </Button>
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
                    <div>No taxable supplies in this period.</div>
                    {s?.excluded ? <ExclusionHint excluded={s.excluded} /> : null}
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
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-base">Invoices in {period}</CardTitle>
          <Badge variant="secondary">{s?.invoices?.length ?? 0} document{(s?.invoices?.length ?? 0) === 1 ? "" : "s"}</Badge>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Invoice</TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead>Client / Legal name</TableHead>
                  <TableHead>Client GSTIN</TableHead>
                  <TableHead>GST type</TableHead>
                  <TableHead className="text-right">GST %</TableHead>
                  <TableHead>Place of supply</TableHead>
                  <TableHead className="text-right">Taxable</TableHead>
                  <TableHead className="text-right">CGST</TableHead>
                  <TableHead className="text-right">SGST</TableHead>
                  <TableHead className="text-right">IGST</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {!s || s.invoices.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={12} className="py-8 text-center text-sm text-muted-foreground">
                      <div>No invoices included for this period.</div>
                      {s?.excluded ? <ExclusionHint excluded={s.excluded} /> : null}
                    </TableCell>
                  </TableRow>
                ) : (
                  s.invoices.map((inv) => (
                    <TableRow key={inv.invoice_id}>
                      <TableCell>
                        <div className="font-mono text-xs">{inv.invoice_id}</div>
                        <div className="text-xs text-muted-foreground">{inv.invoice_type}</div>
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-sm">
                        {inv.invoice_date ? inv.invoice_date.slice(0, 10) : "—"}
                      </TableCell>
                      <TableCell>
                        <div className="text-sm">{inv.client_name}</div>
                        {inv.client_legal_name && inv.client_legal_name !== inv.client_name ? (
                          <div className="text-xs text-muted-foreground">{inv.client_legal_name}</div>
                        ) : null}
                        {inv.project_name ? (
                          <div className="text-xs text-muted-foreground">{inv.project_name}</div>
                        ) : null}
                      </TableCell>
                      <TableCell>
                        {inv.client_gstin ? (
                          <span className="font-mono text-xs">{inv.client_gstin}</span>
                        ) : (
                          <Badge variant="outline" className="text-xs">Unregistered</Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">{inv.gst_type}</TableCell>
                      <TableCell className="text-right text-sm">{inv.gst_rate}%</TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {inv.place_of_supply || inv.supply_type}
                      </TableCell>
                      <TableCell className="text-right">{currency(inv.taxable)}</TableCell>
                      <TableCell className="text-right">{currency(inv.cgst)}</TableCell>
                      <TableCell className="text-right">{currency(inv.sgst)}</TableCell>
                      <TableCell className="text-right">{currency(inv.igst)}</TableCell>
                      <TableCell className="text-right font-medium">{currency(inv.total)}</TableCell>
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

function ExclusionHint({
  excluded,
}: {
  excluded: { in_period: number; draft: number; cancelled: number; proforma: number }
}) {
  if (excluded.in_period === 0) {
    return (
      <div className="mt-2 text-xs">
        No sales invoices are dated in this period. Check the invoice date matches the tax period above.
      </div>
    )
  }
  const parts: string[] = []
  if (excluded.draft > 0) parts.push(`${excluded.draft} in Draft`)
  if (excluded.cancelled > 0) parts.push(`${excluded.cancelled} Cancelled`)
  if (excluded.proforma > 0) parts.push(`${excluded.proforma} Proforma`)
  return (
    <div className="mt-2 text-xs">
      {excluded.in_period} invoice{excluded.in_period === 1 ? "" : "s"} dated in this period
      {parts.length ? ` — ${parts.join(", ")}` : ""}. Every invoice that is not Draft or Cancelled appears in GSTR-1
      automatically (even with ₹0 GST), so move a Draft invoice out of Draft to include it.
    </div>
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
