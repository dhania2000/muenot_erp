"use client"

import useSWR from "swr"
import { fetcher } from "@/lib/fetcher"
import type { EmailHubUiConfig } from "@/lib/email-hub-shared"
import { EmailHubStatusBadge } from "@/components/email-hub/email-hub-status-badge"

type Analytics = {
  totals: {
    total: number
    sent: number
    failed: number
    pending: number
    drafts: number
    opened: number
    automated: number
    manual: number
  }
  openRate: number
  byCategory: { category: string; count: number }[]
  byStatus: { status: string; count: number }[]
  daily: { day: string; sent: number; opened: number }[]
}

function pct(part: number, whole: number) {
  return whole > 0 ? Math.round((part / whole) * 100) : 0
}

export function EmailHubAnalytics({ config }: { config: EmailHubUiConfig }) {
  const { data, isLoading } = useSWR<Analytics>(`${config.apiBase}/analytics`, fetcher, {
    keepPreviousData: true,
  })

  const t = data?.totals
  const maxDaily = Math.max(1, ...(data?.daily.map((d) => d.sent) ?? [1]))

  const headline = t
    ? [
        { label: "Emails", value: String(t.total), hint: "all time" },
        {
          label: "Delivery",
          value: `${pct(t.sent, t.total)}%`,
          hint: `${t.sent} sent`,
          accent: "text-emerald-600 dark:text-emerald-400",
        },
        {
          label: "Open rate",
          value: `${data?.openRate ?? 0}%`,
          hint: `${t.opened} opened`,
          accent: "text-blue-600 dark:text-blue-400",
        },
        {
          label: "Failed",
          value: String(t.failed),
          hint: t.pending ? `${t.pending} in queue` : "delivery errors",
          accent: "text-red-600 dark:text-red-400",
        },
      ]
    : []

  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground">Delivery and engagement across all mail.</p>

      {isLoading && !data ? (
        <p className="py-10 text-center text-sm text-muted-foreground">Loading analytics…</p>
      ) : !t || t.total === 0 ? (
        <p className="rounded-xl border bg-card py-10 text-center text-sm text-muted-foreground">
          No email activity yet.
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
            <div className="rounded-xl border bg-card p-5">
              <h3 className="text-sm font-medium">Daily sent (14 days)</h3>
              <div className="mt-4 flex h-40 items-end gap-1">
                {data!.daily.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No sends in the last 14 days.</p>
                ) : (
                  data!.daily.map((d) => (
                    <div
                      key={d.day}
                      className="group relative flex flex-1 flex-col items-center gap-1"
                    >
                      <div
                        className="w-full rounded-t bg-primary/80 transition-colors group-hover:bg-primary"
                        style={{ height: `${Math.max(4, (d.sent / maxDaily) * 140)}px` }}
                        title={`${d.day}: ${d.sent} sent, ${d.opened} opened`}
                      />
                    </div>
                  ))
                )}
              </div>
            </div>

            <div className="rounded-xl border bg-card p-5">
              <h3 className="text-sm font-medium">Origin & status</h3>
              <div className="mt-4 space-y-3">
                {[
                  { type: "Manual", count: t.manual },
                  { type: "Automated", count: t.automated },
                ].map((o) => (
                  <div key={o.type}>
                    <div className="mb-1 flex items-center justify-between text-xs">
                      <span className="font-medium">{o.type}</span>
                      <span className="text-muted-foreground">
                        {o.count} · {pct(o.count, t.total)}%
                      </span>
                    </div>
                    <div className="h-2 overflow-hidden rounded-full bg-muted">
                      <div
                        className={`h-full rounded-full ${
                          o.type === "Automated" ? "bg-blue-500" : "bg-primary"
                        }`}
                        style={{ width: `${pct(o.count, t.total)}%` }}
                      />
                    </div>
                  </div>
                ))}
              </div>
              <div className="mt-4 flex flex-wrap gap-2 border-t pt-4">
                {data!.byStatus.map((s) => (
                  <div key={s.status} className="flex items-center gap-1.5 text-xs">
                    <EmailHubStatusBadge status={s.status} />
                    <span className="tabular-nums text-muted-foreground">{s.count}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="rounded-xl border bg-card p-5">
            <h3 className="text-sm font-medium">By category</h3>
            {data!.byCategory.length === 0 ? (
              <p className="mt-6 text-sm text-muted-foreground">No categorized emails yet.</p>
            ) : (
              <table className="mt-3 w-full text-sm">
                <thead className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="pb-2 font-medium">Category</th>
                    <th className="pb-2 text-right font-medium">Total</th>
                    <th className="pb-2 text-right font-medium">Share</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {data!.byCategory.map((c) => (
                    <tr key={c.category}>
                      <td className="py-2">{c.category}</td>
                      <td className="py-2 text-right tabular-nums">{c.count}</td>
                      <td className="py-2 text-right tabular-nums text-muted-foreground">
                        {pct(c.count, t.total)}%
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}
    </div>
  )
}
