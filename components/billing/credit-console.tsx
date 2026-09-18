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
import { formatMoney, Pill, StatCard, type CreditEntry } from "./engine-shared"

const KEY = "/api/billing/credits"
type Data = { entries: CreditEntry[]; balance: number }

const ENTRY_TONE: Record<string, string> = {
  credit: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  debit: "bg-red-500/15 text-red-600 dark:text-red-400",
  adjustment: "bg-sky-500/15 text-sky-600 dark:text-sky-400",
}

export function CreditConsole() {
  const { data, isLoading, mutate } = useSWR<Data>(KEY, fetcher)
  const [open, setOpen] = useState(false)
  const entries = data?.entries ?? []
  const balance = data?.balance ?? 0
  const credited = entries.filter((e) => e.entry_type === "credit").reduce((s, e) => s + e.amount, 0)
  const consumed = entries.filter((e) => e.entry_type === "debit").reduce((s, e) => s + Math.abs(e.amount), 0)

  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">Credits &amp; Adjustments</h1>
          <p className="max-w-2xl text-sm text-muted-foreground">
            The account credit ledger. Grant credits, record signed adjustments and see debits consumed by
            invoices. The running balance is applied automatically when an invoice opts to use credit.
          </p>
        </div>
        <Button className="shrink-0" onClick={() => setOpen(true)}>
          New entry
        </Button>
      </header>

      <div className="mt-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label="Available balance" value={formatMoney(balance)} hint="Spendable now" />
        <StatCard label="Total credited" value={formatMoney(credited)} />
        <StatCard label="Total consumed" value={formatMoney(consumed)} />
        <StatCard label="Ledger entries" value={String(entries.length)} />
      </div>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle className="text-base font-medium">Ledger</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="py-16 text-center text-sm text-muted-foreground">Loading ledger…</div>
          ) : entries.length === 0 ? (
            <div className="flex flex-col items-center gap-3 py-16 text-center">
              <p className="text-sm text-muted-foreground">No ledger entries yet.</p>
              <Button onClick={() => setOpen(true)}>Add an entry</Button>
            </div>
          ) : (
            <div className="overflow-x-auto rounded-md border border-border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Reference</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Reason</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Date</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {entries.map((e) => (
                    <TableRow key={e.id}>
                      <TableCell className="font-mono text-xs">{e.credit_no}</TableCell>
                      <TableCell>
                        <Pill tone={ENTRY_TONE[e.entry_type]}>{e.entry_type}</Pill>
                      </TableCell>
                      <TableCell className="max-w-[220px] truncate">{e.reason}</TableCell>
                      <TableCell className="text-right">
                        {e.entry_type === "debit" ? "−" : ""}
                        {formatMoney(Math.abs(e.amount), e.currency)}
                      </TableCell>
                      <TableCell className="capitalize">{e.status}</TableCell>
                      <TableCell>{e.created_at?.slice(0, 10)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <CreateCreditDialog open={open} onOpenChange={setOpen} onCreated={() => { setOpen(false); mutate() }} />
    </div>
  )
}

function CreateCreditDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  onCreated: () => void
}) {
  const [entryType, setEntryType] = useState<"credit" | "adjustment">("credit")
  const [amount, setAmount] = useState("0")
  const [reason, setReason] = useState("")
  const [saving, setSaving] = useState(false)

  async function submit() {
    setSaving(true)
    try {
      const res = await fetch(KEY, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entry_type: entryType, amount: Number(amount) || 0, reason }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || "Failed to add entry")
      toast.success(`Entry ${json.entry.credit_no} added`)
      setAmount("0")
      setReason("")
      onCreated()
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
          <DialogTitle>New ledger entry</DialogTitle>
          <DialogDescription>
            Grant a credit or record an adjustment. Adjustments may be negative to reduce the balance.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>Type</Label>
            <select
              className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm"
              value={entryType}
              onChange={(e) => setEntryType(e.target.value as typeof entryType)}
            >
              <option value="credit">Credit (add to balance)</option>
              <option value="adjustment">Adjustment (signed)</option>
            </select>
          </div>
          <div className="space-y-1.5">
            <Label>Amount</Label>
            <Input type="number" value={amount} onChange={(e) => setAmount(e.target.value)} />
            {entryType === "adjustment" ? (
              <p className="text-xs text-muted-foreground">Use a negative number to reduce the balance.</p>
            ) : null}
          </div>
          <div className="space-y-1.5">
            <Label>Reason</Label>
            <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Goodwill credit" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={saving}>
            {saving ? "Saving…" : "Add entry"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
