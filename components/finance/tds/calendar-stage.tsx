"use client"

import useSWR from "swr"
import { useState } from "react"
import { fetcher } from "@/lib/fetcher"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { CalendarClock, BellRing, Receipt, ScrollText, Award, RefreshCw, AlertTriangle } from "lucide-react"
import { currency, isDeductor, type Direction } from "./shared"

type Severity = "done" | "overdue" | "due-soon" | "upcoming"
type Obligation = {
  obligation_key: string
  kind: "challan" | "return" | "certificate"
  direction: string
  form_type: string | null
  quarter: string | null
  period: string | null
  financial_year: string
  title: string
  due_date: string
  amount: number
  status: string
  severity: Severity
  days_to_due: number
  done: boolean
}
type Reminder = {
  reminder_id: string
  kind: string
  title: string
  due_date: string
  amount: number
  severity: string
  status: string
  offset_label: string | null
  note: string | null
}

const KIND_ICON = { challan: Receipt, return: ScrollText, certificate: Award } as const

const SEVERITY_META: Record<Severity, { label: string; variant: "default" | "secondary" | "outline" | "destructive" }> = {
  overdue: { label: "Overdue", variant: "destructive" },
  "due-soon": { label: "Due soon", variant: "secondary" },
  upcoming: { label: "Upcoming", variant: "outline" },
  done: { label: "Done", variant: "default" },
}

function dueLabel(days: number, done: boolean): string {
  if (done) return "Completed"
  if (days < 0) return `${Math.abs(days)}d overdue`
  if (days === 0) return "Due today"
  return `in ${days}d`
}

