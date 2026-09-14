"use client"

import useSWR from "swr"
import { useState } from "react"
import { fetcher } from "@/lib/fetcher"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { ScrollText, Users, FileCheck2 } from "lucide-react"
import { currency, QUARTERS, returnForm, StatusBadge, type Direction, type Quarter } from "./shared"

type Prep = {
  form_type: string
  quarter: Quarter
  financial_year: string
  sections: { section: string; base: number; tds: number; doc_count: number }[]
  deductees: { party_name: string; pan: string; section: string; base: number; tds: number; doc_count: number }[]
  challans: { challan_id: string; challan_no: string | null; period: string; tds_amount: number }[]
  totals: {
    total_base: number
    total_deducted: number
    total_deposited: number
    deductee_count: number
    balance: number
  }
  due_date: string
  return: { return_id: string; status: string; token_no: string | null; filed_at: string | null } | null
}
type FiledReturn = {
  id: number
  return_id: string
  form_type: string
  quarter: string
  financial_year: string
  total_deducted: number
  total_deposited: number
  deductee_count: number
  status: string
  token_no: string | null
}

export function ReturnsStage({ direction, fy }: { direction: Direction; fy: string }) {
  const [quarter, setQuarter] = useState<Quarter>("Q1")
  const [token, setToken] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const form = returnForm(direction)

  const { data, mutate } = useSWR<{ preparation: Prep }>(
    `/api/finance/tds/returns?fy=${fy}&quarter=${quarter}&direction=${direction}`,
    fetcher,
  )
  const { data: listData, mutate: mutateList } = useSWR<{ returns: FiledReturn[] }>(
    `/api/finance/tds/returns?direction=${direction}`,
    fetcher,
  )
  const prep = data?.preparation
  const filed = listData?.returns ?? []

  async function file() {
    setBusy(true)
    setError("")
    try {
      const res = await fetch("/api/finance/tds/returns", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ quarter, fy, direction, token_no: token }),
      })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error || "Could not file return")
      setToken("")
      mutate()
      mutateList()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <p className="max-w-xl text-sm text-muted-foreground">
          Quarterly {form} return, assembled automatically from the deductee ledger and matched against the challans
          deposited for the quarter. Filing locks the quarter and stores a snapshot.
        </p>
        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted-foreground" htmlFor="quarter">
            Quarter
          </label>
          <select
            id="quarter"
            value={quarter}
            onChange={(e) => setQuarter(e.target.value as Quarter)}
            className="h-9 w-40 rounded-md border border-input bg-background px-3 text-sm"
          >
            {QUARTERS.map((q) => (
              <option key={q.value} value={q.value}>
                {q.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {error ? <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p> : null}

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <ScrollText className="h-4 w-4" />
            {form} · {quarter} · FY {fy}
          </CardTitle>
          {prep?.return ? (
            <Badge variant="default" className="gap-1">
              <FileCheck2 className="h-3.5 w-3.5" />
              Filed · {prep.return.return_id}
              {prep.return.token_no ? ` · ${prep.return.token_no}` : ""}
            </Badge>
          ) : (
            <div className="flex items-center gap-2">
              <Input
                placeholder="Token no. (optional)"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                className="h-9 w-40"
              />
              <Button onClick={file} disabled={busy || !prep || prep.totals.deductee_count === 0}>
                {busy ? "Filing…" : "File return"}
              </Button>
            </div>
          )}
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <Mini label="Deductees" value={String(prep?.totals.deductee_count ?? 0)} />
            <Mini label="Deducted" value={currency(prep?.totals.total_deducted)} />
            <Mini label="Deposited" value={currency(prep?.totals.total_deposited)} />
            <Mini
              label="Balance"
              value={currency(prep?.totals.balance)}
              danger={(prep?.totals.balance ?? 0) > 0.5}
            />
          </div>
          {prep && prep.totals.balance > 0.5 ? (
            <p className="rounded-md bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-400">
              Deducted TDS exceeds the challans deposited for this quarter. Record the missing challan before filing to
              keep the return balanced.
            </p>
          ) : null}
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Section summary</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Section</TableHead>
                  <TableHead className="text-right">Docs</TableHead>
                  <TableHead className="text-right">Base</TableHead>
                  <TableHead className="text-right">TDS</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {!prep || prep.sections.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={4} className="py-8 text-center text-sm text-muted-foreground">
                      No deductions in this quarter.
                    </TableCell>
                  </TableRow>
                ) : (
                  prep.sections.map((s) => (
                    <TableRow key={s.section}>
                      <TableCell className="font-medium">{s.section}</TableCell>
                      <TableCell className="text-right">{s.doc_count}</TableCell>
                      <TableCell className="text-right">{currency(s.base)}</TableCell>
                      <TableCell className="text-right font-medium">{currency(s.tds)}</TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Challans matched</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Challan</TableHead>
                  <TableHead>Period</TableHead>
                  <TableHead className="text-right">TDS</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {!prep || prep.challans.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={3} className="py-8 text-center text-sm text-muted-foreground">
                      No challans deposited for this quarter.
                    </TableCell>
                  </TableRow>
                ) : (
                  prep.challans.map((c) => (
                    <TableRow key={c.challan_id}>
                      <TableCell className="font-mono text-xs">{c.challan_no || c.challan_id}</TableCell>
                      <TableCell>{c.period}</TableCell>
                      <TableCell className="text-right font-medium">{currency(c.tds_amount)}</TableCell>
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
            <Users className="h-4 w-4" />
            Deductees
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Party</TableHead>
                  <TableHead>PAN</TableHead>
                  <TableHead>Section</TableHead>
                  <TableHead className="text-right">Docs</TableHead>
                  <TableHead className="text-right">Base</TableHead>
                  <TableHead className="text-right">TDS</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {!prep || prep.deductees.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} className="py-8 text-center text-sm text-muted-foreground">
                      No deductees in this quarter.
                    </TableCell>
                  </TableRow>
                ) : (
                  prep.deductees.map((d, i) => (
                    <TableRow key={`${d.party_name}-${d.section}-${i}`}>
                      <TableCell className="font-medium">{d.party_name}</TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground">{d.pan || "—"}</TableCell>
                      <TableCell>{d.section}</TableCell>
                      <TableCell className="text-right">{d.doc_count}</TableCell>
                      <TableCell className="text-right">{currency(d.base)}</TableCell>
                      <TableCell className="text-right font-medium">{currency(d.tds)}</TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Filed returns</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Return ID</TableHead>
                  <TableHead>Form</TableHead>
                  <TableHead>Quarter</TableHead>
                  <TableHead>FY</TableHead>
                  <TableHead className="text-right">Deducted</TableHead>
                  <TableHead className="text-right">Deposited</TableHead>
                  <TableHead>Token</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filed.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={8} className="py-8 text-center text-sm text-muted-foreground">
                      No returns filed yet.
                    </TableCell>
                  </TableRow>
                ) : (
                  filed.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell className="font-mono text-xs">{r.return_id}</TableCell>
                      <TableCell>{r.form_type}</TableCell>
                      <TableCell>{r.quarter}</TableCell>
                      <TableCell>{r.financial_year}</TableCell>
                      <TableCell className="text-right">{currency(r.total_deducted)}</TableCell>
                      <TableCell className="text-right">{currency(r.total_deposited)}</TableCell>
                      <TableCell className="text-muted-foreground">{r.token_no || "—"}</TableCell>
                      <TableCell>
                        <StatusBadge status={r.status} />
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

function Mini({ label, value, danger }: { label: string; value: string; danger?: boolean }) {
  return (
    <div className="flex flex-col gap-1 rounded-lg border bg-card p-3">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className={`text-lg font-semibold ${danger ? "text-destructive" : ""}`}>{value}</span>
    </div>
  )
}
