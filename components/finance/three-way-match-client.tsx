"use client"

import useSWR from "swr"
import { useMemo, useState } from "react"
import { fetcher } from "@/lib/fetcher"
import { inr } from "@/lib/finance-calc"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Field, FieldLabel } from "@/components/ui/field"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Separator } from "@/components/ui/separator"
import { Empty } from "@/components/ui/empty"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  GitCompareArrows,
  Lock,
  LockOpen,
  Check,
  X,
  AlertTriangle,
  ShieldCheck,
  Settings2,
  Loader2Icon,
  History,
} from "lucide-react"

type Variance = {
  dimension: string
  label: string
  status: "matched" | "within_tolerance" | "exception"
  expected: number
  actual: number
  variance: number
  variancePercent: number
  tolerance: number
  category: string | null
  message: string | null
}

type Evidence = {
  status: string
  paymentHold: boolean
  variances: Variance[]
  categories: string[]
  context?: {
    orderedQuantity: number
    acceptedQuantity: number
    billedQuantity: number
    cumulativeBilledQuantity: number
    receivedValue: number
    billTaxable: number
    cumulativeBilledTaxable: number
    partialDelivery: boolean
    receipts: { grnId: string; receiptDate: string | null; receivedQuantity: number; acceptedQuantity: number; rejectedQuantity: number; receivedValue: number }[]
  }
}

type Match = {
  billId: string
  billNumber: string | null
  poNumber: string | null
  grnNumber: string | null
  vendorName: string | null
  status: "matched" | "matched_within_tolerance" | "exception"
  paymentHold: boolean
  resolutionStatus: "open" | "approved" | "rejected"
  categories: string[]
  resolvedByName: string | null
  resolvedAt: string | null
  resolutionNote: string | null
  billedTaxable: number
  computedAt: string | null
  evidence: Evidence
  summary: string
}

type Tolerances = { quantityPercent: number; pricePercent: number; amountPercent: number; amountAbsolute: number }
type ListResponse = { matches: Match[]; tolerances: Tolerances; summary: { total: number; onHold: number; openExceptions: number } }
type Event = { id: number; type: string; summary: string; actorName: string | null; createdAt: string | null }

const STATUS_TABS = [
  { key: "all", label: "All" },
  { key: "exception", label: "Exceptions" },
  { key: "matched_within_tolerance", label: "Within tolerance" },
  { key: "matched", label: "Matched" },
] as const

function statusBadge(m: Match) {
  if (m.status === "exception") {
    return m.paymentHold
      ? { variant: "destructive" as const, label: "Payment held", icon: Lock }
      : { variant: "secondary" as const, label: "Exception cleared", icon: LockOpen }
  }
  if (m.status === "matched_within_tolerance") return { variant: "secondary" as const, label: "Within tolerance", icon: ShieldCheck }
  return { variant: "outline" as const, label: "Matched", icon: Check }
}

function dimBadge(status: Variance["status"]) {
  if (status === "exception") return { variant: "destructive" as const, label: "Exception" }
  if (status === "within_tolerance") return { variant: "secondary" as const, label: "Within tolerance" }
  return { variant: "outline" as const, label: "Matched" }
}

