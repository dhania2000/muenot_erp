"use client"

import useSWR from "swr"
import { useMemo, useState } from "react"
import { fetcher } from "@/lib/fetcher"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Checkbox } from "@/components/ui/checkbox"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { FileSpreadsheet, RefreshCcw, ScrollText, TriangleAlert } from "lucide-react"
import { inr0 } from "@/lib/finance-calc"

const currency = (n: any) => inr0(Number(n) || 0)
const thisMonth = () => new Date().toISOString().slice(0, 7)

type Totals = {
  count: number
  taxable: number
  total_gst: number
  itc_gross: number
  itc_eligible: number
  itc_ineligible: number
  itc_reversal: number
  itc_net: number
}

type Monthly = {
  period: string
  totals: Totals
  sectionWise: { section: string; count: number; itc_gross: number; itc_net: number }[]
  reconWise: { status: string; count: number; itc_net: number }[]
  rows: Record<string, any>[]
}

type TaxException = {
  expense_id: string
  expense_date: string | null
  party: string
  severity: "high" | "medium" | "low"
  category: string
  message: string
}

const SEVERITY_BADGE: Record<string, "default" | "secondary" | "outline" | "destructive"> = {
  high: "destructive",
  medium: "secondary",
  low: "outline",
}

const RECON_BADGE: Record<string, "default" | "secondary" | "outline" | "destructive"> = {
  Matched: "default",
  Mismatch: "destructive",
  "Not in 2B": "secondary",
  Unreconciled: "outline",
}
const STATUS_BADGE: Record<string, "default" | "secondary" | "outline" | "destructive"> = {
  Claimed: "default",
  Available: "secondary",
  Ineligible: "destructive",
  Reversed: "outline",
}

