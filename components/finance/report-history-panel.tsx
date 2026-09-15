"use client"

import { useState } from "react"
import useSWR from "swr"
import { fetcher } from "@/lib/fetcher"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Download, Mail, RefreshCw } from "lucide-react"

type RunRow = {
  id: number
  report_key: string
  report_label: string
  format: "PDF" | "Excel" | "CSV" | "Email"
  period_label: string | null
  filters_text: string | null
  recipient: string | null
  status: string | null
  user_name: string | null
  row_count: number | null
  generated_at: string
}

type RunsResponse = {
  runs: RunRow[]
  total: number
  page: number
  pageSize: number
  summary: { total: number; downloads: number; emails: number }
}

const PAGE_SIZE = 25

const FORMAT_TABS: { key: "all" | "download" | "Email"; label: string }[] = [
  { key: "all", label: "All activity" },
  { key: "download", label: "Downloads" },
  { key: "Email", label: "Emails" },
]

function formatWhen(value: string | null): string {
  if (!value) return "—"
  const d = new Date(value.includes("T") ? value : value.replace(" ", "T") + "Z")
  if (Number.isNaN(d.getTime())) return String(value)
  return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
}

function statusTone(status: string | null): string {
  const s = (status || "").toLowerCase()
  if (s === "sent") return "text-emerald-600 dark:text-emerald-400"
  if (s === "failed") return "text-red-600 dark:text-red-400"
  if (s === "downloaded") return "text-blue-600 dark:text-blue-400"
  return "text-muted-foreground"
}

/**
 * Download + Email history for Financial Reports (Phases 18–19). Reads the
 * shared `finance_report_runs` log so every generated snapshot — whether it was
 * downloaded as PDF/Excel/CSV or emailed — is listed with who generated it, the
 * period, filters and the exact generated-at time.
 */
export function ReportHistoryPanel() {
  const [tab, setTab] = useState<"all" | "download" | "Email">("all")
  const [q, setQ] = useState("")
  const [page, setPage] = useState(1)

  const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) })
  // The API accepts a specific format; "download" is expanded to each download
  // type client-side is unnecessary — instead we filter Emails vs everything.
  if (tab === "Email") params.set("format", "Email")
  if (q.trim()) params.set("q", q.trim())

  const { data, isLoading, isValidating, mutate } = useSWR<RunsResponse>(
    `/api/finance/reports/runs?${params.toString()}`,
    fetcher,
    { keepPreviousData: true },
  )

  const allRuns = data?.runs ?? []
  const runs = tab === "download" ? allRuns.filter((r) => r.format !== "Email") : allRuns
  const summary = data?.summary
  const total = data?.total ?? 0
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  const cards = summary
    ? [
        { label: "Total", value: summary.total },
        { label: "Downloads", value: summary.downloads },
        { label: "Emails", value: summary.emails },
      ]
    : []

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        {cards.map((c) => (
          <Card key={c.label}>
            <CardContent className="p-4">
              <p className="text-xs font-medium text-muted-foreground">{c.label}</p>
              <p className="mt-1 text-2xl font-semibold tabular-nums">{c.value}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader className="gap-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <CardTitle className="text-base">Generation history</CardTitle>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Refresh history"
              onClick={() => mutate()}
            >
              <RefreshCw className={isValidating ? "animate-spin" : ""} />
            </Button>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex gap-1 rounded-md border p-1">
              {FORMAT_TABS.map((t) => (
                <button
                  key={t.key}
                  type="button"
                  onClick={() => {
                    setTab(t.key)
                    setPage(1)
                  }}
                  aria-pressed={tab === t.key}
                  className={`rounded px-3 py-1.5 text-sm font-medium transition-colors ${
                    tab === t.key ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted/60"
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>
            <Input
              value={q}
              onChange={(e) => {
                setQ(e.target.value)
                setPage(1)
              }}
              placeholder="Search report, user, recipient…"
              className="h-9 w-full sm:max-w-xs"
            />
          </div>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Report</TableHead>
                  <TableHead>Format</TableHead>
                  <TableHead>Period</TableHead>
                  <TableHead>Filters</TableHead>
                  <TableHead>Recipient</TableHead>
                  <TableHead>By</TableHead>
                  <TableHead>Generated At</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  <TableRow>
                    <TableCell colSpan={8} className="py-6 text-center text-muted-foreground">
                      Loading history…
                    </TableCell>
                  </TableRow>
                ) : runs.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={8} className="py-6 text-center text-muted-foreground">
                      No report downloads or emails recorded yet.
                    </TableCell>
                  </TableRow>
                ) : (
                  runs.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell className="font-medium">{r.report_label}</TableCell>
                      <TableCell>
                        <Badge variant={r.format === "Email" ? "default" : "secondary"} className="gap-1">
                          {r.format === "Email" ? (
                            <Mail className="size-3" />
                          ) : (
                            <Download className="size-3" />
                          )}
                          {r.format}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-muted-foreground">{r.period_label || "—"}</TableCell>
                      <TableCell className="text-muted-foreground">{r.filters_text || "—"}</TableCell>
                      <TableCell className="text-muted-foreground">{r.recipient || "—"}</TableCell>
                      <TableCell>{r.user_name || "—"}</TableCell>
                      <TableCell className="whitespace-nowrap text-muted-foreground">
                        {formatWhen(r.generated_at)}
                      </TableCell>
                      <TableCell className={statusTone(r.status)}>{r.status || "—"}</TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>

          {total > PAGE_SIZE && (
            <div className="mt-4 flex items-center justify-between text-sm text-muted-foreground">
              <span>
                Page {page} of {totalPages} · {total} records
              </span>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page <= 1}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                >
                  Previous
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page >= totalPages}
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                >
                  Next
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
