"use client"

import { useState } from "react"
import useSWR from "swr"
import { toast } from "sonner"
import { fetcher } from "@/lib/fetcher"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { StatusBadge, formatMoney, type SubscriptionView, type Summary } from "./billing-shared"

type ApiData = { subscriptions: SubscriptionView[]; summary: Summary }

export function RenewalsClient() {
  const { data, isLoading, mutate } = useSWR<ApiData>("/api/billing/subscriptions", fetcher)
  const [busyId, setBusyId] = useState<number | null>(null)

  const subs = data?.subscriptions ?? []
  // Renewals view: everything that is still live (has a renewal date) or lapsed
  // and recoverable. Terminal (cancelled/expired) records are excluded.
  const rows = subs
    .filter((s) => !["cancelled", "expired"].includes(s.status))
    .sort((a, b) => (a.days_to_renewal ?? 1e9) - (b.days_to_renewal ?? 1e9))

  const summary = data?.summary

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

  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">Renewals</h1>
        <p className="max-w-2xl text-sm text-muted-foreground">
          Upcoming and overdue subscription renewals across the lifecycle, with auto-renew status and one-click
          renewal / payment recording.
        </p>
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
