"use client"

import useSWR from "swr"
import { fetcher } from "@/lib/fetcher"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { BarChart3 } from "lucide-react"
import { PageHeader, StatusPill } from "@/components/recruit/recruit-shared"
import { ExcelExportButton } from "@/components/excel-export-button"

type ReportRow = {
  job_id: string
  title: string
  department: string | null
  status: string
  positions: number
  applications: number
  interviews: number
  offered: number
  hired: number
  rejected: number
}

type Perf = {
  key: string
  applications: number
  screened: number
  shortlisted: number
  interviewed: number
  selected: number
  offers: number
  joined: number
  conversion: number
}

type Insights = {
  kpis: {
    timeToHire: number | null
    timeToFill: number | null
    offerAcceptanceRate: number
    joiningRatio: number
    screeningConversion: number
    interviewConversion: number
    sourceConversion: number
    requisitionAging: number | null
    jobAging: number | null
    applicationAging: number | null
  }
  totals: Perf
  analytics: { source: Perf[]; campaign: Perf[]; recruiter: Perf[] }
}

const DAYS = (v: number | null) => (v === null ? "—" : `${v}d`)
const PCT = (v: number) => `${v}%`

function KpiCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card size="sm">
      <CardContent className="flex flex-col gap-1 py-1">
        <span className="text-2xl font-semibold tabular-nums">{value}</span>
        <span className="text-xs font-medium leading-tight">{label}</span>
        {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
      </CardContent>
    </Card>
  )
}

