"use client"

import useSWR from "swr"
import { useState } from "react"
import { fetcher } from "@/lib/fetcher"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Award, CheckCircle2 } from "lucide-react"
import { currency, QUARTERS, StatusBadge, type Direction, type Quarter } from "./shared"

type CertForm = "16" | "16A"
type Preview = {
  form_type: CertForm
  quarter: Quarter | null
  financial_year: string
  deductees: {
    party_name: string
    pan: string
    sections: string
    base: number
    tds: number
    doc_count: number
    issued: boolean
    certificate_id: string | null
  }[]
  totals: { deductee_count: number; total_base: number; total_tds: number; issued_count: number }
}
type Issued = {
  id: number
  certificate_id: string
  form_type: string
  quarter: string | null
  financial_year: string
  party_name: string
  pan: string | null
  sections: string | null
  total_tds: number
  status: string
}

export function CertificatesStage({ direction, fy }: { direction: Direction; fy: string }) {
  // Form 16 is annual salary (employee); Form 16A is quarterly non-salary (vendors).
  const defaultForm: CertForm = direction === "employee" ? "16" : "16A"
  const [formType, setFormType] = useState<CertForm>(defaultForm)
  const [quarter, setQuarter] = useState<Quarter>("Q1")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")

  const needsQuarter = formType === "16A"
  const previewKey = `/api/finance/tds/certificates?preview=1&fy=${fy}&form=${formType}&direction=${direction}${
    needsQuarter ? `&quarter=${quarter}` : ""
  }`
  const { data, mutate } = useSWR<{ preview: Preview }>(previewKey, fetcher)
  const { data: listData, mutate: mutateList } = useSWR<{ certificates: Issued[] }>(
    `/api/finance/tds/certificates?direction=${direction}&fy=${fy}`,
    fetcher,
  )
  const preview = data?.preview
  const issued = listData?.certificates ?? []

  async function generate() {
    setBusy(true)
    setError("")
    try {
      const res = await fetch("/api/finance/tds/certificates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ form: formType, fy, direction, quarter: needsQuarter ? quarter : undefined }),
      })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error || "Could not generate certificates")
      mutate()
      mutateList()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const pending = preview ? preview.totals.deductee_count - preview.totals.issued_count : 0

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <p className="max-w-xl text-sm text-muted-foreground">
          Generate TDS certificates for each deductee. Form 16 covers annual salary TDS; Form 16A covers quarterly
          non-salary TDS. Amounts are drawn from the same deductee ledger the returns use.
        </p>
        <div className="flex items-end gap-3">
          <div className="flex flex-col gap-1">
            <label className="text-xs text-muted-foreground" htmlFor="cert-form">
              Form
            </label>
            <select
              id="cert-form"
              value={formType}
              onChange={(e) => setFormType(e.target.value as CertForm)}
              className="h-9 w-40 rounded-md border border-input bg-background px-3 text-sm"
            >
              <option value="16A">Form 16A · non-salary</option>
              <option value="16">Form 16 · salary</option>
            </select>
          </div>
          {needsQuarter ? (
            <div className="flex flex-col gap-1">
              <label className="text-xs text-muted-foreground" htmlFor="cert-quarter">
                Quarter
              </label>
              <select
                id="cert-quarter"
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
          ) : null}
        </div>
      </div>

      {error ? <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p> : null}

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <Award className="h-4 w-4" />
            Form {formType} · {needsQuarter ? `${quarter} · ` : ""}FY {fy}
          </CardTitle>
          <div className="flex items-center gap-3">
            <span className="text-sm text-muted-foreground">
              {preview ? `${preview.totals.issued_count}/${preview.totals.deductee_count} issued` : "—"}
            </span>
            <Button onClick={generate} disabled={busy || pending <= 0}>
              {busy ? "Generating…" : pending > 0 ? `Generate ${pending} certificate${pending > 1 ? "s" : ""}` : "All issued"}
            </Button>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Party</TableHead>
                  <TableHead>PAN</TableHead>
                  <TableHead>Sections</TableHead>
                  <TableHead className="text-right">Base</TableHead>
                  <TableHead className="text-right">TDS</TableHead>
                  <TableHead>Certificate</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {!preview || preview.deductees.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} className="py-8 text-center text-sm text-muted-foreground">
                      No deductees for this selection.
                    </TableCell>
                  </TableRow>
                ) : (
                  preview.deductees.map((d, i) => (
                    <TableRow key={`${d.party_name}-${i}`}>
                      <TableCell className="font-medium">{d.party_name}</TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground">{d.pan || "—"}</TableCell>
                      <TableCell>{d.sections}</TableCell>
                      <TableCell className="text-right">{currency(d.base)}</TableCell>
                      <TableCell className="text-right font-medium">{currency(d.tds)}</TableCell>
                      <TableCell>
                        {d.issued ? (
                          <Badge variant="default" className="gap-1 font-mono">
                            <CheckCircle2 className="h-3 w-3" />
                            {d.certificate_id}
                          </Badge>
                        ) : (
                          <Badge variant="outline">Pending</Badge>
                        )}
                      </TableCell>
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
          <CardTitle className="text-base">Issued certificates · FY {fy}</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Certificate ID</TableHead>
                  <TableHead>Form</TableHead>
                  <TableHead>Quarter</TableHead>
                  <TableHead>Party</TableHead>
                  <TableHead>PAN</TableHead>
                  <TableHead className="text-right">TDS</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {issued.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={7} className="py-8 text-center text-sm text-muted-foreground">
                      No certificates issued yet.
                    </TableCell>
                  </TableRow>
                ) : (
                  issued.map((c) => (
                    <TableRow key={c.id}>
                      <TableCell className="font-mono text-xs">{c.certificate_id}</TableCell>
                      <TableCell>{c.form_type}</TableCell>
                      <TableCell>{c.quarter || "Annual"}</TableCell>
                      <TableCell className="font-medium">{c.party_name}</TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground">{c.pan || "—"}</TableCell>
                      <TableCell className="text-right">{currency(c.total_tds)}</TableCell>
                      <TableCell>
                        <StatusBadge status={c.status} />
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
