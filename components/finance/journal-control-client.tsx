"use client"

import { useMemo, useState } from "react"
import useSWR from "swr"
import { fetcher } from "@/lib/fetcher"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  ShieldCheck, CheckCircle2, AlertTriangle, XCircle, RefreshCw, Lock, LockOpen, ArrowRight, BookOpen,
} from "lucide-react"

type BadgeVariant = "default" | "secondary" | "destructive" | "outline"

type MonthEndCheck = { key: string; label: string; count: number; status: "clean" | "attention"; vouchers: string[] }
type MonthEndReport = { period: string; locked: boolean; clean: boolean; checks: MonthEndCheck[] }
type JournalException = {
  code: string
  severity: "error" | "warning"
  voucherNo: string
  period: string
  journalDate: string
  sourceModule: string
  message: string
}
type ErrorGroup = { code: string; label: string; severity: "error" | "warning"; count: number; exceptions: JournalException[] }
type ErrorCenter = { total: number; errors: number; warnings: number; groups: ErrorGroup[] }
type Reconciliation = { scope: string; reconciled: number; unreconciled: number; total: number }

type ControlData = {
  period: string
  monthEnd: MonthEndReport
  errors: ErrorCenter
  reconciliation: Reconciliation[]
}

// The last 12 months as YYYY-MM options, newest first.
function recentPeriods(count = 12): { value: string; label: string }[] {
  const out: { value: string; label: string }[] = []
  const now = new Date()
  for (let i = 0; i < count; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
    const value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`
    const label = d.toLocaleString(undefined, { month: "short", year: "numeric" })
    out.push({ value, label })
  }
  return out
}

export function JournalControlClient() {
  const periods = useMemo(() => recentPeriods(), [])
  const [period, setPeriod] = useState(periods[0].value)
  const [sweeping, setSweeping] = useState(false)

  const { data, isLoading, mutate } = useSWR<ControlData>(
    `/api/finance/journal-entries/control?period=${period}`,
    fetcher,
  )

  async function runSweep() {
    setSweeping(true)
    try {
      await fetch(`/api/cron/journal-daily?period=${period}`, { method: "POST" })
      await mutate()
    } finally {
      setSweeping(false)
    }
  }

  const monthEnd = data?.monthEnd
  const errors = data?.errors
  const reconciliation = data?.reconciliation ?? []

  return (
    <main className="space-y-8 p-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-sm text-muted-foreground">Finance management</p>
          <h1 className="flex items-center gap-2 text-3xl font-semibold tracking-tight text-balance">
            <ShieldCheck className="size-7 text-primary" />
            Journal Control Center
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Traceability, reconciliation, month-end readiness and exceptions for the central accounting engine — a
            read-only view over the Journal and General Ledger. Posting, approval and locking stay where they are.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={period}
            onChange={(e) => setPeriod(e.target.value)}
            className="h-9 rounded-md border border-input bg-background px-3 text-sm shadow-sm"
            aria-label="Accounting period"
          >
            {periods.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
          <Button variant="outline" onClick={() => mutate()} disabled={isLoading}>
            <RefreshCw data-icon="inline-start" className={isLoading ? "animate-spin" : ""} />
            Refresh
          </Button>
          <Button onClick={runSweep} disabled={sweeping}>
            <ShieldCheck data-icon="inline-start" />
            {sweeping ? "Running…" : "Run checks"}
          </Button>
        </div>
      </div>

      {/* Readiness banner */}
      <Card className={monthEnd?.clean ? "border-emerald-500/40" : "border-amber-500/40"}>
        <CardContent className="flex flex-wrap items-center justify-between gap-4 pt-6">
          <div className="flex items-center gap-3">
            {monthEnd?.locked ? (
              <Lock className="size-8 text-muted-foreground" />
            ) : monthEnd?.clean ? (
              <CheckCircle2 className="size-8 text-emerald-600" />
            ) : (
              <AlertTriangle className="size-8 text-amber-600" />
            )}
            <div>
              <p className="text-sm text-muted-foreground">Period {data?.period ?? period}</p>
              <p className="text-lg font-semibold">
                {monthEnd?.locked
                  ? "Period is locked"
                  : monthEnd?.clean
                    ? "Ready to close — no blocking exceptions"
                    : "Needs attention before closing"}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant={monthEnd?.locked ? "secondary" : "outline"} className="gap-1">
              {monthEnd?.locked ? <Lock className="size-3" /> : <LockOpen className="size-3" />}
              {monthEnd?.locked ? "Locked" : "Open"}
            </Badge>
            <Button asChild variant="ghost" size="sm">
              <a href="/modules/finance/year-end-closing">
                Period locking
                <ArrowRight data-icon="inline-end" />
              </a>
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Month-end checklist */}
      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Month-end checklist</h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {(monthEnd?.checks ?? []).map((c) => (
            <Card key={c.key} className={c.status === "attention" ? "border-amber-500/40" : ""}>
              <CardContent className="flex items-center justify-between pt-6">
                <div className="flex items-center gap-3">
                  {c.status === "clean" ? (
                    <CheckCircle2 className="size-5 text-emerald-600" />
                  ) : (
                    <AlertTriangle className="size-5 text-amber-600" />
                  )}
                  <span className="text-sm font-medium">{c.label}</span>
                </div>
                <span className={`text-2xl font-semibold tabular-nums ${c.count ? "text-amber-600" : "text-muted-foreground"}`}>
                  {c.count}
                </span>
              </CardContent>
            </Card>
          ))}
          {!isLoading && !(monthEnd?.checks ?? []).length && (
            <p className="text-sm text-muted-foreground">No journals in this period.</p>
          )}
        </div>
      </section>

      {/* Reconciliation */}
      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Reconciliation status</h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {reconciliation.map((r) => {
            const pct = r.total ? Math.round((r.reconciled / r.total) * 100) : 0
            return (
              <Card key={r.scope}>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm">{r.scope}</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2">
                  <div className="flex items-baseline justify-between">
                    <span className="text-2xl font-semibold tabular-nums">{pct}%</span>
                    <span className="text-xs text-muted-foreground">{r.reconciled}/{r.total} reconciled</span>
                  </div>
                  <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full rounded-full bg-primary transition-all"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  {r.unreconciled > 0 && (
                    <p className="text-xs text-amber-600">{r.unreconciled} unreconciled</p>
                  )}
                </CardContent>
              </Card>
            )
          })}
          {!isLoading && !reconciliation.length && (
            <p className="text-sm text-muted-foreground">No posted ledger lines in this period.</p>
          )}
        </div>
      </section>

      {/* Error center */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Error center</h2>
          {errors ? (
            <div className="flex items-center gap-2">
              <Badge variant="destructive" className="gap-1">
                <XCircle className="size-3" />
                {errors.errors} errors
              </Badge>
              <Badge variant="secondary" className="gap-1">
                <AlertTriangle className="size-3" />
                {errors.warnings} warnings
              </Badge>
            </div>
          ) : null}
        </div>
        {errors && errors.total === 0 ? (
          <Card className="border-emerald-500/40">
            <CardContent className="flex items-center gap-3 pt-6">
              <CheckCircle2 className="size-6 text-emerald-600" />
              <span className="text-sm font-medium">No exceptions detected for this period.</span>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-4">
            {(errors?.groups ?? []).map((g) => (
              <ErrorGroupCard key={g.code} group={g} />
            ))}
          </div>
        )}
      </section>
    </main>
  )
}

const SEVERITY_BADGE: Record<string, BadgeVariant> = { error: "destructive", warning: "secondary" }

function ErrorGroupCard({ group }: { group: ErrorGroup }) {
  const [open, setOpen] = useState(false)
  const shown = open ? group.exceptions : group.exceptions.slice(0, 5)
  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-sm">
            {group.severity === "error" ? (
              <XCircle className="size-4 text-destructive" />
            ) : (
              <AlertTriangle className="size-4 text-amber-600" />
            )}
            {group.label}
            <Badge variant={SEVERITY_BADGE[group.severity]}>{group.count}</Badge>
          </CardTitle>
        </div>
      </CardHeader>
      <CardContent className="space-y-1.5">
        {shown.map((e) => (
          <div
            key={`${e.code}-${e.voucherNo}`}
            className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border bg-muted/30 px-3 py-2 text-sm"
          >
            <a
              href={`/modules/finance/general-ledger?voucher=${encodeURIComponent(e.voucherNo)}`}
              className="inline-flex items-center gap-1 font-mono text-primary underline-offset-2 hover:underline"
            >
              <BookOpen className="size-3.5" />
              {e.voucherNo}
            </a>
            <span className="text-xs text-muted-foreground">{e.journalDate}</span>
            <span className="text-xs text-muted-foreground">{e.sourceModule}</span>
            <span className="text-muted-foreground">{e.message}</span>
          </div>
        ))}
        {group.exceptions.length > 5 && (
          <Button variant="ghost" size="sm" onClick={() => setOpen((v) => !v)}>
            {open ? "Show less" : `Show all ${group.exceptions.length}`}
          </Button>
        )}
      </CardContent>
    </Card>
  )
}
