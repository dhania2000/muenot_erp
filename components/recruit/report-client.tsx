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

export function ReportClient() {
  const { data, isLoading } = useSWR<{ report: ReportRow[] }>("/api/recruit/report", fetcher)
  const rows = data?.report ?? []

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
      <PageHeader title="Recruitment Report" description="Hiring funnel performance across every job posting." icon={BarChart3} />

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
