"use client"

import useSWR from "swr"
import { useState } from "react"
import { fetcher } from "@/lib/fetcher"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { FileCheck2, Landmark, Download, Layers, Scale, GitCompareArrows, History, Lock, ShieldCheck } from "lucide-react"
import { inr0 } from "@/lib/finance-calc"
import * as XLSX from "xlsx"

const currency = (n: any) => inr0(Number(n) || 0)
const thisMonth = () => new Date().toISOString().slice(0, 7)

type Summary = {
  period: string
  financial_year: string
  quarter: string
  liability: {
    output_gst: number
    input_gst: number
    rcm_liability: number
    itc_reversal: number
    net_liability: number
    tax_paid: number
    balance_payable: number
  }
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
    credit_note_count: number
    debit_note_taxable: number
    debit_note_tax: number
    debit_note_count: number
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
  sections: {
    key: string
    title: string
    description: string
    count: number
    taxable: number
    tax: number
    rows: Summary["invoices"]
  }[]
  gstr3b: {
    outward: {
      taxable: number
      cgst: number
      sgst: number
      igst: number
      cess: number
      credit_note_tax: number
      net_output_tax: number
    }
    rcm_liability: number
    itc: {
      eligible: number
      cgst: number
      sgst: number
      igst: number
      cess: number
      reversal: number
      net: number
    }
    net_tax_payable: number
  }
  excluded?: { in_period: number; draft: number; cancelled: number; proforma: number }
  workflow: {
    status: string
    locked: boolean
    actions: string[]
    amendment_count: number
  }
  nil: { eligible: boolean; reasons: string[] }
  filing: {
    filing_id: string
    status: string
    return_type?: string
    arn: string | null
    filed_at: string | null
    filed_by_name?: string | null
    is_nil?: boolean
    total_itc?: number
    net_liability?: number
  } | null
}

// Reconciliation payloads (Phase 17–19).
type ReconStatus = "Matched" | "Mismatch" | "Missing" | "Extra" | "Pending"
type ReconcileData = {
  output: {
    period: string
    filed: boolean
    status_label: string
    counts: { matched: number; mismatch: number; missing: number; extra: number; pending: number }
    totals: { books_taxable: number; books_tax: number; filed_taxable: number; filed_tax: number }
    rows: {
      invoice_id: string
      invoice_number: string
      client_name: string
      books_taxable: number | null
      books_tax: number | null
      filed_taxable: number | null
      filed_tax: number | null
      status: ReconStatus
    }[]
  }
  center: {
    period: string
    financial_year: string
    filed: boolean
    headline: {
      sales_taxable: number
      sales_tax: number
      itc: number
      net_liability: number
      paid: number
      gstr2b_tax: number
    }
    lines: {
      key: string
      label: string
      left_label: string
      left: number
      right_label: string
      right: number
      status: ReconStatus
    }[]
  }
  amendments: {
    id: number
    filing_id: string
    revision: number
    previous_status: string
    previous_arn: string | null
    previous_total_taxable: number
    previous_total_tax: number
    reason: string | null
    amended_at: string
  }[]
}

const WORKFLOW_ACTIONS: Record<string, { label: string; variant?: "default" | "outline" | "secondary" | "destructive" }> = {
  prepare: { label: "Prepare draft", variant: "outline" },
  "submit-review": { label: "Submit for review", variant: "outline" },
  review: { label: "Mark reviewed", variant: "outline" },
  reopen: { label: "Reopen draft", variant: "secondary" },
  file: { label: "File GSTR-1", variant: "default" },
  "file-nil": { label: "File Nil return", variant: "outline" },
  amend: { label: "Amend return", variant: "secondary" },
  "mark-payment-pending": { label: "Mark payment pending", variant: "outline" },
  complete: { label: "Mark completed", variant: "default" },
}

function statusVariant(status: string): "default" | "outline" | "secondary" | "destructive" {
  switch (status) {
    case "Filed":
    case "Completed":
      return "default"
    case "Amended":
    case "Payment Pending":
      return "secondary"
    case "Not Prepared":
      return "outline"
    default:
      return "outline"
  }
}

