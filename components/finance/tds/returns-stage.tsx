"use client"

import useSWR from "swr"
import { useState } from "react"
import { fetcher } from "@/lib/fetcher"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import {
  ScrollText,
  Users,
  FileCheck2,
  ShieldCheck,
  ShieldAlert,
  AlertTriangle,
  History,
} from "lucide-react"
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

type ValidationIssue = {
  code: string
  severity: "error" | "warning"
  message: string
  party_name?: string
  section?: string
}
type Validation = {
  issues: ValidationIssue[]
  error_count: number
  warning_count: number
  can_file: boolean
  already_filed: boolean
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
  arn: string | null
  challan_label: string | null
  original_return_id: string | null
  correction_type: string | null
  revision_no: number
  is_correction: boolean
  remarks: string | null
  filed_at: string | null
  allowed_transitions: string[]
}

export function ReturnsStage({ direction, fy }: { direction: Direction; fy: string }) {
  const [quarter, setQuarter] = useState<Quarter>("Q1")
  const [token, setToken] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [rowBusy, setRowBusy] = useState<string>("")
  const form = returnForm(direction)

  const { data, mutate } = useSWR<{ preparation: Prep }>(
    `/api/finance/tds/returns?fy=${fy}&quarter=${quarter}&direction=${direction}`,
    fetcher,
  )
  const { data: validationData, mutate: mutateValidation } = useSWR<{ validation: Validation }>(
    `/api/finance/tds/returns?fy=${fy}&quarter=${quarter}&direction=${direction}&validate=1`,
    fetcher,
  )
  const { data: listData, mutate: mutateList } = useSWR<{ returns: FiledReturn[] }>(
    `/api/finance/tds/returns?direction=${direction}`,
    fetcher,
  )
  const prep = data?.preparation
  const validation = validationData?.validation
  const filed = listData?.returns ?? []

  function refreshAll() {
    mutate()
    mutateValidation()
    mutateList()
  }

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
      refreshAll()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function transition(returnId: string, status: string) {
    setRowBusy(returnId)
    setError("")
    try {
      let remarks: string | null = null
      if (status === "Rejected" || status === "Correction Required") {
        remarks = window.prompt(`Reason for marking this return "${status}" (optional):`) ?? null
      }
      const res = await fetch("/api/finance/tds/returns", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "set_status", return_id: returnId, status, remarks }),
      })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error || "Could not update return status")
      refreshAll()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setRowBusy("")
    }
  }

  async function correct(returnId: string) {
    if (!window.confirm("File a correction return? The original is preserved and a revised copy is created from the current ledger.")) return
    setRowBusy(returnId)
    setError("")
    try {
      const remarks = window.prompt("Correction remarks (optional):") ?? null
      const res = await fetch("/api/finance/tds/returns", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "correct", return_id: returnId, remarks }),
      })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error || "Could not file correction")
      refreshAll()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setRowBusy("")
    }
  }

  const canFile = !!validation?.can_file && !!prep && prep.totals.deductee_count > 0

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <p className="max-w-xl text-sm text-muted-foreground">
          Quarterly {form} return, assembled automatically from the deductee ledger and matched against the challans
          deposited for the quarter. Filing runs pre-filing validation and locks the quarter with a snapshot.
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
              <Button onClick={file} disabled={busy || !canFile}>
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
            <Mini label="Balance" value={currency(prep?.totals.balance)} danger={(prep?.totals.balance ?? 0) > 0.5} />
          </div>

          {prep && !prep.return ? <ValidationPanel validation={validation} /> : null}
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
          <CardTitle className="flex items-center gap-2 text-base">
            <History className="h-4 w-4" />
            Filed returns &amp; corrections
          </CardTitle>
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
                  <TableHead>ARN</TableHead>
                  <TableHead className="text-right">Deducted</TableHead>
                  <TableHead className="text-right">Deposited</TableHead>
                  <TableHead>Filed</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filed.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={10} className="py-8 text-center text-sm text-muted-foreground">
                      No returns filed yet.
                    </TableCell>
                  </TableRow>
                ) : (
                  filed.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell className="font-mono text-xs">
                        {r.return_id}
                        {r.is_correction ? (
                          <Badge variant="secondary" className="ml-2 align-middle text-[10px]">
                            {r.correction_type || `Rev ${r.revision_no}`}
                          </Badge>
                        ) : null}
                        {r.original_return_id ? (
                          <div className="text-[10px] text-muted-foreground">of {r.original_return_id}</div>
                        ) : null}
                      </TableCell>
                      <TableCell>{r.form_type}</TableCell>
                      <TableCell>{r.quarter}</TableCell>
                      <TableCell>{r.financial_year}</TableCell>
                      <TableCell className="font-mono text-[10px] text-muted-foreground">{r.arn || "—"}</TableCell>
                      <TableCell className="text-right">{currency(r.total_deducted)}</TableCell>
                      <TableCell className="text-right">{currency(r.total_deposited)}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {r.filed_at ? new Date(r.filed_at).toLocaleDateString() : "—"}
                      </TableCell>
                      <TableCell>
                        <StatusBadge status={r.status} />
                        {r.remarks ? (
                          <div className="mt-0.5 max-w-[160px] truncate text-[10px] text-muted-foreground" title={r.remarks}>
                            {r.remarks}
                          </div>
                        ) : null}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex flex-wrap items-center justify-end gap-1">
                          {r.allowed_transitions.map((t) => (
                            <Button
                              key={t}
                              size="sm"
                              variant="outline"
                              className="h-7 px-2 text-xs"
                              disabled={rowBusy === r.return_id}
                              onClick={() => transition(r.return_id, t)}
                            >
                              {t}
                            </Button>
                          ))}
                          {r.status !== "Cancelled" ? (
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-7 px-2 text-xs"
                              disabled={rowBusy === r.return_id}
                              onClick={() => correct(r.return_id)}
                            >
                              Correct
                            </Button>
                          ) : null}
                        </div>
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

function ValidationPanel({ validation }: { validation?: Validation }) {
  if (!validation) {
    return <p className="text-sm text-muted-foreground">Running pre-filing validation…</p>
  }
  const { issues, error_count, warning_count, can_file } = validation

  if (issues.length === 0) {
    return (
      <div className="flex items-center gap-2 rounded-md bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-400">
        <ShieldCheck className="h-4 w-4" />
        All pre-filing checks passed. This return is ready to file.
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-2 rounded-md border p-3">
      <div className="flex items-center gap-2 text-sm font-medium">
        {can_file ? (
          <ShieldCheck className="h-4 w-4 text-emerald-600" />
        ) : (
          <ShieldAlert className="h-4 w-4 text-destructive" />
        )}
        Pre-filing validation
        {error_count > 0 ? (
          <Badge variant="destructive">{error_count} error{error_count > 1 ? "s" : ""}</Badge>
        ) : null}
        {warning_count > 0 ? (
          <Badge variant="secondary">
            {warning_count} warning{warning_count > 1 ? "s" : ""}
          </Badge>
        ) : null}
      </div>
      <ul className="flex flex-col gap-1">
        {issues.map((issue, i) => (
          <li key={`${issue.code}-${i}`} className="flex items-start gap-2 text-sm">
            {issue.severity === "error" ? (
              <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />
            ) : (
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" />
            )}
            <span className={issue.severity === "error" ? "text-destructive" : "text-muted-foreground"}>
              {issue.message}
            </span>
          </li>
        ))}
      </ul>
      {error_count > 0 ? (
        <p className="text-xs text-muted-foreground">Resolve all errors in the source records before filing.</p>
      ) : null}
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
