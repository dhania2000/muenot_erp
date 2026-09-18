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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { formatMoney, Pill, StatCard, type Refund, type Invoice } from "./engine-shared"

const KEY = "/api/billing/refunds"

const TONE: Record<string, string> = {
  succeeded: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  pending: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  failed: "bg-red-500/15 text-red-600 dark:text-red-400",
}

export function RefundConsole() {
  const { data, isLoading, mutate } = useSWR<{ refunds: Refund[] }>(KEY, fetcher)
  const [open, setOpen] = useState(false)
  const refunds = data?.refunds ?? []
  const total = refunds.filter((r) => r.status === "succeeded").reduce((s, r) => s + r.amount, 0)

  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">Refunds</h1>
          <p className="max-w-2xl text-sm text-muted-foreground">
            Issue full or partial refunds against paid invoices, as cash or account credit. Refunds are capped at
            the captured, not-yet-refunded amount and update the invoice status automatically.
          </p>
        </div>
        <Button className="shrink-0" onClick={() => setOpen(true)}>
          Issue refund
        </Button>
      </header>

      <div className="mt-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label="Total refunded" value={formatMoney(total)} hint="Succeeded refunds" />
        <StatCard label="Refund count" value={String(refunds.length)} />
        <StatCard label="Pending" value={String(refunds.filter((r) => r.status === "pending").length)} />
        <StatCard label="Failed" value={String(refunds.filter((r) => r.status === "failed").length)} />
      </div>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle className="text-base font-medium">All refunds</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="py-16 text-center text-sm text-muted-foreground">Loading refunds…</div>
          ) : refunds.length === 0 ? (
            <div className="flex flex-col items-center gap-3 py-16 text-center">
              <p className="text-sm text-muted-foreground">No refunds issued yet.</p>
              <Button onClick={() => setOpen(true)}>Issue a refund</Button>
            </div>
          ) : (
            <div className="overflow-x-auto rounded-md border border-border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Refund</TableHead>
                    <TableHead>Invoice</TableHead>
                    <TableHead>Customer</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                    <TableHead>Reason</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Date</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {refunds.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell className="font-mono text-xs">{r.refund_no}</TableCell>
                      <TableCell className="font-mono text-xs">{r.invoice_no ?? "—"}</TableCell>
                      <TableCell className="max-w-[160px] truncate">{r.customer_name ?? "—"}</TableCell>
                      <TableCell className="text-right">{formatMoney(r.amount, r.currency)}</TableCell>
                      <TableCell className="max-w-[200px] truncate">{r.reason ?? "—"}</TableCell>
                      <TableCell>
                        <Pill tone={TONE[r.status]}>{r.status}</Pill>
                      </TableCell>
                      <TableCell>{(r.refunded_at ?? r.created_at)?.slice(0, 10)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <IssueRefundDialog open={open} onOpenChange={setOpen} onDone={() => { setOpen(false); mutate() }} />
    </div>
  )
}

function IssueRefundDialog({
  open,
  onOpenChange,
  onDone,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  onDone: () => void
}) {
  const { data } = useSWR<{ invoices: Invoice[] }>(open ? "/api/billing/invoices" : null, fetcher)
  const [invoiceId, setInvoiceId] = useState("")
  const [amount, setAmount] = useState("")
  const [reason, setReason] = useState("")
  const [asCredit, setAsCredit] = useState(false)
  const [saving, setSaving] = useState(false)

  const refundable = (data?.invoices ?? []).filter((i) => i.amount_paid - i.amount_refunded > 0)
  const selected = refundable.find((i) => String(i.id) === invoiceId) ?? null
  const max = selected ? selected.amount_paid - selected.amount_refunded : 0

  async function submit() {
    if (!invoiceId) {
      toast.error("Select an invoice")
      return
    }
    setSaving(true)
    try {
      const res = await fetch(KEY, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          invoice_id: Number(invoiceId),
          amount: amount ? Number(amount) : undefined,
          reason: reason || null,
          as_credit: asCredit,
        }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || "Failed to issue refund")
      toast.success(`Refund ${json.refund.refund_no} issued`)
      setInvoiceId("")
      setAmount("")
      setReason("")
      setAsCredit(false)
      onDone()
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Issue refund</DialogTitle>
          <DialogDescription>Refund a paid invoice as cash or account credit.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>Invoice</Label>
            <select
              className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm"
              value={invoiceId}
              onChange={(e) => { setInvoiceId(e.target.value); setAmount("") }}
            >
              <option value="">Select a paid invoice…</option>
              {refundable.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.invoice_no} · {i.customer_name || "—"} · {formatMoney(i.amount_paid - i.amount_refunded, i.currency)} refundable
                </option>
              ))}
            </select>
            {refundable.length === 0 ? (
              <p className="text-xs text-muted-foreground">No invoices with captured payments to refund.</p>
            ) : null}
          </div>
          <div className="space-y-1.5">
            <Label>Amount</Label>
            <Input
              type="number"
              placeholder={selected ? `Max ${max.toFixed(2)} (blank = full)` : "Select an invoice first"}
              value={amount}
              disabled={!selected}
              onChange={(e) => setAmount(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label>Reason</Label>
            <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Customer request" />
          </div>
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            <Switch checked={asCredit} onCheckedChange={setAsCredit} />
            Issue as account credit instead of cash
          </label>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={saving || !selected}>
            {saving ? "Refunding…" : "Issue refund"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
