"use client"

import useSWR from "swr"
import { useMemo, useState } from "react"
import { fetcher } from "@/lib/fetcher"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent } from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Plus, FilterX, Receipt, Wallet, TrendingUp, Clock, Pencil, Eye, Trash2 } from "lucide-react"
import { SalesInvoiceDialog } from "@/components/finance/sales-invoice-dialog"

export type InvoiceRow = {
  id: number
  invoice_id: string
  invoice_date: string | null
  invoice_type: string | null
  financial_year: string | null
  client_id: string | null
  client_name: string | null
  project_id: string | null
  project_name: string | null
  billing_period_from: string | null
  billing_period_to: string | null
  description: string | null
  hsn_sac: string | null
  quantity: number
  unit: string | null
  rate: number
  taxable_amount: number
  discount: number
  cgst_percent: number
  cgst_amount: number
  sgst_percent: number
  sgst_amount: number
  igst_percent: number
  igst_amount: number
  other_tax_cess: number
  invoice_total: number
  tds_applicable: number
  tds_section: string | null
  tds_rate: number
  tds_amount: number
  net_receivable: number
  due_date: string | null
  amount_received: number
  outstanding_amount: number
  payment_status: string
  payment_date: string | null
  payment_reference: string | null
  irn_reference: string | null
  eway_bill_no: string | null
  credit_debit_note_ref: string | null
  notes: string | null
  invoice_status: string
  created_by_name: string | null
  created_at: string | null
  updated_at: string | null
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
]

const currency = (n: any) =>
  new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(Number(n) || 0)

const PAYMENT_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  Paid: "default",
  "Partially Paid": "secondary",
  Unpaid: "outline",
  Overdue: "destructive",
}
const STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  Issued: "default",
  Sent: "default",
  Draft: "secondary",
  Cancelled: "destructive",
}

const emptyFilters = {
  search: "", year: "", month: "", financial_year: "", invoice_status: "", payment_status: "", date_from: "", date_to: "",
}

