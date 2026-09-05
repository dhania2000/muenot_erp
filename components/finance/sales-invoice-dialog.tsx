"use client"

import { useEffect, useMemo, useState } from "react"
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
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Loader2Icon } from "lucide-react"
import type { InvoiceRow } from "@/components/finance/sales-invoices-client"

const INVOICE_TYPES = ["Tax Invoice", "Proforma Invoice", "Credit Note", "Debit Note", "Export Invoice", "Bill of Supply"]
const INVOICE_STATUSES = ["Draft", "Issued", "Sent", "Cancelled"]
const PAYMENT_STATUSES = ["Unpaid", "Partially Paid", "Paid", "Overdue"]
const UNITS = ["Nos", "Hours", "Days", "Months", "Lot", "Project", "Kg", "Units"]

const num = (v: any) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100

function financialYearFor(dateStr?: string | null) {
  if (!dateStr) return ""
  const d = new Date(dateStr)
  if (Number.isNaN(d.getTime())) return ""
  const y = d.getFullYear()
  const start = d.getMonth() >= 3 ? y : y - 1
  return `${start}-${String((start + 1) % 100).padStart(2, "0")}`
}

const currency = (n: number) =>
  new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 }).format(n || 0)

type FormState = Record<string, string> & { tds_applicable: string }

