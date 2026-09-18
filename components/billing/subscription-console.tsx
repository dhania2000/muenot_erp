"use client"

import { useState } from "react"
import useSWR from "swr"
import { toast } from "sonner"
import { fetcher } from "@/lib/fetcher"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Separator } from "@/components/ui/separator"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { TERM_OPTIONS, StatusBadge, formatMoney, type Plan, type SubscriptionView, type Summary } from "./billing-shared"

type ApiData = { subscriptions: SubscriptionView[]; summary: Summary }

export function SubscriptionConsole() {
  const { data, isLoading, mutate } = useSWR<ApiData>("/api/billing/subscriptions", fetcher)
  const { data: planData } = useSWR<{ plans: Plan[] }>("/api/billing/plans?activeOnly=1", fetcher)
  const [subscribeOpen, setSubscribeOpen] = useState(false)
  const [busy, setBusy] = useState(false)

  const subscriptions = data?.subscriptions ?? []
  const summary = data?.summary
  const current = subscriptions.find((s) => !["cancelled", "expired"].includes(s.status)) ?? null
  const history = subscriptions.filter((s) => s.id !== current?.id)

  async function runAction(id: number, body: Record<string, unknown>, ok: string) {
    setBusy(true)
    try {
      const res = await fetch(`/api/billing/subscriptions/${id}/actions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || "Action failed")
      toast.success(ok)
      mutate()
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">Subscription Management</h1>
          <p className="max-w-2xl text-sm text-muted-foreground">
            Your organisation&apos;s subscription to Muenot ERP — plan, billing term and full lifecycle
            (trial, active, past due, grace, suspended, cancelled, expired).
          </p>
        </div>
        {!current ? (
          <Button className="shrink-0" onClick={() => setSubscribeOpen(true)}>
            New subscription
          </Button>
        ) : null}
      </header>

      <div className="mt-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label="Active MRR" value={summary ? formatMoney(summary.active_mrr, summary.currency) : "—"} hint="Trial + active, normalised" />
        <StatCard label="Renewals due" value={summary ? String(summary.renewals_due_30d) : "—"} hint="Next 30 days" />
        <StatCard label="At risk" value={summary ? String(summary.at_risk) : "—"} hint="Past due, grace or suspended" />
        <StatCard label="Total records" value={summary ? String(summary.total) : "—"} hint="Including history" />
      </div>

      <div className="mt-6">
        {isLoading ? (
          <Card>
            <CardContent className="py-16 text-center text-sm text-muted-foreground">Loading subscription…</CardContent>
          </Card>
        ) : current ? (
          <CurrentSubscriptionCard sub={current} busy={busy} onAction={runAction} />
        ) : (
          <Card>
            <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
              <p className="text-sm text-muted-foreground">No active subscription for this organisation yet.</p>
              <Button onClick={() => setSubscribeOpen(true)}>Start a subscription</Button>
            </CardContent>
          </Card>
        )}
      </div>

      {history.length > 0 ? (
        <Card className="mt-6">
          <CardHeader>
            <CardTitle className="text-base font-medium">Subscription history</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto rounded-md border border-border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Reference</TableHead>
                    <TableHead>Plan</TableHead>
                    <TableHead>Term</TableHead>
                    <TableHead>Amount</TableHead>
                    <TableHead>Period end</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {history.map((s) => (
                    <TableRow key={s.id}>
                      <TableCell className="font-mono text-xs">{s.subscription_no}</TableCell>
                      <TableCell>{s.plan_name}</TableCell>
                      <TableCell>{s.term_label}</TableCell>
                      <TableCell>{formatMoney(s.amount, s.currency)}</TableCell>
                      <TableCell>{s.current_period_end}</TableCell>
                      <TableCell><StatusBadge status={s.status} label={s.status_label} /></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      ) : null}

      <SubscribeDialog
        open={subscribeOpen}
        onOpenChange={setSubscribeOpen}
        plans={planData?.plans ?? []}
        onSubscribed={() => {
          setSubscribeOpen(false)
          mutate()
        }}
      />
    </div>
  )
}

function StatCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-semibold text-foreground">{value}</div>
        {hint ? <p className="mt-1 text-xs text-muted-foreground">{hint}</p> : null}
      </CardContent>
    </Card>
  )
}

function CurrentSubscriptionCard({
  sub,
  busy,
  onAction,
}: {
  sub: SubscriptionView
  busy: boolean
  onAction: (id: number, body: Record<string, unknown>, ok: string) => void
}) {
  const renewLabel = sub.days_to_renewal == null ? "—" : sub.days_to_renewal < 0 ? `${Math.abs(sub.days_to_renewal)}d overdue` : `in ${sub.days_to_renewal}d`
  return (
    <Card>
      <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <CardTitle className="text-lg font-semibold">{sub.plan_name}</CardTitle>
            <StatusBadge status={sub.status} label={sub.status_label} />
          </div>
          <p className="font-mono text-xs text-muted-foreground">{sub.subscription_no}</p>
        </div>
        <div className="text-right">
          <div className="text-2xl font-semibold text-foreground">{formatMoney(sub.amount, sub.currency)}</div>
          <p className="text-xs text-muted-foreground">per {sub.term_label.toLowerCase()}</p>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
          <Field label="Billing term" value={sub.term_label} />
          <Field label="Current period" value={`${sub.current_period_start} → ${sub.current_period_end}`} />
          <Field label="Renews" value={renewLabel} />
          <Field label="Seats" value={sub.seats == null ? "Unlimited" : String(sub.seats)} />
          <Field label="Auto-renew" value={sub.auto_renew ? "On" : "Off"} />
          <Field label="Renewals" value={String(sub.renewal_count)} />
          {sub.trial_end_date ? <Field label="Trial ends" value={sub.trial_end_date} /> : null}
          {sub.cancel_at_period_end ? <Field label="Scheduled" value="Cancels at period end" /> : null}
        </div>

        <Separator />

        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            disabled={busy}
            onClick={() => onAction(sub.id, { action: "renew" }, "Renewal recorded")}
          >
            {sub.status === "active" || sub.status === "trial" ? "Renew now" : "Record payment / reactivate"}
          </Button>
          <AutoRenewToggle sub={sub} busy={busy} />
          {sub.status !== "suspended" ? (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => onAction(sub.id, { action: "suspend", reason: "Suspended from console" }, "Subscription suspended")}
            >
              Suspend
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => onAction(sub.id, { action: "resume" }, "Subscription resumed")}
            >
              Resume
            </Button>
          )}
          {!sub.cancel_at_period_end ? (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => onAction(sub.id, { action: "cancel", atPeriodEnd: true, reason: "Scheduled from console" }, "Cancellation scheduled")}
            >
              Cancel at period end
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="outline"
            className="text-red-600 hover:text-red-600"
            disabled={busy}
            onClick={() => {
              if (confirm("Cancel this subscription immediately? Access ends now.")) {
                onAction(sub.id, { action: "cancel", reason: "Cancelled immediately from console" }, "Subscription cancelled")
              }
            }}
          >
            Cancel now
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

function AutoRenewToggle({ sub, busy }: { sub: SubscriptionView; busy: boolean }) {
  const { mutate } = useSWR<ApiData>("/api/billing/subscriptions", fetcher)
  const [saving, setSaving] = useState(false)
  async function toggle(next: boolean) {
    setSaving(true)
    try {
      const res = await fetch(`/api/billing/subscriptions/${sub.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ auto_renew: next }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || "Update failed")
      toast.success(next ? "Auto-renew enabled" : "Auto-renew disabled")
      mutate()
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setSaving(false)
    }
  }
  return (
    <div className="flex items-center gap-2 rounded-md border border-border px-3">
      <Label className="text-xs text-muted-foreground">Auto-renew</Label>
      <Switch checked={sub.auto_renew} disabled={busy || saving} onCheckedChange={toggle} />
    </div>
  )
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-0.5">
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="text-sm font-medium text-foreground">{value}</p>
    </div>
  )
}

