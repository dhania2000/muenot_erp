"use client"

import { useEffect, useMemo, useState } from "react"
import useSWR from "swr"
import { fetcher } from "@/lib/fetcher"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Checkbox } from "@/components/ui/checkbox"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Loader2Icon, Plus, Trash2, Lock } from "lucide-react"
import type { InvoiceRow } from "@/components/finance/sales-invoices-client"
import { inr, financialYearFor, num, round2 } from "@/lib/finance-calc"

const INVOICE_TYPES = ["Tax Invoice", "Proforma Invoice", "Credit Note", "Debit Note", "Export Invoice", "Bill of Supply"]
const INVOICE_STATUSES = ["Draft", "Issued", "Sent", "Posted", "Cancelled"]
const PAYMENT_STATUSES = ["Unpaid", "Partially Paid", "Paid", "Overdue"]
const UNITS = ["Nos", "Hours", "Days", "Months", "Lot", "Project", "Subscription", "Kg", "Units"]
const SUPPLY_TYPES = ["Intra-State", "Inter-State"]
const TAX_RATES = ["0", "5", "12", "18", "28"]

const currency = (n: number) => inr(n || 0)

type LineItem = {
  key: string
  item_id: string
  description: string
  hsn_sac: string
  quantity: string
  unit: string
  rate: string
  discount_type: "amount" | "percent"
  discount_value: string
  tax_rate: string
  cess_amount: string
}

function emptyLine(): LineItem {
  return {
    key: Math.random().toString(36).slice(2),
    item_id: "", description: "", hsn_sac: "", quantity: "1", unit: "Nos", rate: "",
    discount_type: "amount", discount_value: "", tax_rate: "18", cess_amount: "",
  }
}

type HeaderState = {
  invoice_date: string
  invoice_type: string
  financial_year: string
  client_id: string
  client_name: string
  customer_party_id: string
  contract_id: string
  quotation_id: string
  source_type: string
  original_invoice_id: string
  project_id: string
  project_name: string
  billing_period_from: string
  billing_period_to: string
  place_of_supply: string
  place_of_supply_code: string
  supply_type: string
  tds_applicable: boolean
  tds_section: string
  tds_rate: string
  due_date: string
  amount_received: string
  payment_status: string
  payment_date: string
  payment_reference: string
  irn_reference: string
  eway_bill_no: string
  credit_debit_note_ref: string
  notes: string
  invoice_status: string
}

const EMPTY_HEADER: HeaderState = {
  invoice_date: "", invoice_type: "Tax Invoice", financial_year: "", client_id: "", client_name: "",
  customer_party_id: "", contract_id: "", quotation_id: "", source_type: "Manual", original_invoice_id: "",
  project_id: "", project_name: "", billing_period_from: "", billing_period_to: "",
  place_of_supply: "", place_of_supply_code: "", supply_type: "Intra-State",
  tds_applicable: false, tds_section: "", tds_rate: "", due_date: "", amount_received: "",
  payment_status: "", payment_date: "", payment_reference: "", irn_reference: "",
  eway_bill_no: "", credit_debit_note_ref: "", notes: "", invoice_status: "Draft",
}

type Party = {
  client_id: string
  client_name: string
  gstin: string
  state: string
  state_code: string | null
  place_of_supply: string
  place_of_supply_code: string | null
  currency: string
  payment_terms_days: number
  credit_limit: number | null
  tds_section: string
  tds_rate: number
  customer_party_id: string | null
}

type TaxRate = { id: number; code: string; name: string; rate: number; category: string }
type HsnRow = { id: number; code: string; description: string; default_tax_rate: number }
type ProductRow = {
  id: number
  code: string
  name: string
  unit: string | null
  rate: number
  hsn_sac: string | null
  tax_rate: number
}
type Masters = { taxRates: TaxRate[]; hsnSac: HsnRow[]; products: ProductRow[] }

