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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  FileCheck2,
  Landmark,
  Download,
  Layers,
  Scale,
  GitCompareArrows,
  History,
  Lock,
  ShieldCheck,
  AlertTriangle,
  Table2,
  CalendarRange,
  Users,
  Truck,
  Percent,
  Split,
  FileMinus2,
  CheckCircle2,
  XCircle,
  Search,
  ClipboardCheck,
  FileSpreadsheet,
  Wallet,
} from "lucide-react"
import { inr0 } from "@/lib/finance-calc"
import { GstInputClient } from "@/components/finance/gst-input-client"
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

/**
 * Phase 35/36 — build the CA-ready GST package workbook. Pure presentation over
 * the consolidated `gstCaPackage` payload: one sheet per compliance dataset so a
 * chartered accountant can review the whole period in a single file. It adds no
 * figures of its own — every cell comes straight from the derived package.
 */
function buildCaWorkbook(pkg: any) {
  const wb = XLSX.utils.book_new()
  const add = (name: string, aoa: any[][], cols?: number[]) => {
    if (!aoa.length) return
    const ws = XLSX.utils.aoa_to_sheet(aoa)
    if (cols) ws["!cols"] = cols.map((wch) => ({ wch }))
    // Excel caps sheet names at 31 chars and forbids a few characters.
    XLSX.utils.book_append_sheet(wb, ws, name.replace(/[\\/?*[\]:]/g, " ").slice(0, 31))
  }
  const n = (v: any) => (v === null || v === undefined ? 0 : Number(v) || 0)

  const t = pkg.gstr1?.totals ?? {}
  const l = pkg.liability ?? {}
  add(
    "Cover",
    [
      ["CA-Ready GST Package"],
      ["Tax period", pkg.period],
      ["Financial year", pkg.financial_year],
      ["Quarter", pkg.quarter],
      ["Return status", pkg.workflow?.status ?? "—"],
      ["Filing ID", pkg.filing?.filing_id ?? "—"],
      ["ARN", pkg.filing?.arn ?? "—"],
      ["Generated on", new Date(pkg.generated_at ?? Date.now()).toLocaleString()],
      [],
      ["OUTPUT (GSTR-1)"],
      ["Documents", n(t.invoice_count)],
      ["Taxable value", n(t.taxable)],
      ["Total tax", n(t.total_tax)],
      [],
      ["LIABILITY"],
      ["Output GST", n(l.output_gst)],
      ["Input GST (ITC)", n(l.input_gst)],
      ["RCM liability", n(l.rcm_liability)],
      ["ITC reversal", n(l.itc_reversal)],
      ["Net GST liability", n(l.net_liability)],
      ["Tax paid", n(l.tax_paid)],
      ["Balance payable", n(l.balance_payable)],
    ],
    [30, 22],
  )

  const g3b = pkg.gstr3b ?? {}
  add(
    "GSTR-3B",
    [
      ["GSTR-3B (auto-computed)"],
      ["3.1 Outward taxable supplies", n(g3b.outward?.taxable)],
      ["Output CGST", n(g3b.outward?.cgst)],
      ["Output SGST", n(g3b.outward?.sgst)],
      ["Output IGST", n(g3b.outward?.igst)],
      ["Output Cess", n(g3b.outward?.cess)],
      ["Less: credit note tax", n(g3b.outward?.credit_note_tax)],
      ["Net output tax", n(g3b.outward?.net_output_tax)],
      ["3.1(d) RCM liability", n(g3b.rcm_liability)],
      ["ITC — CGST", n(g3b.itc?.cgst)],
      ["ITC — SGST", n(g3b.itc?.sgst)],
      ["ITC — IGST", n(g3b.itc?.igst)],
      ["ITC — Cess", n(g3b.itc?.cess)],
      ["Less: ITC reversal", n(g3b.itc?.reversal)],
      ["Net ITC available", n(g3b.itc?.net)],
      ["Net GST payable", n(g3b.net_tax_payable)],
    ],
    [30, 18],
  )

  const rateWise = pkg.rate_wise ?? pkg.gstr1?.rate_wise ?? []
  add(
    "Rate-wise",
    [
      ["GST rate (%)", "Taxable", "CGST", "SGST", "IGST", "Cess", "Total GST"],
      ...rateWise.map((r: any) => [n(r.rate), n(r.taxable), n(r.cgst), n(r.sgst), n(r.igst), n(r.cess), n(r.total_gst)]),
    ],
    [12, 16, 14, 14, 14, 14, 14],
  )

  add(
    "Supply-wise",
    [
      ["Supply type", "Count", "Taxable", "CGST", "SGST", "IGST", "Cess", "Total GST"],
      ...(pkg.supply_wise ?? []).map((r: any) => [
        r.label, n(r.count), n(r.taxable), n(r.cgst), n(r.sgst), n(r.igst), n(r.cess), n(r.total_gst),
      ]),
    ],
    [26, 8, 16, 14, 14, 14, 14, 14],
  )

  add(
    "Client-wise",
    [
      ["Client", "Legal name", "GSTIN", "Invoices", "Taxable", "CGST", "SGST", "IGST", "Cess", "Total GST"],
      ...(pkg.client_wise ?? []).map((r: any) => [
        r.client, r.client_legal_name, r.gstin || "Unregistered", n(r.invoices),
        n(r.taxable), n(r.cgst), n(r.sgst), n(r.igst), n(r.cess), n(r.total_gst),
      ]),
    ],
    [24, 24, 18, 10, 16, 12, 12, 12, 10, 14],
  )

  add(
    "Vendor-wise",
    [
      ["Vendor", "GSTIN", "Bills", "Taxable", "CGST", "SGST", "IGST", "Cess", "ITC", "Reversal", "Net ITC"],
      ...(pkg.vendor_wise ?? []).map((r: any) => [
        r.vendor, r.gstin || "Unregistered", n(r.bills), n(r.taxable), n(r.cgst), n(r.sgst),
        n(r.igst), n(r.cess), n(r.itc), n(r.reversal), n(r.net_itc),
      ]),
    ],
    [24, 18, 8, 16, 12, 12, 12, 10, 14, 12, 14],
  )

  add(
    "GST Input (ITC)",
    [
      ["GST Input ID", "Source", "Bill #", "Date", "Vendor", "GSTIN", "Taxable", "Total GST", "Net ITC", "Status", "Reconciliation"],
      ...(pkg.gst_input ?? []).map((r: any) => [
        r.gst_input_id, r.source, r.bill_number || r.source_bill_ref, r.bill_date ? String(r.bill_date).slice(0, 10) : "",
        r.vendor_name || r.employee_name, r.vendor_gstin || "", n(r.taxable_amount), n(r.total_gst),
        n(r.itc_net), r.status, r.reconciliation_status,
      ]),
    ],
    [16, 14, 16, 12, 24, 18, 14, 14, 14, 14, 16],
  )

  const tb = pkg.two_b_reconciliation ?? {}
  add(
    "2B Reconciliation",
    [
      ["Component", "Source", "Amount", "GSTR-3B", "Amount", "Status"],
      ...((tb.lines ?? []).map((r: any) => [
        r.label, r.source_label, n(r.source), r.target_label, n(r.target), r.status,
      ])),
    ],
    [24, 20, 16, 20, 16, 12],
  )

  const rc = pkg.reconciliation_center
  if (rc?.lines?.length) {
    add(
      "Reconciliation Center",
      [
        ["Reconciliation", "Source", "Amount", "Counterpart", "Amount", "Difference", "Status"],
        ...rc.lines.map((r: any) => [
          r.label, r.left_label, n(r.left), r.right_label, n(r.right), Math.abs(n(r.left) - n(r.right)), r.status,
        ]),
      ],
      [24, 20, 16, 20, 16, 14, 12],
    )
  }

  const exRows: any[][] = [["Exception", "Severity", "Count", "Reference", "Detail"]]
  for (const e of pkg.exceptions ?? []) {
    if (!e.items?.length) {
      exRows.push([e.label, e.severity, n(e.count), "", e.description])
    } else {
      for (const it of e.items) exRows.push([e.label, e.severity, n(e.count), it.ref, it.detail])
    }
  }
  add("Exceptions", exRows, [26, 10, 8, 20, 40])

  add(
    "Credit-Debit Notes",
    [
      ["Note", "Type", "Date", "Client", "GSTIN", "Original invoice", "Taxable", "Tax", "Liability effect", "Status"],
      ...(pkg.credit_debit_notes ?? []).map((r: any) => [
        r.note_id, r.type, r.date ? String(r.date).slice(0, 10) : "", r.client, r.gstin,
        r.original_invoice || "", n(r.taxable), n(r.tax), n(r.liability_effect), r.status,
      ]),
    ],
    [16, 14, 12, 24, 18, 18, 14, 12, 16, 12],
  )

  add(
    "Raw GST Register",
    [
      ["Source", "Document", "Number", "Date", "Party", "GSTIN", "PAN", "Supply", "POS", "HSN/SAC",
       "Taxable", "Rate", "CGST", "SGST", "IGST", "Cess", "Total GST", "ITC", "TDS", "Status", "Reconciliation"],
      ...(pkg.raw_register ?? []).map((r: any) => [
        r.source, r.document_id, r.number, r.date ? String(r.date).slice(0, 10) : "", r.party, r.gstin, r.pan,
        r.supply_type, r.place_of_supply, r.hsn_sac, n(r.taxable), n(r.gst_rate), n(r.cgst), n(r.sgst), n(r.igst),
        n(r.cess), n(r.total_gst), n(r.itc), n(r.tds), r.status, r.reconciliation,
      ]),
    ],
  )

  if ((pkg.amendments ?? []).length) {
    add(
      "Amendments",
      [
        ["Revision", "Prev. status", "Prev. ARN", "Prev. taxable", "Prev. tax", "Reason", "When"],
        ...pkg.amendments.map((a: any) => [
          a.revision, a.previous_status, a.previous_arn || "", n(a.previous_total_taxable),
          n(a.previous_total_tax), a.reason || "", a.amended_at ? String(a.amended_at).slice(0, 19).replace("T", " ") : "",
        ]),
      ],
      [10, 16, 18, 16, 14, 30, 20],
    )
  }

  if ((pkg.audit ?? []).length) {
    add(
      "Audit Trail",
      [
        ["When", "Type", "Summary", "User"],
        ...pkg.audit.map((a: any) => [
          a.created_at ? String(a.created_at).slice(0, 19).replace("T", " ") : "",
          a.event_type ?? a.type ?? "", a.summary, a.actor_name ?? a.actorName ?? "",
        ]),
      ],
      [20, 16, 60, 20],
    )
  }

  XLSX.writeFile(wb, `GST_CA_Package_${pkg.period}.xlsx`)
}

