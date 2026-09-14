"use client"

import useSWR from "swr"
import { useState } from "react"
import { fetcher } from "@/lib/fetcher"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Receipt, Trash2, Link2 } from "lucide-react"
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
}

export function ChallansStage({ direction, fy }: { direction: Direction; fy: string }) {
  const [form, setForm] = useState({ ...empty })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")

  const { data, mutate } = useSWR<{ challans: Challan[] }>(
    `/api/finance/tds/challans?direction=${direction}&fy=${fy}`,
    fetcher,
  )
  const challans = data?.challans ?? []
  const set = (k: keyof typeof empty, v: string) => setForm((f) => ({ ...f, [k]: v }))

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
              <Input
                type="number"
                inputMode="decimal"
                value={form.interest}
                onChange={(e) => set("interest", e.target.value)}
                placeholder="0.00"
              />
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
          </div>
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
                  challans.map((c) => (
                    <TableRow key={c.id}>
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
                        <Button
                          size="icon"
                          variant="ghost"
                          onClick={() => remove(c.challan_id)}
                          aria-label={`Delete challan ${c.challan_id}`}
                        >
                          <Trash2 className="h-4 w-4 text-muted-foreground" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))
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