const EMPTY: FormState = {
  invoice_date: "", invoice_type: "Tax Invoice", financial_year: "", client_id: "", client_name: "",
  project_id: "", project_name: "", billing_period_from: "", billing_period_to: "", description: "",
  hsn_sac: "", quantity: "", unit: "", rate: "", taxable_amount: "", discount: "",
  cgst_percent: "", sgst_percent: "", igst_percent: "", other_tax_cess: "",
  tds_applicable: "", tds_section: "", tds_rate: "", due_date: "", amount_received: "",
  payment_status: "", payment_date: "", payment_reference: "", irn_reference: "",
  eway_bill_no: "", credit_debit_note_ref: "", notes: "", invoice_status: "Draft",
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
  const [form, setForm] = useState<FormState>(EMPTY)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!open) return
    setError(null)
    if (invoice) {
      const next = { ...EMPTY }
      for (const key of Object.keys(EMPTY)) {
        const v = (invoice as any)[key]
        next[key] = v === null || v === undefined ? "" : String(v)
      }
      next.tds_applicable = invoice.tds_applicable ? "1" : ""
      setForm(next)
    } else {
      setForm(EMPTY)
    }
  }, [open, invoice])

  function update(key: keyof FormState, value: string) {
    setForm((prev) => {
      const next = { ...prev, [key]: value }
      // Auto-fill the financial year from the invoice date unless edited by hand.
      if (key === "invoice_date" && (!prev.financial_year || prev.financial_year === financialYearFor(prev.invoice_date))) {
        next.financial_year = financialYearFor(value)
      }
      return next
    })
  }

  // Live mirror of the server's derived-field math so the user sees totals update.
  const totals = useMemo(() => {
    const quantity = num(form.quantity)
    const rate = num(form.rate)
    const discount = num(form.discount)
    const base = quantity > 0 && rate > 0 ? quantity * rate : num(form.taxable_amount) + discount
    const taxable = round2(Math.max(base - discount, 0))
    const cgst = round2((taxable * num(form.cgst_percent)) / 100)
    const sgst = round2((taxable * num(form.sgst_percent)) / 100)
    const igst = round2((taxable * num(form.igst_percent)) / 100)
    const cess = round2(num(form.other_tax_cess))
    const invoiceTotal = round2(taxable + cgst + sgst + igst + cess)
    const tdsAmount = form.tds_applicable ? round2((taxable * num(form.tds_rate)) / 100) : 0
    const netReceivable = round2(invoiceTotal - tdsAmount)
    const outstanding = round2(netReceivable - num(form.amount_received))
    return { taxable, cgst, sgst, igst, invoiceTotal, tdsAmount, netReceivable, outstanding }
  }, [form])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!form.invoice_date) return setError("Invoice date is required")
    if (!form.client_name) return setError("Client name is required")
    setLoading(true)
    setError(null)

    const payload = { ...form, id: invoice?.id, tds_applicable: form.tds_applicable ? 1 : 0 }
    try {
      const res = await fetch("/api/finance/sales-invoices", {
        method: invoice ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-3xl">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>{invoice ? `Edit invoice ${invoice.invoice_id}` : "New sales invoice"}</DialogTitle>
            <DialogDescription>
              {invoice
                ? "Update invoice details. Totals, tax and receivable amounts recalculate automatically."
                : "The Invoice ID is generated automatically on save. Totals and taxes are calculated for you."}
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-6 py-4">
            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}

            <Section title="Invoice details">
              <Grid>
                <Field>
                  <FieldLabel htmlFor="invoice_date">Invoice date</FieldLabel>
                  <Input id="invoice_date" type="date" value={form.invoice_date} onChange={(e) => update("invoice_date", e.target.value)} required />
                </Field>
                <SelectField label="Invoice type" value={form.invoice_type || "Tax Invoice"} options={INVOICE_TYPES} onChange={(v) => update("invoice_type", v)} />
                <Field>
                  <FieldLabel htmlFor="financial_year">Financial year</FieldLabel>
                  <Input id="financial_year" placeholder="2026-27" value={form.financial_year} onChange={(e) => update("financial_year", e.target.value)} />
                </Field>
              </Grid>
              <Grid>
                <Field>
                  <FieldLabel htmlFor="client_id">Client ID</FieldLabel>
                  <Input id="client_id" value={form.client_id} onChange={(e) => update("client_id", e.target.value)} />
                </Field>
                <Field>
                  <FieldLabel htmlFor="client_name">Client name</FieldLabel>
                  <Input id="client_name" value={form.client_name} onChange={(e) => update("client_name", e.target.value)} required />
                </Field>
              </Grid>
              <Grid>
                <Field>
                  <FieldLabel htmlFor="project_id">Project ID</FieldLabel>
                  <Input id="project_id" value={form.project_id} onChange={(e) => update("project_id", e.target.value)} />
                </Field>
                <Field>
                  <FieldLabel htmlFor="project_name">Project name</FieldLabel>
                  <Input id="project_name" value={form.project_name} onChange={(e) => update("project_name", e.target.value)} />
                </Field>
              </Grid>
              <Grid>
                <Field>
                  <FieldLabel htmlFor="billing_period_from">Billing period from</FieldLabel>
                  <Input id="billing_period_from" type="date" value={form.billing_period_from} onChange={(e) => update("billing_period_from", e.target.value)} />
                </Field>
                <Field>
                  <FieldLabel htmlFor="billing_period_to">Billing period to</FieldLabel>
                  <Input id="billing_period_to" type="date" value={form.billing_period_to} onChange={(e) => update("billing_period_to", e.target.value)} />
                </Field>
              </Grid>
              <Field>
                <FieldLabel htmlFor="description">Description</FieldLabel>
                <Textarea id="description" rows={2} value={form.description} onChange={(e) => update("description", e.target.value)} />
              </Field>
            </Section>

            <Section title="Line item & taxes">
              <Grid>
                <Field>
                  <FieldLabel htmlFor="hsn_sac">HSN / SAC</FieldLabel>
                  <Input id="hsn_sac" value={form.hsn_sac} onChange={(e) => update("hsn_sac", e.target.value)} />
                </Field>
                <Field>
                  <FieldLabel htmlFor="quantity">Quantity</FieldLabel>
                  <Input id="quantity" type="number" step="any" value={form.quantity} onChange={(e) => update("quantity", e.target.value)} />
                </Field>
                <SelectField label="Unit" value={form.unit || "none"} options={UNITS} allowEmpty emptyLabel="—" onChange={(v) => update("unit", v === "none" ? "" : v)} />
              </Grid>
              <Grid>
                <Field>
                  <FieldLabel htmlFor="rate">Rate</FieldLabel>
                  <Input id="rate" type="number" step="any" value={form.rate} onChange={(e) => update("rate", e.target.value)} />
                </Field>
                <Field>
                  <FieldLabel htmlFor="taxable_amount">Taxable amount (or lump sum)</FieldLabel>
                  <Input id="taxable_amount" type="number" step="any" placeholder="auto from qty × rate" value={form.taxable_amount} onChange={(e) => update("taxable_amount", e.target.value)} />
                </Field>
                <Field>
                  <FieldLabel htmlFor="discount">Discount</FieldLabel>
                  <Input id="discount" type="number" step="any" value={form.discount} onChange={(e) => update("discount", e.target.value)} />
                </Field>
              </Grid>
              <Grid>
                <Field>
                  <FieldLabel htmlFor="cgst_percent">CGST %</FieldLabel>
                  <Input id="cgst_percent" type="number" step="any" value={form.cgst_percent} onChange={(e) => update("cgst_percent", e.target.value)} />
                </Field>
                <Field>
                  <FieldLabel htmlFor="sgst_percent">SGST %</FieldLabel>
                  <Input id="sgst_percent" type="number" step="any" value={form.sgst_percent} onChange={(e) => update("sgst_percent", e.target.value)} />
                </Field>
                <Field>
                  <FieldLabel htmlFor="igst_percent">IGST %</FieldLabel>
                  <Input id="igst_percent" type="number" step="any" value={form.igst_percent} onChange={(e) => update("igst_percent", e.target.value)} />
                </Field>
                <Field>
                  <FieldLabel htmlFor="other_tax_cess">Other tax / cess</FieldLabel>
                  <Input id="other_tax_cess" type="number" step="any" value={form.other_tax_cess} onChange={(e) => update("other_tax_cess", e.target.value)} />
                </Field>
              </Grid>

              <div className="grid grid-cols-2 gap-2 rounded-lg border bg-muted/40 p-4 text-sm sm:grid-cols-3">
                <Computed label="Taxable amount" value={currency(totals.taxable)} />
                <Computed label="CGST amount" value={currency(totals.cgst)} />
                <Computed label="SGST amount" value={currency(totals.sgst)} />
                <Computed label="IGST amount" value={currency(totals.igst)} />
                <Computed label="Invoice total" value={currency(totals.invoiceTotal)} emphasize />
              </div>
            </Section>

            <Section title="TDS & receivable">
              <label className="flex items-center gap-2 text-sm">
                <Checkbox checked={!!form.tds_applicable} onCheckedChange={(c) => update("tds_applicable", c ? "1" : "")} />
                TDS applicable
              </label>
              {!!form.tds_applicable && (
                <Grid>
                  <Field>
                    <FieldLabel htmlFor="tds_section">TDS section</FieldLabel>
                    <Input id="tds_section" placeholder="194J" value={form.tds_section} onChange={(e) => update("tds_section", e.target.value)} />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="tds_rate">TDS rate %</FieldLabel>
                    <Input id="tds_rate" type="number" step="any" value={form.tds_rate} onChange={(e) => update("tds_rate", e.target.value)} />
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
                  <Input id="due_date" type="date" value={form.due_date} onChange={(e) => update("due_date", e.target.value)} />
                </Field>
                <Field>
                  <FieldLabel htmlFor="amount_received">Amount received</FieldLabel>
                  <Input id="amount_received" type="number" step="any" value={form.amount_received} onChange={(e) => update("amount_received", e.target.value)} />
                </Field>
                <SelectField label="Payment status" value={form.payment_status || "auto"} options={PAYMENT_STATUSES} allowEmpty emptyLabel="Auto" onChange={(v) => update("payment_status", v === "auto" ? "" : v)} />
              </Grid>
              <Grid>
                <Field>
                  <FieldLabel htmlFor="payment_date">Payment date</FieldLabel>
                  <Input id="payment_date" type="date" value={form.payment_date} onChange={(e) => update("payment_date", e.target.value)} />
                </Field>
                <Field>
                  <FieldLabel htmlFor="payment_reference">Payment reference</FieldLabel>
                  <Input id="payment_reference" value={form.payment_reference} onChange={(e) => update("payment_reference", e.target.value)} />
                </Field>
              </Grid>
            </Section>

            <Section title="Compliance & notes">
              <Grid>
                <Field>
                  <FieldLabel htmlFor="irn_reference">IRN / E-Invoice reference</FieldLabel>
                  <Input id="irn_reference" value={form.irn_reference} onChange={(e) => update("irn_reference", e.target.value)} />
                </Field>
                <Field>
                  <FieldLabel htmlFor="eway_bill_no">E-Way Bill no.</FieldLabel>
                  <Input id="eway_bill_no" value={form.eway_bill_no} onChange={(e) => update("eway_bill_no", e.target.value)} />
                </Field>
              </Grid>
              <Grid>
                <Field>
                  <FieldLabel htmlFor="credit_debit_note_ref">Credit / Debit note ref.</FieldLabel>
                  <Input id="credit_debit_note_ref" value={form.credit_debit_note_ref} onChange={(e) => update("credit_debit_note_ref", e.target.value)} />
                </Field>
                <SelectField label="Invoice status" value={form.invoice_status || "Draft"} options={INVOICE_STATUSES} onChange={(v) => update("invoice_status", v)} />
              </Grid>
              <Field>
                <FieldLabel htmlFor="notes">Notes</FieldLabel>
                <Textarea id="notes" rows={2} value={form.notes} onChange={(e) => update("notes", e.target.value)} />
              </Field>
            </Section>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={loading}>
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
}: {
  label: string
  value: string
  options: string[]
  onChange: (v: string) => void
  allowEmpty?: boolean
  emptyLabel?: string
}) {
  return (
    <Field>
      <FieldLabel>{label}</FieldLabel>
      <Select value={value} onValueChange={(v) => onChange(v ?? "")}>
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