function PerfTable({ title, label, rows }: { title: string; label: string; rows: Perf[] }) {
  return (
    <Card>
      <CardHeader><CardTitle>{title}</CardTitle></CardHeader>
      <CardContent className="px-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{label}</TableHead>
              <TableHead className="text-right">Applications</TableHead>
              <TableHead className="text-right">Shortlisted</TableHead>
              <TableHead className="text-right">Interviewed</TableHead>
              <TableHead className="text-right">Selected</TableHead>
              <TableHead className="text-right">Joined</TableHead>
              <TableHead className="text-right">Conv.</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 && (
              <TableRow><TableCell colSpan={7} className="py-8 text-center text-sm text-muted-foreground">No data yet.</TableCell></TableRow>
            )}
            {rows.map((r) => (
              <TableRow key={r.key}>
                <TableCell className="font-medium">{r.key}</TableCell>
                <TableCell className="text-right tabular-nums">{r.applications}</TableCell>
                <TableCell className="text-right tabular-nums">{r.shortlisted}</TableCell>
                <TableCell className="text-right tabular-nums">{r.interviewed}</TableCell>
                <TableCell className="text-right tabular-nums">{r.selected}</TableCell>
                <TableCell className="text-right tabular-nums font-medium text-emerald-600 dark:text-emerald-400">{r.joined}</TableCell>
                <TableCell className="text-right tabular-nums text-muted-foreground">{r.conversion}%</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}

export function ReportClient() {
  const { data, isLoading } = useSWR<{ report: ReportRow[] }>("/api/recruit/report", fetcher)
  const { data: insights } = useSWR<Insights>("/api/recruit/report/insights", fetcher)
  const rows = data?.report ?? []
  const k = insights?.kpis

  const totals = rows.reduce(
    (acc, r) => ({
      positions: acc.positions + Number(r.positions || 0),
      applications: acc.applications + Number(r.applications || 0),
      interviews: acc.interviews + Number(r.interviews || 0),
      offered: acc.offered + Number(r.offered || 0),
      hired: acc.hired + Number(r.hired || 0),
    }),
    { positions: 0, applications: 0, interviews: 0, offered: 0, hired: 0 },
  )

  const stats = [
    { label: "Open positions", value: totals.positions },
    { label: "Applications", value: totals.applications },
    { label: "Interviews", value: totals.interviews },
    { label: "Offers", value: totals.offered },
    { label: "Hired", value: totals.hired },
  ]

  return (
    <main className="flex flex-col gap-6 p-6 md:p-8">
      <PageHeader
        title="Recruitment Report"
        description="Hiring funnel performance across every job posting."
        icon={BarChart3}
        action={
          <ExcelExportButton
            rows={rows}
            filename="recruitment-report"
            columns={[
              { header: "Job ID", value: (r) => r.job_id },
              { header: "Title", value: (r) => r.title },
              { header: "Department", value: (r) => r.department },
              { header: "Status", value: (r) => r.status },
              { header: "Positions", value: (r) => r.positions },
              { header: "Applications", value: (r) => r.applications },
              { header: "Interviews", value: (r) => r.interviews },
              { header: "Offered", value: (r) => r.offered },
              { header: "Hired", value: (r) => r.hired },
              { header: "Rejected", value: (r) => r.rejected },
            ]}
          />
        }
      />

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
        {stats.map((s) => (
          <Card key={s.label} size="sm">
            <CardContent className="flex flex-col gap-1 py-1">
              <span className="text-2xl font-semibold tabular-nums">{s.value}</span>
              <span className="text-xs text-muted-foreground">{s.label}</span>
            </CardContent>
          </Card>
        ))}
      </div>

      {k && (
        <Card>
          <CardHeader><CardTitle>Recruitment KPIs</CardTitle></CardHeader>
          <CardContent className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            <KpiCard label="Time to hire" value={DAYS(k.timeToHire)} hint="applied → hired, avg" />
            <KpiCard label="Time to fill" value={DAYS(k.timeToFill)} hint="requisition → filled, avg" />
            <KpiCard label="Offer acceptance" value={PCT(k.offerAcceptanceRate)} hint="accepted / offers" />
            <KpiCard label="Joining ratio" value={PCT(k.joiningRatio)} hint="joined / accepted" />
            <KpiCard label="Source conversion" value={PCT(k.sourceConversion)} hint="joined / applications" />
            <KpiCard label="Screening conversion" value={PCT(k.screeningConversion)} hint="shortlisted / screened" />
            <KpiCard label="Interview conversion" value={PCT(k.interviewConversion)} hint="selected / interviewed" />
            <KpiCard label="Application aging" value={DAYS(k.applicationAging)} hint="active apps, avg age" />
            <KpiCard label="Job aging" value={DAYS(k.jobAging)} hint="open jobs, avg age" />
            <KpiCard label="Requisition aging" value={DAYS(k.requisitionAging)} hint="open reqs, avg age" />
          </CardContent>
        </Card>
      )}

      {insights && (
        <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
          <PerfTable title="Source performance" label="Source" rows={insights.analytics.source} />
          <PerfTable title="Campaign performance" label="Campaign" rows={insights.analytics.campaign} />
          <PerfTable title="Recruiter performance" label="Recruiter" rows={insights.analytics.recruiter} />
        </div>
      )}

      <Card>
        <CardHeader><CardTitle>Job-wise funnel</CardTitle></CardHeader>
        <CardContent className="px-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Job</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Positions</TableHead>
                <TableHead className="text-right">Applications</TableHead>
                <TableHead className="text-right">Interviews</TableHead>
                <TableHead className="text-right">Offered</TableHead>
                <TableHead className="text-right">Hired</TableHead>
                <TableHead className="text-right">Rejected</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading && <TableRow><TableCell colSpan={8} className="py-10 text-center text-sm text-muted-foreground">Loading report...</TableCell></TableRow>}
              {!isLoading && rows.length === 0 && <TableRow><TableCell colSpan={8} className="py-10 text-center text-sm text-muted-foreground">No data yet.</TableCell></TableRow>}
              {rows.map((r) => (
                <TableRow key={r.job_id}>
                  <TableCell>
                    <div className="flex flex-col">
                      <span className="font-medium">{r.title}</span>
                      <span className="text-xs text-muted-foreground">{r.department || r.job_id}</span>
                    </div>
                  </TableCell>
                  <TableCell><StatusPill status={r.status} kind="job" /></TableCell>
                  <TableCell className="text-right tabular-nums">{r.positions}</TableCell>
                  <TableCell className="text-right tabular-nums">{r.applications}</TableCell>
                  <TableCell className="text-right tabular-nums">{r.interviews}</TableCell>
                  <TableCell className="text-right tabular-nums">{r.offered}</TableCell>
                  <TableCell className="text-right tabular-nums font-medium text-emerald-600 dark:text-emerald-400">{r.hired}</TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">{r.rejected}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </main>
  )
}