function SubscribeDialog({
  open,
  onOpenChange,
  plans,
  onSubscribed,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  plans: Plan[]
  onSubscribed: () => void
}) {
  const [planId, setPlanId] = useState<number | null>(null)
  const [term, setTerm] = useState("yearly")
  const [withTrial, setWithTrial] = useState(true)
  const [autoRenew, setAutoRenew] = useState(true)
  const [saving, setSaving] = useState(false)

  const plan = plans.find((p) => p.id === planId) ?? plans[0] ?? null
  const effectivePlanId = planId ?? plan?.id ?? null
  const price = plan ? priceForTerm(plan, term) : 0

  async function submit() {
    if (!effectivePlanId) {
      toast.error("Select a plan")
      return
    }
    setSaving(true)
    try {
      const res = await fetch("/api/billing/subscriptions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan_id: effectivePlanId, term, with_trial: withTrial, auto_renew: autoRenew }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || "Failed to subscribe")
      toast.success("Subscription created")
      onSubscribed()
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New subscription</DialogTitle>
          <DialogDescription>Choose a plan and billing term to subscribe to Muenot ERP.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>Plan</Label>
            <select
              className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm"
              value={effectivePlanId ?? ""}
              onChange={(e) => setPlanId(Number(e.target.value))}
            >
              {plans.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {p.seats == null ? " · Unlimited seats" : ` · ${p.seats} seats`}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label>Billing term</Label>
            <select
              className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm"
              value={term}
              onChange={(e) => setTerm(e.target.value)}
            >
              {TERM_OPTIONS.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label} — {plan ? formatMoney(priceForTerm(plan, t.value), plan.currency) : ""}
                </option>
              ))}
            </select>
          </div>
          <div className="flex items-center justify-between rounded-md border border-border px-3 py-2">
            <div>
              <Label className="text-sm">Start with trial</Label>
              <p className="text-xs text-muted-foreground">
                {plan && plan.trial_days > 0 ? `${plan.trial_days}-day free trial` : "No trial on this plan"}
              </p>
            </div>
            <Switch checked={withTrial} disabled={!plan || plan.trial_days === 0} onCheckedChange={setWithTrial} />
          </div>
          <div className="flex items-center justify-between rounded-md border border-border px-3 py-2">
            <div>
              <Label className="text-sm">Auto-renew</Label>
              <p className="text-xs text-muted-foreground">Automatically renew at the end of each term</p>
            </div>
            <Switch checked={autoRenew} onCheckedChange={setAutoRenew} />
          </div>
          <div className="rounded-md bg-muted px-3 py-2 text-sm">
            <span className="text-muted-foreground">Total per term: </span>
            <span className="font-semibold text-foreground">{plan ? formatMoney(price, plan.currency) : "—"}</span>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={saving || plans.length === 0}>
            {saving ? "Subscribing…" : "Subscribe"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function priceForTerm(plan: Plan, term: string): number {
  switch (term) {
    case "monthly":
      return plan.price_monthly
    case "yearly":
      return plan.price_yearly
    case "two_year":
      return plan.price_two_year
    case "five_year":
      return plan.price_five_year
    default:
      return 0
  }
}