export function ThreeWayMatchClient() {
  const [tab, setTab] = useState<(typeof STATUS_TABS)[number]["key"]>("exception")
  const [q, setQ] = useState("")
  const [selected, setSelected] = useState<string | null>(null)
  const [showConfig, setShowConfig] = useState(false)

  const listUrl = `/api/finance/three-way-match?status=${tab}`
  const { data, isLoading, mutate } = useSWR<ListResponse>(listUrl, fetcher)

  const filtered = useMemo(() => {
    const rows = data?.matches ?? []
    const needle = q.trim().toLowerCase()
    if (!needle) return rows
    return rows.filter((m) =>
      [m.billNumber, m.billId, m.poNumber, m.grnNumber, m.vendorName].some((v) => (v ?? "").toLowerCase().includes(needle)),
    )
  }, [data, q])

  return (
    <div className="flex flex-col gap-6 p-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <div className="flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <GitCompareArrows className="size-5" />
          </div>
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Purchase Three-Way Match</h1>
            <p className="text-sm text-muted-foreground">
              Match purchase order, goods receipt and vendor bill by line before releasing payment.
            </p>
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={() => setShowConfig(true)}>
          <Settings2 className="size-4" /> Tolerances
        </Button>
      </header>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
        <SummaryCard label="Matches" value={data?.summary.total ?? 0} />
        <SummaryCard label="Payments on hold" value={data?.summary.onHold ?? 0} tone="danger" />
        <SummaryCard label="Open exceptions" value={data?.summary.openExceptions ?? 0} tone="warn" />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-1">
          {STATUS_TABS.map((t) => (
            <Button key={t.key} size="sm" variant={tab === t.key ? "default" : "ghost"} onClick={() => setTab(t.key)}>
              {t.label}
            </Button>
          ))}
        </div>
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search bill, PO, GRN or vendor"
          className="max-w-xs"
        />
      </div>

      {isLoading ? (
        <div className="flex flex-col gap-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-20 w-full" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <Empty className="border rounded-lg">
          <div className="flex flex-col items-center gap-2 py-10 text-center">
            <GitCompareArrows className="size-8 text-muted-foreground" />
            <p className="font-medium">No matches in this view</p>
            <p className="text-sm text-muted-foreground">Matches are computed automatically when vendor bills are booked against a PO.</p>
          </div>
        </Empty>
      ) : (
        <div className="flex flex-col gap-3">
          {filtered.map((m) => {
            const badge = statusBadge(m)
            const Icon = badge.icon
            return (
              <Card key={m.billId} className="cursor-pointer transition-colors hover:border-primary/40" onClick={() => setSelected(m.billId)}>
                <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{m.billNumber || m.billId}</span>
                      <Badge variant={badge.variant} className="gap-1">
                        <Icon className="size-3" />
                        {badge.label}
                      </Badge>
                      {m.resolutionStatus !== "open" && (
                        <Badge variant="outline" className="capitalize">
                          {m.resolutionStatus}
                        </Badge>
                      )}
                    </div>
                    <p className="mt-1 truncate text-sm text-muted-foreground">
                      {m.vendorName || "Unknown vendor"} · PO {m.poNumber || "—"} · GRN {m.grnNumber || "—"}
                    </p>
                    {m.categories.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-1">
                        {m.categories.map((c) => (
                          <Badge key={c} variant="destructive" className="font-normal">
                            {c.replace(/_/g, " ")}
                          </Badge>
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="text-right">
                    <p className="font-semibold tabular-nums">{inr(m.billedTaxable)}</p>
                    <p className="text-xs text-muted-foreground">{m.summary}</p>
                  </div>
                </CardContent>
              </Card>
            )
          })}
        </div>
      )}

      {selected && (
        <MatchDetailDialog
          billId={selected}
          onClose={() => setSelected(null)}
          onResolved={() => {
            mutate()
          }}
        />
      )}
      {showConfig && (
        <ToleranceDialog
          current={data?.tolerances}
          onClose={() => setShowConfig(false)}
          onSaved={() => {
            setShowConfig(false)
            mutate()
          }}
        />
      )}
    </div>
  )
}

function SummaryCard({ label, value, tone }: { label: string; value: number; tone?: "danger" | "warn" }) {
  const color = tone === "danger" ? "text-destructive" : tone === "warn" ? "text-amber-600 dark:text-amber-500" : "text-foreground"
  return (
    <Card>
      <CardContent className="p-4">
        <p className="text-sm text-muted-foreground">{label}</p>
        <p className={`mt-1 text-2xl font-semibold tabular-nums ${color}`}>{value}</p>
      </CardContent>
    </Card>
  )
}

function MatchDetailDialog({ billId, onClose, onResolved }: { billId: string; onClose: () => void; onResolved: () => void }) {
  const { data, isLoading, mutate } = useSWR<{ match: Match; events: Event[] }>(
    `/api/finance/three-way-match/${encodeURIComponent(billId)}`,
    fetcher,
  )
  const [note, setNote] = useState("")
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null)
  const [error, setError] = useState<string | null>(null)

  const match = data?.match
  const canResolve = match?.status === "exception"

  async function resolve(decision: "approve" | "reject") {
    setError(null)
    if (note.trim().length < 10) {
      setError("A justification note of at least 10 characters is required for every override.")
      return
    }
    setBusy(decision)
    try {
      const res = await fetch(`/api/finance/three-way-match/${encodeURIComponent(billId)}/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": `${billId}:${decision}:${Date.now()}` },
        body: JSON.stringify({ decision, note: note.trim() }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(body.error || "Could not record the decision.")
        return
      }
      setNote("")
      await mutate()
      onResolved()
    } finally {
      setBusy(null)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GitCompareArrows className="size-5" />
            {match?.billNumber || billId}
          </DialogTitle>
          <DialogDescription>
            {match ? `${match.vendorName || "Unknown vendor"} · PO ${match.poNumber || "—"} · GRN ${match.grnNumber || "—"}` : "Loading match evidence…"}
          </DialogDescription>
        </DialogHeader>

        {isLoading || !match ? (
          <div className="flex flex-col gap-3">
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-24 w-full" />
          </div>
        ) : (
          <div className="flex flex-col gap-5">
            {match.paymentHold && (
              <Alert variant="destructive">
                <Lock className="size-4" />
                <AlertDescription>Payment is held until an authorised checker approves the exceptions below.</AlertDescription>
              </Alert>
            )}

            {match.evidence.context && (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Metric label="Ordered qty" value={match.evidence.context.orderedQuantity} />
                <Metric label="Accepted qty" value={match.evidence.context.acceptedQuantity} />
                <Metric label="Billed qty (this)" value={match.evidence.context.billedQuantity} />
                <Metric label="Billed qty (cum.)" value={match.evidence.context.cumulativeBilledQuantity} />
              </div>
            )}
            {match.evidence.context?.partialDelivery && (
              <Alert>
                <AlertTriangle className="size-4" />
                <AlertDescription>Partial delivery: accepted quantity is still below the ordered quantity.</AlertDescription>
              </Alert>
            )}

            <section>
              <h3 className="mb-2 text-sm font-semibold">Comparison evidence</h3>
              <div className="overflow-hidden rounded-lg border">
                <table className="w-full text-sm">
                  <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
                    <tr>
                      <th className="p-2 font-medium">Dimension</th>
                      <th className="p-2 text-right font-medium">Expected</th>
                      <th className="p-2 text-right font-medium">Actual</th>
                      <th className="p-2 text-right font-medium">Variance</th>
                      <th className="p-2 font-medium">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {match.evidence.variances.map((v) => {
                      const b = dimBadge(v.status)
                      return (
                        <tr key={v.dimension} className="border-t">
                          <td className="p-2">
                            <p className="font-medium">{v.label}</p>
                            {v.message && <p className="text-xs text-muted-foreground">{v.message}</p>}
                          </td>
                          <td className="p-2 text-right tabular-nums">{v.expected}</td>
                          <td className="p-2 text-right tabular-nums">{v.actual}</td>
                          <td className="p-2 text-right tabular-nums">
                            {v.variance}
                            {v.variancePercent ? <span className="text-xs text-muted-foreground"> ({v.variancePercent}%)</span> : null}
                          </td>
                          <td className="p-2">
                            <Badge variant={b.variant}>{b.label}</Badge>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </section>

            {match.evidence.context && match.evidence.context.receipts.length > 0 && (
              <section>
                <h3 className="mb-2 text-sm font-semibold">Goods receipts (split)</h3>
                <div className="flex flex-col gap-2">
                  {match.evidence.context.receipts.map((r) => (
                    <div key={r.grnId} className="flex items-center justify-between rounded-md border px-3 py-2 text-sm">
                      <span className="font-medium">{r.grnId}</span>
                      <span className="text-muted-foreground">{r.receiptDate || "—"}</span>
                      <span className="tabular-nums">
                        acc {r.acceptedQuantity} / rej {r.rejectedQuantity}
                      </span>
                      <span className="tabular-nums">{inr(r.receivedValue)}</span>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {match.resolutionStatus !== "open" && (
              <Alert>
                <ShieldCheck className="size-4" />
                <AlertDescription>
                  {match.resolutionStatus === "approved" ? "Approved" : "Rejected"} by {match.resolvedByName || "checker"}
                  {match.resolvedAt ? ` on ${new Date(match.resolvedAt).toLocaleString()}` : ""}.
                  {match.resolutionNote ? ` "${match.resolutionNote}"` : ""}
                </AlertDescription>
              </Alert>
            )}

            {canResolve && (
              <section className="flex flex-col gap-3 rounded-lg border p-4">
                <h3 className="text-sm font-semibold">Resolve exception</h3>
                <Field>
                  <FieldLabel htmlFor="note">Justification note</FieldLabel>
                  <Textarea
                    id="note"
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    placeholder="Explain why you are approving or rejecting this exception (audited)."
                    rows={3}
                  />
                </Field>
                {error && (
                  <Alert variant="destructive">
                    <AlertDescription>{error}</AlertDescription>
                  </Alert>
                )}
                <div className="flex justify-end gap-2">
                  <Button variant="outline" disabled={busy !== null} onClick={() => resolve("reject")}>
                    {busy === "reject" ? <Loader2Icon className="size-4 animate-spin" /> : <X className="size-4" />}
                    Reject (keep held)
                  </Button>
                  <Button disabled={busy !== null} onClick={() => resolve("approve")}>
                    {busy === "approve" ? <Loader2Icon className="size-4 animate-spin" /> : <Check className="size-4" />}
                    Approve (release)
                  </Button>
                </div>
              </section>
            )}

            {data && data.events.length > 0 && (
              <section>
                <Separator className="mb-3" />
                <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold">
                  <History className="size-4" /> Audit trail
                </h3>
                <ul className="flex flex-col gap-2">
                  {data.events.map((e) => (
                    <li key={e.id} className="flex items-start justify-between gap-3 text-sm">
                      <span>{e.summary}</span>
                      <span className="whitespace-nowrap text-xs text-muted-foreground">
                        {e.actorName || "system"}
                        {e.createdAt ? ` · ${new Date(e.createdAt).toLocaleString()}` : ""}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 font-semibold tabular-nums">{value}</p>
    </div>
  )
}

function ToleranceDialog({ current, onClose, onSaved }: { current?: Tolerances; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState<Tolerances>(
    current ?? { quantityPercent: 0, pricePercent: 0, amountPercent: 0, amountAbsolute: 1 },
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function set(key: keyof Tolerances, value: string) {
    setForm((f) => ({ ...f, [key]: value === "" ? 0 : Number(value) }))
  }

  async function save() {
    setError(null)
    setBusy(true)
    try {
      const res = await fetch("/api/finance/three-way-match/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(body.error || "Could not save tolerances.")
        return
      }
      onSaved()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Match tolerances</DialogTitle>
          <DialogDescription>Allowed variance before a bill is held for review. Applies tenant-wide.</DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-4">
          <Field>
            <FieldLabel htmlFor="quantityPercent">Quantity %</FieldLabel>
            <Input id="quantityPercent" type="number" min={0} max={100} step="0.01" value={form.quantityPercent} onChange={(e) => set("quantityPercent", e.target.value)} />
          </Field>
          <Field>
            <FieldLabel htmlFor="pricePercent">Unit price %</FieldLabel>
            <Input id="pricePercent" type="number" min={0} max={100} step="0.01" value={form.pricePercent} onChange={(e) => set("pricePercent", e.target.value)} />
          </Field>
          <Field>
            <FieldLabel htmlFor="amountPercent">Amount %</FieldLabel>
            <Input id="amountPercent" type="number" min={0} max={100} step="0.01" value={form.amountPercent} onChange={(e) => set("amountPercent", e.target.value)} />
          </Field>
          <Field>
            <FieldLabel htmlFor="amountAbsolute">Amount slack (abs.)</FieldLabel>
            <Input id="amountAbsolute" type="number" min={0} step="0.01" value={form.amountAbsolute} onChange={(e) => set("amountAbsolute", e.target.value)} />
          </Field>
        </div>
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={save} disabled={busy}>
            {busy ? <Loader2Icon className="size-4 animate-spin" /> : null}
            Save tolerances
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
