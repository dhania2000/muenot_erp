"use client"

import { Fragment, useState } from "react"
import useSWR from "swr"
import { fetcher } from "@/lib/fetcher"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { ChevronDown, ChevronRight, TriangleAlert, Users } from "lucide-react"
import { currency, DIRECTION_COPY, Stat, type Direction } from "./shared"

type Breakup = { section: string; base: number; tds: number; doc_count: number; rate: number }
type Row = {
  party_id: string
  deductee_id: string
  party_name: string
  pan: string
  pan_status: "Valid" | "Invalid" | "Missing"
  party_type: string
  resident_status: "Resident" | "Non-Resident"
  payment_type: string
  sections: string[]
  base: number
  tds: number
  rate: number
  doc_count: number
  quarters: string[]
  breakup: Breakup[]
}
type Master = {
  financial_year: string
  direction: Direction
  deductees: Row[]
  totals: { party_count: number; base: number; tds: number; pan_issues: number }
}

const PAN_VARIANT: Record<Row["pan_status"], "default" | "destructive" | "outline"> = {
  Valid: "default",
  Invalid: "destructive",
  Missing: "outline",
}

export function DeducteesStage({ direction, fy }: { direction: Direction; fy: string }) {
  const copy = DIRECTION_COPY[direction]
  const { data } = useSWR<Master>(`/api/finance/tds/deductees?fy=${fy}&direction=${direction}`, fetcher)
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const [q, setQ] = useState("")

  const all = data?.deductees ?? []
  const needle = q.trim().toLowerCase()
  const rows = needle
    ? all.filter(
        (r) =>
          r.party_name.toLowerCase().includes(needle) ||
          r.deductee_id.toLowerCase().includes(needle) ||
          r.pan.toLowerCase().includes(needle) ||
          r.payment_type.toLowerCase().includes(needle) ||
          r.sections.some((s) => s.toLowerCase().includes(needle)),
      )
    : all

  const label = direction === "receivable" ? "Deductor" : "Deductee"

  return (
    <div className="flex flex-col gap-6">
      <p className="text-sm text-muted-foreground">
        {direction === "receivable"
          ? "Every party that has deducted TDS from your receipts this year, derived from your receivable ledger. Each row rolls up to a single deductor with its section-wise credit."
          : `Every ${copy.partyLabel.toLowerCase()} you deducted TDS from this year, derived from the source ledgers. Each row is one ${label.toLowerCase()} with its section-wise breakup — the raw material for the quarterly return.`}
      </p>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label={`${label}s`} value={String(data?.totals.party_count ?? 0)} />
        <Stat label="Base amount" value={currency(data?.totals.base)} />
        <Stat label="TDS" value={currency(data?.totals.tds)} />
        <Stat label="PAN issues" value={String(data?.totals.pan_issues ?? 0)} hint="Missing or invalid PAN" />
      </div>

      {(data?.totals.pan_issues ?? 0) > 0 && direction !== "receivable" ? (
        <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            {data?.totals.pan_issues} {label.toLowerCase()}
            {(data?.totals.pan_issues ?? 0) === 1 ? " has" : "s have"} a missing or invalid PAN. Under section 206AA these
            attract a 20% deduction and will be flagged in the quarterly return.
          </span>
        </div>
      ) : null}

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Users className="h-4 w-4" />
            {label} master · FY {fy}
          </CardTitle>
          <Input
            placeholder="Search name, PAN, section"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="h-9 w-56"
          />
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-8" />
                  <TableHead>Deductee ID</TableHead>
                  <TableHead>{label}</TableHead>
                  <TableHead>PAN</TableHead>
                  <TableHead>Party type</TableHead>
                  <TableHead>Residence</TableHead>
                  <TableHead>Section</TableHead>
                  <TableHead>Payment type</TableHead>
                  <TableHead className="text-right">Rate</TableHead>
                  <TableHead className="text-right">TDS</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={10} className="py-8 text-center text-sm text-muted-foreground">
                      No {label.toLowerCase()}s found for this year.
                    </TableCell>
                  </TableRow>
                ) : (
                  rows.map((r, i) => {
                    const key = `${r.party_id || r.party_name}-${i}`
                    const isOpen = !!open[key]
                    return (
                      <Fragment key={key}>
                        <TableRow className="cursor-pointer" onClick={() => setOpen((o) => ({ ...o, [key]: !o[key] }))}>
                          <TableCell>
                            <Button variant="ghost" size="icon" className="h-6 w-6">
                              {isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                              <span className="sr-only">Toggle breakup</span>
                            </Button>
                          </TableCell>
                          <TableCell className="font-mono text-xs text-muted-foreground">{r.deductee_id || "—"}</TableCell>
                          <TableCell className="font-medium">{r.party_name}</TableCell>
                          <TableCell>
                            <div className="flex items-center gap-1.5">
                              <span className="font-mono text-xs">{r.pan || "—"}</span>
                              <Badge variant={PAN_VARIANT[r.pan_status]} className="h-4 px-1.5 text-[10px] leading-none">
                                {r.pan_status}
                              </Badge>
                            </div>
                          </TableCell>
                          <TableCell className="text-muted-foreground">{r.party_type || "—"}</TableCell>
                          <TableCell>
                            <Badge
                              variant={r.resident_status === "Non-Resident" ? "secondary" : "outline"}
                              className="h-4 px-1.5 text-[10px] leading-none"
                            >
                              {r.resident_status}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-muted-foreground">{r.sections.join(", ") || "—"}</TableCell>
                          <TableCell className="text-muted-foreground">{r.payment_type || "—"}</TableCell>
                          <TableCell className="text-right">{r.rate ? `${r.rate}%` : "—"}</TableCell>
                          <TableCell className="text-right font-medium">{currency(r.tds)}</TableCell>
                        </TableRow>
                        {isOpen ? (
                          <TableRow className="bg-muted/40 hover:bg-muted/40">
                            <TableCell />
                            <TableCell colSpan={9} className="py-2">
                              <div className="rounded-md border bg-background">
                                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2 text-xs text-muted-foreground">
                                  <span>
                                    Quarters: <span className="text-foreground">{r.quarters.join(", ") || "—"}</span>
                                  </span>
                                  <span>
                                    Documents: <span className="text-foreground">{r.doc_count}</span>
                                  </span>
                                  <span>
                                    Base: <span className="text-foreground">{currency(r.base)}</span>
                                  </span>
                                </div>
                                <Table>
                                  <TableHeader>
                                    <TableRow>
                                      <TableHead>Section</TableHead>
                                      <TableHead className="text-right">Docs</TableHead>
                                      <TableHead className="text-right">Base</TableHead>
                                      <TableHead className="text-right">Rate</TableHead>
                                      <TableHead className="text-right">TDS</TableHead>
                                    </TableRow>
                                  </TableHeader>
                                  <TableBody>
                                    {r.breakup.map((b) => (
                                      <TableRow key={b.section}>
                                        <TableCell className="font-medium">{b.section}</TableCell>
                                        <TableCell className="text-right">{b.doc_count}</TableCell>
                                        <TableCell className="text-right">{currency(b.base)}</TableCell>
                                        <TableCell className="text-right">{b.rate ? `${b.rate}%` : "—"}</TableCell>
                                        <TableCell className="text-right">{currency(b.tds)}</TableCell>
                                      </TableRow>
                                    ))}
                                  </TableBody>
                                </Table>
                              </div>
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
