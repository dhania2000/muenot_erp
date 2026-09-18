"use client"

import { useState } from "react"
import useSWR from "swr"
import { toast } from "sonner"
import { fetcher } from "@/lib/fetcher"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Separator } from "@/components/ui/separator"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  formatMoney,
  InvoiceStatusBadge,
  StatCard,
  type Invoice,
  type InvoiceView,
  type Payment,
  type Refund,
  type BillingSummary,
} from "./engine-shared"

type ListData = { invoices: Invoice[]; summary: BillingSummary }
type DetailData = { invoice: InvoiceView; payments: Payment[]; refunds: Refund[] }

const INVOICES_KEY = "/api/billing/invoices"

export function InvoiceConsole() {
  const { data, isLoading, mutate } = useSWR<ListData>(INVOICES_KEY, fetcher)
  const [createOpen, setCreateOpen] = useState(false)
  const [openId, setOpenId] = useState<number | null>(null)

  const invoices = data?.invoices ?? []
  const summary = data?.summary
  const cur = summary?.currency ?? "USD"

  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">Invoices</h1>
          <p className="max-w-2xl text-sm text-muted-foreground">
            Generate one-time and recurring invoices with discounts, coupons, tax, account credit and
            adjustments. Finalize, collect payment, and refund — every figure runs through the billing math core.
          </p>
        </div>
        <Button className="shrink-0" onClick={() => setCreateOpen(true)}>
          New invoice
        </Button>
      </header>

      <div className="mt-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label="Outstanding" value={summary ? formatMoney(summary.outstanding, cur) : "—"} hint="Unpaid balance across open invoices" />
        <StatCard label="Collected" value={summary ? formatMoney(summary.collected, cur) : "—"} hint="Payments captured" />
        <StatCard label="Refunded" value={summary ? formatMoney(summary.refunded, cur) : "—"} hint="Returned to customers" />
        <StatCard label="Credit balance" value={summary ? formatMoney(summary.credit_balance, cur) : "—"} hint="Available account credit" />
      </div>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle className="text-base font-medium">All invoices</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="py-16 text-center text-sm text-muted-foreground">Loading invoices…</div>
          ) : invoices.length === 0 ? (
            <div className="flex flex-col items-center gap-3 py-16 text-center">
              <p className="text-sm text-muted-foreground">No invoices yet.</p>
              <Button onClick={() => setCreateOpen(true)}>Create your first invoice</Button>
            </div>
          ) : (
            <div className="overflow-x-auto rounded-md border border-border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Invoice</TableHead>
                    <TableHead>Customer</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead className="text-right">Total</TableHead>
                    <TableHead className="text-right">Balance</TableHead>
                    <TableHead>Due</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {invoices.map((inv) => (
                    <TableRow
                      key={inv.id}
                      className="cursor-pointer"
                      onClick={() => setOpenId(inv.id)}
                    >
                      <TableCell className="font-mono text-xs">{inv.invoice_no}</TableCell>
                      <TableCell className="max-w-[180px] truncate">{inv.customer_name || "—"}</TableCell>
                      <TableCell className="capitalize">{inv.invoice_type.replace("_", " ")}</TableCell>
                      <TableCell className="text-right">{formatMoney(inv.total, inv.currency)}</TableCell>
                      <TableCell className="text-right">{formatMoney(inv.balance, inv.currency)}</TableCell>
                      <TableCell>{inv.due_date ?? "—"}</TableCell>
                      <TableCell><InvoiceStatusBadge status={inv.status} /></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <CreateInvoiceDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={() => {
          setCreateOpen(false)
          mutate()
        }}
      />

      <InvoiceDetailDialog
        invoiceId={openId}
        onClose={() => setOpenId(null)}
        onChanged={() => mutate()}
      />
    </div>
  )
}

type LineDraft = { description: string; quantity: string; unit_amount: string; taxable: boolean }

function CreateInvoiceDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  onCreated: () => void
}) {
  const [customer, setCustomer] = useState("")
  const [lines, setLines] = useState<LineDraft[]>([{ description: "", quantity: "1", unit_amount: "0", taxable: true }])
  const [discountType, setDiscountType] = useState<"none" | "percent" | "fixed">("none")
  const [discountValue, setDiscountValue] = useState("0")
  const [couponCode, setCouponCode] = useState("")
  const [taxRate, setTaxRate] = useState("0")
  const [adjustment, setAdjustment] = useState("0")
  const [applyCredit, setApplyCredit] = useState(false)
  const [dueDate, setDueDate] = useState("")
  const [finalize, setFinalize] = useState(true)
  const [saving, setSaving] = useState(false)

  const subtotal = lines.reduce((s, l) => s + (Number(l.quantity) || 0) * (Number(l.unit_amount) || 0), 0)

  function reset() {
    setCustomer("")
    setLines([{ description: "", quantity: "1", unit_amount: "0", taxable: true }])
    setDiscountType("none")
    setDiscountValue("0")
    setCouponCode("")
    setTaxRate("0")
    setAdjustment("0")
    setApplyCredit(false)
    setDueDate("")
    setFinalize(true)
  }

  function updateLine(i: number, patch: Partial<LineDraft>) {
    setLines((prev) => prev.map((l, idx) => (idx === i ? { ...l, ...patch } : l)))
  }

  async function submit() {
    setSaving(true)
    try {
      const res = await fetch(INVOICES_KEY, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          invoice_type: "one_time",
          customer_name: customer,
          lines: lines.map((l) => ({
            description: l.description,
            quantity: Number(l.quantity) || 0,
            unit_amount: Number(l.unit_amount) || 0,
            taxable: l.taxable,
          })),
          discount_type: discountType === "none" ? null : discountType,
          discount_value: discountType === "none" ? null : Number(discountValue) || 0,
          coupon_code: couponCode.trim() || null,
          tax_rate: Number(taxRate) || 0,
          adjustment: Number(adjustment) || 0,
          apply_credit: applyCredit,
          due_date: dueDate || null,
          finalize,
        }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || "Failed to create invoice")
      toast.success(`Invoice ${json.invoice.invoice_no} created`)
      reset()
      onCreated()
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>New invoice</DialogTitle>
          <DialogDescription>Add line items, then apply discounts, a coupon, tax, credit or an adjustment.</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>Customer</Label>
            <Input value={customer} onChange={(e) => setCustomer(e.target.value)} placeholder="Acme Inc." />
          </div>

          <div className="space-y-2">
            <Label>Line items</Label>
            {lines.map((l, i) => (
              <div key={i} className="grid grid-cols-12 gap-2">
                <Input
                  className="col-span-5"
                  placeholder="Description"
                  value={l.description}
                  onChange={(e) => updateLine(i, { description: e.target.value })}
                />
                <Input
                  className="col-span-2"
                  type="number"
                  placeholder="Qty"
                  value={l.quantity}
                  onChange={(e) => updateLine(i, { quantity: e.target.value })}
                />
                <Input
                  className="col-span-3"
                  type="number"
                  placeholder="Unit price"
                  value={l.unit_amount}
                  onChange={(e) => updateLine(i, { unit_amount: e.target.value })}
                />
                <div className="col-span-2 flex items-center justify-end gap-1">
                  <button
                    type="button"
                    className="text-xs text-muted-foreground hover:text-foreground disabled:opacity-40"
                    disabled={lines.length === 1}
                    onClick={() => setLines((prev) => prev.filter((_, idx) => idx !== i))}
                  >
                    Remove
                  </button>
                </div>
              </div>
            ))}
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setLines((prev) => [...prev, { description: "", quantity: "1", unit_amount: "0", taxable: true }])}
            >
              Add line
            </Button>
          </div>

          <Separator />

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Discount</Label>
              <select
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm"
                value={discountType}
                onChange={(e) => setDiscountType(e.target.value as typeof discountType)}
              >
                <option value="none">None</option>
                <option value="percent">Percent (%)</option>
                <option value="fixed">Fixed amount</option>
              </select>
            </div>
            <div className="space-y-1.5">
              <Label>Discount value</Label>
              <Input
                type="number"
                value={discountValue}
                disabled={discountType === "none"}
                onChange={(e) => setDiscountValue(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Coupon code</Label>
              <Input value={couponCode} onChange={(e) => setCouponCode(e.target.value.toUpperCase())} placeholder="SAVE20" />
            </div>
            <div className="space-y-1.5">
              <Label>Tax rate (%)</Label>
              <Input type="number" value={taxRate} onChange={(e) => setTaxRate(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>Adjustment (+/−)</Label>
              <Input type="number" value={adjustment} onChange={(e) => setAdjustment(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>Due date</Label>
              <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
            </div>
          </div>

          <div className="flex items-center justify-between rounded-md border border-border px-3 py-2">
            <div>
              <Label className="text-sm">Apply account credit</Label>
              <p className="text-xs text-muted-foreground">Use available credit balance to reduce the amount due</p>
            </div>
            <Switch checked={applyCredit} onCheckedChange={setApplyCredit} />
          </div>
          <div className="flex items-center justify-between rounded-md border border-border px-3 py-2">
            <div>
              <Label className="text-sm">Finalize immediately</Label>
              <p className="text-xs text-muted-foreground">Skip draft and open the invoice for payment</p>
            </div>
            <Switch checked={finalize} onCheckedChange={setFinalize} />
          </div>

          <div className="rounded-md bg-muted px-3 py-2 text-sm">
            <span className="text-muted-foreground">Subtotal (before modifiers): </span>
            <span className="font-semibold text-foreground">{formatMoney(subtotal)}</span>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={saving}>
            {saving ? "Creating…" : "Create invoice"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function InvoiceDetailDialog({
  invoiceId,
  onClose,
  onChanged,
}: {
  invoiceId: number | null
  onClose: () => void
  onChanged: () => void
}) {
  const { data, isLoading, mutate } = useSWR<DetailData>(
    invoiceId ? `/api/billing/invoices/${invoiceId}` : null,
    fetcher,
  )
  const [busy, setBusy] = useState(false)
  const [payAmount, setPayAmount] = useState("")
  const [refundAmount, setRefundAmount] = useState("")
  const [refundAsCredit, setRefundAsCredit] = useState(false)

  const inv = data?.invoice
  const payments = data?.payments ?? []
  const refunds = data?.refunds ?? []
  const outstanding = inv ? Math.max(0, inv.total - inv.credit_applied - inv.amount_paid) : 0
  const refundable = inv ? inv.amount_paid - inv.amount_refunded : 0

  async function action(body: Record<string, unknown>, ok: string) {
    if (!invoiceId) return
    setBusy(true)
    try {
      const res = await fetch(`/api/billing/invoices/${invoiceId}/actions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || "Action failed")
      toast.success(ok)
      setPayAmount("")
      setRefundAmount("")
      mutate()
      onChanged()
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={invoiceId != null} onOpenChange={(v) => (!v ? onClose() : null)}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        {isLoading || !inv ? (
          <div className="py-16 text-center text-sm text-muted-foreground">Loading invoice…</div>
        ) : (
          <>
            <DialogHeader>
              <div className="flex items-center gap-2">
                <DialogTitle className="font-mono text-base">{inv.invoice_no}</DialogTitle>
                <InvoiceStatusBadge status={inv.status} />
              </div>
              <DialogDescription>
                {inv.customer_name || "—"} · issued {inv.issue_date}
                {inv.due_date ? ` · due ${inv.due_date}` : ""}
              </DialogDescription>
            </DialogHeader>

            <div className="overflow-x-auto rounded-md border border-border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Description</TableHead>
                    <TableHead className="text-right">Qty</TableHead>
                    <TableHead className="text-right">Unit</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {inv.lines.map((l) => (
                    <TableRow key={l.id}>
                      <TableCell>{l.description}</TableCell>
                      <TableCell className="text-right">{l.quantity}</TableCell>
                      <TableCell className="text-right">{formatMoney(l.unit_amount, inv.currency)}</TableCell>
                      <TableCell className="text-right">{formatMoney(l.amount, inv.currency)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            <div className="ml-auto w-full max-w-xs space-y-1 text-sm">
              <Row label="Subtotal" value={formatMoney(inv.subtotal, inv.currency)} />
              {inv.discount_total > 0 ? (
                <Row label={`Discount${inv.coupon_code ? ` (${inv.coupon_code})` : ""}`} value={`−${formatMoney(inv.discount_total, inv.currency)}`} />
              ) : null}
              {inv.tax_total > 0 ? <Row label={`Tax (${inv.tax_rate}%)`} value={formatMoney(inv.tax_total, inv.currency)} /> : null}
              {inv.adjustment_total !== 0 ? <Row label="Adjustment" value={formatMoney(inv.adjustment_total, inv.currency)} /> : null}
              {inv.credit_applied > 0 ? <Row label="Credit applied" value={`−${formatMoney(inv.credit_applied, inv.currency)}`} /> : null}
              <Separator className="my-1" />
              <Row label="Total" value={formatMoney(inv.total, inv.currency)} strong />
              {inv.amount_paid > 0 ? <Row label="Paid" value={`−${formatMoney(inv.amount_paid, inv.currency)}`} /> : null}
              {inv.amount_refunded > 0 ? <Row label="Refunded" value={formatMoney(inv.amount_refunded, inv.currency)} /> : null}
              <Row label="Balance due" value={formatMoney(inv.balance, inv.currency)} strong />
            </div>

            {payments.length > 0 || refunds.length > 0 ? (
              <div className="space-y-2 text-xs text-muted-foreground">
                {payments.map((p) => (
                  <div key={`p${p.id}`} className="flex justify-between">
                    <span>Payment {p.payment_no} · {p.method}{p.reconciled ? " · reconciled" : ""}</span>
                    <span>{formatMoney(p.amount, p.currency)}</span>
                  </div>
                ))}
                {refunds.map((r) => (
                  <div key={`r${r.id}`} className="flex justify-between">
                    <span>Refund {r.refund_no}{r.reason ? ` · ${r.reason}` : ""}</span>
                    <span>−{formatMoney(r.amount, r.currency)}</span>
                  </div>
                ))}
              </div>
            ) : null}

            <Separator />

            <div className="space-y-3">
              {inv.status === "draft" ? (
                <div className="flex gap-2">
                  <Button size="sm" disabled={busy} onClick={() => action({ action: "finalize" }, "Invoice finalized")}>
                    Finalize
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => action({ action: "void" }, "Invoice voided")}
                  >
                    Void
                  </Button>
                </div>
              ) : null}

              {(inv.status === "open" || inv.status === "partially_paid") && outstanding > 0 ? (
                <div className="flex items-end gap-2">
                  <div className="flex-1 space-y-1.5">
                    <Label className="text-xs">Record payment</Label>
                    <Input
                      type="number"
                      placeholder={`Outstanding ${outstanding.toFixed(2)}`}
                      value={payAmount}
                      onChange={(e) => setPayAmount(e.target.value)}
                    />
                  </div>
                  <Button
                    size="sm"
                    disabled={busy}
                    onClick={() => action({ action: "pay", amount: payAmount ? Number(payAmount) : undefined, method: "manual" }, "Payment recorded")}
                  >
                    Pay
                  </Button>
                </div>
              ) : null}

              {refundable > 0 ? (
                <div className="space-y-2">
                  <div className="flex items-end gap-2">
                    <div className="flex-1 space-y-1.5">
                      <Label className="text-xs">Refund (max {refundable.toFixed(2)})</Label>
                      <Input
                        type="number"
                        placeholder={refundable.toFixed(2)}
                        value={refundAmount}
                        onChange={(e) => setRefundAmount(e.target.value)}
                      />
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => action({ action: "refund", amount: refundAmount ? Number(refundAmount) : undefined, as_credit: refundAsCredit }, "Refund issued")}
                    >
                      Refund
                    </Button>
                  </div>
                  <label className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Switch checked={refundAsCredit} onCheckedChange={setRefundAsCredit} />
                    Issue as account credit instead of cash
                  </label>
                </div>
              ) : null}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex justify-between">
      <span className={strong ? "font-medium text-foreground" : "text-muted-foreground"}>{label}</span>
      <span className={strong ? "font-semibold text-foreground" : "text-foreground"}>{value}</span>
    </div>
  )
}