const COMPLIANCE_TAB_VALUES = [
  "overview", "gstr1", "gstr3b", "gst_input", "gstr2b", "rcm",
  "itc_reversal", "output", "liability", "payment", "reconciliation",
  "exceptions", "history",
] as const

export function GstFilingClient({ initialTab }: { initialTab?: string }) {
  const [period, setPeriod] = useState(thisMonth())
  const [tab, setTab] = useState<string>(() =>
    initialTab && (COMPLIANCE_TAB_VALUES as readonly string[]).includes(initialTab) ? initialTab : "overview",
  )

  // Phase 33/34 — advanced filters + search over the outward document register.
  const [invSearch, setInvSearch] = useState("")
  const [invType, setInvType] = useState("all")
  const [invGstType, setInvGstType] = useState("all")
  const [invStatus, setInvStatus] = useState("all")
  const [invRate, setInvRate] = useState("all")
  const [caBusy, setCaBusy] = useState(false)

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

  const allInvoices = s?.invoices ?? []
  const invRates = Array.from(new Set(allInvoices.map((i) => i.gst_rate))).sort((a, b) => a - b)
  const invTypes = Array.from(new Set(allInvoices.map((i) => i.invoice_type)))
  const invStatuses = Array.from(new Set(allInvoices.map((i) => i.status)))
  const filteredInvoices = allInvoices.filter((inv) => {
    if (invType !== "all" && inv.invoice_type !== invType) return false
    if (invGstType !== "all" && inv.gst_type !== invGstType) return false
    if (invStatus !== "all" && inv.status !== invStatus) return false
    if (invRate !== "all" && String(inv.gst_rate) !== invRate) return false
    const q = invSearch.trim().toLowerCase()
    if (q) {
      const hay = [inv.invoice_id, inv.client_name, inv.client_legal_name, inv.client_gstin, inv.project_name]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
      if (!hay.includes(q)) return false
    }
    return true
  })
  const invFiltersActive =
    invSearch.trim() !== "" || invType !== "all" || invGstType !== "all" || invStatus !== "all" || invRate !== "all"

  async function exportCaPackage() {
    setCaBusy(true)
    try {
      const res = await fetch(`/api/finance/gst-filing?period=${period}&view=ca-package`)
      const body = await res.json()
      if (!res.ok) throw new Error(body.error || "Failed to build CA package")
      buildCaWorkbook(body.package)
    } catch (e) {
      console.log("[v0] CA package export failed:", (e as Error).message)
    } finally {
      setCaBusy(false)
    }
  }

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
          <Button
            variant="default"
            onClick={exportCaPackage}
            disabled={caBusy || !s}
            className="gap-2"
          >
            <FileSpreadsheet className="h-4 w-4" />
            {caBusy ? "Building…" : "CA Package"}
          </Button>
        </div>
      </header>

      <Tabs value={tab} onValueChange={setTab} className="flex flex-col gap-6">
        <div className="overflow-x-auto pb-1 [scrollbar-width:thin]">
          <TabsList className="w-max flex-nowrap">
            <TabsTrigger value="overview" className="gap-1.5 whitespace-nowrap"><ClipboardCheck className="h-3.5 w-3.5" /> Overview</TabsTrigger>
            <TabsTrigger value="gstr1" className="gap-1.5 whitespace-nowrap"><FileCheck2 className="h-3.5 w-3.5" /> GSTR-1</TabsTrigger>
            <TabsTrigger value="gstr3b" className="gap-1.5 whitespace-nowrap"><Scale className="h-3.5 w-3.5" /> GSTR-3B</TabsTrigger>
            <TabsTrigger value="gst_input" className="gap-1.5 whitespace-nowrap"><Layers className="h-3.5 w-3.5" /> GST Input / ITC</TabsTrigger>
            <TabsTrigger value="gstr2b" className="gap-1.5 whitespace-nowrap"><GitCompareArrows className="h-3.5 w-3.5" /> GSTR-2B Reconciliation</TabsTrigger>
            <TabsTrigger value="rcm" className="gap-1.5 whitespace-nowrap"><Truck className="h-3.5 w-3.5" /> RCM</TabsTrigger>
            <TabsTrigger value="itc_reversal" className="gap-1.5 whitespace-nowrap"><FileMinus2 className="h-3.5 w-3.5" /> ITC Reversal</TabsTrigger>
            <TabsTrigger value="output" className="gap-1.5 whitespace-nowrap"><Percent className="h-3.5 w-3.5" /> Output GST</TabsTrigger>
            <TabsTrigger value="liability" className="gap-1.5 whitespace-nowrap"><Landmark className="h-3.5 w-3.5" /> Tax Liability</TabsTrigger>
            <TabsTrigger value="payment" className="gap-1.5 whitespace-nowrap"><Wallet className="h-3.5 w-3.5" /> GST Payment</TabsTrigger>
            <TabsTrigger value="reconciliation" className="gap-1.5 whitespace-nowrap"><ShieldCheck className="h-3.5 w-3.5" /> Reconciliation</TabsTrigger>
            <TabsTrigger value="exceptions" className="gap-1.5 whitespace-nowrap"><AlertTriangle className="h-3.5 w-3.5" /> Tax Exceptions</TabsTrigger>
            <TabsTrigger value="history" className="gap-1.5 whitespace-nowrap"><History className="h-3.5 w-3.5" /> Filing History</TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="overview" className="mt-0 flex flex-col gap-6">
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
        <div className="text-sm font-medium">GST liability at a glance</div>
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <Stat label="Output GST" value={currency(s?.liability.output_gst)} hint="net of credit notes" />
          <Stat label="Input GST (ITC)" value={currency(s?.liability.input_gst)} hint="net eligible credit" />
          <Stat label="RCM liability" value={currency(s?.liability.rcm_liability)} hint="reverse charge" />
          <Stat label="ITC reversal" value={currency(s?.liability.itc_reversal)} hint="credit reversed" />
          <Stat label="Net GST liability" value={currency(s?.liability.net_liability)} hint="output + RCM − ITC" emphasis />
        </div>
      </section>
        </TabsContent>

        <TabsContent value="liability" className="mt-0 flex flex-col gap-6">
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
        </TabsContent>

        <TabsContent value="payment" className="mt-0 flex flex-col gap-6">
      <section className="flex flex-col gap-2">
        <div className="text-sm font-medium">GST payment</div>
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-3">
          <Stat label="Net GST liability" value={currency(s?.liability.net_liability)} hint="output + RCM − ITC" />
          <Stat label="Tax paid" value={currency(s?.liability.tax_paid)} hint="cash-ledger challan" />
          <Stat
            label="Balance payable"
            value={currency(s?.liability.balance_payable)}
            hint={(s?.liability.balance_payable ?? 0) <= 0 ? "credit carried forward" : "still payable"}
            emphasis
          />
        </div>
      </section>
      <RecordPayment
        period={period}
        current={s?.liability.tax_paid ?? 0}
        onSaved={() => mutate()}
      />
        </TabsContent>

        <TabsContent value="gstr2b" className="mt-0 flex flex-col gap-6">
      <ReconciliationCenter period={period} />
        </TabsContent>

        <TabsContent value="reconciliation" className="mt-0 flex flex-col gap-6">
      <GstComplianceSection period={period} />
        </TabsContent>

        <TabsContent value="exceptions" className="mt-0 flex flex-col gap-6">
      <GstComplianceSection period={period} mode="exceptions" />
        </TabsContent>

        <TabsContent value="output" className="mt-0 flex flex-col gap-6">
      <OutputGstView summary={s} />
        </TabsContent>

        <TabsContent value="rcm" className="mt-0 flex flex-col gap-6">
      <RcmView summary={s} />
        </TabsContent>

        <TabsContent value="itc_reversal" className="mt-0 flex flex-col gap-6">
      <ItcReversalView summary={s} />
        </TabsContent>

        <TabsContent value="gst_input" className="mt-0">
      <GstInputClient />
        </TabsContent>

        <TabsContent value="gstr1" className="mt-0 flex flex-col gap-6">
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
        <CardHeader className="flex flex-col gap-3">
          <div className="flex flex-row items-center justify-between">
            <CardTitle className="text-base">Invoices in {period}</CardTitle>
            <Badge variant="secondary">
              {invFiltersActive
                ? `${filteredInvoices.length} of ${allInvoices.length}`
                : `${allInvoices.length}`}{" "}
              document{(invFiltersActive ? filteredInvoices.length : allInvoices.length) === 1 ? "" : "s"}
            </Badge>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-[220px] flex-1">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={invSearch}
                onChange={(e) => setInvSearch(e.target.value)}
                placeholder="Search invoice #, client, legal name, GSTIN, project…"
                className="pl-8"
                aria-label="Search invoices"
              />
            </div>
            <Select value={invType} onValueChange={(v) => setInvType(v ?? "all")}>
              <SelectTrigger className="w-[150px]" aria-label="Filter by document type">
                <SelectValue placeholder="Type" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All types</SelectItem>
                {invTypes.map((t) => (
                  <SelectItem key={t} value={t}>
                    {t}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={invGstType} onValueChange={(v) => setInvGstType(v ?? "all")}>
              <SelectTrigger className="w-[150px]" aria-label="Filter by supply type">
                <SelectValue placeholder="Supply" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All supply</SelectItem>
                <SelectItem value="Intra-State">Intra-State</SelectItem>
                <SelectItem value="Inter-State">Inter-State</SelectItem>
              </SelectContent>
            </Select>
            <Select value={invRate} onValueChange={(v) => setInvRate(v ?? "all")}>
              <SelectTrigger className="w-[120px]" aria-label="Filter by GST rate">
                <SelectValue placeholder="Rate" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All rates</SelectItem>
                {invRates.map((r) => (
                  <SelectItem key={r} value={String(r)}>
                    {r}%
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={invStatus} onValueChange={(v) => setInvStatus(v ?? "all")}>
              <SelectTrigger className="w-[140px]" aria-label="Filter by status">
                <SelectValue placeholder="Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                {invStatuses.map((st) => (
                  <SelectItem key={st} value={st}>
                    {st}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {invFiltersActive ? (
              <Button
                variant="ghost"
                size="sm"
                className="gap-1"
                onClick={() => {
                  setInvSearch("")
                  setInvType("all")
                  setInvGstType("all")
                  setInvStatus("all")
                  setInvRate("all")
                }}
              >
                <XCircle className="h-4 w-4" />
                Clear
              </Button>
            ) : null}
          </div>
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
                {!s || allInvoices.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={12} className="py-8 text-center text-sm text-muted-foreground">
                      <div>No invoices included for this period.</div>
                      {s?.excluded ? <ExclusionHint excluded={s.excluded} /> : null}
                    </TableCell>
                  </TableRow>
                ) : filteredInvoices.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={12} className="py-8 text-center text-sm text-muted-foreground">
                      No invoices match the current filters.
                    </TableCell>
                  </TableRow>
                ) : (
                  filteredInvoices.map((inv) => (
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

        </TabsContent>

        <TabsContent value="gstr3b" className="mt-0 flex flex-col gap-6">
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

        </TabsContent>

        <TabsContent value="history" className="mt-0 flex flex-col gap-6">
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
      <PeriodCloseAndAudit
        period={period}
        onChanged={() => {
          mutate()
          mutateFilings()
        }}
      />
        </TabsContent>
      </Tabs>
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

// ── GST Compliance (Phases 21–30) ───────────────────────────────────────────
// Everything below is DERIVED from the same GSTR-1/3B engine and the shared ITC
// register, so the compliance views can never disagree with the numbers above.

type ComplianceReconStatus = "Matched" | "Mismatch"

type Compliance = {
  period: string
  financial_year: string
  quarter: string
  monthly: {
    taxable_outward: number
    output_gst: number
    input_gst: number
    eligible_itc: number
    itc_reversal: number
    rcm: number
    net_liability: number
    tax_paid: number
    balance: number
  }
  three_b: {
    gstr2b_present: boolean
    headline: {
      gstr1_output: number
      gstr2b_itc: number
      itc_register: number
      rcm: number
      net_payable: number
    }
    lines: {
      key: string
      label: string
      source_label: string
      source: number
      target_label: string
      target: number
      status: ComplianceReconStatus
    }[]
  }
  exceptions: {
    key: string
    label: string
    description: string
    severity: "error" | "warning" | "info"
    count: number
    items: { ref: string; detail: string }[]
  }[]
  exception_total: number
  raw: {
    fy: string | null
    month: string
    quarter: string
    source: string
    document_id: string
    number: string
    date: string | null
    party: string
    gstin: string
    pan: string
    supply_type: string
    place_of_supply: string
    hsn_sac: string
    taxable: number
    gst_rate: number
    cgst: number
    sgst: number
    igst: number
    cess: number
    total_gst: number
    itc: number
    tds: number
    status: string
    reconciliation: string
  }[]
  rate_wise: { rate: number; taxable: number; cgst: number; sgst: number; igst: number; cess: number; total_gst: number }[]
  supply_wise: {
    key: string
    label: string
    count: number
    taxable: number
    cgst: number
    sgst: number
    igst: number
    cess: number
    total_gst: number
  }[]
  client_wise: {
    client: string
    client_legal_name: string
    gstin: string
    invoices: number
    taxable: number
    cgst: number
    sgst: number
    igst: number
    cess: number
    total_gst: number
  }[]
  vendor_wise: {
    vendor: string
    gstin: string
    bills: number
    taxable: number
    cgst: number
    sgst: number
    igst: number
    cess: number
    itc: number
    reversal: number
    net_itc: number
  }[]
  credit_debit_notes: {
    note_id: string
    type: string
    date: string | null
    client: string
    gstin: string
    original_invoice: string | null
    taxable: number
    tax: number
    total: number
    liability_effect: number
    status: string
  }[]
}

type Quarterly = {
  financial_year: string
  quarters: { quarter: string; output: number; input: number; itc: number; rcm: number; liability: number; paid: number }[]
  total: { quarter: string; output: number; input: number; itc: number; rcm: number; liability: number; paid: number }
}

const SEVERITY_STYLE: Record<string, string> = {
  error: "border-red-500/40 text-red-700 dark:text-red-400",
  warning: "border-amber-500/40 text-amber-700 dark:text-amber-400",
  info: "text-muted-foreground",
}

function ComplianceReconBadge({ status }: { status: ComplianceReconStatus }) {
  return (
    <Badge
      variant="outline"
      className={
        status === "Matched"
          ? "border-emerald-500/40 text-emerald-700 dark:text-emerald-400"
          : "border-red-500/40 text-red-700 dark:text-red-400"
      }
    >
      {status}
    </Badge>
  )
}

function GstComplianceSection({ period }: { period: string }) {
  const { data } = useSWR<{ compliance: Compliance }>(
    `/api/finance/gst-filing?period=${period}&view=compliance`,
    fetcher,
  )
  const [fy, setFy] = useState<string | null>(null)
  const { data: qData } = useSWR<{ quarterly: Quarterly | null; financial_years: string[] }>(
    `/api/finance/gst-filing?view=quarterly${fy ? `&fy=${fy}` : ""}`,
    fetcher,
  )

  const c = data?.compliance
  const quarterly = qData?.quarterly
  const years = qData?.financial_years ?? []
  const activeFy = fy ?? quarterly?.financial_year ?? c?.financial_year ?? "—"

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <ShieldCheck className="h-4 w-4" />
          GST compliance
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          3B reconciliation, exceptions, summaries and the raw register — all derived from the same GSTR-1 engine and
          ITC register, so nothing is entered twice.
        </p>
      </CardHeader>
      <CardContent>
        <Tabs defaultValue="three_b">
          <div className="overflow-x-auto pb-2 [scrollbar-width:thin]">
          <TabsList className="w-max flex-nowrap">
            <TabsTrigger value="three_b" className="gap-1.5 whitespace-nowrap">
              <Scale className="h-3.5 w-3.5" /> 3B Reconciliation
            </TabsTrigger>
            <TabsTrigger value="exceptions" className="gap-1.5">
              <AlertTriangle className="h-3.5 w-3.5" /> Exceptions
              {c && c.exception_total > 0 ? (
                <Badge variant="secondary" className="ml-1 px-1.5 py-0 text-[10px]">
                  {c.exception_total}
                </Badge>
              ) : null}
            </TabsTrigger>
            <TabsTrigger value="monthly" className="gap-1.5">
              <CalendarRange className="h-3.5 w-3.5" /> Monthly
            </TabsTrigger>
            <TabsTrigger value="quarterly" className="gap-1.5">
              <CalendarRange className="h-3.5 w-3.5" /> Quarterly
            </TabsTrigger>
            <TabsTrigger value="client" className="gap-1.5">
              <Users className="h-3.5 w-3.5" /> Client-wise
            </TabsTrigger>
            <TabsTrigger value="vendor" className="gap-1.5">
              <Truck className="h-3.5 w-3.5" /> Vendor-wise
            </TabsTrigger>
            <TabsTrigger value="rate" className="gap-1.5">
              <Percent className="h-3.5 w-3.5" /> Rate-wise
            </TabsTrigger>
            <TabsTrigger value="supply" className="gap-1.5">
              <Split className="h-3.5 w-3.5" /> Supply-wise
            </TabsTrigger>
            <TabsTrigger value="notes" className="gap-1.5">
              <FileMinus2 className="h-3.5 w-3.5" /> Credit/Debit Notes
            </TabsTrigger>
            <TabsTrigger value="raw" className="gap-1.5 whitespace-nowrap">
              <Table2 className="h-3.5 w-3.5" /> Raw Register
            </TabsTrigger>
          </TabsList>
          </div>

          {/* Phase 21 — 3B reconciliation */}
          <TabsContent value="three_b" className="mt-4">
            {!c ? (
              <Loading />
            ) : (
              <div className="flex flex-col gap-4">
                <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
                  <MiniStat label="GSTR-1 output" value={currency(c.three_b.headline.gstr1_output)} />
                  <MiniStat
                    label={c.three_b.gstr2b_present ? "GSTR-2B ITC" : "ITC register"}
                    value={currency(c.three_b.gstr2b_present ? c.three_b.headline.gstr2b_itc : c.three_b.headline.itc_register)}
                  />
                  <MiniStat label="RCM" value={currency(c.three_b.headline.rcm)} />
                  <MiniStat label="Net payable" value={currency(c.three_b.headline.net_payable)} emphasis />
                  <MiniStat
                    label="Overall"
                    value={c.three_b.lines.every((l) => l.status === "Matched") ? "Matched" : "Review"}
                  />
                </div>
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Component</TableHead>
                        <TableHead>Source</TableHead>
                        <TableHead className="text-right">Amount</TableHead>
                        <TableHead>GSTR-3B</TableHead>
                        <TableHead className="text-right">Amount</TableHead>
                        <TableHead className="text-right">Difference</TableHead>
                        <TableHead>Status</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {c.three_b.lines.map((l) => (
                        <TableRow key={l.key}>
                          <TableCell className="text-sm font-medium">{l.label}</TableCell>
                          <TableCell className="text-sm text-muted-foreground">{l.source_label}</TableCell>
                          <TableCell className="text-right">{currency(l.source)}</TableCell>
                          <TableCell className="text-sm text-muted-foreground">{l.target_label}</TableCell>
                          <TableCell className="text-right">{currency(l.target)}</TableCell>
                          <TableCell className="text-right">{currency(Math.abs(l.source - l.target))}</TableCell>
                          <TableCell><ComplianceReconBadge status={l.status} /></TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
                {!c.three_b.gstr2b_present ? (
                  <p className="text-xs text-muted-foreground">
                    No GSTR-2B staged for this period — the ITC line compares the GST Input register against GSTR-3B
                    instead.
                  </p>
                ) : null}
              </div>
            )}
          </TabsContent>

          {/* Phase 22 — exception centre */}
          <TabsContent value="exceptions" className="mt-4">
            {!c ? (
              <Loading />
            ) : (
              <div className="grid gap-3 md:grid-cols-2">
                {c.exceptions.map((e) => (
                  <div key={e.key} className="rounded-md border">
                    <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
                      <div className="flex items-center gap-2 text-sm font-medium">
                        {e.count > 0 ? <AlertTriangle className={`h-3.5 w-3.5 ${e.severity === "error" ? "text-red-600" : e.severity === "warning" ? "text-amber-600" : "text-muted-foreground"}`} /> : <FileCheck2 className="h-3.5 w-3.5 text-emerald-600" />}
                        {e.label}
                      </div>
                      <Badge variant="outline" className={e.count > 0 ? SEVERITY_STYLE[e.severity] : "border-emerald-500/40 text-emerald-700 dark:text-emerald-400"}>
                        {e.count > 0 ? e.count : "Clean"}
                      </Badge>
                    </div>
                    <div className="px-3 py-2">
                      <p className="text-xs text-muted-foreground">{e.description}</p>
                      {e.items.length > 0 ? (
                        <ul className="mt-2 flex flex-col gap-1">
                          {e.items.slice(0, 5).map((it, i) => (
                            <li key={i} className="flex flex-wrap items-center gap-2 text-xs">
                              <span className="font-mono">{it.ref}</span>
                              <span className="text-muted-foreground">{it.detail}</span>
                            </li>
                          ))}
                          {e.items.length > 5 ? (
                            <li className="text-xs text-muted-foreground">+ {e.items.length - 5} more…</li>
                          ) : null}
                        </ul>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </TabsContent>

          {/* Phase 24 — monthly summary */}
          <TabsContent value="monthly" className="mt-4">
            {!c ? (
              <Loading />
            ) : (
              <div className="grid grid-cols-2 gap-4 lg:grid-cols-3">
                <MiniStat label="Taxable outward" value={currency(c.monthly.taxable_outward)} />
                <MiniStat label="Output GST" value={currency(c.monthly.output_gst)} />
                <MiniStat label="Input GST" value={currency(c.monthly.input_gst)} />
                <MiniStat label="Eligible ITC" value={currency(c.monthly.eligible_itc)} />
                <MiniStat label="ITC reversal" value={currency(c.monthly.itc_reversal)} />
                <MiniStat label="RCM" value={currency(c.monthly.rcm)} />
                <MiniStat label="Net liability" value={currency(c.monthly.net_liability)} emphasis />
                <MiniStat label="Tax paid" value={currency(c.monthly.tax_paid)} />
                <MiniStat label="Balance" value={currency(c.monthly.balance)} emphasis />
              </div>
            )}
          </TabsContent>

          {/* Phase 25 — quarterly summary */}
          <TabsContent value="quarterly" className="mt-4">
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <span className="text-sm text-muted-foreground">Financial year</span>
              {years.length > 0 ? (
                <div className="flex flex-wrap gap-1">
                  {years.map((y) => (
                    <Button
                      key={y}
                      size="sm"
                      variant={y === activeFy ? "default" : "outline"}
                      onClick={() => setFy(y)}
                    >
                      {y}
                    </Button>
                  ))}
                </div>
              ) : (
                <span className="text-sm font-medium">{activeFy}</span>
              )}
            </div>
            {!quarterly ? (
              <Loading />
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Quarter</TableHead>
                      <TableHead className="text-right">Output</TableHead>
                      <TableHead className="text-right">Input</TableHead>
                      <TableHead className="text-right">ITC</TableHead>
                      <TableHead className="text-right">RCM</TableHead>
                      <TableHead className="text-right">Liability</TableHead>
                      <TableHead className="text-right">Paid</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {quarterly.quarters.map((q) => (
                      <TableRow key={q.quarter}>
                        <TableCell className="font-medium">{q.quarter}</TableCell>
                        <TableCell className="text-right">{currency(q.output)}</TableCell>
                        <TableCell className="text-right">{currency(q.input)}</TableCell>
                        <TableCell className="text-right">{currency(q.itc)}</TableCell>
                        <TableCell className="text-right">{currency(q.rcm)}</TableCell>
                        <TableCell className="text-right">{currency(q.liability)}</TableCell>
                        <TableCell className="text-right">{currency(q.paid)}</TableCell>
                      </TableRow>
                    ))}
                    <TableRow className="bg-muted/40 font-medium">
                      <TableCell>{quarterly.total.quarter}</TableCell>
                      <TableCell className="text-right">{currency(quarterly.total.output)}</TableCell>
                      <TableCell className="text-right">{currency(quarterly.total.input)}</TableCell>
                      <TableCell className="text-right">{currency(quarterly.total.itc)}</TableCell>
                      <TableCell className="text-right">{currency(quarterly.total.rcm)}</TableCell>
                      <TableCell className="text-right">{currency(quarterly.total.liability)}</TableCell>
                      <TableCell className="text-right">{currency(quarterly.total.paid)}</TableCell>
                    </TableRow>
                  </TableBody>
                </Table>
              </div>
            )}
          </TabsContent>

          {/* Phase 26 — client-wise output */}
          <TabsContent value="client" className="mt-4">
            {!c ? (
              <Loading />
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Client</TableHead>
                      <TableHead>GSTIN</TableHead>
                      <TableHead className="text-right">Invoices</TableHead>
                      <TableHead className="text-right">Taxable</TableHead>
                      <TableHead className="text-right">CGST</TableHead>
                      <TableHead className="text-right">SGST</TableHead>
                      <TableHead className="text-right">IGST</TableHead>
                      <TableHead className="text-right">Cess</TableHead>
                      <TableHead className="text-right">Total GST</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {c.client_wise.length === 0 ? (
                      <EmptyRow colSpan={9} label="No outward supplies for this period." />
                    ) : (
                      c.client_wise.map((r, i) => (
                        <TableRow key={i}>
                          <TableCell className="text-sm">{r.client}</TableCell>
                          <TableCell>
                            {r.gstin ? <span className="font-mono text-xs">{r.gstin}</span> : <Badge variant="outline" className="text-xs">Unregistered</Badge>}
                          </TableCell>
                          <TableCell className="text-right">{r.invoices}</TableCell>
                          <TableCell className="text-right">{currency(r.taxable)}</TableCell>
                          <TableCell className="text-right">{currency(r.cgst)}</TableCell>
                          <TableCell className="text-right">{currency(r.sgst)}</TableCell>
                          <TableCell className="text-right">{currency(r.igst)}</TableCell>
                          <TableCell className="text-right">{currency(r.cess)}</TableCell>
                          <TableCell className="text-right font-medium">{currency(r.total_gst)}</TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </div>
            )}
          </TabsContent>

          {/* Phase 27 — vendor-wise input */}
          <TabsContent value="vendor" className="mt-4">
            {!c ? (
              <Loading />
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Vendor</TableHead>
                      <TableHead>GSTIN</TableHead>
                      <TableHead className="text-right">Bills</TableHead>
                      <TableHead className="text-right">Taxable</TableHead>
                      <TableHead className="text-right">CGST</TableHead>
                      <TableHead className="text-right">SGST</TableHead>
                      <TableHead className="text-right">IGST</TableHead>
                      <TableHead className="text-right">Cess</TableHead>
                      <TableHead className="text-right">ITC</TableHead>
                      <TableHead className="text-right">Reversal</TableHead>
                      <TableHead className="text-right">Net ITC</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {c.vendor_wise.length === 0 ? (
                      <EmptyRow colSpan={11} label="No input tax credit for this period." />
                    ) : (
                      c.vendor_wise.map((r, i) => (
                        <TableRow key={i}>
                          <TableCell className="text-sm">{r.vendor}</TableCell>
                          <TableCell>
                            {r.gstin ? <span className="font-mono text-xs">{r.gstin}</span> : <Badge variant="outline" className="text-xs">Unregistered</Badge>}
                          </TableCell>
                          <TableCell className="text-right">{r.bills}</TableCell>
                          <TableCell className="text-right">{currency(r.taxable)}</TableCell>
                          <TableCell className="text-right">{currency(r.cgst)}</TableCell>
                          <TableCell className="text-right">{currency(r.sgst)}</TableCell>
                          <TableCell className="text-right">{currency(r.igst)}</TableCell>
                          <TableCell className="text-right">{currency(r.cess)}</TableCell>
                          <TableCell className="text-right">{currency(r.itc)}</TableCell>
                          <TableCell className="text-right">{currency(r.reversal)}</TableCell>
                          <TableCell className="text-right font-medium">{currency(r.net_itc)}</TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </div>
            )}
          </TabsContent>

          {/* Phase 28 — rate-wise */}
          <TabsContent value="rate" className="mt-4">
            {!c ? (
              <Loading />
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>GST rate</TableHead>
                      <TableHead className="text-right">Taxable</TableHead>
                      <TableHead className="text-right">CGST</TableHead>
                      <TableHead className="text-right">SGST</TableHead>
                      <TableHead className="text-right">IGST</TableHead>
                      <TableHead className="text-right">Cess</TableHead>
                      <TableHead className="text-right">Total GST</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {c.rate_wise.length === 0 ? (
                      <EmptyRow colSpan={7} label="No taxable supplies for this period." />
                    ) : (
                      c.rate_wise.map((r) => (
                        <TableRow key={r.rate}>
                          <TableCell>{r.rate}%</TableCell>
                          <TableCell className="text-right">{currency(r.taxable)}</TableCell>
                          <TableCell className="text-right">{currency(r.cgst)}</TableCell>
                          <TableCell className="text-right">{currency(r.sgst)}</TableCell>
                          <TableCell className="text-right">{currency(r.igst)}</TableCell>
                          <TableCell className="text-right">{currency(r.cess)}</TableCell>
                          <TableCell className="text-right font-medium">{currency(r.total_gst)}</TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </div>
            )}
          </TabsContent>

          {/* Phase 29 — supply-wise */}
          <TabsContent value="supply" className="mt-4">
            {!c ? (
              <Loading />
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Supply type</TableHead>
                      <TableHead className="text-right">Documents</TableHead>
                      <TableHead className="text-right">Taxable</TableHead>
                      <TableHead className="text-right">CGST</TableHead>
                      <TableHead className="text-right">SGST</TableHead>
                      <TableHead className="text-right">IGST</TableHead>
                      <TableHead className="text-right">Cess</TableHead>
                      <TableHead className="text-right">Total GST</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {c.supply_wise.map((r) => (
                      <TableRow key={r.key}>
                        <TableCell className="text-sm font-medium">{r.label}</TableCell>
                        <TableCell className="text-right">{r.count}</TableCell>
                        <TableCell className="text-right">{currency(r.taxable)}</TableCell>
                        <TableCell className="text-right">{currency(r.cgst)}</TableCell>
                        <TableCell className="text-right">{currency(r.sgst)}</TableCell>
                        <TableCell className="text-right">{currency(r.igst)}</TableCell>
                        <TableCell className="text-right">{currency(r.cess)}</TableCell>
                        <TableCell className="text-right font-medium">{currency(r.total_gst)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </TabsContent>

          {/* Phase 30 — credit / debit notes */}
          <TabsContent value="notes" className="mt-4">
            {!c ? (
              <Loading />
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Note</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead>Date</TableHead>
                      <TableHead>Client</TableHead>
                      <TableHead>Original invoice</TableHead>
                      <TableHead className="text-right">Taxable</TableHead>
                      <TableHead className="text-right">Tax</TableHead>
                      <TableHead className="text-right">Liability effect</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {c.credit_debit_notes.length === 0 ? (
                      <EmptyRow colSpan={8} label="No credit or debit notes in this period." />
                    ) : (
                      c.credit_debit_notes.map((n) => (
                        <TableRow key={n.note_id}>
                          <TableCell className="font-mono text-xs">{n.note_id}</TableCell>
                          <TableCell><NoteTypeBadge type={n.type} /></TableCell>
                          <TableCell className="whitespace-nowrap text-sm">{n.date ? n.date.slice(0, 10) : "—"}</TableCell>
                          <TableCell className="text-sm">{n.client}</TableCell>
                          <TableCell className="font-mono text-xs">{n.original_invoice || "—"}</TableCell>
                          <TableCell className="text-right">{currency(n.taxable)}</TableCell>
                          <TableCell className="text-right">{currency(n.tax)}</TableCell>
                          <TableCell className={`text-right font-medium ${n.liability_effect < 0 ? "text-red-600 dark:text-red-400" : ""}`}>
                            {n.liability_effect < 0 ? `(${currency(Math.abs(n.liability_effect))})` : currency(n.liability_effect)}
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
                <p className="mt-2 text-xs text-muted-foreground">
                  Notes adjust the return through their source linkage — a Credit Note reduces and a Debit Note
                  increases the period&apos;s output liability. The original invoice is never edited.
                </p>
              </div>
            )}
          </TabsContent>

          {/* Phase 23 — raw register */}
          <TabsContent value="raw" className="mt-4">
            {!c ? (
              <Loading />
            ) : (
              <div className="max-h-[520px] overflow-auto rounded-md border">
                <Table>
                  <TableHeader className="sticky top-0 bg-background">
                    <TableRow>
                      <TableHead>Source</TableHead>
                      <TableHead>Document</TableHead>
                      <TableHead>Number</TableHead>
                      <TableHead>Date</TableHead>
                      <TableHead>Party</TableHead>
                      <TableHead>GSTIN</TableHead>
                      <TableHead>PAN</TableHead>
                      <TableHead>Supply</TableHead>
                      <TableHead>POS</TableHead>
                      <TableHead>HSN/SAC</TableHead>
                      <TableHead className="text-right">Taxable</TableHead>
                      <TableHead className="text-right">Rate</TableHead>
                      <TableHead className="text-right">CGST</TableHead>
                      <TableHead className="text-right">SGST</TableHead>
                      <TableHead className="text-right">IGST</TableHead>
                      <TableHead className="text-right">Cess</TableHead>
                      <TableHead className="text-right">Total GST</TableHead>
                      <TableHead className="text-right">ITC</TableHead>
                      <TableHead className="text-right">TDS</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Reconciliation</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {c.raw.length === 0 ? (
                      <EmptyRow colSpan={21} label="No transactions for this period." />
                    ) : (
                      c.raw.map((r, i) => (
                        <TableRow key={`${r.document_id}-${i}`}>
                          <TableCell className="whitespace-nowrap text-xs">{r.source}</TableCell>
                          <TableCell className="whitespace-nowrap font-mono text-xs">{r.document_id}</TableCell>
                          <TableCell className="whitespace-nowrap text-xs">{r.number}</TableCell>
                          <TableCell className="whitespace-nowrap text-xs">{r.date ? r.date.slice(0, 10) : "—"}</TableCell>
                          <TableCell className="whitespace-nowrap text-xs">{r.party}</TableCell>
                          <TableCell className="whitespace-nowrap font-mono text-xs">{r.gstin || "—"}</TableCell>
                          <TableCell className="whitespace-nowrap font-mono text-xs">{r.pan || "—"}</TableCell>
                          <TableCell className="whitespace-nowrap text-xs">{r.supply_type}</TableCell>
                          <TableCell className="whitespace-nowrap text-xs">{r.place_of_supply || "—"}</TableCell>
                          <TableCell className="whitespace-nowrap text-xs">{r.hsn_sac || "—"}</TableCell>
                          <TableCell className="whitespace-nowrap text-right text-xs">{currency(r.taxable)}</TableCell>
                          <TableCell className="whitespace-nowrap text-right text-xs">{r.gst_rate}%</TableCell>
                          <TableCell className="whitespace-nowrap text-right text-xs">{currency(r.cgst)}</TableCell>
                          <TableCell className="whitespace-nowrap text-right text-xs">{currency(r.sgst)}</TableCell>
                          <TableCell className="whitespace-nowrap text-right text-xs">{currency(r.igst)}</TableCell>
                          <TableCell className="whitespace-nowrap text-right text-xs">{currency(r.cess)}</TableCell>
                          <TableCell className="whitespace-nowrap text-right text-xs font-medium">{currency(r.total_gst)}</TableCell>
                          <TableCell className="whitespace-nowrap text-right text-xs">{r.itc ? currency(r.itc) : "—"}</TableCell>
                          <TableCell className="whitespace-nowrap text-right text-xs">{r.tds ? currency(r.tds) : "—"}</TableCell>
                          <TableCell className="whitespace-nowrap text-xs">{r.status}</TableCell>
                          <TableCell className="whitespace-nowrap text-xs">{r.reconciliation}</TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </div>
            )}
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  )
}

/**
 * Period close (Phase 40) + audit trail (Phase 32). The close gate reads the
 * pre-close checklist and only enables "Close period" when every required check
 * passes and the return is filed — closing posts nothing new (it just marks the
 * period Completed through the existing lifecycle). The audit trail is the full
 * Prepared → Reviewed → Filed → Amended → Payment → Reconciliation → Close
 * history for the period, read from the shared finance audit log.
 */
type CloseCheck = { key: string; label: string; passed: boolean; detail: string; required: boolean }
type CloseData = {
  period: string
  financial_year: string | null
  can_close: boolean
  already_closed: boolean
  status: string
  checks: CloseCheck[]
}
type AuditEvent = {
  id: number
  event_type: string
  summary: string
  amount: number | null
  actor_name: string | null
  created_at: string | null
}

function PeriodCloseAndAudit({ period, onChanged }: { period: string; onChanged: () => void }) {
  const { data: closeData, mutate: mutateClose } = useSWR<{ close: CloseData }>(
    `/api/finance/gst-filing?period=${period}&view=close`,
    fetcher,
  )
  const { data: auditData, mutate: mutateAudit } = useSWR<{ audit: AuditEvent[] }>(
    `/api/finance/gst-filing?period=${period}&view=audit`,
    fetcher,
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")

  const close = closeData?.close
  const audit = auditData?.audit ?? []

  async function closePeriod() {
    setBusy(true)
    setError("")
    try {
      const res = await fetch("/api/finance/gst-filing", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "close-period", period }),
      })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error || "Could not close the period")
      await Promise.all([mutateClose(), mutateAudit()])
      onChanged()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <ClipboardCheck className="h-4 w-4" />
          Period close &amp; audit trail
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          A GST period can only be closed once GSTR-1/3B are ready, ITC is reconciled, RCM and tax liability are
          checked, payment is settled and every blocking exception is resolved.
        </p>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        <div>
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <div className="text-sm font-medium">Pre-close checklist</div>
            {close ? (
              close.already_closed ? (
                <Badge variant="default" className="gap-1">
                  <Lock className="h-3.5 w-3.5" /> Period closed
                </Badge>
              ) : (
                <Badge variant="outline" className="font-normal text-muted-foreground">
                  Status: {close.status}
                </Badge>
              )
            ) : null}
          </div>
          {!close ? (
            <Loading />
          ) : (
            <div className="grid gap-2 md:grid-cols-2">
              {close.checks.map((chk) => (
                <div
                  key={chk.key}
                  className="flex items-start gap-2 rounded-md border px-3 py-2 text-sm"
                >
                  {chk.passed ? (
                    <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
                  ) : (
                    <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-600" />
                  )}
                  <div className="flex flex-col">
                    <span className="font-medium">{chk.label}</span>
                    <span className="text-xs text-muted-foreground">{chk.detail}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
          {close && !close.already_closed ? (
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <Button size="sm" onClick={closePeriod} disabled={busy || !close.can_close} className="gap-1">
                <Lock className="h-4 w-4" />
                {busy ? "Closing…" : "Close period"}
              </Button>
              {!close.can_close ? (
                <span className="text-xs text-muted-foreground">
                  Resolve every required check and file the return to enable closing.
                </span>
              ) : null}
              {error ? <span className="text-xs text-destructive">{error}</span> : null}
            </div>
          ) : null}
        </div>

        <div>
          <div className="mb-2 flex items-center gap-2 text-sm font-medium">
            <History className="h-4 w-4" />
            Audit trail
          </div>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead>Event</TableHead>
                  <TableHead>Summary</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead>User</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {audit.length === 0 ? (
                  <EmptyRow colSpan={5} label="No audit events recorded for this period yet." />
                ) : (
                  audit.map((a) => (
                    <TableRow key={a.id}>
                      <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                        {a.created_at ? a.created_at.slice(0, 19).replace("T", " ") : "—"}
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className="font-normal">
                          {a.event_type}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-sm">{a.summary}</TableCell>
                      <TableCell className="text-right text-sm">
                        {a.amount ? currency(a.amount) : "—"}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">{a.actor_name || "System"}</TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

function OutputGstView({ summary: s }: { summary?: Summary }) {
  return (
    <>
      <section className="flex flex-col gap-2">
        <div className="text-sm font-medium">Output GST</div>
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <Stat label="Taxable outward" value={currency(s?.gstr3b.outward.taxable)} />
          <Stat label="Output GST" value={currency(s?.liability.output_gst)} hint="net of credit notes" emphasis />
          <Stat label="Credit note tax" value={currency(s?.gstr3b.outward.credit_note_tax)} hint="reduces output" />
          <Stat label="Net output tax" value={currency(s?.gstr3b.outward.net_output_tax)} />
        </div>
      </section>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Percent className="h-4 w-4" />
            Output tax breakup
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="rounded-md border">
            <div className="flex flex-col divide-y text-sm">
              <Line label="Output CGST" value={currency(s?.gstr3b.outward.cgst)} />
              <Line label="Output SGST" value={currency(s?.gstr3b.outward.sgst)} />
              <Line label="Output IGST" value={currency(s?.gstr3b.outward.igst)} />
              <Line label="Output Cess" value={currency(s?.gstr3b.outward.cess)} />
              <Line label="Less: credit note tax" value={`(${currency(s?.gstr3b.outward.credit_note_tax)})`} />
              <Line label="Net output tax" value={currency(s?.gstr3b.outward.net_output_tax)} strong />
            </div>
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Rate-wise output</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
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
                <EmptyRow colSpan={6} label="No taxable outward supplies in this period." />
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
    </>
  )
}

function RcmView({ summary: s }: { summary?: Summary }) {
  return (
    <>
      <section className="flex flex-col gap-2">
        <div className="text-sm font-medium">Reverse charge (RCM)</div>
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-3">
          <Stat label="RCM liability" value={currency(s?.gstr3b.rcm_liability)} hint="self-assessed output" emphasis />
          <Stat label="Added to output" value={currency(s?.liability.rcm_liability)} hint="3.1(d)" />
          <Stat label="Net GST liability" value={currency(s?.liability.net_liability)} hint="incl. RCM" />
        </div>
      </section>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Truck className="h-4 w-4" />
            How RCM flows
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 text-sm text-muted-foreground">
          <p>
            Reverse-charge tax is self-assessed on purchase bills and expenses from unregistered or notified suppliers.
            It is added to your output liability under GSTR-3B 3.1(d) and, where eligible, claimed back as input tax
            credit in the GST Input / ITC register.
          </p>
          <div className="rounded-md border">
            <div className="flex flex-col divide-y">
              <Line label="RCM liability (added to output)" value={currency(s?.gstr3b.rcm_liability)} />
              <Line label="RCM ITC (claimable, subject to eligibility)" value={currency(s?.gstr3b.rcm_liability)} />
            </div>
          </div>
          <p className="text-xs">
            Open the <span className="font-medium text-foreground">GST Input / ITC</span> tab to review and claim the
            reverse-charge credit line by line.
          </p>
        </CardContent>
      </Card>
    </>
  )
}

function ItcReversalView({ summary: s }: { summary?: Summary }) {
  return (
    <>
      <section className="flex flex-col gap-2">
        <div className="text-sm font-medium">ITC reversal</div>
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <Stat label="Eligible ITC" value={currency(s?.gstr3b.itc.eligible)} />
          <Stat label="ITC reversal" value={currency(s?.gstr3b.itc.reversal)} hint="credit reversed" emphasis />
          <Stat label="Net ITC available" value={currency(s?.gstr3b.itc.net)} />
          <Stat label="Input GST claimed" value={currency(s?.liability.input_gst)} />
        </div>
      </section>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <FileMinus2 className="h-4 w-4" />
            ITC reversal breakup
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="rounded-md border">
            <div className="flex flex-col divide-y text-sm">
              <Line label="ITC — CGST" value={currency(s?.gstr3b.itc.cgst)} />
              <Line label="ITC — SGST" value={currency(s?.gstr3b.itc.sgst)} />
              <Line label="ITC — IGST" value={currency(s?.gstr3b.itc.igst)} />
              <Line label="ITC — Cess" value={currency(s?.gstr3b.itc.cess)} />
              <Line label="Less: ITC reversal" value={`(${currency(s?.gstr3b.itc.reversal)})`} />
              <Line label="Net ITC available" value={currency(s?.gstr3b.itc.net)} strong />
            </div>
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            Reversals are driven from the GST Input / ITC register (ineligible credit, non-payment within 180 days,
            common-credit rules). Manage individual reversals from the GST Input / ITC tab.
          </p>
        </CardContent>
      </Card>
    </>
  )
}

function MiniStat({ label, value, emphasis }: { label: string; value: string; emphasis?: boolean }) {
  return (
    <div className={`rounded-md border p-3 ${emphasis ? "border-primary/40 bg-primary/5" : ""}`}>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={`text-lg font-semibold ${emphasis ? "text-primary" : ""}`}>{value}</div>
    </div>
  )
}

function Loading() {
  return <p className="py-8 text-center text-sm text-muted-foreground">Loading…</p>
}

function EmptyRow({ colSpan, label }: { colSpan: number; label: string }) {
  return (
    <TableRow>
      <TableCell colSpan={colSpan} className="py-8 text-center text-sm text-muted-foreground">
        {label}
      </TableCell>
    </TableRow>
  )
}
