"use client"

import useSWR from "swr"
import { useMemo, useState } from "react"
import Link from "next/link"
import { fetcher } from "@/lib/fetcher"
import { inr } from "@/lib/finance-calc"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent } from "@/components/ui/card"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import type { BadgeVariant } from "@/lib/finance-schema"
import type { IntegrationOverview, ModuleIntegration, PostingException } from "@/lib/finance-core-integration"
import {
  Boxes, ReceiptText, ShoppingCart, Wallet, Users, Landmark, FolderKanban, Percent,
  ArrowUpRight, RefreshCw, Loader2, CheckCircle2, AlertTriangle, Layers, ScrollText,
  Coins, ShieldCheck, Link2, CircleDot,
} from "lucide-react"

type OverviewResponse = IntegrationOverview & { exceptions: PostingException[] }

const ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  ReceiptText, ShoppingCart, Wallet, Users, Landmark, FolderKanban, Percent, Boxes,
}

const STATUS_BADGE: Record<ModuleIntegration["status"], BadgeVariant> = {
  Connected: "default",
  Attention: "destructive",
  Pending: "secondary",
  Idle: "outline",
}

const KIND_LABEL: Record<ModuleIntegration["kind"], string> = {
  source: "Source documents",
  dimension: "Accounting dimension",
  account: "Account overlay",
  tax: "Tax overlay",
}

function StatCard({
  icon: Icon,
  label,
  value,
  hint,
  tone,
}: {
  icon: React.ComponentType<{ className?: string }>
  label: string
  value: string
  hint?: string
  tone?: "default" | "warning" | "positive"
}) {
  const toneClass =
    tone === "warning"
      ? "text-amber-600 dark:text-amber-500"
      : tone === "positive"
        ? "text-emerald-600 dark:text-emerald-500"
        : "text-foreground"
  return (
    <Card>
      <CardContent className="flex items-start gap-3 p-4">
        <span className="mt-0.5 inline-flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-primary">
          <Icon className="size-4" />
        </span>
        <div className="flex min-w-0 flex-col">
          <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</span>
          <span className={`text-xl font-semibold tabular-nums ${toneClass}`}>{value}</span>
          {hint ? <span className="text-xs text-muted-foreground">{hint}</span> : null}
        </div>
      </CardContent>
    </Card>
  )
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: "warning" | "muted" }) {
  const toneClass =
    tone === "warning" ? "text-amber-600 dark:text-amber-500" : tone === "muted" ? "text-muted-foreground" : "text-foreground"
  return (
    <div className="flex flex-col">
      <span className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</span>
      <span className={`text-sm font-semibold tabular-nums ${toneClass}`}>{value}</span>
    </div>
  )
}

function ModuleCard({ m }: { m: ModuleIntegration }) {
  const Icon = ICONS[m.icon] ?? Boxes
  return (
    <Card className="flex flex-col">
      <CardContent className="flex flex-1 flex-col gap-4 p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <span className="inline-flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted text-primary">
              <Icon className="size-5" />
            </span>
            <div className="flex flex-col gap-0.5">
              <div className="flex items-center gap-2">
                <h3 className="text-base font-semibold leading-none">{m.module}</h3>
                <Badge variant={STATUS_BADGE[m.status]} className="text-[10px]">
                  {m.status}
                </Badge>
              </div>
              <span className="text-xs text-muted-foreground">{m.sourceLabel}</span>
            </div>
          </div>
          <Button asChild variant="ghost" size="icon" className="shrink-0">
            <Link href={m.link} aria-label={`Open ${m.module}`}>
              <ArrowUpRight className="size-4" />
            </Link>
          </Button>
        </div>

        <p className="text-sm text-muted-foreground text-pretty">{m.description}</p>

        <div className="grid grid-cols-3 gap-3 rounded-lg border bg-muted/40 p-3">
          {m.docs ? (
            <>
              <Metric label="Documents" value={String(m.docs.total)} />
              <Metric label="Posted" value={String(m.docs.posted)} />
              <Metric
                label="Unposted"
                value={String(m.docs.attention)}
                tone={m.docs.attention > 0 ? "warning" : "muted"}
              />
            </>
          ) : m.kind === "dimension" ? (
            <>
              <Metric label="Projects" value={String(m.ledger.projects ?? 0)} />
              <Metric label="Postings" value={String(m.ledger.rows)} />
              <Metric label="Vouchers" value={String(m.ledger.vouchers)} />
            </>
          ) : (
            <>
              <Metric label="Postings" value={String(m.ledger.rows)} />
              <Metric label="Vouchers" value={String(m.ledger.vouchers)} />
              <Metric label="Reconciled" value={String(m.ledger.reconciled)} />
            </>
          )}
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Metric label="Ledger value" value={inr(m.ledger.value)} />
          {m.kind === "tax" ? (
            <Metric label="GST + TDS" value={inr(m.ledger.gst + m.ledger.tds)} />
          ) : (
            <Metric
              label="Unreconciled"
              value={String(m.ledger.unreconciled)}
              tone={m.ledger.unreconciled > 0 ? "warning" : "muted"}
            />
          )}
        </div>

        <div className="mt-auto flex items-start gap-2 border-t pt-3">
          <Link2 className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
          <p className="text-xs text-muted-foreground text-pretty">
            <span className="font-medium text-foreground">{KIND_LABEL[m.kind]}.</span> {m.postingPath}
          </p>
        </div>
      </CardContent>
    </Card>
  )
}

