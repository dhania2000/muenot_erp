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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { formatMoney, Pill, StatCard, type ReconEntry } from "./engine-shared"

const KEY = "/api/billing/reconciliation"

export function ReconciliationConsole() {
  const { data, isLoading, mutate } = useSWR<{ entries: ReconEntry[] }>(KEY, fetcher)
  const [open, setOpen] = useState(false)
  const entries = data?.entries ?? []
  const matched = entries.filter((e) => e.status === "matched")
  const unmatched = entries.filter((e) => e.status === "unmatched")
  const matchedTotal = matched.reduce((s, e) => s + e.amount, 0)

  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">Payment Reconciliation</h1>
          <p className="max-w-2xl text-sm text-muted-foreground">
            Ingest gateway settlement lines and auto-match them to captured payments by reference or exact amount.
            Matched lines flag their payment as reconciled; unmatched lines are flagged for review.
          </p>
        </div>
        <Button className="shrink-0" onClick={() => setOpen(true)}>
          Ingest settlement
        </Button>
      </header>

      <div className="mt-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label="Settlement lines" value={String(entries.length)} />
        <StatCard label="Matched" value={String(matched.length)} hint={formatMoney(matchedTotal)} />
        <StatCard label="Unmatched" value={String(unmatched.length)} hint="Need review" />
        <StatCard
          label="Match rate"
          value={entries.length ? `${Math.round((matched.length / entries.length) * 100)}%` : "—"}
        />
      </div>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle className="text-base font-medium">Settlement lines</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="py-16 text-center text-sm text-muted-foreground">Loading reconciliation…</div>
          ) : entries.length === 0 ? (
            <div className="flex flex-col items-center gap-3 py-16 text-center">
              <p className="text-sm text-muted-foreground">No settlement lines yet.</p>
              <Button onClick={() => setOpen(true)}>Ingest a settlement</Button>
            </div>
          ) : (
            <div className="overflow-x-auto rounded-md border border-border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Statement</TableHead>
                    <TableHead>Gateway</TableHead>
                    <TableHead>Payout ref</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                    <TableHead>Invoice</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {entries.map((e) => (
                    <TableRow key={e.id}>
                      <TableCell className="font-mono text-xs">{e.statement_ref}</TableCell>
                      <TableCell className="capitalize">{e.gateway || "—"}</TableCell>
                      <TableCell className="font-mono text-xs">{e.payout_ref ?? "—"}</TableCell>
                      <TableCell className="text-right">{formatMoney(e.amount, e.currency)}</TableCell>
                      <TableCell className="font-mono text-xs">{e.invoice_no ?? "—"}</TableCell>
                      <TableCell>
                        {e.status === "matched" ? (
                          <Pill tone="bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">Matched</Pill>
                        ) : (
                          <Pill tone="bg-amber-500/15 text-amber-600 dark:text-amber-400">Unmatched</Pill>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <IngestDialog open={open} onOpenChange={setOpen} onDone={() => { setOpen(false); mutate() }} />
    </div>
  )
}

function IngestDialog({
  open,
  onOpenChange,
  onDone,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  onDone: () => void
}) {
  const [statementRef, setStatementRef] = useState("")
  const [gateway, setGateway] = useState("stripe")
  const [payoutRef, setPayoutRef] = useState("")
  const [amount, setAmount] = useState("0")
  const [paymentReference, setPaymentReference] = useState("")
  const [saving, setSaving] = useState(false)

  async function submit() {
    setSaving(true)
    try {
      const res = await fetch(KEY, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          statement_ref: statementRef || undefined,
          gateway,
          payout_ref: payoutRef || null,
          amount: Number(amount) || 0,
          payment_reference: paymentReference || null,
        }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || "Failed to ingest")
      toast.success(json.entry.status === "matched" ? "Settlement matched to a payment" : "Settlement recorded (unmatched)")
      setStatementRef("")
      setPayoutRef("")
      setAmount("0")
      setPaymentReference("")
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
          <DialogTitle>Ingest settlement</DialogTitle>
          <DialogDescription>
            Record a gateway settlement line. It auto-matches to a captured payment by reference, then by exact amount.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Statement ref</Label>
              <Input value={statementRef} onChange={(e) => setStatementRef(e.target.value)} placeholder="Auto" />
            </div>
            <div className="space-y-1.5">
              <Label>Gateway</Label>
              <Input value={gateway} onChange={(e) => setGateway(e.target.value)} placeholder="stripe" />
            </div>
            <div className="space-y-1.5">
              <Label>Payout ref</Label>
              <Input value={payoutRef} onChange={(e) => setPayoutRef(e.target.value)} placeholder="po_123" />
            </div>
            <div className="space-y-1.5">
              <Label>Amount</Label>
              <Input type="number" value={amount} onChange={(e) => setAmount(e.target.value)} />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>Payment reference (optional)</Label>
            <Input
              value={paymentReference}
              onChange={(e) => setPaymentReference(e.target.value)}
              placeholder="Payment no or gateway reference"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={saving}>
            {saving ? "Ingesting…" : "Ingest"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
