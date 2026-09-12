"use client"

import useSWR from "swr"
import { fetcher } from "@/lib/fetcher"
import { Badge } from "@/components/ui/badge"
import { AlertTriangle, CheckCircle2 } from "lucide-react"

type Summary = {
  departments: { total: number; active: number; inactive: number }
  designations: { total: number; active: number; inactive: number }
  documentTypes: { total: number; required: number }
  promotions: { pending: number; approved: number; upcoming: number; due: number }
  awards: { thisYear: number }
  appreciations: { thisMonth: number }
  passportVisa: { passportExpired: number; passportExpiring: number; visaExpired: number; visaExpiring: number }
  holidays: { upcoming: number; thisYear: number }
  dataQuality: { key: string; label: string; count: number; kind?: string }[]
}

type Stat = { label: string; value: number; hint?: string; tab?: string; tone?: "default" | "warn" | "danger" }

export function MasterSummaryPanel({ onJump }: { onJump?: (kind: string) => void }) {
  const { data } = useSWR<Summary>("/api/hr/master-data/summary", fetcher)
  if (!data) return null

  const stats: Stat[] = [
    { label: "Departments", value: data.departments.total, hint: `${data.departments.active} active`, tab: "departments" },
    { label: "Designations", value: data.designations.total, hint: `${data.designations.active} active`, tab: "designations" },
    {
      label: "Promotions",
      value: data.promotions.pending + data.promotions.approved,
      hint: `${data.promotions.pending} pending · ${data.promotions.due} due`,
      tab: "promotions",
      tone: data.promotions.due > 0 ? "warn" : "default",
    },
    { label: "Awards (YTD)", value: data.awards.thisYear, tab: "awards" },
    { label: "Appreciations (MTD)", value: data.appreciations.thisMonth, tab: "appreciations" },
    {
      label: "Passport / Visa alerts",
      value:
        data.passportVisa.passportExpired +
        data.passportVisa.passportExpiring +
        data.passportVisa.visaExpired +
        data.passportVisa.visaExpiring,
      hint: `${data.passportVisa.passportExpired + data.passportVisa.visaExpired} expired`,
      tab: "passport-visa",
      tone:
        data.passportVisa.passportExpired + data.passportVisa.visaExpired > 0
          ? "danger"
          : data.passportVisa.passportExpiring + data.passportVisa.visaExpiring > 0
            ? "warn"
            : "default",
    },
    { label: "Holidays (upcoming)", value: data.holidays.upcoming, hint: `${data.holidays.thisYear} this year`, tab: "holidays" },
  ]

  return (
    <section className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-7">
        {stats.map((s) => (
          <button
            key={s.label}
            type="button"
            onClick={() => s.tab && onJump?.(s.tab)}
            className="rounded-xl border bg-card p-3 text-left transition-colors hover:bg-accent"
          >
            <p className="text-xs text-muted-foreground">{s.label}</p>
            <p
              className={
                "mt-1 text-2xl font-semibold tabular-nums " +
                (s.tone === "danger" ? "text-destructive" : s.tone === "warn" ? "text-amber-600" : "")
              }
            >
              {s.value}
            </p>
            {s.hint && <p className="mt-0.5 text-xs text-muted-foreground">{s.hint}</p>}
          </button>
        ))}
      </div>

      <div className="rounded-xl border">
        <div className="flex items-center gap-2 border-b p-3">
          {data.dataQuality.length === 0 ? (
            <CheckCircle2 className="size-4 text-emerald-600" />
          ) : (
            <AlertTriangle className="size-4 text-amber-600" />
          )}
          <h2 className="text-sm font-medium">Data quality</h2>
          {data.dataQuality.length > 0 && (
            <Badge variant="secondary" className="ml-auto">
              {data.dataQuality.reduce((n, i) => n + i.count, 0)} to review
            </Badge>
          )}
        </div>
        {data.dataQuality.length === 0 ? (
          <p className="p-3 text-sm text-muted-foreground">No issues detected. Master data looks healthy.</p>
        ) : (
          <ul className="divide-y">
            {data.dataQuality.map((i) => (
              <li key={i.key} className="flex items-center justify-between gap-3 p-3 text-sm">
                <span>{i.label}</span>
                <span className="flex items-center gap-2">
                  <Badge variant="outline" className="tabular-nums">
                    {i.count}
                  </Badge>
                  {i.kind && (
                    <button
                      type="button"
                      onClick={() => onJump?.(i.kind!)}
                      className="text-xs font-medium text-primary hover:underline"
                    >
                      Review
                    </button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  )
}
