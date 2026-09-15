"use client"

import useSWR from "swr"
import { Fragment, useState } from "react"
import { fetcher } from "@/lib/fetcher"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { HandCoins, Trash2, ChevronDown, ChevronRight } from "lucide-react"
import { currency, Stat, StatusBadge, type Direction } from "./shared"

type CustomerRow = {
  party_id: string
  customer: string
  pan: string
  base: number
  tds: number
  received: number
  adjusted: number
  outstanding: number
  invoices: number
}
type InvoiceRow = {
  party_id: string
  customer: string
  invoice_id: string
  invoice_ref: string
  source_module: string
  invoice_date: string
  quarter: string
  pan: string
  section: string
  base: number
  tds: number
  received: number
  adjusted: number
  outstanding: number
  certificate_ref: string | null
  status: string
}
type Receipt = {
  receipt_id: string
  party_name: string | null
  invoice_ref: string | null
  mode: string
  amount: number
  receipt_date: string | null
  certificate_ref: string | null
}
type LedgerData = {
  rows: InvoiceRow[]
  customers: CustomerRow[]
  receipts: Receipt[]
  totals: {
    receivable: number
    received: number
    adjusted: number
    outstanding: number
    invoice_count: number
    customer_count: number
  }
}

export function CustomerTdsStage({ fy }: { direction: Direction; fy: string }) {
  const { data, mutate } = useSWR<LedgerData>(`/api/finance/tds/receivable?fy=${fy}`, fetcher)
  const [openParty, setOpenParty] = useState<string | null>(null)
  const [record, setRecord] = useState<InvoiceRow | null>(null)

  const customers = data?.customers ?? []
  const rows = data?.rows ?? []
  const totals = data?.totals

  return (
    <div className="flex flex-col gap-6">
      <p className="text-sm text-muted-foreground">
        The credit side of TDS. TDS your <strong>customers deduct</strong> on your sales invoices is derived per
        invoice, then reconciled against credits you actually <strong>received</strong> or <strong>adjusted</strong>{" "}
        against advance tax — so any outstanding Form 16A / 26AS credit stays visible.
      </p>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="TDS receivable" value={currency(totals?.receivable)} hint={`${totals?.invoice_count ?? 0} invoices`} />
        <Stat label="Received" value={currency(totals?.received)} />
        <Stat label="Adjusted" value={currency(totals?.adjusted)} />
        <Stat label="Outstanding" value={currency(totals?.outstanding)} hint={`${totals?.customer_count ?? 0} customers`} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <HandCoins className="h-4 w-4" />
            Customer TDS ledger · FY {fy}
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-8" />
                  <TableHead>Customer</TableHead>
                  <TableHead>PAN</TableHead>
                  <TableHead className="text-right">Base</TableHead>
                  <TableHead className="text-right">TDS</TableHead>
                  <TableHead className="text-right">Received</TableHead>
                  <TableHead className="text-right">Adjusted</TableHead>
                  <TableHead className="text-right">Outstanding</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {customers.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={8} className="py-8 text-center text-sm text-muted-foreground">
                      No customer TDS credits for this financial year.
                    </TableCell>
                  </TableRow>
                ) : (
                  customers.map((c) => {
                    const isOpen = openParty === c.party_id
                    const invoices = rows.filter((r) => r.party_id === c.party_id)
                    return (
                      <Fragment key={c.party_id || c.customer}>
                        <TableRow className="cursor-pointer" onClick={() => setOpenParty(isOpen ? null : c.party_id)}>
                          <TableCell>
                            {isOpen ? (
                              <ChevronDown className="h-4 w-4 text-muted-foreground" />
                            ) : (
                              <ChevronRight className="h-4 w-4 text-muted-foreground" />
                            )}
                          </TableCell>
                          <TableCell className="font-medium">
                            {c.customer}
                            <span className="ml-2 text-xs text-muted-foreground">{c.invoices} inv</span>
                          </TableCell>
                          <TableCell className="font-mono text-xs">
                            {c.pan || <span className="text-destructive">No PAN</span>}
                          </TableCell>
                          <TableCell className="text-right">{currency(c.base)}</TableCell>
                          <TableCell className="text-right">{currency(c.tds)}</TableCell>
                          <TableCell className="text-right text-emerald-600">{currency(c.received)}</TableCell>
                          <TableCell className="text-right text-muted-foreground">{currency(c.adjusted)}</TableCell>
                          <TableCell className="text-right font-medium">
                            <span className={c.outstanding > 0.5 ? "text-amber-600" : "text-emerald-600"}>
                              {currency(c.outstanding)}
                            </span>
                          </TableCell>
                        </TableRow>
                        {isOpen ? (
                          <TableRow>
                            <TableCell colSpan={8} className="bg-muted/30 p-0">
                              <div className="px-4 py-3">
                                <Table>
                                  <TableHeader>
                                    <TableRow>
                                      <TableHead className="h-8 text-xs">Invoice</TableHead>
                                      <TableHead className="h-8 text-xs">Date</TableHead>
                                      <TableHead className="h-8 text-xs">Section</TableHead>
                                      <TableHead className="h-8 text-right text-xs">TDS</TableHead>
                                      <TableHead className="h-8 text-right text-xs">Received</TableHead>
                                      <TableHead className="h-8 text-right text-xs">Outstanding</TableHead>
                                      <TableHead className="h-8 text-xs">Certificate</TableHead>
                                      <TableHead className="h-8 text-xs">Status</TableHead>
                                      <TableHead className="h-8 w-8" />
                                    </TableRow>
                                  </TableHeader>
                                  <TableBody>
                                    {invoices.map((r) => (
                                      <TableRow key={r.invoice_id}>
                                        <TableCell className="font-mono text-xs">{r.invoice_ref}</TableCell>
                                        <TableCell className="text-xs">{r.invoice_date}</TableCell>
                                        <TableCell className="text-xs">{r.section}</TableCell>
                                        <TableCell className="text-right text-xs">{currency(r.tds)}</TableCell>
                                        <TableCell className="text-right text-xs text-emerald-600">
                                          {currency(r.received + r.adjusted)}
                                        </TableCell>
                                        <TableCell className="text-right text-xs">{currency(r.outstanding)}</TableCell>
                                        <TableCell className="font-mono text-xs">{r.certificate_ref || "—"}</TableCell>
                                        <TableCell className="text-xs">
                                          <StatusBadge status={r.status} />
                                        </TableCell>
                                        <TableCell>
                                          <Button
                                            size="sm"
                                            variant="ghost"
                                            className="h-7 text-xs"
                                            onClick={() => setRecord(r)}
                                            disabled={r.outstanding <= 0.5}
                                          >
                                            Record
                                          </Button>
                                        </TableCell>
                                      </TableRow>
                                    ))}
                                  </TableBody>
                                </Table>
                              </div>
                            </TableCell>
                          </TableRow>
                        ) : null}
                      </Fragment>
                    )
                  })
                )}
              </TableBody>
              {customers.length > 0 ? (
                <TableFooter>
                  <TableRow>
                    <TableCell />
                    <TableCell className="font-medium">Total</TableCell>
                    <TableCell />
                    <TableCell className="text-right font-medium">
                      {currency(customers.reduce((s, c) => s + c.base, 0))}
                    </TableCell>
                    <TableCell className="text-right font-medium">{currency(totals?.receivable)}</TableCell>
                    <TableCell className="text-right font-medium">{currency(totals?.received)}</TableCell>
                    <TableCell className="text-right font-medium">{currency(totals?.adjusted)}</TableCell>
                    <TableCell className="text-right font-medium">{currency(totals?.outstanding)}</TableCell>
                  </TableRow>
                </TableFooter>
              ) : null}
            </Table>
          </div>
        </CardContent>
      </Card>

      {record ? (
        <RecordReceiptDialog
          fy={fy}
          invoice={record}
          onClose={() => setRecord(null)}
          onSaved={() => {
            setRecord(null)
            mutate()
          }}
        />
      ) : null}
    </div>
  )
}

