"use client"

import useSWR from "swr"
import { useMemo, useState } from "react"
import { fetcher } from "@/lib/fetcher"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent } from "@/components/ui/card"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Plus, Wallet, Clock, TrendingUp, Undo2, Receipt } from "lucide-react"
import { inr0 } from "@/lib/finance-calc"

const currency = (n: any) => inr0(Number(n) || 0)
const today = () => new Date().toISOString().slice(0, 10)

type Payment = {
  id: number
  payment_id: string
  payment_date: string
  party_name: string | null
  amount: number
  payment_mode: string
  deposit_role: string
  reference_no: string | null
  status: string
  voucher_no: string | null
  reversal_voucher_no: string | null
  allocation_count: number
}

type OpenInvoice = {
  id: number
  invoice_id: string
  invoice_date: string | null
  client_name: string | null
  net_receivable: number
  outstanding_amount: number
  due_date: string | null
}

type AgeingRow = {
  client_name: string
  total: number
  not_due: number
  d1_30: number
  d31_60: number
  d61_90: number
  d90_plus: number
}

const STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  Active: "default",
  Reversed: "destructive",
}

export function PaymentsClient() {
  const [tab, setTab] = useState("receipts")
  const [recordOpen, setRecordOpen] = useState(false)
  const [reverseTarget, setReverseTarget] = useState<Payment | null>(null)
  const [reverseReason, setReverseReason] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")

  const { data, mutate } = useSWR<{ payments: Payment[] }>("/api/finance/payments", fetcher)
  const { data: ageingData } = useSWR<{ ageing: AgeingRow[] }>(
    tab === "ageing" ? "/api/finance/payments?view=ageing" : null,
    fetcher,
  )

  const payments = data?.payments ?? []
  const ageing = ageingData?.ageing ?? []

  const totals = useMemo(() => {
    const active = payments.filter((p) => p.status === "Active")
    const received = active.reduce((s, p) => s + Number(p.amount || 0), 0)
    return { received, count: active.length, reversed: payments.length - active.length }
  }, [payments])

  const outstandingTotal = useMemo(() => ageing.reduce((s, r) => s + Number(r.total || 0), 0), [ageing])
  const overdueTotal = useMemo(
    () => ageing.reduce((s, r) => s + Number(r.d1_30 + r.d31_60 + r.d61_90 + r.d90_plus || 0), 0),
    [ageing],
  )

  async function doReverse() {
    if (!reverseTarget) return
    setBusy(true)
    setError("")
    try {
      const res = await fetch("/api/finance/payments", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: reverseTarget.id, action: "reverse", reason: reverseReason }),
      })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error || "Reversal failed")
      setReverseTarget(null)
      setReverseReason("")
      mutate()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="flex flex-col gap-6 p-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Payments &amp; Receivables</h1>
          <p className="text-sm text-muted-foreground">
            Ledger-backed cash receipts applied against sales invoices.
          </p>
        </div>
        <Button onClick={() => setRecordOpen(true)}>
          <Plus className="mr-2 h-4 w-4" />
          Record Payment
        </Button>
      </header>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <SummaryCard icon={<Wallet className="h-4 w-4" />} label="Received (active)" value={currency(totals.received)} />
        <SummaryCard icon={<Receipt className="h-4 w-4" />} label="Active receipts" value={String(totals.count)} />
        <SummaryCard icon={<TrendingUp className="h-4 w-4" />} label="Outstanding" value={currency(outstandingTotal)} hint="Open the Ageing tab" />
        <SummaryCard icon={<Clock className="h-4 w-4" />} label="Overdue" value={currency(overdueTotal)} hint="Open the Ageing tab" />
      </div>

      {error && !reverseTarget ? (
        <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>
      ) : null}

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="receipts">Receipts</TabsTrigger>
          <TabsTrigger value="ageing">Receivable Ageing</TabsTrigger>
        </TabsList>

        <TabsContent value="receipts" className="mt-4">
          <Card>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Payment ID</TableHead>
                    <TableHead>Date</TableHead>
                    <TableHead>Party</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                    <TableHead>Mode</TableHead>
                    <TableHead>Reference</TableHead>
                    <TableHead>Voucher</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {payments.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={9} className="py-10 text-center text-sm text-muted-foreground">
                        No payments recorded yet.
                      </TableCell>
                    </TableRow>
                  ) : (
                    payments.map((p) => (
                      <TableRow key={p.id}>
                        <TableCell className="font-mono text-xs">{p.payment_id}</TableCell>
                        <TableCell>{p.payment_date}</TableCell>
                        <TableCell>{p.party_name || "—"}</TableCell>
                        <TableCell className="text-right font-medium">{currency(p.amount)}</TableCell>
                        <TableCell>{p.payment_mode}</TableCell>
                        <TableCell className="text-muted-foreground">{p.reference_no || "—"}</TableCell>
                        <TableCell className="font-mono text-xs">{p.voucher_no || "—"}</TableCell>
                        <TableCell>
                          <Badge variant={STATUS_VARIANT[p.status] || "outline"}>{p.status}</Badge>
                        </TableCell>
                        <TableCell className="text-right">
                          {p.status === "Active" ? (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => {
                                setReverseTarget(p)
                                setError("")
                              }}
                            >
                              <Undo2 className="mr-1 h-3.5 w-3.5" />
                              Reverse
                            </Button>
                          ) : (
                            <span className="text-xs text-muted-foreground">{p.reversal_voucher_no}</span>
                          )}
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="ageing" className="mt-4">
          <Card>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Customer</TableHead>
                    <TableHead className="text-right">Not due</TableHead>
                    <TableHead className="text-right">1–30</TableHead>
                    <TableHead className="text-right">31–60</TableHead>
                    <TableHead className="text-right">61–90</TableHead>
                    <TableHead className="text-right">90+</TableHead>
                    <TableHead className="text-right">Total</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {ageing.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={7} className="py-10 text-center text-sm text-muted-foreground">
                        No outstanding receivables.
                      </TableCell>
                    </TableRow>
                  ) : (
                    ageing.map((r) => (
                      <TableRow key={r.client_name}>
                        <TableCell className="font-medium">{r.client_name || "—"}</TableCell>
                        <TableCell className="text-right">{currency(r.not_due)}</TableCell>
                        <TableCell className="text-right">{currency(r.d1_30)}</TableCell>
                        <TableCell className="text-right">{currency(r.d31_60)}</TableCell>
                        <TableCell className="text-right">{currency(r.d61_90)}</TableCell>
                        <TableCell className="text-right text-destructive">{currency(r.d90_plus)}</TableCell>
                        <TableCell className="text-right font-semibold">{currency(r.total)}</TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <RecordPaymentDialog
        open={recordOpen}
        onClose={() => setRecordOpen(false)}
        onSaved={() => {
          setRecordOpen(false)
          mutate()
        }}
      />

      <AlertDialog open={!!reverseTarget} onOpenChange={(o) => !o && setReverseTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reverse payment {reverseTarget?.payment_id}?</AlertDialogTitle>
            <AlertDialogDescription>
              This posts a mirror voucher (Dr Accounts Receivable, Cr {reverseTarget?.deposit_role}) and reopens the
              allocated invoices. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-2">
            <Label htmlFor="reverse-reason">Reason</Label>
            <Input
              id="reverse-reason"
              value={reverseReason}
              onChange={(e) => setReverseReason(e.target.value)}
              placeholder="e.g. Cheque bounced"
            />
            {error ? <p className="text-sm text-destructive">{error}</p> : null}
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault()
                doReverse()
              }}
              disabled={busy}
            >
              {busy ? "Reversing…" : "Reverse payment"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </main>
  )
}

function SummaryCard({
  icon,
  label,
  value,
  hint,
}: {
  icon: React.ReactNode
  label: string
  value: string
  hint?: string
}) {
  return (
    <Card>
      <CardContent className="flex flex-col gap-1 p-4">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          {icon}
          {label}
        </div>
        <div className="text-xl font-semibold">{value}</div>
        {hint ? <div className="text-xs text-muted-foreground">{hint}</div> : null}
      </CardContent>
    </Card>
  )
}

function RecordPaymentDialog({
  open,
  onClose,
  onSaved,
}: {
  open: boolean
  onClose: () => void
  onSaved: () => void
}) {
  const [party, setParty] = useState("")
  const [paymentDate, setPaymentDate] = useState(today())
  const [depositRole, setDepositRole] = useState("bank")
  const [mode, setMode] = useState("Bank Transfer")
  const [reference, setReference] = useState("")
  const [narration, setNarration] = useState("")
  const [alloc, setAlloc] = useState<Record<number, string>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [idemKey] = useState(() => `pay-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)

  const { data } = useSWR<{ invoices: OpenInvoice[] }>(
    open && party ? `/api/finance/payments?view=outstanding&party=${encodeURIComponent(party)}` : null,
    fetcher,
  )
  const invoices = data?.invoices ?? []

  const totalAllocated = useMemo(
    () => Object.values(alloc).reduce((s, v) => s + (Number(v) || 0), 0),
    [alloc],
  )

  function reset() {
    setParty("")
    setPaymentDate(today())
    setDepositRole("bank")
    setMode("Bank Transfer")
    setReference("")
    setNarration("")
    setAlloc({})
    setError("")
  }

  async function submit() {
    setError("")
    const allocations = Object.entries(alloc)
      .map(([pk, v]) => ({ invoice_pk: Number(pk), amount: Number(v) || 0 }))
      .filter((a) => a.amount > 0)
    if (allocations.length === 0) {
      setError("Allocate a positive amount to at least one invoice.")
      return
    }
    setBusy(true)
    try {
      const res = await fetch("/api/finance/payments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          party_name: party,
          payment_date: paymentDate,
          deposit_role: depositRole,
          payment_mode: mode,
          reference_no: reference,
          narration,
          allocations,
          idempotency_key: idemKey,
        }),
      })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error || "Failed to record payment")
      reset()
      onSaved()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) {
          reset()
          onClose()
        }
      }}
    >
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Record payment</DialogTitle>
          <DialogDescription>
            Enter a customer, then allocate the received amount across their open invoices. The receipt posts to the
            ledger automatically.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-2">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="party">Customer</Label>
              <Input
                id="party"
                value={party}
                onChange={(e) => setParty(e.target.value)}
                placeholder="Exact client name"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="pdate">Payment date</Label>
              <Input id="pdate" type="date" value={paymentDate} onChange={(e) => setPaymentDate(e.target.value)} />
            </div>
          </div>

          <div className="grid grid-cols-3 gap-4">
            <div className="space-y-2">
              <Label>Deposit to</Label>
              <Select value={depositRole} onValueChange={(v) => setDepositRole(v ?? "bank")}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="bank">Bank</SelectItem>
                  <SelectItem value="cash">Cash</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Mode</Label>
              <Select value={mode} onValueChange={(v) => setMode(v ?? "Bank Transfer")}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="Bank Transfer">Bank Transfer</SelectItem>
                  <SelectItem value="UPI">UPI</SelectItem>
                  <SelectItem value="Cheque">Cheque</SelectItem>
                  <SelectItem value="Cash">Cash</SelectItem>
                  <SelectItem value="Card">Card</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="ref">Reference</Label>
              <Input id="ref" value={reference} onChange={(e) => setReference(e.target.value)} placeholder="UTR / cheque no." />
            </div>
          </div>

          <div className="space-y-2">
            <Label>Allocate to open invoices</Label>
            {!party ? (
              <p className="rounded-md border border-dashed p-4 text-center text-sm text-muted-foreground">
                Enter a customer name to load their open invoices.
              </p>
            ) : invoices.length === 0 ? (
              <p className="rounded-md border border-dashed p-4 text-center text-sm text-muted-foreground">
                No open invoices for this customer.
              </p>
            ) : (
              <div className="rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Invoice</TableHead>
                      <TableHead>Due</TableHead>
                      <TableHead className="text-right">Outstanding</TableHead>
                      <TableHead className="text-right">Allocate</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {invoices.map((inv) => (
                      <TableRow key={inv.id}>
                        <TableCell className="font-mono text-xs">{inv.invoice_id}</TableCell>
                        <TableCell className="text-xs text-muted-foreground">{inv.due_date || "—"}</TableCell>
                        <TableCell className="text-right">{currency(inv.outstanding_amount)}</TableCell>
                        <TableCell className="text-right">
                          <div className="flex items-center justify-end gap-1">
                            <Input
                              type="number"
                              min={0}
                              max={inv.outstanding_amount}
                              step="0.01"
                              value={alloc[inv.id] ?? ""}
                              onChange={(e) => setAlloc((a) => ({ ...a, [inv.id]: e.target.value }))}
                              className="h-8 w-28 text-right"
                              placeholder="0.00"
                            />
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="h-8 px-2 text-xs"
                              onClick={() =>
                                setAlloc((a) => ({ ...a, [inv.id]: String(inv.outstanding_amount) }))
                              }
                            >
                              Full
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="narr">Narration</Label>
            <Textarea id="narr" value={narration} onChange={(e) => setNarration(e.target.value)} rows={2} />
          </div>

          <div className="flex items-center justify-between rounded-md bg-muted px-3 py-2 text-sm">
            <span className="text-muted-foreground">Total allocated</span>
            <span className="font-semibold">{currency(totalAllocated)}</span>
          </div>

          {error ? <p className="text-sm text-destructive">{error}</p> : null}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={busy || totalAllocated <= 0}>
            {busy ? "Recording…" : `Record ${currency(totalAllocated)}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
