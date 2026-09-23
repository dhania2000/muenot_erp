"use client"

import { useState } from "react"
import useSWR from "swr"
import { toast } from "sonner"
import { fetcher } from "@/lib/fetcher"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { formatMoney, InvoiceStatusBadge, StatCard, type Invoice, type BillingSummary } from "./engine-shared"

type ListData = { invoices: Invoice[]; summary: BillingSummary }

/**
 * Recurring billing runner. Kicks off a billing cycle that generates
 * an invoice for every active subscription whose current period is not yet
 * invoiced (idempotent per subscription+period), then shows the resulting
 * invoice book and money summary.
 */
export function BillingRunConsole() {
  const { data, isLoading, mutate } = useSWR<ListData>("/api/billing/invoices", fetcher)
  const [taxRate, setTaxRate] = useState("0")
  const [running, setRunning] = useState(false)

  const invoices = data?.invoices ?? []
  const summary = data?.summary
  const cur = summary?.currency ?? "USD"
  const recurring = invoices.filter((i) => i.invoice_type === "recurring")

  async function runBilling() {
    setRunning(true)
    try {
      const res = await fetch("/api/billing/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tax_rate: Number(taxRate) || 0 }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || "Billing run failed")
      const generated = json.generated ?? 0
      const skipped = json.skipped ?? 0
      toast.success(`Billing run complete — ${generated} invoice(s) generated, ${skipped} skipped`)
      mutate()
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">Billing</h1>
        <p className="max-w-2xl text-sm text-muted-foreground">
          Run the recurring billing cycle to generate invoices for active subscriptions, and monitor MRR,
          collections and outstanding balances across the whole invoice book.
        </p>
      </header>

      <div className="mt-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label="MRR" value={summary ? formatMoney(summary.mrr, cur) : "—"} hint="Monthly recurring revenue" />
        <StatCard label="Outstanding" value={summary ? formatMoney(summary.outstanding, cur) : "—"} />
        <StatCard label="Collected" value={summary ? formatMoney(summary.collected, cur) : "—"} />
        <StatCard label="Active coupons" value={summary ? String(summary.coupons_active) : "—"} />
      </div>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle className="text-base font-medium">Run recurring billing</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <div className="w-full space-y-1.5 sm:max-w-[180px]">
              <Label>Tax rate (%)</Label>
              <Input type="number" value={taxRate} onChange={(e) => setTaxRate(e.target.value)} />
            </div>
            <Button onClick={runBilling} disabled={running}>
              {running ? "Running…" : "Run billing cycle"}
            </Button>
            <p className="text-xs text-muted-foreground sm:ml-2 sm:pb-2">
              Generates one invoice per active subscription for the current period. Safe to run repeatedly.
            </p>
          </div>
        </CardContent>
      </Card>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle className="text-base font-medium">Recurring invoices</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="py-16 text-center text-sm text-muted-foreground">Loading…</div>
          ) : recurring.length === 0 ? (
            <div className="py-16 text-center text-sm text-muted-foreground">
              No recurring invoices yet. Run a billing cycle to generate them.
            </div>
          ) : (
            <div className="overflow-x-auto rounded-md border border-border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Invoice</TableHead>
                    <TableHead>Customer</TableHead>
                    <TableHead>Period</TableHead>
                    <TableHead className="text-right">Total</TableHead>
                    <TableHead className="text-right">Balance</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {recurring.map((inv) => (
                    <TableRow key={inv.id}>
                      <TableCell className="font-mono text-xs">{inv.invoice_no}</TableCell>
                      <TableCell className="max-w-[160px] truncate">{inv.customer_name || "—"}</TableCell>
                      <TableCell className="text-xs">
                        {inv.period_start && inv.period_end ? `${inv.period_start} → ${inv.period_end}` : "—"}
                      </TableCell>
                      <TableCell className="text-right">{formatMoney(inv.total, inv.currency)}</TableCell>
                      <TableCell className="text-right">{formatMoney(inv.balance, inv.currency)}</TableCell>
                      <TableCell><InvoiceStatusBadge status={inv.status} /></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
