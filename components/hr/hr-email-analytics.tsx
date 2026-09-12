"use client"

import { useState } from "react"
import useSWR from "swr"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { fetcher } from "@/lib/fetcher"
import { HrEmailStatusBadge } from "@/components/hr/hr-email-status-badge"

type Analytics = {
  days: number
  funnel: {
    total: number
    sent: number
    failed: number
    pending: number
    drafts: number
    cancelled: number
    opened: number
    totalOpens: number
    deliveryRate: number
    openRate: number
  }
  byStatus: { status: string; count: number }[]
  byCategory: { category: string; count: number; sent: number; opened: number }[]
  byType: { type: string; count: number }[]
  byEvent: { module: string; count: number; sent: number; failed: number }[]
  trend: { day: string; total: number; sent: number; failed: number }[]
}

const RANGES = [
  { value: "7", label: "Last 7 days" },
  { value: "30", label: "Last 30 days" },
  { value: "90", label: "Last 90 days" },
  { value: "365", label: "Last 12 months" },
]

function pct(part: number, whole: number) {
  return whole > 0 ? Math.round((part / whole) * 100) : 0
}

export function HrEmailAnalytics() {
  const [days, setDays] = useState("30")
  const { data, isLoading } = useSWR<Analytics>(
    `/api/hr/emails/analytics?days=${days}`,
    fetcher,
    { keepPreviousData: true },
  )

  const f = data?.funnel
  const maxTrend = Math.max(1, ...(data?.trend.map((t) => t.total) ?? [1]))

  const headline: { label: string; value: string; hint?: string; accent?: string }[] = f
    ? [
        { label: "Emails", value: String(f.total), hint: "created in range" },
        {
          label: "Delivery rate",
          value: `${f.deliveryRate}%`,
          hint: `${f.sent} sent`,
          accent: "text-emerald-600 dark:text-emerald-400",
        },
        {
          label: "Open rate",
          value: `${f.openRate}%`,
          hint: `${f.opened} opened`,
          accent: "text-blue-600 dark:text-blue-400",
        },
        {
          label: "Failed",
          value: String(f.failed),
          hint: f.pending ? `${f.pending} in queue` : "delivery errors",
          accent: "text-red-600 dark:text-red-400",
        },
      ]
    : []

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          Delivery and engagement across all HR mail.
        </p>
        <Select value={days} onValueChange={(v) => setDays(v || "30")}>
          <SelectTrigger className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {RANGES.map((r) => (
              <SelectItem key={r.value} value={r.value}>
                {r.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {isLoading && !data ? (
        <p className="py-10 text-center text-sm text-muted-foreground">Loading analytics…</p>
      ) : !f || f.total === 0 ? (
        <p className="rounded-xl border bg-card py-10 text-center text-sm text-muted-foreground">
          No email activity in this period yet.
        </p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {headline.map((c) => (
              <div key={c.label} className="rounded-xl border bg-card p-4">
                <p className="text-xs text-muted-foreground">{c.label}</p>
                <p className={`mt-1 text-2xl font-semibold ${c.accent || ""}`}>{c.value}</p>
                {c.hint && <p className="mt-0.5 text-xs text-muted-foreground">{c.hint}</p>}
              </div>
            ))}
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            {/* Daily volume trend */}
            <div className="rounded-xl border bg-card p-5">
              <h3 className="text-sm font-medium">Daily volume</h3>
              <div className="mt-4 flex h-40 items-end gap-1">
                {data!.trend.map((t) => (
                  <div key={t.day} className="group relative flex flex-1 flex-col items-center gap-1">
                    <div
                      className="w-full rounded-t bg-primary/80 transition-colors group-hover:bg-primary"
                      style={{ height: `${Math.max(4, (t.total / maxTrend) * 140)}px` }}
                      title={`${t.day}: ${t.total} email(s), ${t.sent} sent, ${t.failed} failed`}
                    />
                  </div>
                ))}
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                {data!.trend.length} active day{data!.trend.length === 1 ? "" : "s"} in range
              </p>
            </div>

            {/* Manual vs automated + status breakdown */}
            <div className="rounded-xl border bg-card p-5">
              <h3 className="text-sm font-medium">Origin & status</h3>
              <div className="mt-4 space-y-3">
                {data!.byType.map((t) => (
                  <div key={t.type}>
                    <div className="mb-1 flex items-center justify-between text-xs">
                      <span className="font-medium">{t.type}</span>
                      <span className="text-muted-foreground">
                        {t.count} · {pct(t.count, f.total)}%
                      </span>
                    </div>
                    <div className="h-2 overflow-hidden rounded-full bg-muted">
                      <div
                        className={`h-full rounded-full ${
                          t.type === "Automated" ? "bg-blue-500" : "bg-primary"
                        }`}
                        style={{ width: `${pct(t.count, f.total)}%` }}
                      />
                    </div>
                  </div>
                ))}
              </div>
              <div className="mt-4 flex flex-wrap gap-2 border-t pt-4">
                {data!.byStatus.map((s) => (
                  <div key={s.status} className="flex items-center gap-1.5 text-xs">
                    <HrEmailStatusBadge status={s.status} />
                    <span className="tabular-nums text-muted-foreground">{s.count}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            {/* By category */}
            <div className="rounded-xl border bg-card p-5">
              <h3 className="text-sm font-medium">By category</h3>
              <table className="mt-3 w-full text-sm">
                <thead className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="pb-2 font-medium">Category</th>
                    <th className="pb-2 text-right font-medium">Total</th>
                    <th className="pb-2 text-right font-medium">Sent</th>
                    <th className="pb-2 text-right font-medium">Open %</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {data!.byCategory.map((c) => (
                    <tr key={c.category}>
                      <td className="py-2">{c.category}</td>
                      <td className="py-2 text-right tabular-nums">{c.count}</td>
                      <td className="py-2 text-right tabular-nums">{c.sent}</td>
                      <td className="py-2 text-right tabular-nums text-muted-foreground">
                        {pct(c.opened, c.sent)}%
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Top automated flows */}
            <div className="rounded-xl border bg-card p-5">
              <h3 className="text-sm font-medium">Top automated flows</h3>
              {data!.byEvent.length === 0 ? (
                <p className="mt-6 text-sm text-muted-foreground">
                  No automated emails sent in this period.
                </p>
              ) : (
                <table className="mt-3 w-full text-sm">
                  <thead className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <tr>
                      <th className="pb-2 font-medium">Source module</th>
                      <th className="pb-2 text-right font-medium">Total</th>
                      <th className="pb-2 text-right font-medium">Sent</th>
                      <th className="pb-2 text-right font-medium">Failed</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {data!.byEvent.map((e) => (
                      <tr key={e.module}>
                        <td className="py-2 font-mono text-xs">{e.module}</td>
                        <td className="py-2 text-right tabular-nums">{e.count}</td>
                        <td className="py-2 text-right tabular-nums text-emerald-600 dark:text-emerald-400">
                          {e.sent}
                        </td>
                        <td className="py-2 text-right tabular-nums text-red-600 dark:text-red-400">
                          {e.failed}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
