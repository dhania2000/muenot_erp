"use client"

import useSWR from "swr"
import { Fragment, useState } from "react"
import { fetcher } from "@/lib/fetcher"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Receipt, Trash2, Link2, SplitSquareHorizontal, Wand2, ChevronDown } from "lucide-react"
import { currency, thisMonth, StatusBadge, type Direction } from "./shared"

type Challan = {
  id: number
  challan_id: string
  period: string
  quarter: string
  bsr_code: string | null
  challan_no: string | null
  payment_date: string | null
  tds_amount: number
  interest: number
  late_fee: number
  total_amount: number
  payment_mode: string | null
  status: string
  voucher_no: string | null
  posting_status: string
}

const empty = {
  period: thisMonth(),
  bsr_code: "",
  challan_no: "",
  payment_date: new Date().toISOString().slice(0, 10),
  tds_amount: "",
  interest: "",
  late_fee: "",
  payment_mode: "bank",
  bank_name: "",
  payment_ref: "",
}

const CAN_ALLOCATE: Direction[] = ["payable", "employee"]

export function ChallansStage({ direction, fy }: { direction: Direction; fy: string }) {
  const [form, setForm] = useState({ ...empty })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [expanded, setExpanded] = useState<string | null>(null)

  const { data, mutate } = useSWR<{ challans: Challan[] }>(
    `/api/finance/tds/challans?direction=${direction}&fy=${fy}`,
    fetcher,
  )
  const challans = data?.challans ?? []
  const set = (k: keyof typeof empty, v: string) => setForm((f) => ({ ...f, [k]: v }))
  const [calc, setCalc] = useState<{ interest: string; late_fee: string } | null>(null)

  async function suggestCharges() {
    const tds = Number(form.tds_amount || 0)
    if (tds <= 0) return
    setError("")
    try {
      const res = await fetch(
        `/api/finance/tds/interest?kind=deposit&period=${form.period}&tds=${tds}&date=${form.payment_date}`,
      )
      const body = await res.json()
      if (!res.ok) throw new Error(body.error || "Could not compute interest")
      const interest = String(body.suggestion?.interest ?? 0)
      setForm((f) => ({ ...f, interest }))
      setCalc({ interest: body.suggestion?.basis || "", late_fee: "" })
    } catch (e) {
      setError((e as Error).message)
    }
  }

  async function save() {
    setBusy(true)
    setError("")
    try {
      const res = await fetch("/api/finance/tds/challans", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          direction,
          period: form.period,
          bsr_code: form.bsr_code,
          challan_no: form.challan_no,
          payment_date: form.payment_date,
          tds_amount: Number(form.tds_amount || 0),
          interest: Number(form.interest || 0),
          late_fee: Number(form.late_fee || 0),
          payment_mode: form.payment_mode,
          bank_name: form.bank_name,
          payment_ref: form.payment_ref,
        }),
      })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error || "Could not record challan")
      setForm({ ...empty })
      mutate()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function remove(challanId: string) {
    if (!confirm("Delete this challan? Its Journal/GL posting will be reversed.")) return
    const res = await fetch(`/api/finance/tds/challans?id=${encodeURIComponent(challanId)}`, { method: "DELETE" })
    if (res.ok) mutate()
    else {
      const body = await res.json().catch(() => ({}))
      setError(body.error || "Could not delete challan")
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <p className="text-sm text-muted-foreground">
        Record a TDS deposit challan. Saving it automatically posts the balanced voucher — Dr TDS Payable (plus any
        interest / late fee) and Cr Bank or Cash — into the Journal and General Ledger.
      </p>

      {error ? <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p> : null}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Receipt className="h-4 w-4" />
            Record challan
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Tax period">
              <Input type="month" value={form.period} onChange={(e) => set("period", e.target.value)} />
            </Field>
            <Field label="Payment date">
              <Input type="date" value={form.payment_date} onChange={(e) => set("payment_date", e.target.value)} />
            </Field>
            <Field label="BSR code">
              <Input value={form.bsr_code} onChange={(e) => set("bsr_code", e.target.value)} placeholder="0000000" />
            </Field>
            <Field label="Challan no.">
              <Input value={form.challan_no} onChange={(e) => set("challan_no", e.target.value)} placeholder="Serial" />
            </Field>
            <Field label="TDS amount">
              <Input
                type="number"
                inputMode="decimal"
                value={form.tds_amount}
                onChange={(e) => set("tds_amount", e.target.value)}
                placeholder="0.00"
              />
            </Field>
            <Field label="Interest">
              <div className="flex gap-1.5">
                <Input
                  type="number"
                  inputMode="decimal"
                  value={form.interest}
                  onChange={(e) => set("interest", e.target.value)}
                  placeholder="0.00"
                />
                <Button
                  type="button"
                  size="icon"
                  variant="outline"
                  onClick={suggestCharges}
                  disabled={Number(form.tds_amount || 0) <= 0}
                  aria-label="Auto-calculate §201(1A) interest"
                  title="Auto-calculate §201(1A) interest"
                >
                  <Wand2 className="h-4 w-4" />
                </Button>
              </div>
            </Field>
            <Field label="Late fee">
              <Input
                type="number"
                inputMode="decimal"
                value={form.late_fee}
                onChange={(e) => set("late_fee", e.target.value)}
                placeholder="0.00"
              />
            </Field>
            <Field label="Paid via">
              <select
                value={form.payment_mode}
                onChange={(e) => set("payment_mode", e.target.value)}
                className="h-9 rounded-md border border-input bg-background px-3 text-sm"
              >
                <option value="bank">Bank</option>
                <option value="cash">Cash</option>
              </select>
            </Field>
            <Field label="Bank name">
              <Input
                value={form.bank_name}
                onChange={(e) => set("bank_name", e.target.value)}
                placeholder="e.g. HDFC Bank"
              />
            </Field>
            <Field label="Payment reference">
              <Input
                value={form.payment_ref}
                onChange={(e) => set("payment_ref", e.target.value)}
                placeholder="UTR / txn no."
              />
            </Field>
          </div>
          {calc?.interest ? (
            <p className="mt-3 rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">{calc.interest}</p>
          ) : null}
          <div className="mt-4 flex justify-end">
            <Button onClick={save} disabled={busy || Number(form.tds_amount || 0) <= 0}>
              {busy ? "Posting…" : "Record & post challan"}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Deposited challans · FY {fy}</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Challan</TableHead>
                  <TableHead>Period</TableHead>
                  <TableHead className="text-right">TDS</TableHead>
                  <TableHead className="text-right">Int + Fee</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                  <TableHead>Posting</TableHead>
                  <TableHead className="w-10" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {challans.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={7} className="py-8 text-center text-sm text-muted-foreground">
                      No challans recorded for this year.
                    </TableCell>
                  </TableRow>
                ) : (
                  challans.map((c) => {
                    const canAllocate = CAN_ALLOCATE.includes(direction)
                    const isOpen = expanded === c.challan_id
                    return (
                      <Fragment key={c.id}>
                        <TableRow>
                          <TableCell>
                            <div className="font-mono text-xs">{c.challan_no || c.challan_id}</div>
                            <div className="text-xs text-muted-foreground">
                              {c.bsr_code ? `BSR ${c.bsr_code}` : ""}
                              {c.payment_date ? ` · ${c.payment_date}` : ""}
                            </div>
                          </TableCell>
                          <TableCell>
                            {c.period}
                            <span className="ml-1 text-xs text-muted-foreground">{c.quarter}</span>
                          </TableCell>
                          <TableCell className="text-right">{currency(c.tds_amount)}</TableCell>
                          <TableCell className="text-right text-muted-foreground">
                            {currency(c.interest + c.late_fee)}
                          </TableCell>
                          <TableCell className="text-right font-medium">{currency(c.total_amount)}</TableCell>
                          <TableCell>
                            {c.voucher_no ? (
                              <Badge variant="default" className="gap-1 font-mono">
                                <Link2 className="h-3 w-3" />
                                {c.voucher_no}
                              </Badge>
                            ) : (
                              <StatusBadge status={c.posting_status || "Unposted"} />
                            )}
                          </TableCell>
                          <TableCell>
                            <div className="flex items-center justify-end gap-1">
                              {canAllocate ? (
                                <Button
                                  size="icon"
                                  variant="ghost"
                                  onClick={() => setExpanded(isOpen ? null : c.challan_id)}
                                  aria-label={`Allocate challan ${c.challan_id}`}
                                  aria-expanded={isOpen}
                                >
                                  {isOpen ? (
                                    <ChevronDown className="h-4 w-4 text-muted-foreground" />
                                  ) : (
                                    <SplitSquareHorizontal className="h-4 w-4 text-muted-foreground" />
                                  )}
                                </Button>
                              ) : null}
                              <Button
                                size="icon"
                                variant="ghost"
                                onClick={() => remove(c.challan_id)}
                                aria-label={`Delete challan ${c.challan_id}`}
                              >
                                <Trash2 className="h-4 w-4 text-muted-foreground" />
                              </Button>
                            </div>
                          </TableCell>
                        </TableRow>
                        {canAllocate && isOpen ? (
                          <TableRow key={`${c.id}-alloc`}>
                            <TableCell colSpan={7} className="p-0">
                              <AllocationPanel challanId={c.challan_id} onChanged={mutate} />
                            </TableCell>
                          </TableRow>
                        ) : null}
                      </Fragment>
                    )
                  })
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-xs text-muted-foreground">{label}</label>
      {children}
    </div>
  )
}

type Candidate = { party_id: string; party_name: string; section: string; tds: number; covered: number; open: number }
type Allocation = { id: number; party_name: string | null; section: string | null; amount: number }
type AllocData = {
  allocations: Allocation[]
  headroom: { tds_amount: number; allocated: number; unallocated: number }
  candidates: Candidate[]
}

function AllocationPanel({ challanId, onChanged }: { challanId: string; onChanged: () => void }) {
  const { data, mutate, isLoading } = useSWR<AllocData>(
    `/api/finance/tds/challans/allocations?challan=${encodeURIComponent(challanId)}`,
    fetcher,
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")

  const headroom = data?.headroom
  const allocations = data?.allocations ?? []
  const candidates = data?.candidates ?? []

  async function auto() {
    setBusy(true)
    setError("")
    try {
      const res = await fetch("/api/finance/tds/challans/allocations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ challan_id: challanId, mode: "auto" }),
      })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error || "Could not allocate")
      await mutate()
      onChanged()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function clearAll() {
    setBusy(true)
    setError("")
    try {
      const res = await fetch(`/api/finance/tds/challans/allocations?challan=${encodeURIComponent(challanId)}`, {
        method: "DELETE",
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error || "Could not clear allocations")
      }
      await mutate()
      onChanged()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  if (isLoading) return <div className="px-4 py-3 text-xs text-muted-foreground">Loading allocations…</div>

  return (
    <div className="flex flex-col gap-3 bg-muted/30 px-4 py-4">
      {error ? <p className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</p> : null}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-4 text-xs">
          <span className="text-muted-foreground">
            Deposited <span className="font-medium text-foreground">{currency(headroom?.tds_amount ?? 0)}</span>
          </span>
          <span className="text-muted-foreground">
            Allocated <span className="font-medium text-foreground">{currency(headroom?.allocated ?? 0)}</span>
          </span>
          <span className="text-muted-foreground">
            Unallocated{" "}
            <span className={`font-medium ${(headroom?.unallocated ?? 0) > 0.01 ? "text-amber-600" : "text-emerald-600"}`}>
              {currency(headroom?.unallocated ?? 0)}
            </span>
          </span>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={auto} disabled={busy || (headroom?.unallocated ?? 0) <= 0.01}>
            <Wand2 className="mr-1 h-3.5 w-3.5" />
            Auto-allocate
          </Button>
          <Button size="sm" variant="ghost" onClick={clearAll} disabled={busy || allocations.length === 0}>
            Clear
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div>
          <p className="mb-1.5 text-xs font-medium">Deductee lines this period</p>
          <div className="rounded-md border bg-background">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="h-8 text-xs">Deductee</TableHead>
                  <TableHead className="h-8 text-xs">Section</TableHead>
                  <TableHead className="h-8 text-right text-xs">Open</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {candidates.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={3} className="py-4 text-center text-xs text-muted-foreground">
                      No deductee lines for this period.
                    </TableCell>
                  </TableRow>
                ) : (
                  candidates.map((c, i) => (
                    <TableRow key={`${c.party_id}-${c.section}-${i}`}>
                      <TableCell className="text-xs">{c.party_name}</TableCell>
                      <TableCell className="text-xs">{c.section}</TableCell>
                      <TableCell className="text-right text-xs">{currency(c.open)}</TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </div>
        <div>
          <p className="mb-1.5 text-xs font-medium">Mapped to this challan</p>
          <div className="rounded-md border bg-background">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="h-8 text-xs">Deductee</TableHead>
                  <TableHead className="h-8 text-xs">Section</TableHead>
                  <TableHead className="h-8 text-right text-xs">Amount</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {allocations.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={3} className="py-4 text-center text-xs text-muted-foreground">
                      Not allocated yet. Use Auto-allocate.
                    </TableCell>
                  </TableRow>
                ) : (
                  allocations.map((a) => (
                    <TableRow key={a.id}>
                      <TableCell className="text-xs">{a.party_name || "—"}</TableCell>
                      <TableCell className="text-xs">{a.section || "—"}</TableCell>
                      <TableCell className="text-right text-xs">{currency(a.amount)}</TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </div>
      </div>
    </div>
  )
}