export function CoreIntegrationClient() {
  const { data, error, isLoading, mutate } = useSWR<OverviewResponse>("/api/finance/core-integration", fetcher)
  const [syncing, setSyncing] = useState(false)
  const [syncMsg, setSyncMsg] = useState<{ tone: "ok" | "error"; text: string } | null>(null)

  const modules = data?.modules ?? []
  const exceptions = data?.exceptions ?? []
  const summary = data?.summary

  const groupedExceptions = useMemo(() => {
    const map = new Map<string, PostingException[]>()
    for (const e of exceptions) {
      const list = map.get(e.module) ?? []
      list.push(e)
      map.set(e.module, list)
    }
    return Array.from(map.entries())
  }, [exceptions])

  async function runReconcile() {
    setSyncing(true)
    setSyncMsg(null)
    try {
      const res = await fetch("/api/finance/core-integration", { method: "POST" })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error || "Reconciliation failed")
      const created = Number(body.created ?? 0)
      setSyncMsg({
        tone: "ok",
        text:
          created > 0
            ? `Reconciled ${created} ledger ${created === 1 ? "row" : "rows"} from posted journals.`
            : "Ledger already in sync with posted journals.",
      })
      await mutate()
    } catch (e) {
      setSyncMsg({ tone: "error", text: (e as Error).message })
    } finally {
      setSyncing(false)
    }
  }

  return (
    <div className="flex flex-1 flex-col gap-6 p-4 md:p-6">
      <header className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div className="flex items-start gap-4">
          <span className="inline-flex size-11 shrink-0 items-center justify-center rounded-xl bg-muted text-primary">
            <Boxes className="size-5" />
          </span>
          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">SPEC 163</span>
            <h1 className="text-2xl font-semibold tracking-tight text-balance">Finance Core Integration</h1>
            <p className="max-w-2xl text-sm text-muted-foreground text-pretty">
              Every module posts through the same double-entry engine into one General Ledger. This is the live map of
              those accounting events and their reconciliation with the ledger.
            </p>
          </div>
        </div>
        <Button onClick={runReconcile} disabled={syncing} className="shrink-0">
          {syncing ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
          Reconcile ledger
        </Button>
      </header>

      {syncMsg ? (
        <div
          role="status"
          className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-sm ${
            syncMsg.tone === "ok"
              ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
              : "border-destructive/30 bg-destructive/10 text-destructive"
          }`}
        >
          {syncMsg.tone === "ok" ? <CheckCircle2 className="size-4" /> : <AlertTriangle className="size-4" />}
          {syncMsg.text}
        </div>
      ) : null}

      {error ? (
        <Card>
          <CardContent className="flex items-center gap-2 p-4 text-sm text-destructive">
            <AlertTriangle className="size-4" />
            {(error as Error).message}
          </CardContent>
        </Card>
      ) : null}

      <section aria-label="Integration summary" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          icon={Link2}
          label="Connected"
          value={summary ? `${summary.connectedModules}/${summary.modules}` : "—"}
          hint="modules feeding the ledger"
        />
        <StatCard
          icon={ScrollText}
          label="Ledger vouchers"
          value={summary ? summary.ledgerVouchers.toLocaleString("en-IN") : "—"}
          hint="posted accounting events"
        />
        <StatCard
          icon={Coins}
          label="Posted value"
          value={summary ? inr(summary.ledgerValue) : "—"}
          tone="positive"
          hint="across all modules"
        />
        <StatCard
          icon={ShieldCheck}
          label="Tax captured"
          value={summary ? inr(summary.taxCaptured) : "—"}
          hint="GST + TDS on postings"
        />
      </section>

      <Tabs defaultValue="map" className="flex flex-1 flex-col gap-4">
        <TabsList className="w-fit">
          <TabsTrigger value="map" className="gap-1.5">
            <Layers className="size-4" /> Integration map
          </TabsTrigger>
          <TabsTrigger value="reconciliation" className="gap-1.5">
            <RefreshCw className="size-4" /> Reconciliation
            {summary && summary.attentionDocs > 0 ? (
              <Badge variant="destructive" className="ml-1 text-[10px]">
                {summary.attentionDocs}
              </Badge>
            ) : null}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="map" className="m-0">
          {isLoading && !data ? (
            <div className="flex items-center gap-2 rounded-xl border bg-card p-8 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Loading integration map…
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
              {modules.map((m) => (
                <ModuleCard key={m.key} m={m} />
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="reconciliation" className="m-0 flex flex-col gap-4">
          <Card>
            <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-start gap-3">
                <span className="mt-0.5 inline-flex size-9 items-center justify-center rounded-lg bg-muted text-primary">
                  <RefreshCw className="size-4" />
                </span>
                <div className="flex flex-col">
                  <span className="text-sm font-semibold">Source ↔ Ledger reconciliation</span>
                  <span className="text-xs text-muted-foreground">
                    Every posted journal owns exactly one balanced ledger row. Reconcile rebuilds any ledger rows missing
                    from posted journals — it never creates new accounting values.
                  </span>
                </div>
              </div>
              <div className="flex items-center gap-4">
                <Metric
                  label="Unposted docs"
                  value={summary ? String(summary.attentionDocs) : "—"}
                  tone={summary && summary.attentionDocs > 0 ? "warning" : "muted"}
                />
                <Metric
                  label="Unreconciled rows"
                  value={summary ? String(summary.unreconciledRows) : "—"}
                  tone={summary && summary.unreconciledRows > 0 ? "warning" : "muted"}
                />
              </div>
            </CardContent>
          </Card>

          <div className="overflow-hidden rounded-xl border bg-card">
            <div className="grid grid-cols-[1.4fr_repeat(4,1fr)] gap-2 border-b bg-muted/50 px-4 py-2.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              <span>Module</span>
              <span className="text-right">Documents</span>
              <span className="text-right">Posted</span>
              <span className="text-right">Unposted</span>
              <span className="text-right">Ledger value</span>
            </div>
            {modules.map((m) => {
              const Icon = ICONS[m.icon] ?? Boxes
              return (
                <div
                  key={m.key}
                  className="grid grid-cols-[1.4fr_repeat(4,1fr)] items-center gap-2 border-b px-4 py-3 text-sm last:border-b-0"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <Icon className="size-4 shrink-0 text-muted-foreground" />
                    <span className="truncate font-medium">{m.module}</span>
                    <Badge variant={STATUS_BADGE[m.status]} className="text-[10px]">
                      {m.status}
                    </Badge>
                  </div>
                  <span className="text-right tabular-nums text-muted-foreground">
                    {m.docs ? m.docs.total : "—"}
                  </span>
                  <span className="text-right tabular-nums">{m.docs ? m.docs.posted : m.ledger.vouchers}</span>
                  <span
                    className={`text-right tabular-nums ${
                      m.docs && m.docs.attention > 0 ? "font-semibold text-amber-600 dark:text-amber-500" : "text-muted-foreground"
                    }`}
                  >
                    {m.docs ? m.docs.attention : "—"}
                  </span>
                  <span className="text-right tabular-nums">{inr(m.ledger.value)}</span>
                </div>
              )
            })}
          </div>

          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <AlertTriangle className="size-4 text-amber-600 dark:text-amber-500" />
              Posting exceptions
              <span className="text-xs font-normal text-muted-foreground">
                source documents stuck Unposted
              </span>
            </div>
            {groupedExceptions.length === 0 ? (
              <div className="flex items-center gap-2 rounded-xl border bg-card px-4 py-6 text-sm text-muted-foreground">
                <CheckCircle2 className="size-4 text-emerald-600 dark:text-emerald-500" />
                No posting exceptions — every source document is posted to the ledger.
              </div>
            ) : (
              <div className="flex flex-col gap-3">
                {groupedExceptions.map(([moduleName, items]) => (
                  <Card key={moduleName}>
                    <CardContent className="p-4">
                      <div className="mb-2 flex items-center gap-2">
                        <span className="text-sm font-semibold">{moduleName}</span>
                        <Badge variant="secondary" className="text-[10px]">
                          {items.length}
                        </Badge>
                        <Link
                          href={items[0].link}
                          className="ml-auto inline-flex items-center gap-1 text-xs text-primary hover:underline"
                        >
                          Open module <ArrowUpRight className="size-3" />
                        </Link>
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {items.map((e) => (
                          <span
                            key={`${moduleName}-${e.reference}`}
                            className="inline-flex items-center gap-1 rounded-md border bg-muted/40 px-2 py-1 font-mono text-xs"
                          >
                            <CircleDot className="size-3 text-amber-600 dark:text-amber-500" />
                            {e.reference}
                          </span>
                        ))}
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </div>
        </TabsContent>
      </Tabs>
    </div>
  )
}