export function SalesInvoicesClient() {
  const [filters, setFilters] = useState(emptyFilters)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<InvoiceRow | null>(null)
  const [viewing, setViewing] = useState<InvoiceRow | null>(null)

  const queryKey = useMemo(() => {
    const params = new URLSearchParams()
    for (const [k, v] of Object.entries(filters)) if (v) params.set(k, v)
    return `/api/finance/sales-invoices?${params.toString()}`
  }, [filters])

  const { data, mutate } = useSWR<{ rows: InvoiceRow[]; summary: any; filterOptions: any }>(queryKey, fetcher)

  const rows = data?.rows ?? []
  const summary = data?.summary ?? {}
  const filterOptions = data?.filterOptions ?? { years: [], financialYears: [], statuses: [] }
  const activeFilterCount = Object.values(filters).filter(Boolean).length

  const kpis = [
    { label: "Total Billed", value: currency(summary.total_billed), icon: Receipt },
    { label: "Net Receivable", value: currency(summary.total_receivable), icon: TrendingUp },
    { label: "Received", value: currency(summary.total_received), icon: Wallet },
    { label: "Outstanding", value: currency(summary.total_outstanding), icon: Clock },
  ]

  function openNew() {
    setEditing(null)
    setDialogOpen(true)
  }
  function openEdit(row: InvoiceRow) {
    setEditing(row)
    setDialogOpen(true)
  }
  async function remove(row: InvoiceRow) {
    if (!confirm(`Delete invoice ${row.invoice_id}? This cannot be undone.`)) return
    await fetch(`/api/finance/sales-invoices?id=${row.id}`, { method: "DELETE" })
    mutate()
  }

  return (
    <main className="space-y-8 p-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-sm text-muted-foreground">Finance management</p>
          <h1 className="text-3xl font-semibold tracking-tight">Sales Invoices</h1>
        </div>
        <Button onClick={openNew}>
          <Plus data-icon="inline-start" />
          New invoice
        </Button>
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
        <CardContent className="grid gap-3 pt-6 sm:grid-cols-2 lg:grid-cols-4">
          <Input
            placeholder="Search invoice, client, project..."
            value={filters.search}
            onChange={(e) => setFilters((f) => ({ ...f, search: e.target.value }))}
            className="lg:col-span-2"
          />
          <select className="h-10 rounded-md border bg-background px-3 text-sm" aria-label="Financial year"
            value={filters.financial_year} onChange={(e) => setFilters((f) => ({ ...f, financial_year: e.target.value }))}>
            <option value="">All financial years</option>
            {filterOptions.financialYears.map((fy: string) => <option key={fy} value={fy}>{fy}</option>)}
          </select>
          <select className="h-10 rounded-md border bg-background px-3 text-sm" aria-label="Month"
            value={filters.month} onChange={(e) => setFilters((f) => ({ ...f, month: e.target.value }))}>
            <option value="">All months</option>
            {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
          </select>
          <select className="h-10 rounded-md border bg-background px-3 text-sm" aria-label="Invoice status"
            value={filters.invoice_status} onChange={(e) => setFilters((f) => ({ ...f, invoice_status: e.target.value }))}>
            <option value="">All invoice statuses</option>
            {["Draft", "Issued", "Sent", "Cancelled"].map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <select className="h-10 rounded-md border bg-background px-3 text-sm" aria-label="Payment status"
            value={filters.payment_status} onChange={(e) => setFilters((f) => ({ ...f, payment_status: e.target.value }))}>
            <option value="">All payment statuses</option>
            {["Unpaid", "Partially Paid", "Paid", "Overdue"].map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <div className="flex items-center gap-2">
            <Input type="date" aria-label="From date" value={filters.date_from} onChange={(e) => setFilters((f) => ({ ...f, date_from: e.target.value }))} />
            <span className="text-xs text-muted-foreground">to</span>
            <Input type="date" aria-label="To date" value={filters.date_to} onChange={(e) => setFilters((f) => ({ ...f, date_to: e.target.value }))} />
          </div>
          {activeFilterCount > 0 && (
            <Button variant="ghost" size="sm" className="justify-self-start" onClick={() => setFilters(emptyFilters)}>
              <FilterX data-icon="inline-start" />
              Clear filters ({activeFilterCount})
            </Button>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-6">
          <div className="mb-3 flex items-center justify-between">
            <span className="text-sm font-medium">Invoices</span>
            <Badge variant="secondary">{rows.length} records</Badge>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  <th className="p-2 font-medium">Invoice ID</th>
                  <th className="p-2 font-medium">Date</th>
                  <th className="p-2 font-medium">Client</th>
                  <th className="p-2 font-medium">Type</th>
                  <th className="p-2 text-right font-medium">Invoice Total</th>
                  <th className="p-2 text-right font-medium">Net Receivable</th>
                  <th className="p-2 text-right font-medium">Outstanding</th>
                  <th className="p-2 font-medium">Payment</th>
                  <th className="p-2 font-medium">Status</th>
                  <th className="p-2 text-right font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={10} className="p-6 text-center text-muted-foreground">
                      No invoices match the current filters.
                    </td>
                  </tr>
                )}
                {rows.map((row) => (
                  <tr key={row.id} className="border-b hover:bg-muted/40">
                    <td className="p-2 font-mono text-xs">{row.invoice_id}</td>
                    <td className="p-2">{row.invoice_date || "—"}</td>
                    <td className="p-2">
                      <div className="font-medium">{row.client_name || "—"}</div>
                      {row.project_name && <div className="text-xs text-muted-foreground">{row.project_name}</div>}
                    </td>
                    <td className="p-2">{row.invoice_type || "—"}</td>
                    <td className="p-2 text-right">{currency(row.invoice_total)}</td>
                    <td className="p-2 text-right">{currency(row.net_receivable)}</td>
                    <td className="p-2 text-right">{currency(row.outstanding_amount)}</td>
                    <td className="p-2">
                      <Badge variant={PAYMENT_VARIANT[row.payment_status] ?? "outline"}>{row.payment_status}</Badge>
                    </td>
                    <td className="p-2">
                      <Badge variant={STATUS_VARIANT[row.invoice_status] ?? "outline"}>{row.invoice_status}</Badge>
                    </td>
                    <td className="p-2">
                      <div className="flex items-center justify-end gap-1">
                        <Button variant="ghost" size="icon" aria-label="View" onClick={() => setViewing(row)}>
                          <Eye className="size-4" />
                        </Button>
                        <Button variant="ghost" size="icon" aria-label="Edit" onClick={() => openEdit(row)}>
                          <Pencil className="size-4" />
                        </Button>
                        <Button variant="ghost" size="icon" aria-label="Delete" onClick={() => remove(row)}>
                          <Trash2 className="size-4" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      <SalesInvoiceDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        invoice={editing}
        onSaved={() => {
          setDialogOpen(false)
          mutate()
        }}
      />

      <InvoiceDetailDialog invoice={viewing} onClose={() => setViewing(null)} />
    </main>
  )
}

function InvoiceDetailDialog({ invoice, onClose }: { invoice: InvoiceRow | null; onClose: () => void }) {
  const money = (n: any) =>
    new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 }).format(Number(n) || 0)

  return (
    <Dialog open={!!invoice} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-2xl">
        {invoice && (
          <>
            <DialogHeader>
              <DialogTitle className="font-mono">{invoice.invoice_id}</DialogTitle>
              <DialogDescription>
                {invoice.invoice_type} · {invoice.financial_year || "—"} · created by {invoice.created_by_name || "—"}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-5 py-2 text-sm">
              <DetailSection title="Client & project" items={[
                ["Client ID", invoice.client_id],
                ["Client name", invoice.client_name],
                ["Project ID", invoice.project_id],
                ["Project name", invoice.project_name],
                ["Billing from", invoice.billing_period_from],
                ["Billing to", invoice.billing_period_to],
                ["Description", invoice.description],
              ]} />
              <DetailSection title="Line & tax" items={[
                ["HSN / SAC", invoice.hsn_sac],
                ["Quantity", invoice.quantity],
                ["Unit", invoice.unit],
                ["Rate", money(invoice.rate)],
                ["Discount", money(invoice.discount)],
                ["Taxable amount", money(invoice.taxable_amount)],
                ["CGST", `${invoice.cgst_percent}% · ${money(invoice.cgst_amount)}`],
                ["SGST", `${invoice.sgst_percent}% · ${money(invoice.sgst_amount)}`],
                ["IGST", `${invoice.igst_percent}% · ${money(invoice.igst_amount)}`],
                ["Other tax / cess", money(invoice.other_tax_cess)],
                ["Invoice total", money(invoice.invoice_total)],
              ]} />
              <DetailSection title="TDS & receivable" items={[
                ["TDS applicable", invoice.tds_applicable ? "Yes" : "No"],
                ["TDS section", invoice.tds_section],
                ["TDS rate", `${invoice.tds_rate}%`],
                ["TDS amount", money(invoice.tds_amount)],
                ["Net receivable", money(invoice.net_receivable)],
                ["Outstanding", money(invoice.outstanding_amount)],
              ]} />
              <DetailSection title="Payment" items={[
                ["Due date", invoice.due_date],
                ["Amount received", money(invoice.amount_received)],
                ["Payment status", invoice.payment_status],
                ["Payment date", invoice.payment_date],
                ["Payment reference", invoice.payment_reference],
              ]} />
              <DetailSection title="Compliance" items={[
                ["IRN / E-Invoice", invoice.irn_reference],
                ["E-Way Bill no.", invoice.eway_bill_no],
                ["Credit/Debit note ref.", invoice.credit_debit_note_ref],
                ["Invoice status", invoice.invoice_status],
                ["Notes", invoice.notes],
                ["Last updated", invoice.updated_at],
              ]} />
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

function DetailSection({ title, items }: { title: string; items: [string, any][] }) {
  return (
    <div>
      <h3 className="mb-2 text-sm font-semibold">{title}</h3>
      <dl className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
        {items.map(([label, value]) => (
          <div key={label} className="flex justify-between gap-4 border-b border-dashed py-1">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="text-right font-medium">{value === null || value === undefined || value === "" ? "—" : String(value)}</dd>
          </div>
        ))}
      </dl>
    </div>
  )
}