export function GstFilingClient() {
  const [period, setPeriod] = useState(thisMonth())

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
      ["Financial year", s.financial_year],
      ["Quarter", s.quarter],
      ["Generated on", new Date().toLocaleString()],
      [],
      ["Documents", s.totals.invoice_count],
      ["Taxable value", s.totals.taxable],
      ["CGST", s.totals.cgst],
      ["SGST", s.totals.sgst],
      ["IGST", s.totals.igst],
      ["Cess", s.totals.cess],
      ["Total tax", s.totals.total_tax],
      ["Credit notes", s.totals.credit_note_count],
      ["Credit note taxable", s.totals.credit_note_taxable],
      ["Credit note tax reduced", s.totals.credit_note_tax],
      ["Debit notes", s.totals.debit_note_count],
      ["Debit note taxable", s.totals.debit_note_taxable],
      ["Debit note tax added", s.totals.debit_note_tax],
      [],
      ["GST LIABILITY"],
      ["Output GST (net of credit notes)", s.liability.output_gst],
      ["Input GST (net eligible ITC)", s.liability.input_gst],
      ["RCM liability", s.liability.rcm_liability],
      ["ITC reversal", s.liability.itc_reversal],
      ["Net GST liability", s.liability.net_liability],
      ["Tax paid", s.liability.tax_paid],
      ["Balance payable", s.liability.balance_payable],
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

    const g3bRows = [
      ["GSTR-3B (auto-computed)"],
      ["Tax period", s.period],
      [],
      ["3.1 Outward supplies"],
      ["Outward taxable supplies", s.gstr3b.outward.taxable],
      ["Output CGST", s.gstr3b.outward.cgst],
      ["Output SGST", s.gstr3b.outward.sgst],
      ["Output IGST", s.gstr3b.outward.igst],
      ["Output Cess", s.gstr3b.outward.cess],
      ["Less: credit note tax", s.gstr3b.outward.credit_note_tax],
      ["Net output tax", s.gstr3b.outward.net_output_tax],
      [],
      ["3.1(d) RCM liability", s.gstr3b.rcm_liability],
      [],
      ["4. Eligible ITC"],
      ["ITC — CGST", s.gstr3b.itc.cgst],
      ["ITC — SGST", s.gstr3b.itc.sgst],
      ["ITC — IGST", s.gstr3b.itc.igst],
      ["ITC — Cess", s.gstr3b.itc.cess],
      ["Less: ITC reversal", s.gstr3b.itc.reversal],
      ["Net ITC available", s.gstr3b.itc.net],
      [],
      ["Net GST payable", s.gstr3b.net_tax_payable],
    ]
    const wsG3b = XLSX.utils.aoa_to_sheet(g3bRows)
    wsG3b["!cols"] = [{ wch: 30 }, { wch: 18 }]
    XLSX.utils.book_append_sheet(wb, wsG3b, "GSTR-3B")

    XLSX.writeFile(wb, `GST_${s.period}.xlsx`)
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

      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Badge variant="outline" className="gap-1 font-normal">
          Tax period <span className="font-medium text-foreground">{s?.period ?? period}</span>
        </Badge>
        <Badge variant="outline" className="gap-1 font-normal">
          FY <span className="font-medium text-foreground">{s?.financial_year ?? "—"}</span>
        </Badge>
        <Badge variant="outline" className="gap-1 font-normal">
          Quarter <span className="font-medium text-foreground">{s?.quarter ?? "—"}</span>
        </Badge>
      </div>

      <section className="flex flex-col gap-2">
        <div className="text-sm font-medium">Return overview</div>
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <Stat label="Documents" value={String(s?.totals.invoice_count ?? 0)} />
          <Stat label="Taxable value" value={currency(s?.totals.taxable)} />
          <Stat label="Total tax" value={currency(s?.totals.total_tax)} />
          <Stat
            label="Credit notes"
            value={currency(s?.totals.credit_note_tax)}
            hint={`${s?.totals.credit_note_count ?? 0} note${(s?.totals.credit_note_count ?? 0) === 1 ? "" : "s"} · tax reduced`}
          />
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <div className="text-sm font-medium">GST liability</div>
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <Stat label="Output GST" value={currency(s?.liability.output_gst)} hint="net of credit notes" />
          <Stat label="Input GST (ITC)" value={currency(s?.liability.input_gst)} hint="net eligible credit" />
          <Stat label="RCM liability" value={currency(s?.liability.rcm_liability)} hint="reverse charge" />
          <Stat label="ITC reversal" value={currency(s?.liability.itc_reversal)} hint="credit reversed" />
          <Stat label="Net GST liability" value={currency(s?.liability.net_liability)} hint="output + RCM − ITC" emphasis />
          <Stat label="Debit notes" value={currency(s?.totals.debit_note_tax)} hint={`${s?.totals.debit_note_count ?? 0} note${(s?.totals.debit_note_count ?? 0) === 1 ? "" : "s"} · tax added`} />
          <Stat label="Tax paid" value={currency(s?.liability.tax_paid)} hint="cash-ledger challan" />
          <Stat
            label="Balance payable"
            value={currency(s?.liability.balance_payable)}
            hint={(s?.liability.balance_payable ?? 0) <= 0 ? "credit carried forward" : "still payable"}
            emphasis
          />
        </div>
        <RecordPayment
          period={period}
          current={s?.liability.tax_paid ?? 0}
          onSaved={() => mutate()}
        />
      </section>

      {s ? (
        <ReturnWorkflow
          period={period}
          summary={s}
          onChanged={() => {
            mutate()
            mutateFilings()
          }}
        />
      ) : null}

      <ReconciliationCenter period={period} />

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-base">Return for {period}</CardTitle>
          <StatusBadge status={s?.workflow.status ?? "Not Prepared"} nil={s?.filing?.is_nil} />
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
                        <NoteTypeBadge type={inv.invoice_type} />
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
            <Layers className="h-4 w-4" />
            GSTR-1 data sections
          </CardTitle>
        </CardHeader>
        <CardContent>
          {!s || (s.sections?.every((sec) => sec.count === 0) ?? true) ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              No outward documents to classify for this period.
            </p>
          ) : (
            <Tabs defaultValue={s.sections[0]?.key}>
              <TabsList className="flex-wrap">
                {s.sections.map((sec) => (
                  <TabsTrigger key={sec.key} value={sec.key} className="gap-1.5">
                    {sec.title}
                    <Badge variant="secondary" className="ml-1 px-1.5 py-0 text-[10px]">
                      {sec.count}
                    </Badge>
                  </TabsTrigger>
                ))}
              </TabsList>
              {s.sections.map((sec) => (
                <TabsContent key={sec.key} value={sec.key} className="mt-4">
                  <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                    <p className="text-xs text-muted-foreground">{sec.description}</p>
                    <div className="flex gap-4 text-sm">
                      <span className="text-muted-foreground">
                        Taxable <span className="font-medium text-foreground">{currency(sec.taxable)}</span>
                      </span>
                      <span className="text-muted-foreground">
                        Tax <span className="font-medium text-foreground">{currency(sec.tax)}</span>
                      </span>
                    </div>
                  </div>
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Invoice</TableHead>
                          <TableHead>Date</TableHead>
                          <TableHead>Client</TableHead>
                          <TableHead>GSTIN</TableHead>
                          <TableHead>Place of supply</TableHead>
                          <TableHead className="text-right">GST %</TableHead>
                          <TableHead className="text-right">Taxable</TableHead>
                          <TableHead className="text-right">CGST</TableHead>
                          <TableHead className="text-right">SGST</TableHead>
                          <TableHead className="text-right">IGST</TableHead>
                          <TableHead className="text-right">Cess</TableHead>
                          <TableHead className="text-right">Total</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {sec.rows.length === 0 ? (
                          <TableRow>
                            <TableCell colSpan={12} className="py-8 text-center text-sm text-muted-foreground">
                              No documents in this section.
                            </TableCell>
                          </TableRow>
                        ) : (
                          sec.rows.map((inv) => (
                            <TableRow key={inv.invoice_id}>
                              <TableCell className="font-mono text-xs">{inv.invoice_id}</TableCell>
                              <TableCell className="whitespace-nowrap text-sm">
                                {inv.invoice_date ? inv.invoice_date.slice(0, 10) : "—"}
                              </TableCell>
                              <TableCell className="text-sm">{inv.client_name}</TableCell>
                              <TableCell>
                                {inv.client_gstin ? (
                                  <span className="font-mono text-xs">{inv.client_gstin}</span>
                                ) : (
                                  <span className="text-xs text-muted-foreground">—</span>
                                )}
                              </TableCell>
                              <TableCell className="text-sm text-muted-foreground">
                                {inv.place_of_supply || inv.supply_type || "—"}
                              </TableCell>
                              <TableCell className="text-right text-sm">{inv.gst_rate}%</TableCell>
                              <TableCell className="text-right">{currency(inv.taxable)}</TableCell>
                              <TableCell className="text-right">{currency(inv.cgst)}</TableCell>
                              <TableCell className="text-right">{currency(inv.sgst)}</TableCell>
                              <TableCell className="text-right">{currency(inv.igst)}</TableCell>
                              <TableCell className="text-right">{currency(inv.cess)}</TableCell>
                              <TableCell className="text-right font-medium">{currency(inv.total)}</TableCell>
                            </TableRow>
                          ))
                        )}
                      </TableBody>
                    </Table>
                  </div>
                </TabsContent>
              ))}
            </Tabs>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-base">
            <Scale className="h-4 w-4" />
            GSTR-3B (auto-computed)
          </CardTitle>
          <Badge variant="outline" className="font-normal">Derived · no manual entry</Badge>
        </CardHeader>
        <CardContent className="grid gap-4 lg:grid-cols-3">
          <div className="rounded-md border">
            <div className="border-b bg-muted/40 px-3 py-2 text-sm font-medium">3.1 Outward supplies</div>
            <div className="flex flex-col divide-y text-sm">
              <Line label="Outward taxable supplies" value={currency(s?.gstr3b.outward.taxable)} />
              <Line label="Output CGST" value={currency(s?.gstr3b.outward.cgst)} />
              <Line label="Output SGST" value={currency(s?.gstr3b.outward.sgst)} />
              <Line label="Output IGST" value={currency(s?.gstr3b.outward.igst)} />
              <Line label="Output Cess" value={currency(s?.gstr3b.outward.cess)} />
              <Line label="Less: credit note tax" value={`(${currency(s?.gstr3b.outward.credit_note_tax)})`} />
              <Line label="Net output tax" value={currency(s?.gstr3b.outward.net_output_tax)} strong />
            </div>
          </div>
          <div className="rounded-md border">
            <div className="border-b bg-muted/40 px-3 py-2 text-sm font-medium">3.1(d) RCM liability</div>
            <div className="flex flex-col divide-y text-sm">
              <Line label="Inward supplies liable to RCM" value={currency(s?.gstr3b.rcm_liability)} />
              <div className="px-3 py-2 text-xs text-muted-foreground">
                Reverse-charge tax self-assessed on Purchase Bills / Expenses. Adds to output liability and is
                claimable as ITC below.
              </div>
            </div>
          </div>
          <div className="rounded-md border">
            <div className="border-b bg-muted/40 px-3 py-2 text-sm font-medium">4. Eligible ITC</div>
            <div className="flex flex-col divide-y text-sm">
              <Line label="ITC — CGST" value={currency(s?.gstr3b.itc.cgst)} />
              <Line label="ITC — SGST" value={currency(s?.gstr3b.itc.sgst)} />
              <Line label="ITC — IGST" value={currency(s?.gstr3b.itc.igst)} />
              <Line label="ITC — Cess" value={currency(s?.gstr3b.itc.cess)} />
              <Line label="Less: ITC reversal" value={`(${currency(s?.gstr3b.itc.reversal)})`} />
              <Line label="Net ITC available" value={currency(s?.gstr3b.itc.net)} strong />
            </div>
          </div>
          <div className="lg:col-span-3">
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-primary/40 bg-primary/5 px-4 py-3">
              <div className="text-sm text-muted-foreground">
                Net GST payable
                <span className="ml-2 text-xs">(net output tax + RCM − net ITC)</span>
              </div>
              <div className="text-xl font-semibold text-primary">{currency(s?.gstr3b.net_tax_payable)}</div>
            </div>
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

function NoteTypeBadge({ type }: { type: string }) {
  const t = String(type || "")
  if (t === "Credit Note") {
    return (
      <Badge variant="outline" className="mt-0.5 border-amber-500/40 text-amber-700 dark:text-amber-400">
        Credit Note
      </Badge>
    )
  }
  if (t === "Debit Note") {
    return (
      <Badge variant="outline" className="mt-0.5 border-sky-500/40 text-sky-700 dark:text-sky-400">
        Debit Note
      </Badge>
    )
  }
  return <div className="text-xs text-muted-foreground">{t || "Tax Invoice"}</div>
}

function Stat({
  label,
  value,
  hint,
  emphasis,
}: {
  label: string
  value: string
  hint?: string
  emphasis?: boolean
}) {
  return (
    <Card className={emphasis ? "border-primary/40 bg-primary/5" : undefined}>
      <CardContent className="flex flex-col gap-1 p-4">
        <div className="text-sm text-muted-foreground">{label}</div>
        <div className={`text-xl font-semibold${emphasis ? " text-primary" : ""}`}>{value}</div>
        {hint ? <div className="text-xs text-muted-foreground">{hint}</div> : null}
      </CardContent>
    </Card>
  )
}

function Line({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={`flex items-center justify-between px-3 py-2${strong ? " bg-muted/30" : ""}`}>
      <span className="text-muted-foreground">{label}</span>
      <span className={strong ? "font-semibold" : "font-medium"}>{value}</span>
    </div>
  )
}

function StatusBadge({ status, nil }: { status: string; nil?: boolean }) {
  const isFiled = status === "Filed" || status === "Completed"
  return (
    <Badge variant={statusVariant(status)} className="gap-1">
      {isFiled ? <FileCheck2 className="h-3.5 w-3.5" /> : null}
      {status}
      {nil ? " · Nil" : ""}
    </Badge>
  )
}

function ReconStatusBadge({ status }: { status: ReconStatus }) {
  const map: Record<ReconStatus, { variant: "default" | "outline" | "secondary" | "destructive"; className?: string }> = {
    Matched: { variant: "outline", className: "border-emerald-500/40 text-emerald-700 dark:text-emerald-400" },
    Mismatch: { variant: "outline", className: "border-red-500/40 text-red-700 dark:text-red-400" },
    Missing: { variant: "outline", className: "border-amber-500/40 text-amber-700 dark:text-amber-400" },
    Extra: { variant: "outline", className: "border-sky-500/40 text-sky-700 dark:text-sky-400" },
    Pending: { variant: "outline", className: "text-muted-foreground" },
  }
  const cfg = map[status]
  return <Badge variant={cfg.variant} className={cfg.className}>{status}</Badge>
}

/**
 * The controlled return lifecycle. Every transition is a server action — the UI
 * only renders the moves the engine currently permits (summary.workflow.actions),
 * so filing-lock and amendment rules stay enforced server-side, never bypassed here.
 */
function ReturnWorkflow({
  period,
  summary,
  onChanged,
}: {
  period: string
  summary: Summary
  onChanged: () => void
}) {
  const [arn, setArn] = useState("")
  const [reason, setReason] = useState("")
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState("")

  const wf = summary.workflow
  const actions = wf.actions ?? []
  const needsReason = actions.includes("amend")
  const canFile = actions.includes("file") || actions.includes("file-nil")

  async function run(action: string) {
    setBusy(action)
    setError("")
    try {
      const payload: Record<string, unknown> = { period }
      if (action === "file") {
        payload.action = "file"
        payload.arn = arn || null
      } else if (action === "file-nil") {
        payload.action = "file-nil"
        payload.arn = arn || null
      } else if (action === "amend") {
        if (!reason.trim()) throw new Error("An amendment reason is required")
        payload.action = "amend"
        payload.reason = reason.trim()
        payload.arn = arn || null
      } else {
        payload.action = "transition"
        payload.transition = action
        if (arn) payload.arn = arn
        if (reason.trim()) payload.reason = reason.trim()
      }
      const res = await fetch("/api/finance/gst-filing", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error || "Action failed")
      setArn("")
      setReason("")
      onChanged()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="flex items-center gap-2 text-base">
          <ShieldCheck className="h-4 w-4" />
          Return status &amp; workflow
        </CardTitle>
        <div className="flex items-center gap-2">
          {wf.locked ? (
            <Badge variant="outline" className="gap-1 font-normal text-muted-foreground">
              <Lock className="h-3.5 w-3.5" />
              Period locked
            </Badge>
          ) : null}
          {wf.amendment_count > 0 ? (
            <Badge variant="secondary" className="font-normal">Rev. {wf.amendment_count}</Badge>
          ) : null}
          <StatusBadge status={wf.status} nil={summary.filing?.is_nil} />
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
          <div>
            <div className="text-xs text-muted-foreground">Net liability</div>
            <div className="font-semibold">{currency(summary.liability.net_liability)}</div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">ITC claimed</div>
            <div className="font-semibold">{currency(summary.liability.input_gst)}</div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">Filing ID</div>
            <div className="font-mono text-xs">{summary.filing?.filing_id ?? "—"}</div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">ARN</div>
            <div className="font-mono text-xs">{summary.filing?.arn || "—"}</div>
          </div>
        </div>

        {summary.filing?.filed_at ? (
          <p className="text-xs text-muted-foreground">
            {summary.filing.is_nil ? "Nil return " : "Return "}
            filed on {summary.filing.filed_at.slice(0, 10)}
            {summary.filing.filed_by_name ? ` by ${summary.filing.filed_by_name}` : ""}.
            {wf.locked ? " Corrections must go through an amendment, which preserves the original snapshot." : ""}
          </p>
        ) : null}

        {summary.nil?.eligible && !summary.filing ? (
          <p className="rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">
            No taxable outward supplies this period — eligible to file a <span className="font-medium text-foreground">Nil return</span>.
          </p>
        ) : null}

        {canFile || needsReason ? (
          <div className="flex flex-wrap items-center gap-2">
            <Input
              placeholder="ARN (optional)"
              value={arn}
              onChange={(e) => setArn(e.target.value)}
              className="h-9 w-48"
            />
            {needsReason ? (
              <Input
                placeholder="Amendment reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                className="h-9 w-64"
              />
            ) : null}
          </div>
        ) : null}

        {actions.length === 0 ? (
          <p className="text-sm text-muted-foreground">No further actions available for this period.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {actions.map((a) => {
              const meta = WORKFLOW_ACTIONS[a] ?? { label: a, variant: "outline" as const }
              const disableFile = (a === "file") && summary.totals.invoice_count === 0
              return (
                <Button
                  key={a}
                  variant={meta.variant}
                  size="sm"
                  disabled={busy !== null || disableFile}
                  onClick={() => run(a)}
                >
                  {busy === a ? "Working…" : meta.label}
                </Button>
              )
            })}
          </div>
        )}

        {error ? <p className="text-sm text-destructive">{error}</p> : null}
      </CardContent>
    </Card>
  )
}

/**
 * Reconciliation Center (Phase 17–19). Pulls the read-only cross-checks from the
 * engine: the multi-source period overview, then the invoice-level output match
 * of Sales Books vs the filed GSTR-1 snapshot, plus the amendment audit trail.
 */
function ReconciliationCenter({ period }: { period: string }) {
  const { data } = useSWR<ReconcileData>(
    `/api/finance/gst-filing?period=${period}&view=reconcile`,
    fetcher,
  )
  const center = data?.center
  const output = data?.output
  const amendments = data?.amendments ?? []

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <GitCompareArrows className="h-4 w-4" />
          Reconciliation center
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Reconciliation</TableHead>
                <TableHead>Source</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead>Counterpart</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead className="text-right">Difference</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {!center ? (
                <TableRow>
                  <TableCell colSpan={7} className="py-6 text-center text-sm text-muted-foreground">
                    Loading reconciliation…
                  </TableCell>
                </TableRow>
              ) : (
                center.lines.map((l) => (
                  <TableRow key={l.key}>
                    <TableCell className="text-sm font-medium">{l.label}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">{l.left_label}</TableCell>
                    <TableCell className="text-right">{currency(l.left)}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">{l.right_label}</TableCell>
                    <TableCell className="text-right">{currency(l.right)}</TableCell>
                    <TableCell className="text-right">{currency(Math.abs(l.left - l.right))}</TableCell>
                    <TableCell><ReconStatusBadge status={l.status} /></TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>

        <div>
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <div className="text-sm font-medium">Output GST — Sales Books vs filed GSTR-1</div>
            {output ? (
              output.filed ? (
                <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
                  <span>Matched <span className="font-medium text-foreground">{output.counts.matched}</span></span>
                  <span>Mismatch <span className="font-medium text-foreground">{output.counts.mismatch}</span></span>
                  <span>Missing <span className="font-medium text-foreground">{output.counts.missing}</span></span>
                  <span>Extra <span className="font-medium text-foreground">{output.counts.extra}</span></span>
                </div>
              ) : (
                <Badge variant="outline" className="font-normal text-muted-foreground">
                  Not filed — {output.counts.pending} document{output.counts.pending === 1 ? "" : "s"} pending
                </Badge>
              )
            ) : null}
          </div>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Invoice</TableHead>
                  <TableHead>Client</TableHead>
                  <TableHead className="text-right">Books taxable</TableHead>
                  <TableHead className="text-right">Books tax</TableHead>
                  <TableHead className="text-right">Filed taxable</TableHead>
                  <TableHead className="text-right">Filed tax</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {!output || output.rows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={7} className="py-6 text-center text-sm text-muted-foreground">
                      No outward documents to reconcile for this period.
                    </TableCell>
                  </TableRow>
                ) : (
                  output.rows.map((r) => (
                    <TableRow key={r.invoice_id}>
                      <TableCell className="font-mono text-xs">{r.invoice_number || r.invoice_id}</TableCell>
                      <TableCell className="text-sm">{r.client_name}</TableCell>
                      <TableCell className="text-right">{r.books_taxable == null ? "—" : currency(r.books_taxable)}</TableCell>
                      <TableCell className="text-right">{r.books_tax == null ? "—" : currency(r.books_tax)}</TableCell>
                      <TableCell className="text-right">{r.filed_taxable == null ? "—" : currency(r.filed_taxable)}</TableCell>
                      <TableCell className="text-right">{r.filed_tax == null ? "—" : currency(r.filed_tax)}</TableCell>
                      <TableCell><ReconStatusBadge status={r.status} /></TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </div>

        {amendments.length > 0 ? (
          <div>
            <div className="mb-2 flex items-center gap-2 text-sm font-medium">
              <History className="h-4 w-4" />
              Amendment history
            </div>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Revision</TableHead>
                    <TableHead>Prev. status</TableHead>
                    <TableHead>Prev. ARN</TableHead>
                    <TableHead className="text-right">Prev. taxable</TableHead>
                    <TableHead className="text-right">Prev. tax</TableHead>
                    <TableHead>Reason</TableHead>
                    <TableHead>When</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {amendments.map((a) => (
                    <TableRow key={a.id}>
                      <TableCell>Rev. {a.revision}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">{a.previous_status}</TableCell>
                      <TableCell className="font-mono text-xs">{a.previous_arn || "—"}</TableCell>
                      <TableCell className="text-right">{currency(a.previous_total_taxable)}</TableCell>
                      <TableCell className="text-right">{currency(a.previous_total_tax)}</TableCell>
                      <TableCell className="text-sm">{a.reason || "—"}</TableCell>
                      <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{a.amended_at?.slice(0, 10)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  )
}

function RecordPayment({
  period,
  current,
  onSaved,
}: {
  period: string
  current: number
  onSaved: () => void
}) {
  const [amount, setAmount] = useState<string>("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")

  async function save() {
    setBusy(true)
    setError("")
    try {
      const res = await fetch("/api/finance/gst-filing", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "record-payment", period, amount: Number(amount || 0) }),
      })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error || "Could not record payment")
      setAmount("")
      onSaved()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/30 px-3 py-2 text-sm">
      <span className="text-muted-foreground">Record GST paid for {period}:</span>
      <Input
        type="number"
        inputMode="decimal"
        min={0}
        step="0.01"
        placeholder={current ? String(current) : "0.00"}
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        className="h-8 w-40"
      />
      <Button size="sm" variant="outline" onClick={save} disabled={busy || amount === ""}>
        {busy ? "Saving…" : "Save"}
      </Button>
      {error ? <span className="text-destructive">{error}</span> : null}
    </div>
  )
}
