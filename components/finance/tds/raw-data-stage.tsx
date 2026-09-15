"use client"

import { useMemo, useState } from "react"
import useSWR from "swr"
import { fetcher } from "@/lib/fetcher"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Database, Search, FilterX } from "lucide-react"
import { currency, StatusBadge, Stat, type Direction } from "./shared"

type Row = {
  financial_year: string
  quarter: string
  month: string
  tan: string
  direction: Direction
  tds_type: string
  source: string
  source_id: string
  doc_ref: string
  doc_date: string | null
  deductee_id: string
  deductee_name: string
  pan: string
  pan_status: "Valid" | "Invalid" | "Missing"
  section: string
  payment_type: string
  resident_status: "Resident" | "Non-Resident"
  gross: number
  rate: number
  tds: number
  interest: number
  late_fee: number
  total_liability: number
  paid: number
  balance: number
  challan: string
  return_type: string
  return_status: string
}

type Facets = {
  quarters: string[]
  months: string[]
  sources: string[]
  sections: string[]
  payment_types: string[]
  return_types: string[]
  statuses: string[]
}

type Result = {
  financial_year: string
  rows: Row[]
  totals: {
    line_count: number
    gross: number
    tds: number
    interest: number
    late_fee: number
    total_liability: number
    paid: number
    balance: number
  }
  facets: Facets
}

const ANY = "__any__"

type PaidState = "all" | "paid" | "unpaid"
type ChallanState = "all" | "with" | "without"

const PAN_VARIANT: Record<Row["pan_status"], "default" | "destructive" | "outline"> = {
  Valid: "default",
  Invalid: "destructive",
  Missing: "outline",
}

function Select({
  label,
  value,
  onChange,
  options,
  anyLabel = "All",
}: {
  label: string
  value: string
  onChange: (v: string) => void
  options: { value: string; label: string }[]
  anyLabel?: string
}) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs text-muted-foreground">{label}</label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-9 min-w-[8rem] rounded-md border border-input bg-background px-2 text-sm"
      >
        <option value={ANY}>{anyLabel}</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  )
}