export function CalendarStage({ direction, fy }: { direction: Direction; fy: string }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [rowBusy, setRowBusy] = useState("")

  const deductor = isDeductor(direction)
  const { data: calData } = useSWR<{ calendar: { obligations: Obligation[] } }>(
    deductor ? `/api/finance/tds/calendar?fy=${fy}&direction=${direction}` : null,
    fetcher,
  )
  const { data: remData, mutate: mutateReminders } = useSWR<{ reminders: Reminder[] }>(
    `/api/finance/tds/calendar?reminders=1`,
    fetcher,
  )

  const obligations = calData?.calendar.obligations ?? []
  const reminders = remData?.reminders ?? []
  const openReminders = reminders.filter((r) => r.status === "open" || r.status === "acknowledged")

  const counts = obligations.reduce(
    (acc, o) => {
      acc[o.severity] = (acc[o.severity] || 0) + 1
      return acc
    },
    {} as Record<string, number>,
  )

  async function sweep() {
    setBusy(true)
    setError("")
    try {
      const res = await fetch("/api/finance/tds/calendar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "sweep", fy }),
      })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error || "Reminder sweep failed")
      mutateReminders()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function actReminder(reminderId: string, status: string) {
    setRowBusy(reminderId)
    setError("")
    try {
      const res = await fetch("/api/finance/tds/calendar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "set_reminder_status", reminder_id: reminderId, status }),
      })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error || "Could not update reminder")
      mutateReminders()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setRowBusy("")
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <p className="max-w-xl text-sm text-muted-foreground">
          Every statutory deadline for this financial year — monthly challan deposits, quarterly returns and the Form
          16/16A that follows each — derived automatically from the liability rollup. Run the sweep to raise reminders
          for anything entering its T-7 / T-3 / due / overdue window.
        </p>
        <Button onClick={sweep} disabled={busy} className="gap-1.5">
          <RefreshCw className={`h-4 w-4 ${busy ? "animate-spin" : ""}`} />
          {busy ? "Sweeping…" : "Run reminder sweep"}
        </Button>
      </div>

      {error ? <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p> : null}

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <SummaryCard label="Overdue" value={counts.overdue || 0} tone="destructive" />
        <SummaryCard label="Due soon" value={counts["due-soon"] || 0} tone="warning" />
        <SummaryCard label="Upcoming" value={counts.upcoming || 0} tone="muted" />
        <SummaryCard label="Open reminders" value={openReminders.length} tone="muted" />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <BellRing className="h-4 w-4" />
            Reminder queue
            {openReminders.length > 0 ? <Badge variant="secondary">{openReminders.length} open</Badge> : null}
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Obligation</TableHead>
                  <TableHead>Window</TableHead>
                  <TableHead>Due</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {openReminders.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} className="py-8 text-center text-sm text-muted-foreground">
                      No open reminders. Run the sweep to check for approaching deadlines.
                    </TableCell>
                  </TableRow>
                ) : (
                  openReminders.map((r) => (
                    <TableRow key={r.reminder_id}>
                      <TableCell className="font-medium">{r.title}</TableCell>
                      <TableCell>
                        {r.offset_label ? (
                          <Badge variant={r.offset_label === "OVERDUE" ? "destructive" : "outline"}>
                            {r.offset_label}
                          </Badge>
                        ) : (
                          "—"
                        )}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">{r.due_date}</TableCell>
                      <TableCell className="text-right">{currency(r.amount)}</TableCell>
                      <TableCell>
                        <Badge variant={r.status === "acknowledged" ? "secondary" : "outline"}>{r.status}</Badge>
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex flex-wrap items-center justify-end gap-1">
                          {r.status === "open" ? (
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-7 px-2 text-xs"
                              disabled={rowBusy === r.reminder_id}
                              onClick={() => actReminder(r.reminder_id, "acknowledged")}
                            >
                              Acknowledge
                            </Button>
                          ) : null}
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 px-2 text-xs"
                            disabled={rowBusy === r.reminder_id}
                            onClick={() => actReminder(r.reminder_id, "dismissed")}
                          >
                            Dismiss
                          </Button>
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

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <CalendarClock className="h-4 w-4" />
            Compliance calendar · FY {fy}
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {!deductor ? (
            <p className="p-6 text-sm text-muted-foreground">
              Receivable TDS is a Form 26AS credit and carries no filing obligations, so the calendar is empty for this
              direction.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Obligation</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Due date</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Timeline</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {obligations.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={6} className="py-8 text-center text-sm text-muted-foreground">
                        No obligations for this year — nothing has been deducted yet.
                      </TableCell>
                    </TableRow>
                  ) : (
                    obligations.map((o) => {
                      const Icon = KIND_ICON[o.kind]
                      const sev = SEVERITY_META[o.severity]
                      return (
                        <TableRow key={o.obligation_key}>
                          <TableCell className="font-medium">
                            <div className="flex items-center gap-2">
                              {o.severity === "overdue" ? (
                                <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-destructive" />
                              ) : null}
                              {o.title}
                            </div>
                          </TableCell>
                          <TableCell>
                            <span className="flex items-center gap-1.5 text-sm capitalize text-muted-foreground">
                              <Icon className="h-3.5 w-3.5" />
                              {o.kind}
                            </span>
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground">{o.due_date}</TableCell>
                          <TableCell className="text-right">{currency(o.amount)}</TableCell>
                          <TableCell>
                            <Badge variant={sev.variant}>{o.done ? "Done" : o.status}</Badge>
                          </TableCell>
                          <TableCell className="text-right text-xs text-muted-foreground">
                            {dueLabel(o.days_to_due, o.done)}
                          </TableCell>
                        </TableRow>
                      )
                    })
                  )}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function SummaryCard({
  label,
  value,
  tone,
}: {
  label: string
  value: number
  tone: "destructive" | "warning" | "muted"
}) {
  const color =
    tone === "destructive"
      ? "text-destructive"
      : tone === "warning"
        ? "text-amber-600 dark:text-amber-400"
        : "text-foreground"
  return (
    <div className="flex flex-col gap-1 rounded-lg border bg-card p-4">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className={`text-2xl font-semibold ${color}`}>{value}</span>
    </div>
  )
}