type SourceCredit = { credit_limit: number | null; outstanding: number; overdue: number; available: number | null }
type ContractOpt = { id: number; contract_code: string; title: string | null; value: number; status: string }
type QuotationOpt = { id: number; quote_code: string; version: number; status: string; grand_total: number }
type ProjectOpt = { id: number; project_name: string; status: string }
type SourcesData = {
  contracts: ContractOpt[]
  quotations: QuotationOpt[]
  projects: ProjectOpt[]
  credit: SourceCredit | null
}

export function SalesInvoiceDialog({
  open,
  onOpenChange,
  invoice,
  onSaved,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  invoice: InvoiceRow | null
  onSaved: () => void
}) {
  const [header, setHeader] = useState<HeaderState>(EMPTY_HEADER)
  const [lines, setLines] = useState<LineItem[]>([emptyLine()])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const [allowOverbilling, setAllowOverbilling] = useState(false)
  const [allowDuplicate, setAllowDuplicate] = useState(false)
  const [pendingOverride, setPendingOverride] = useState<"overbilling" | "duplicate" | null>(null)
  const [sourceBilling, setSourceBilling] = useState<{ label: string; remaining: number } | null>(null)

  const { data: partyData } = useSWR<{ parties: Party[] }>(open ? "/api/finance/sales-invoices/parties" : null, fetcher)
  const parties = partyData?.parties ?? []

  // Configurable masters back the line editor (tax rates, HSN/SAC, products).
  const { data: masters } = useSWR<Masters>(open ? "/api/finance/masters" : null, fetcher)
  const taxRates = masters?.taxRates ?? []
  const hsnList = masters?.hsnSac ?? []
  const products = masters?.products ?? []

  // Source documents + live credit profile for the selected client.
  const { data: sources } = useSWR<SourcesData>(
    open && header.client_name ? `/api/finance/sales-invoices/sources?client_name=${encodeURIComponent(header.client_name)}` : null,
    fetcher,
  )
  const credit = sources?.credit ?? null

  // Original-invoice picker options for Credit / Debit notes.
  const isNote = header.invoice_type === "Credit Note" || header.invoice_type === "Debit Note"
  const { data: noteSourceData } = useSWR<{ rows: InvoiceRow[] }>(
    open && isNote && header.client_name
      ? `/api/finance/sales-invoices?search=${encodeURIComponent(header.client_name)}`
      : null,
    fetcher,
  )
  const originalInvoiceOptions = (noteSourceData?.rows ?? []).filter(
    (r) => r.invoice_type !== "Credit Note" && r.invoice_type !== "Debit Note",
  )

  const taxOptions = taxRates.length
    ? taxRates.map((t) => ({ label: `${t.name}`, value: String(Number(t.rate)) }))
    : TAX_RATES.map((r) => ({ label: `${r}%`, value: r }))

  // The stored status governs what can be edited (Draft editable, Issued/Sent
  // restricted to payment + compliance, Posted locked to cash application).
  const status = invoice?.invoice_status || "Draft"
  const isDraft = !invoice || status === "Draft"
  const isPosted = status === "Posted"
  const isCancelled = status === "Cancelled"
  const structuralLocked = !isDraft // items, amounts, party, tax frozen once issued

  useEffect(() => {
    if (!open) return
    setError(null)
    setAllowOverbilling(false)
    setAllowDuplicate(false)
    setPendingOverride(null)
    setSourceBilling(null)
    if (invoice) {
      const next = { ...EMPTY_HEADER }
      for (const key of Object.keys(EMPTY_HEADER) as (keyof HeaderState)[]) {
        const v = (invoice as any)[key]
        if (key === "tds_applicable") (next as any)[key] = !!invoice.tds_applicable
        else (next as any)[key] = v === null || v === undefined ? "" : String(v)
      }
      setHeader(next)
      // Pull the invoice's line items so multi-line invoices round-trip.
      fetch(`/api/finance/sales-invoices?id=${invoice.id}`)
        .then((r) => r.json())
        .then((d) => {
          const items = Array.isArray(d.items) ? d.items : []
          if (items.length > 0) {
            setLines(
              items.map((it: any) => ({
                key: String(it.id),
                item_id: it.item_id ?? "",
                description: it.description ?? "",
                hsn_sac: it.hsn_sac ?? "",
                quantity: String(it.quantity ?? ""),
                unit: it.unit ?? "",
                rate: String(it.rate ?? ""),
                discount_type: it.discount_type === "percent" ? "percent" : "amount",
                discount_value: String(it.discount_value ?? ""),
                tax_rate: String(it.tax_rate ?? ""),
                cess_amount: String(it.cess_amount ?? ""),
              })),
            )
          } else {
            // Legacy single-line invoice: reconstruct one line from the header.
            setLines([
              {
                ...emptyLine(),
                description: invoice.description ?? "",
                hsn_sac: invoice.hsn_sac ?? "",
                quantity: String(invoice.quantity ?? "1"),
                unit: invoice.unit ?? "Nos",
                rate: String(invoice.rate ?? ""),
                discount_value: String(invoice.discount ?? ""),
                tax_rate: String(num(invoice.cgst_percent) + num(invoice.sgst_percent) + num(invoice.igst_percent)),
                cess_amount: String(invoice.other_tax_cess ?? ""),
              },
            ])
          }
        })
        .catch(() => {})
    } else {
      setHeader(EMPTY_HEADER)
      setLines([emptyLine()])
    }
  }, [open, invoice])

  function updateHeader<K extends keyof HeaderState>(key: K, value: HeaderState[K]) {
    setHeader((prev) => {
      const next = { ...prev, [key]: value }
      if (key === "invoice_date" && (!prev.financial_year || prev.financial_year === financialYearFor(prev.invoice_date))) {
        next.financial_year = financialYearFor(value as string)
      }
      return next
    })
  }

  function applyParty(clientId: string) {
    const p = parties.find((x) => x.client_id === clientId)
    if (!p) return
    setHeader((prev) => {
      const next = { ...prev }
      next.client_id = p.client_id
      next.client_name = p.client_name
      next.customer_party_id = p.customer_party_id || ""
      next.place_of_supply = p.place_of_supply || p.state || ""
      next.place_of_supply_code = p.place_of_supply_code || ""
      if (p.tds_rate > 0) {
        next.tds_applicable = true
        next.tds_section = p.tds_section || prev.tds_section
        next.tds_rate = String(p.tds_rate)
      }
      // Due date from client payment terms (server enforces the full hierarchy).
      if (prev.invoice_date && p.payment_terms_days > 0) {
        const d = new Date(prev.invoice_date)
        if (!Number.isNaN(d.getTime())) {
          d.setDate(d.getDate() + p.payment_terms_days)
          next.due_date = d.toISOString().slice(0, 10)
        }
      }
      return next
    })
  }

  function updateLine(key: string, patch: Partial<LineItem>) {
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)))
  }
  function addLine() {
    setLines((prev) => [...prev, emptyLine()])
  }
  function removeLine(key: string) {
    setLines((prev) => (prev.length > 1 ? prev.filter((l) => l.key !== key) : prev))
  }

  // Fill a line from the product/service master (spec 46). Values remain editable.
  function applyProduct(key: string, code: string) {
    const prod = products.find((p) => p.code === code)
    if (!prod) return
    updateLine(key, {
      item_id: prod.code,
      description: prod.name,
      unit: prod.unit || "Nos",
      rate: prod.rate ? String(prod.rate) : "",
      hsn_sac: prod.hsn_sac || "",
      tax_rate: prod.tax_rate != null ? String(Number(prod.tax_rate)) : "18",
    })
  }

  // When an HSN/SAC is chosen from the master, adopt its default tax rate.
  function applyHsn(key: string, code: string) {
    const row = hsnList.find((h) => h.code === code)
    updateLine(key, { hsn_sac: code, ...(row ? { tax_rate: String(Number(row.default_tax_rate)) } : {}) })
  }

  // Selecting a source document (quotation/contract/project) auto-fills the
  // invoice. The server still recomputes all money and re-validates linkage.
  async function applySource(kind: "contract" | "quotation" | "project", id: string) {
    if (!id) {
      setSourceBilling(null)
      return
    }
    try {
      const excl = invoice ? `&exclude_invoice_pk=${invoice.id}` : ""
      const res = await fetch(`/api/finance/sales-invoices/sources?resolve=1&kind=${kind}&id=${id}${excl}`)
      const data = await res.json()
      const src = data.source
      if (!src) return
      setHeader((prev) => {
        const next = { ...prev }
        const a = src.autofill || {}
        if (kind === "contract") next.contract_id = String(id)
        if (kind === "quotation") next.quotation_id = String(id)
        if (kind === "project") {
          next.project_id = String(id)
          if (a.project_name) next.project_name = a.project_name
        }
        if (a.quotation_id) next.quotation_id = String(a.quotation_id)
        if (a.place_of_supply) next.place_of_supply = a.place_of_supply
        if (a.source_type) next.source_type = a.source_type
        return next
      })
      // Copy quotation commercial lines (server recomputes totals — spec 18).
      if (kind === "quotation" && Array.isArray(src.autofill?.items) && src.autofill.items.length > 0) {
        setLines(
          src.autofill.items.map((it: any) => ({
            ...emptyLine(),
            description: it.description ?? "",
            hsn_sac: it.hsn_sac ?? "",
            quantity: String(it.quantity ?? "1"),
            unit: it.unit ?? "Nos",
            rate: String(it.rate ?? ""),
            discount_type: it.discount_type === "percent" ? "percent" : "amount",
            discount_value: String(it.discount_value ?? ""),
            tax_rate: String(it.tax_rate ?? "18"),
            cess_amount: "",
          })),
        )
      }
      if (src.billing && src.billing.billable > 0) {
        setSourceBilling({ label: src.code || kind, remaining: src.billing.remaining })
      } else {
        setSourceBilling(null)
      }
    } catch {
      /* non-fatal auto-fill */
    }
  }

  // Live mirror of the server money engine (place-of-supply GST + aggregation).
  const totals = useMemo(() => {
    const intra = header.supply_type !== "Inter-State"
    let taxable = 0, cgst = 0, sgst = 0, igst = 0, cess = 0
    const computed = lines.map((l) => {
      const gross = round2(num(l.quantity) * num(l.rate))
      const disc = l.discount_type === "percent" ? round2((gross * num(l.discount_value)) / 100) : round2(num(l.discount_value))
      const t = round2(Math.max(gross - disc, 0))
      const gst = num(l.tax_rate)
      const c = intra ? round2((t * (gst / 2)) / 100) : 0
      const s = intra ? round2((t * (gst / 2)) / 100) : 0
      const i = intra ? 0 : round2((t * gst) / 100)
      const ce = round2(num(l.cess_amount))
      taxable += t; cgst += c; sgst += s; igst += i; cess += ce
      return { lineTotal: round2(t + c + s + i + ce), taxable: t }
    })
    taxable = round2(taxable); cgst = round2(cgst); sgst = round2(sgst); igst = round2(igst); cess = round2(cess)
    const invoiceTotal = round2(taxable + cgst + sgst + igst + cess)
    const tdsAmount = header.tds_applicable ? round2((taxable * num(header.tds_rate)) / 100) : 0
    const netReceivable = round2(invoiceTotal - tdsAmount)
    const outstanding = round2(netReceivable - num(header.amount_received))
    return { computed, taxable, cgst, sgst, igst, cess, invoiceTotal, tdsAmount, netReceivable, outstanding }
  }, [lines, header.supply_type, header.tds_applicable, header.tds_rate, header.amount_received])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (isCancelled) return setError("Cancelled invoices cannot be edited.")
    if (isDraft) {
      if (!header.invoice_date) return setError("Invoice date is required")
      if (!header.client_name) return setError("Client is required")
      if (totals.taxable <= 0) return setError("Add at least one line item with an amount")
    }
    setLoading(true)
    setError(null)

    const payload: Record<string, any> = {
      ...header,
      id: invoice?.id,
      tds_applicable: header.tds_applicable ? 1 : 0,
    }
    // Structural data is only sent for editable (Draft) invoices; for restricted
    // states we send just the payment/compliance changes the server allows.
    if (isDraft) {
      payload.items = lines.map((l) => ({
        description: l.description, hsn_sac: l.hsn_sac, quantity: l.quantity, unit: l.unit,
        rate: l.rate, discount_type: l.discount_type, discount_value: l.discount_value,
        tax_rate: l.tax_rate, cess_amount: l.cess_amount,
      }))
    } else {
      for (const k of ["items", "client_id", "client_name", "customer_party_id", "contract_id",
        "quotation_id", "project_id", "project_name", "supply_type", "place_of_supply",
        "place_of_supply_code", "tds_applicable", "tds_section", "tds_rate", "invoice_date",
        "invoice_type", "billing_period_from", "billing_period_to", "financial_year",
        "source_type", "original_invoice_id", "due_date"]) {
        delete payload[k]
      }
    }

    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" }
      if (!invoice) headers["Idempotency-Key"] = crypto.randomUUID()
      const res = await fetch("/api/finance/sales-invoices", {
        method: invoice ? "PATCH" : "POST",
        headers,
        body: JSON.stringify(payload),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(body.error || "Unable to save invoice")
        setLoading(false)
        return
      }
      setLoading(false)
      onSaved()
    } catch {
      setError("Something went wrong. Please try again.")
      setLoading(false)
    }
  }

  const selectedParty = parties.find((p) => p.client_id === header.client_id)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-4xl">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {invoice ? `Edit invoice ${invoice.invoice_id}` : "New sales invoice"}
              {invoice && (
                <Badge variant={isDraft ? "secondary" : isCancelled ? "destructive" : "default"}>{status}</Badge>
              )}
            </DialogTitle>
            <DialogDescription>
              {isDraft
                ? "Select a client to auto-fill their tax profile. Add line items — totals, GST and receivable recalculate on the server."
                : "This invoice is locked. Only payment tracking and compliance references can be updated."}
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-6 py-4">
            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}

            {structuralLocked && !isCancelled && (
              <Alert>
                <Lock className="size-4" />
                <AlertDescription>
                  Amounts and line items are frozen for {status} invoices. To change billed amounts, issue a credit or debit note.
                </AlertDescription>
              </Alert>
            )}

            <Section title="Invoice details">
              <Grid>
                <Field>
                  <FieldLabel htmlFor="invoice_date">Invoice date</FieldLabel>
                  <Input id="invoice_date" type="date" value={header.invoice_date} disabled={structuralLocked}
                    onChange={(e) => updateHeader("invoice_date", e.target.value)} required />
                </Field>
                <SelectField label="Invoice type" value={header.invoice_type || "Tax Invoice"} options={INVOICE_TYPES}
                  disabled={structuralLocked} onChange={(v) => updateHeader("invoice_type", v)} />
                <Field>
                  <FieldLabel htmlFor="financial_year">Financial year</FieldLabel>
                  <Input id="financial_year" placeholder="2026-27" value={header.financial_year} disabled={structuralLocked}
                    onChange={(e) => updateHeader("financial_year", e.target.value)} />
                </Field>
              </Grid>
              <Grid>
                <Field>
                  <FieldLabel>Client</FieldLabel>
                  <Select value={header.client_id || ""} disabled={structuralLocked} onValueChange={applyParty}>
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder={parties.length ? "Select a client" : "No clients found"} />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {parties.map((p) => (
                          <SelectItem key={p.client_id} value={p.client_id}>
                            {p.client_name}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </Field>
                <Field>
                  <FieldLabel htmlFor="client_name">Client name</FieldLabel>
                  <Input id="client_name" value={header.client_name} disabled={structuralLocked}
                    onChange={(e) => updateHeader("client_name", e.target.value)} required />
                </Field>
              </Grid>
              {selectedParty && (
                <div className="flex flex-wrap gap-x-6 gap-y-1 rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                  {selectedParty.gstin && <span>GSTIN: <span className="font-medium text-foreground">{selectedParty.gstin}</span></span>}
                  {selectedParty.state && <span>State: <span className="font-medium text-foreground">{selectedParty.state}</span></span>}
                  {selectedParty.credit_limit != null && <span>Credit limit: <span className="font-medium text-foreground">{currency(selectedParty.credit_limit)}</span></span>}
                  {selectedParty.payment_terms_days > 0 && <span>Terms: <span className="font-medium text-foreground">{selectedParty.payment_terms_days} days</span></span>}
                </div>
              )}
              <Grid>
                <Field>
                  <FieldLabel htmlFor="project_id">Project ID</FieldLabel>
                  <Input id="project_id" value={header.project_id} disabled={structuralLocked}
                    onChange={(e) => updateHeader("project_id", e.target.value)} />
                </Field>
                <Field>
                  <FieldLabel htmlFor="contract_id">Contract ref.</FieldLabel>
                  <Input id="contract_id" value={header.contract_id} disabled={structuralLocked}
                    onChange={(e) => updateHeader("contract_id", e.target.value)} />
                </Field>
                <Field>
                  <FieldLabel htmlFor="quotation_id">Quotation ref.</FieldLabel>
                  <Input id="quotation_id" value={header.quotation_id} disabled={structuralLocked}
                    onChange={(e) => updateHeader("quotation_id", e.target.value)} />
                </Field>
              </Grid>
              <Grid>
                <Field>
                  <FieldLabel htmlFor="billing_period_from">Billing period from</FieldLabel>
                  <Input id="billing_period_from" type="date" value={header.billing_period_from} disabled={structuralLocked}
                    onChange={(e) => updateHeader("billing_period_from", e.target.value)} />
                </Field>
                <Field>
                  <FieldLabel htmlFor="billing_period_to">Billing period to</FieldLabel>
                  <Input id="billing_period_to" type="date" value={header.billing_period_to} disabled={structuralLocked}
                    onChange={(e) => updateHeader("billing_period_to", e.target.value)} />
                </Field>
              </Grid>
              <Grid>
                <Field>
                  <FieldLabel htmlFor="place_of_supply">Place of supply</FieldLabel>
                  <Input id="place_of_supply" value={header.place_of_supply} disabled={structuralLocked}
                    onChange={(e) => updateHeader("place_of_supply", e.target.value)} />
                </Field>
                <SelectField label="Supply type" value={header.supply_type} options={SUPPLY_TYPES}
                  disabled={structuralLocked} onChange={(v) => updateHeader("supply_type", v)} />
              </Grid>
            </Section>

            <Section title="Line items">
              <div className="overflow-x-auto">
                <table className="w-full min-w-[720px] text-sm">
                  <thead>
                    <tr className="border-b text-left text-xs text-muted-foreground">
                      <th className="p-2 font-medium">Description</th>
                      <th className="p-2 font-medium">HSN/SAC</th>
                      <th className="p-2 font-medium">Qty</th>
                      <th className="p-2 font-medium">Unit</th>
                      <th className="p-2 font-medium">Rate</th>
                      <th className="p-2 font-medium">Disc.</th>
                      <th className="p-2 font-medium">GST %</th>
                      <th className="p-2 text-right font-medium">Line total</th>
                      <th className="p-2" />
                    </tr>
                  </thead>
                  <tbody>
                    {lines.map((l, idx) => (
                      <tr key={l.key} className="border-b align-top">
                        <td className="p-1 min-w-[180px]">
                          <Textarea rows={1} value={l.description} disabled={structuralLocked}
                            onChange={(e) => updateLine(l.key, { description: e.target.value })} placeholder="Service / item" />
                        </td>
                        <td className="p-1"><Input className="w-20" value={l.hsn_sac} disabled={structuralLocked}
                          onChange={(e) => updateLine(l.key, { hsn_sac: e.target.value })} /></td>
                        <td className="p-1"><Input className="w-16" type="number" step="any" value={l.quantity} disabled={structuralLocked}
                          onChange={(e) => updateLine(l.key, { quantity: e.target.value })} /></td>
                        <td className="p-1">
                          <Select value={l.unit || "Nos"} disabled={structuralLocked} onValueChange={(v) => updateLine(l.key, { unit: v })}>
                            <SelectTrigger className="w-24"><SelectValue /></SelectTrigger>
                            <SelectContent>{UNITS.map((u) => <SelectItem key={u} value={u}>{u}</SelectItem>)}</SelectContent>
                          </Select>
                        </td>
                        <td className="p-1"><Input className="w-24" type="number" step="any" value={l.rate} disabled={structuralLocked}
                          onChange={(e) => updateLine(l.key, { rate: e.target.value })} /></td>
                        <td className="p-1"><Input className="w-20" type="number" step="any" value={l.discount_value} disabled={structuralLocked}
                          onChange={(e) => updateLine(l.key, { discount_value: e.target.value })} /></td>
                        <td className="p-1">
                          <Select value={l.tax_rate || "18"} disabled={structuralLocked} onValueChange={(v) => updateLine(l.key, { tax_rate: v })}>
                            <SelectTrigger className="w-20"><SelectValue /></SelectTrigger>
                            <SelectContent>{TAX_RATES.map((r) => <SelectItem key={r} value={r}>{r}%</SelectItem>)}</SelectContent>
                          </Select>
                        </td>
                        <td className="p-2 text-right font-medium tabular-nums">{currency(totals.computed[idx]?.lineTotal ?? 0)}</td>
                        <td className="p-1">
                          {!structuralLocked && (
                            <Button type="button" variant="ghost" size="icon" aria-label="Remove line"
                              onClick={() => removeLine(l.key)} disabled={lines.length <= 1}>
                              <Trash2 className="size-4" />
                            </Button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {!structuralLocked && (
                <Button type="button" variant="outline" size="sm" className="self-start" onClick={addLine}>
                  <Plus data-icon="inline-start" /> Add line
                </Button>
              )}
              <div className="grid grid-cols-2 gap-2 rounded-lg border bg-muted/40 p-4 text-sm sm:grid-cols-3 lg:grid-cols-6">
                <Computed label="Taxable" value={currency(totals.taxable)} />
                <Computed label="CGST" value={currency(totals.cgst)} />
                <Computed label="SGST" value={currency(totals.sgst)} />
                <Computed label="IGST" value={currency(totals.igst)} />
                <Computed label="Cess" value={currency(totals.cess)} />
                <Computed label="Invoice total" value={currency(totals.invoiceTotal)} emphasize />
              </div>
            </Section>

            <Section title="TDS & receivable">
              <label className="flex items-center gap-2 text-sm">
                <Checkbox checked={header.tds_applicable} disabled={structuralLocked}
                  onCheckedChange={(c) => updateHeader("tds_applicable", !!c)} />
                TDS applicable
              </label>
              {header.tds_applicable && (
                <Grid>
                  <Field>
                    <FieldLabel htmlFor="tds_section">TDS section</FieldLabel>
                    <Input id="tds_section" placeholder="194J" value={header.tds_section} disabled={structuralLocked}
                      onChange={(e) => updateHeader("tds_section", e.target.value)} />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="tds_rate">TDS rate %</FieldLabel>
                    <Input id="tds_rate" type="number" step="any" value={header.tds_rate} disabled={structuralLocked}
                      onChange={(e) => updateHeader("tds_rate", e.target.value)} />
                  </Field>
                </Grid>
              )}
              <div className="grid grid-cols-2 gap-2 rounded-lg border bg-muted/40 p-4 text-sm sm:grid-cols-3">
                <Computed label="TDS amount" value={currency(totals.tdsAmount)} />
                <Computed label="Net receivable" value={currency(totals.netReceivable)} emphasize />
                <Computed label="Outstanding" value={currency(totals.outstanding)} />
              </div>
            </Section>

            <Section title="Payment tracking">
              <Grid>
                <Field>
                  <FieldLabel htmlFor="due_date">Due date</FieldLabel>
                  <Input id="due_date" type="date" value={header.due_date} disabled={structuralLocked}
                    onChange={(e) => updateHeader("due_date", e.target.value)} />
                </Field>
                <Field>
                  <FieldLabel htmlFor="amount_received">Amount received</FieldLabel>
                  <Input id="amount_received" type="number" step="any" value={header.amount_received} disabled={isCancelled}
                    onChange={(e) => updateHeader("amount_received", e.target.value)} />
                </Field>
                <SelectField label="Payment status" value={header.payment_status || "auto"} options={PAYMENT_STATUSES}
                  allowEmpty emptyLabel="Auto" disabled={isCancelled} onChange={(v) => updateHeader("payment_status", v === "auto" ? "" : v)} />
              </Grid>
              <Grid>
                <Field>
                  <FieldLabel htmlFor="payment_date">Payment date</FieldLabel>
                  <Input id="payment_date" type="date" value={header.payment_date} disabled={isCancelled}
                    onChange={(e) => updateHeader("payment_date", e.target.value)} />
                </Field>
                <Field>
                  <FieldLabel htmlFor="payment_reference">Payment reference</FieldLabel>
                  <Input id="payment_reference" value={header.payment_reference} disabled={isCancelled}
                    onChange={(e) => updateHeader("payment_reference", e.target.value)} />
                </Field>
              </Grid>
            </Section>

            <Section title="Compliance & status">
              <Grid>
                <Field>
                  <FieldLabel htmlFor="irn_reference">IRN / E-Invoice reference</FieldLabel>
                  <Input id="irn_reference" value={header.irn_reference} disabled={isCancelled}
                    onChange={(e) => updateHeader("irn_reference", e.target.value)} />
                </Field>
                <Field>
                  <FieldLabel htmlFor="eway_bill_no">E-Way Bill no.</FieldLabel>
                  <Input id="eway_bill_no" value={header.eway_bill_no} disabled={isCancelled}
                    onChange={(e) => updateHeader("eway_bill_no", e.target.value)} />
                </Field>
              </Grid>
              <Grid>
                {(header.invoice_type === "Credit Note" || header.invoice_type === "Debit Note") && (
                  <Field>
                    <FieldLabel htmlFor="original_invoice_id">Original invoice ID</FieldLabel>
                    <Input id="original_invoice_id" value={header.original_invoice_id} disabled={structuralLocked}
                      onChange={(e) => updateHeader("original_invoice_id", e.target.value)} />
                  </Field>
                )}
                <SelectField label="Invoice status" value={header.invoice_status || "Draft"} options={INVOICE_STATUSES}
                  disabled={isPosted || isCancelled} onChange={(v) => updateHeader("invoice_status", v)} />
              </Grid>
              <Field>
                <FieldLabel htmlFor="notes">Notes</FieldLabel>
                <Textarea id="notes" rows={2} value={header.notes} disabled={isCancelled}
                  onChange={(e) => updateHeader("notes", e.target.value)} />
              </Field>
            </Section>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={loading || isCancelled}>
              {loading && <Loader2Icon className="animate-spin" data-icon="inline-start" />}
              {invoice ? "Save changes" : "Create invoice"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <FieldGroup>
      <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      {children}
    </FieldGroup>
  )
}

function Grid({ children }: { children: React.ReactNode }) {
  return <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">{children}</div>
}

function Computed({ label, value, emphasize }: { label: string; value: string; emphasize?: boolean }) {
  return (
    <div className="flex flex-col">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className={emphasize ? "text-base font-semibold" : "font-medium"}>{value}</span>
    </div>
  )
}

function SelectField({
  label,
  value,
  options,
  onChange,
  allowEmpty,
  emptyLabel = "—",
  disabled,
}: {
  label: string
  value: string
  options: string[]
  onChange: (v: string) => void
  allowEmpty?: boolean
  emptyLabel?: string
  disabled?: boolean
}) {
  return (
    <Field>
      <FieldLabel>{label}</FieldLabel>
      <Select value={value} disabled={disabled} onValueChange={(v) => onChange(v ?? "")}>
        <SelectTrigger className="w-full">
          <SelectValue placeholder={label} />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {allowEmpty && <SelectItem value={value === "auto" ? "auto" : "none"}>{emptyLabel}</SelectItem>}
            {options.map((o) => (
              <SelectItem key={o} value={o}>
                {o}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
    </Field>
  )
}