function RecordReceiptDialog({
  fy,
  invoice,
  onClose,
  onSaved,
}: {
  fy: string
  invoice: InvoiceRow
  onClose: () => void
  onSaved: () => void
}) {
  const [mode, setMode] = useState<"Received" | "Adjusted">("Received")
  const [amount, setAmount] = useState(String(invoice.outstanding))
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10))
  const [certRef, setCertRef] = useState(invoice.certificate_ref ?? "")
  const [note, setNote] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")

  async function save() {
    setBusy(true)
    setError("")
    try {
      const res = await fetch("/api/finance/tds/receivable", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          financial_year: fy,
          party_id: invoice.party_id,
          party_name: invoice.customer,
          pan: invoice.pan,
          section: invoice.section,
          source_module: invoice.source_module,
          source_txn_id: invoice.invoice_id,
          invoice_ref: invoice.invoice_ref,
          mode,
          amount: Number(amount || 0),
          receipt_date: date,
          certificate_ref: certRef,
          note,
        }),
      })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error || "Could not record credit")
      onSaved()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      onClick={onClose}
    >
      <Card className="w-full max-w-md" onClick={(e) => e.stopPropagation()}>
        <CardHeader>
          <CardTitle className="text-base">Record TDS credit · {invoice.invoice_ref}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <p className="text-xs text-muted-foreground">
            {invoice.customer} · Section {invoice.section} · TDS {currency(invoice.tds)} · Outstanding{" "}
            {currency(invoice.outstanding)}
          </p>
          {error ? <p className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</p> : null}
          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1.5 text-xs text-muted-foreground">
              Mode
              <select
                value={mode}
                onChange={(e) => setMode(e.target.value as "Received" | "Adjusted")}
                className="h-9 rounded-md border border-input bg-background px-3 text-sm text-foreground"
              >
                <option value="Received">Received</option>
                <option value="Adjusted">Adjusted (advance tax)</option>
              </select>
            </label>
            <label className="flex flex-col gap-1.5 text-xs text-muted-foreground">
              Amount
              <Input type="number" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
            </label>
            <label className="flex flex-col gap-1.5 text-xs text-muted-foreground">
              Date
              <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </label>
            <label className="flex flex-col gap-1.5 text-xs text-muted-foreground">
              Certificate ref (16A)
              <Input value={certRef} onChange={(e) => setCertRef(e.target.value)} placeholder="Form 16A / 26AS" />
            </label>
          </div>
          <label className="flex flex-col gap-1.5 text-xs text-muted-foreground">
            Note
            <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional" />
          </label>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={save} disabled={busy || Number(amount || 0) <= 0}>
              {busy ? "Saving…" : "Record credit"}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