export function GstInputClient() {
  const [period, setPeriod] = useState(thisMonth())
  const [busy, setBusy] = useState<string>("")
  const [error, setError] = useState("")
  const [selected, setSelected] = useState<Set<number>>(new Set())

  const { data, mutate } = useSWR<{ monthly: Monthly; exceptions: TaxException[] }>(
    `/api/finance/gst-input?period=${period}`,
    fetcher,
  )
  const m = data?.monthly
  const rows = m?.rows ?? []
  const exceptions = data?.exceptions ?? []

  const selectableIds = useMemo(
    () => rows.filter((r) => Number(r.itc_eligible) === 1).map((r) => Number(r.id)),
    [rows],
  )
  const allSelected = selectableIds.length > 0 && selectableIds.every((id) => selected.has(id))

  function toggle(id: number) {
    setSelected((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }
  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(selectableIds))
  }

  async function run(action: string, extra: Record<string, any> = {}) {
    setBusy(action)
    setError("")
    try {
      const res = await fetch("/api/finance/gst-input", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, period, ...extra }),
      })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error || "Request failed")
      setSelected(new Set())
      mutate()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy("")
    }
  }

  const selectedIds = [...selected]

  return (
    <main className="flex flex-col gap-6 p-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">GST Input (ITC) Register</h1>
          <p className="text-sm text-muted-foreground">
            Input tax credit from posted purchase bills and expenses (incl. RCM), reconciled against GSTR-2B.
          </p>
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted-foreground" htmlFor="period">
            Tax period
          </label>
          <Input id="period" type="month" value={period} onChange={(e) => setPeriod(e.target.value)} className="w-40" />
        </div>
      </header>

      {error ? <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p> : null}

      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <Stat label="Bills with GST" value={String(m?.totals.count ?? 0)} />
        <Stat label="Gross ITC" value={currency(m?.totals.itc_gross)} />
        <Stat label="Net eligible ITC" value={currency(m?.totals.itc_net)} accent />
        <Stat label="Ineligible / reversed" value={currency((m?.totals.itc_ineligible ?? 0) + (m?.totals.itc_reversal ?? 0))} />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" onClick={() => run("draft-2b")} disabled={busy !== ""}>
          <FileSpreadsheet className="mr-2 h-4 w-4" />
          {busy === "draft-2b" ? "Drafting…" : "Draft GSTR-2B"}
        </Button>
        <Button variant="outline" onClick={() => run("reconcile")} disabled={busy !== ""}>
          <RefreshCcw className="mr-2 h-4 w-4" />
          {busy === "reconcile" ? "Reconciling…" : "Reconcile with 2B"}
        </Button>
        <div className="flex-1" />
        <Button
          onClick={() => run("claim", { ids: selectedIds, claimed: true })}
          disabled={busy !== "" || selectedIds.length === 0}
        >
          Mark claimed ({selectedIds.length})
        </Button>
        <Button
          variant="outline"
          onClick={() => run("claim", { ids: selectedIds, claimed: false })}
          disabled={busy !== "" || selectedIds.length === 0}
        >
          Unclaim
        </Button>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Section-wise ITC</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Section</TableHead>
                  <TableHead className="text-right">Bills</TableHead>
                  <TableHead className="text-right">Gross</TableHead>
                  <TableHead className="text-right">Net</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {!m || m.sectionWise.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={4} className="py-6 text-center text-sm text-muted-foreground">
                      No ITC in this period.
                    </TableCell>
                  </TableRow>
                ) : (
                  m.sectionWise.map((r) => (
                    <TableRow key={r.section}>
                      <TableCell className="font-medium">{r.section}</TableCell>
                      <TableCell className="text-right">{r.count}</TableCell>
                      <TableCell className="text-right">{currency(r.itc_gross)}</TableCell>
                      <TableCell className="text-right font-medium">{currency(r.itc_net)}</TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Reconciliation status</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Bills</TableHead>
                  <TableHead className="text-right">Net ITC</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {!m || m.reconWise.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={3} className="py-6 text-center text-sm text-muted-foreground">
                      Nothing to reconcile yet.
                    </TableCell>
                  </TableRow>
                ) : (
                  m.reconWise.map((r) => (
                    <TableRow key={r.status}>
                      <TableCell>
                        <Badge variant={RECON_BADGE[r.status] ?? "outline"}>{r.status || "Unreconciled"}</Badge>
                      </TableCell>
                      <TableCell className="text-right">{r.count}</TableCell>
                      <TableCell className="text-right font-medium">{currency(r.itc_net)}</TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <TriangleAlert className="h-4 w-4" />
            Tax exceptions — {period}
            {exceptions.length > 0 ? <Badge variant="destructive">{exceptions.length}</Badge> : null}
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Severity</TableHead>
                <TableHead>Category</TableHead>
                <TableHead>Document</TableHead>
                <TableHead>Party</TableHead>
                <TableHead>Issue</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {exceptions.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="py-6 text-center text-sm text-muted-foreground">
                    No tax exceptions detected in this period.
                  </TableCell>
                </TableRow>
              ) : (
                exceptions.map((ex, i) => (
                  <TableRow key={`${ex.expense_id}-${i}`}>
                    <TableCell>
                      <Badge variant={SEVERITY_BADGE[ex.severity] ?? "outline"}>{ex.severity}</Badge>
                    </TableCell>
                    <TableCell className="text-sm">{ex.category}</TableCell>
                    <TableCell className="font-mono text-xs">{ex.expense_id}</TableCell>
                    <TableCell className="text-sm">{ex.party}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">{ex.message}</TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <ScrollText className="h-4 w-4" />
            ITC register — {period}
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">
                  <Checkbox checked={allSelected} onCheckedChange={toggleAll} aria-label="Select all eligible" />
                </TableHead>
                <TableHead>Document</TableHead>
                <TableHead>Source</TableHead>
                <TableHead>Party</TableHead>
                <TableHead className="text-right">Taxable</TableHead>
                <TableHead className="text-right">Total GST</TableHead>
                <TableHead className="text-right">Net ITC</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>2B</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={8} className="py-8 text-center text-sm text-muted-foreground">
                    No purchase bills with input GST in this period.
                  </TableCell>
                </TableRow>
              ) : (
                rows.map((r) => {
                  const id = Number(r.id)
                  const eligible = Number(r.itc_eligible) === 1
                  return (
                    <TableRow key={id}>
                      <TableCell>
                        <Checkbox
                          checked={selected.has(id)}
                          disabled={!eligible}
                          onCheckedChange={() => toggle(id)}
                          aria-label={`Select ${r.source_bill_ref}`}
                        />
                      </TableCell>
                      <TableCell>
                        <div className="font-mono text-xs">{r.source_bill_ref}</div>
                        <div className="text-xs text-muted-foreground">{r.bill_number || "—"}</div>
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap items-center gap-1">
                          <Badge variant="outline">{r.source || "Purchase Bill"}</Badge>
                          {Number(r.rcm_applicable) === 1 ? <Badge variant="secondary">RCM</Badge> : null}
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="font-medium">{r.vendor_name || r.employee_name || "—"}</div>
                        <div className="text-xs text-muted-foreground">{r.vendor_gstin || "Unregistered"}</div>
                      </TableCell>
                      <TableCell className="text-right">{currency(r.taxable_amount)}</TableCell>
                      <TableCell className="text-right">{currency(r.total_gst)}</TableCell>
                      <TableCell className="text-right font-medium">{currency(r.itc_net)}</TableCell>
                      <TableCell>
                        <Badge variant={STATUS_BADGE[r.status] ?? "outline"}>{r.status}</Badge>
                      </TableCell>
                      <TableCell>
                        <Badge variant={RECON_BADGE[r.reconciliation_status] ?? "outline"}>
                          {r.reconciliation_status || "Unreconciled"}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  )
                })
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </main>
  )
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <Card>
      <CardContent className="flex flex-col gap-1 p-4">
        <div className="text-sm text-muted-foreground">{label}</div>
        <div className={`text-xl font-semibold ${accent ? "text-primary" : ""}`}>{value}</div>
      </CardContent>
    </Card>
  )
}