export function RawDataStage({ direction, fy }: { direction: Direction; fy: string }) {
  // The register spans the whole year; the workspace direction seeds the "TDS
  // type" filter but the user can widen it to every direction from here.
  const [tdsType, setTdsType] = useState<Direction | typeof ANY>(direction)
  const scope = tdsType === ANY ? "all" : tdsType
  const { data, isLoading } = useSWR<Result>(`/api/finance/tds/raw?fy=${fy}&direction=${scope}`, fetcher)

  const [q, setQ] = useState("")
  const [quarter, setQuarter] = useState(ANY)
  const [month, setMonth] = useState(ANY)
  const [source, setSource] = useState(ANY)
  const [section, setSection] = useState(ANY)
  const [paymentType, setPaymentType] = useState(ANY)
  const [returnType, setReturnType] = useState(ANY)
  const [status, setStatus] = useState(ANY)
  const [residence, setResidence] = useState(ANY)
  const [paid, setPaid] = useState<PaidState>("all")
  const [challan, setChallan] = useState<ChallanState>("all")
  const [fromDate, setFromDate] = useState("")
  const [toDate, setToDate] = useState("")

  const facets = data?.facets
  const all = data?.rows ?? []

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return all.filter((r) => {
      if (quarter !== ANY && r.quarter !== quarter) return false
      if (month !== ANY && r.month !== month) return false
      if (source !== ANY && r.source !== source) return false
      if (section !== ANY && r.section !== section) return false
      if (paymentType !== ANY && r.payment_type !== paymentType) return false
      if (returnType !== ANY && r.return_type !== returnType) return false
      if (status !== ANY && r.return_status !== status) return false
      if (residence !== ANY && r.resident_status !== residence) return false
      if (paid === "paid" && r.balance > 0.01) return false
      if (paid === "unpaid" && r.balance <= 0.01) return false
      if (challan === "with" && !r.challan) return false
      if (challan === "without" && r.challan) return false
      if (fromDate && (!r.doc_date || r.doc_date < fromDate)) return false
      if (toDate && (!r.doc_date || r.doc_date > toDate)) return false
      if (needle) {
        const hay = [
          r.source_id,
          r.doc_ref,
          r.pan,
          r.deductee_id,
          r.deductee_name,
          r.challan,
          r.section,
          r.payment_type,
          r.return_status,
        ]
          .join(" ")
          .toLowerCase()
        if (!hay.includes(needle)) return false
      }
      return true
    })
  }, [
    all,
    q,
    quarter,
    month,
    source,
    section,
    paymentType,
    returnType,
    status,
    residence,
    paid,
    challan,
    fromDate,
    toDate,
  ])

  const totals = useMemo(
    () =>
      filtered.reduce(
        (acc, r) => {
          acc.gross += r.gross
          acc.tds += r.tds
          acc.liability += r.total_liability
          acc.paid += r.paid
          acc.balance += r.balance
          return acc
        },
        { gross: 0, tds: 0, liability: 0, paid: 0, balance: 0 },
      ),
    [filtered],
  )

  const activeFilters =
    (quarter !== ANY ? 1 : 0) +
    (month !== ANY ? 1 : 0) +
    (source !== ANY ? 1 : 0) +
    (section !== ANY ? 1 : 0) +
    (paymentType !== ANY ? 1 : 0) +
    (returnType !== ANY ? 1 : 0) +
    (status !== ANY ? 1 : 0) +
    (residence !== ANY ? 1 : 0) +
    (paid !== "all" ? 1 : 0) +
    (challan !== "all" ? 1 : 0) +
    (fromDate ? 1 : 0) +
    (toDate ? 1 : 0) +
    (q.trim() ? 1 : 0)

  function reset() {
    setQ("")
    setQuarter(ANY)
    setMonth(ANY)
    setSource(ANY)
    setSection(ANY)
    setPaymentType(ANY)
    setReturnType(ANY)
    setStatus(ANY)
    setResidence(ANY)
    setPaid("all")
    setChallan("all")
    setFromDate("")
    setToDate("")
  }

  const opts = (vals: string[] = []) => vals.map((v) => ({ value: v, label: v }))

  return (
    <div className="flex flex-col gap-6">
      <p className="text-sm text-muted-foreground">
        The complete line-level TDS ledger for the year — every FTE and freelance invoice, purchase bill, expense and
        sales invoice that carried TDS — replayed through the same filing engine and stitched to its challan, return and
        certificate context. Filter and search to trace any single deduction end to end.
      </p>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
        <Stat label="Lines" value={String(filtered.length)} hint={`of ${all.length} this year`} />
        <Stat label="Gross / Base" value={currency(totals.gross)} />
        <Stat label="TDS" value={currency(totals.tds)} />
        <Stat label="Total liability" value={currency(totals.liability)} hint="TDS + interest + late fee" />
        <Stat label="Balance" value={currency(totals.balance)} hint={`${currency(totals.paid)} paid`} />
      </div>

      <Card>
        <CardHeader className="gap-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Database className="h-4 w-4" />
              Raw TDS data · FY {fy}
            </CardTitle>
            <div className="flex items-center gap-2">
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  placeholder="Filing ID, invoice, PAN, deductee, challan…"
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  className="h-9 w-72 pl-8"
                />
              </div>
              <Button variant="outline" size="sm" onClick={reset} disabled={activeFilters === 0} className="gap-1.5">
                <FilterX className="h-4 w-4" />
                Clear{activeFilters ? ` (${activeFilters})` : ""}
              </Button>
            </div>
          </div>

          <div className="flex flex-wrap gap-3">
            <Select
              label="TDS type"
              value={tdsType}
              onChange={(v) => setTdsType(v as Direction | typeof ANY)}
              anyLabel="All directions"
              options={[
                { value: "payable", label: "Vendor" },
                { value: "employee", label: "Employee / Freelancer" },
                { value: "receivable", label: "Customer (26AS)" },
              ]}
            />
            <Select label="Quarter" value={quarter} onChange={setQuarter} options={opts(facets?.quarters)} />
            <Select label="Month" value={month} onChange={setMonth} options={opts(facets?.months)} />
            <Select label="Source" value={source} onChange={setSource} options={opts(facets?.sources)} />
            <Select label="Section" value={section} onChange={setSection} options={opts(facets?.sections)} />
            <Select
              label="Payment type"
              value={paymentType}
              onChange={setPaymentType}
              options={opts(facets?.payment_types)}
            />
            <Select label="Return type" value={returnType} onChange={setReturnType} options={opts(facets?.return_types)} />
            <Select label="Return status" value={status} onChange={setStatus} options={opts(facets?.statuses)} />
            <Select
              label="Residence"
              value={residence}
              onChange={setResidence}
              options={[
                { value: "Resident", label: "Resident" },
                { value: "Non-Resident", label: "Non-Resident" },
              ]}
            />
            <Select
              label="Paid / Unpaid"
              value={paid === "all" ? ANY : paid}
              onChange={(v) => setPaid(v === ANY ? "all" : (v as PaidState))}
              anyLabel="All"
              options={[
                { value: "paid", label: "Fully paid" },
                { value: "unpaid", label: "Balance due" },
              ]}
            />
            <Select
              label="Challan"
              value={challan === "all" ? ANY : challan}
              onChange={(v) => setChallan(v === ANY ? "all" : (v as ChallanState))}
              anyLabel="All"
              options={[
                { value: "with", label: "Linked" },
                { value: "without", label: "Unlinked" },
              ]}
            />
            <div className="flex flex-col gap-1">
              <label className="text-xs text-muted-foreground">Date from</label>
              <Input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} className="h-9 w-40" />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs text-muted-foreground">Date to</label>
              <Input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} className="h-9 w-40" />
            </div>
          </div>
        </CardHeader>

        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Month</TableHead>
                  <TableHead>Qtr</TableHead>
                  <TableHead>Source</TableHead>
                  <TableHead>Source ID</TableHead>
                  <TableHead>Deductee</TableHead>
                  <TableHead>PAN</TableHead>
                  <TableHead>Section</TableHead>
                  <TableHead>Payment type</TableHead>
                  <TableHead className="text-right">Gross</TableHead>
                  <TableHead className="text-right">Rate</TableHead>
                  <TableHead className="text-right">TDS</TableHead>
                  <TableHead className="text-right">Interest</TableHead>
                  <TableHead className="text-right">Late fee</TableHead>
                  <TableHead className="text-right">Liability</TableHead>
                  <TableHead className="text-right">Paid</TableHead>
                  <TableHead className="text-right">Balance</TableHead>
                  <TableHead>Challan</TableHead>
                  <TableHead>Return</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  <TableRow>
                    <TableCell colSpan={19} className="py-8 text-center text-sm text-muted-foreground">
                      Loading raw data…
                    </TableCell>
                  </TableRow>
                ) : filtered.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={19} className="py-8 text-center text-sm text-muted-foreground">
                      No TDS lines match the current filters.
                    </TableCell>
                  </TableRow>
                ) : (
                  filtered.map((r, i) => (
                    <TableRow key={`${r.direction}-${r.source_id}-${r.section}-${i}`}>
                      <TableCell className="whitespace-nowrap font-mono text-xs">{r.month}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">{r.quarter}</TableCell>
                      <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{r.source}</TableCell>
                      <TableCell className="whitespace-nowrap font-mono text-xs">{r.doc_ref || r.source_id || "—"}</TableCell>
                      <TableCell className="max-w-[12rem] truncate font-medium" title={r.deductee_name}>
                        {r.deductee_name}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1.5">
                          <span className="font-mono text-xs">{r.pan || "—"}</span>
                          {r.pan ? (
                            <Badge
                              variant={PAN_VARIANT[r.pan_status]}
                              className="h-4 px-1 text-[10px] leading-none"
                            >
                              {r.pan_status}
                            </Badge>
                          ) : null}
                        </div>
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-xs">{r.section}</TableCell>
                      <TableCell className="max-w-[10rem] truncate text-xs text-muted-foreground" title={r.payment_type}>
                        {r.payment_type}
                      </TableCell>
                      <TableCell className="text-right">{currency(r.gross)}</TableCell>
                      <TableCell className="text-right text-xs">{r.rate ? `${r.rate}%` : "—"}</TableCell>
                      <TableCell className="text-right font-medium">{currency(r.tds)}</TableCell>
                      <TableCell className="text-right text-xs text-muted-foreground">
                        {r.interest ? currency(r.interest) : "—"}
                      </TableCell>
                      <TableCell className="text-right text-xs text-muted-foreground">
                        {r.late_fee ? currency(r.late_fee) : "—"}
                      </TableCell>
                      <TableCell className="text-right">{currency(r.total_liability)}</TableCell>
                      <TableCell className="text-right text-muted-foreground">{currency(r.paid)}</TableCell>
                      <TableCell className="text-right font-medium">{currency(r.balance)}</TableCell>
                      <TableCell className="whitespace-nowrap font-mono text-xs text-muted-foreground">
                        {r.challan || "—"}
                      </TableCell>
                      <TableCell className="text-xs">{r.return_type}</TableCell>
                      <TableCell>
                        <StatusBadge status={r.return_status} />
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
