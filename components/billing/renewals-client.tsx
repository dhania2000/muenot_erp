"use client"

import { useState } from "react"
import useSWR from "swr"
import { toast } from "sonner"
import { fetcher } from "@/lib/fetcher"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { StatusBadge, formatMoney, type SubscriptionView, type Summary } from "./billing-shared"

type Reminder = {
  id: number
  subscription_no: string
  reminder_kind: string
  reminder_label: string
  period_end: string
  channel: "email" | "log"
  status: "sent" | "logged" | "failed"
  recipient: string | null
  note: string | null
  created_at: string
}

type Attempt = {
  id: number
  subscription_no: string
  attempt_no: number
  period_end: string
  scheduled_for: string
  status: "succeeded" | "failed" | "exhausted"
  amount: number
  currency: string
  gateway: string | null
  invoice_no: string | null
  error: string | null
  created_at: string
}

type CycleResult = {
  scanned: number
  lifecycle_changed: number
  reminders_queued: number
  reminders_sent: number
  retries_attempted: number
  retries_succeeded: number
  suspended: number
  invoices_generated: number
}

type ApiData = {
  subscriptions: SubscriptionView[]
  summary: Summary
  reminders: Reminder[]
  attempts: Attempt[]
}

export function RenewalsClient() {
  const { data, isLoading, mutate } = useSWR<ApiData>("/api/billing/renewals", fetcher)
  const [busyId, setBusyId] = useState<number | null>(null)
  const [running, setRunning] = useState(false)

  const subs = data?.subscriptions ?? []
  // Renewals view: everything that is still live (has a renewal date) or lapsed
  // and recoverable. Terminal (cancelled/expired) records are excluded.
  const rows = subs
    .filter((s) => !["cancelled", "expired"].includes(s.status))
    .sort((a, b) => (a.days_to_renewal ?? 1e9) - (b.days_to_renewal ?? 1e9))

  const summary = data?.summary
  const reminders = data?.reminders ?? []
  const attempts = data?.attempts ?? []

  async function renew(id: number) {
    setBusyId(id)
    try {
      const res = await fetch(`/api/billing/subscriptions/${id}/actions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "renew", note: "Renewed from renewals console" }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || "Renewal failed")
      toast.success("Renewal recorded")
      mutate()
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setBusyId(null)
    }
  }

  async function runCycle() {
    setRunning(true)
    try {
      const res = await fetch("/api/billing/renewals/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sendReminders: true }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || "Renewal cycle failed")
      const r = json.result as CycleResult
      toast.success(
        `Cycle done — ${r.reminders_queued} reminder(s), ${r.retries_attempted} retry(ies), ${r.suspended} suspended`,
      )
      mutate()
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">Renewals</h1>
          <p className="max-w-2xl text-sm text-muted-foreground">
            Upcoming and overdue subscription renewals across the lifecycle, with automated reminders, failed-payment
            retries, grace periods, suspension, and one-click manual renewal.
          </p>
        </div>
        <Button onClick={runCycle} disabled={running}>
          {running ? "Running…" : "Run renewal cycle"}
        </Button>
      </header>

      <div className="mt-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Due in 30 days" value={summary ? String(summary.renewals_due_30d) : "—"} />
        <Stat label="At risk" value={summary ? String(summary.at_risk) : "—"} />
        <Stat label="Auto-renew" value={String(rows.filter((r) => r.auto_renew).length)} />
        <Stat label="Manual" value={String(rows.filter((r) => !r.auto_renew).length)} />
      </div>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle className="text-base font-medium">Renewal schedule</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto rounded-md border border-border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Reference</TableHead>
                  <TableHead>Plan</TableHead>
                  <TableHead>Term</TableHead>
                  <TableHead>Renews on</TableHead>
                  <TableHead>Countdown</TableHead>
                  <TableHead>Amount</TableHead>
                  <TableHead>Mode</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  <TableRow>
                    <TableCell colSpan={9} className="h-24 text-center text-muted-foreground">Loading…</TableCell>
                  </TableRow>
                ) : rows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={9} className="h-24 text-center text-muted-foreground">
                      No upcoming renewals.
                    </TableCell>
                  </TableRow>
                ) : (
                  rows.map((s) => (
                    <TableRow key={s.id}>
                      <TableCell className="font-mono text-xs">{s.subscription_no}</TableCell>
                      <TableCell>{s.plan_name}</TableCell>
                      <TableCell>{s.term_label}</TableCell>
                      <TableCell>{s.current_period_end}</TableCell>
                      <TableCell>
                        <Countdown days={s.days_to_renewal} />
                      </TableCell>
                      <TableCell>{formatMoney(s.amount, s.currency)}</TableCell>
                      <TableCell>{s.auto_renew ? "Auto-renew" : "Manual"}</TableCell>
                      <TableCell><StatusBadge status={s.status} label={s.status_label} /></TableCell>
                      <TableCell className="text-right">
                        <Button size="sm" variant="outline" disabled={busyId === s.id} onClick={() => renew(s.id)}>
                          {busyId === s.id ? "…" : "Renew"}
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base font-medium">Recent renewal reminders</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto rounded-md border border-border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Reference</TableHead>
                    <TableHead>Reminder</TableHead>
                    <TableHead>Renews on</TableHead>
                    <TableHead className="text-right">Delivery</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {reminders.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={4} className="h-20 text-center text-muted-foreground">
                        No reminders sent yet. Run the renewal cycle to queue reminders.
                      </TableCell>
                    </TableRow>
                  ) : (
                    reminders.map((r) => (
                      <TableRow key={r.id}>
                        <TableCell className="font-mono text-xs">{r.subscription_no}</TableCell>
                        <TableCell>{r.reminder_label}</TableCell>
                        <TableCell>{r.period_end}</TableCell>
                        <TableCell className="text-right">
                          <DeliveryBadge channel={r.channel} status={r.status} />
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
            <CardTitle className="text-base font-medium">Failed-payment retries</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto rounded-md border border-border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Reference</TableHead>
                    <TableHead>Attempt</TableHead>
                    <TableHead>Scheduled</TableHead>
                    <TableHead className="text-right">Result</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {attempts.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={4} className="h-20 text-center text-muted-foreground">
                        No payment retries recorded.
                      </TableCell>
                    </TableRow>
                  ) : (
                    attempts.map((a) => (
                      <TableRow key={a.id}>
                        <TableCell className="font-mono text-xs">{a.subscription_no}</TableCell>
                        <TableCell>#{a.attempt_no}</TableCell>
                        <TableCell>{a.scheduled_for}</TableCell>
                        <TableCell className="text-right">
                          <RetryBadge status={a.status} />
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
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-semibold text-foreground">{value}</div>
      </CardContent>
    </Card>
  )
}

function Countdown({ days }: { days: number | null }) {
  if (days == null) return <span className="text-muted-foreground">—</span>
  if (days < 0) return <span className="font-medium text-red-600 dark:text-red-400">{Math.abs(days)}d overdue</span>
  if (days <= 7) return <span className="font-medium text-amber-600 dark:text-amber-400">in {days}d</span>
  return <span className="text-foreground">in {days}d</span>
}

function DeliveryBadge({ channel, status }: { channel: "email" | "log"; status: "sent" | "logged" | "failed" }) {
  if (status === "sent") return <Badge className="bg-emerald-600 text-white hover:bg-emerald-600">Emailed</Badge>
  if (status === "failed") return <Badge variant="destructive">Failed</Badge>
  return <Badge variant="secondary">Logged</Badge>
}

function RetryBadge({ status }: { status: "succeeded" | "failed" | "exhausted" }) {
  if (status === "succeeded") return <Badge className="bg-emerald-600 text-white hover:bg-emerald-600">Collected</Badge>
  if (status === "exhausted") return <Badge variant="destructive">Suspended</Badge>
  return <Badge variant="secondary">Declined</Badge>
}
