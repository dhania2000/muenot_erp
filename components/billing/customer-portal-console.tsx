"use client"

import { useState } from "react"
import useSWR from "swr"
import { fetcher } from "@/lib/fetcher"
import { StatusBadge, formatMoney, TERM_OPTIONS } from "@/components/billing/billing-shared"
import { InvoiceStatusBadge, StatCard, Pill } from "@/components/billing/engine-shared"

type PortalSnapshot = {
  subscription: any | null
  currentTerm: string
  planOptions: Array<{
    id: number
    plan_code: string
    name: string
    description: string | null
    currency: string
    amount: number
    seats: number | null
    trial_days: number
    is_current: boolean
    direction: "current" | "upgrade" | "downgrade"
  }>
  invoices: any[]
  payments: Array<any & { invoice_no: string | null }>
  credits: any[]
  creditBalance: number
  usage: {
    periodStart: string
    periodEnd: string
    meters: Array<{
      key: string
      label: string
      unit: string
      used: number
      limit: number | null
      percent: number | null
      status: string
    }>
  } | null
  paymentMethods: string[]
}

function fmtDate(value: string | null | undefined): string {
  if (!value) return "—"
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return "—"
  return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" })
}

const USAGE_TONE: Record<string, string> = {
  ok: "bg-emerald-500",
  warning: "bg-amber-500",
  over: "bg-red-500",
}

const GATEWAY_LABELS: Record<string, string> = {
  stripe: "Stripe",
  paypal: "PayPal",
  razorpay: "Razorpay",
  manual: "Manual / Bank transfer",
  offline: "Offline",
}

export function CustomerPortalConsole() {
  const { data, error, isLoading, mutate } = useSWR<PortalSnapshot>("/api/billing/portal", fetcher)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<{ tone: "ok" | "err"; text: string } | null>(null)
  const [confirmCancel, setConfirmCancel] = useState(false)

  const sub = data?.subscription ?? null
  const currency = sub?.currency ?? "USD"

  async function changePlan(planId: number, planName: string, direction: string) {
    if (!sub) return
    setBusy(true)
    setNotice(null)
    try {
      const res = await fetch(`/api/billing/subscriptions/${sub.id}/plan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan_id: planId, term: data?.currentTerm }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error || "Could not change plan")
      setNotice({ tone: "ok", text: `${direction === "downgrade" ? "Downgraded" : "Upgraded"} to ${planName}.` })
      await mutate()
    } catch (e: any) {
      setNotice({ tone: "err", text: e.message })
    } finally {
      setBusy(false)
    }
  }

  async function cancelSubscription(atPeriodEnd: boolean) {
    if (!sub) return
    setBusy(true)
    setNotice(null)
    try {
      const res = await fetch(`/api/billing/subscriptions/${sub.id}/actions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "cancel", atPeriodEnd }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error || "Could not cancel subscription")
      setNotice({
        tone: "ok",
        text: atPeriodEnd ? "Cancellation scheduled for the end of your billing period." : "Subscription cancelled.",
      })
      setConfirmCancel(false)
      await mutate()
    } catch (e: any) {
      setNotice({ tone: "err", text: e.message })
    } finally {
      setBusy(false)
    }
  }

  if (isLoading) {
    return <p className="p-6 text-sm text-muted-foreground">Loading your billing portal…</p>
  }
  if (error) {
    return <p className="p-6 text-sm text-red-600">Failed to load your billing portal. Please try again.</p>
  }

  const isTerminal = sub && ["cancelled", "expired"].includes(sub.status)
  const cancelScheduled = sub?.cancel_at_period_end

  return (
    <div className="space-y-6 pl-4 sm:pl-6 lg:pl-8">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold text-foreground">Customer Billing Portal</h1>
        <p className="text-sm text-muted-foreground">
          Manage your plan, review usage and invoices, and update how you pay.
        </p>
      </header>

      {notice ? (
        <div
          role="status"
          className={`rounded-lg border px-4 py-3 text-sm ${
            notice.tone === "ok"
              ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
              : "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300"
          }`}
        >
          {notice.text}
        </div>
      ) : null}

      {!sub ? (
        <div className="rounded-lg border border-border bg-card p-8 text-center">
          <p className="text-sm text-muted-foreground">
            You don&apos;t have an active subscription yet. Choose a plan below to get started.
          </p>
        </div>
      ) : (
        <>
          {/* Current plan + cycle */}
          <section className="rounded-lg border border-border bg-card p-5" aria-labelledby="current-plan">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Current plan</p>
                <div className="mt-1 flex items-center gap-3">
                  <h2 id="current-plan" className="text-xl font-semibold text-foreground">
                    {sub.plan_name ?? "—"}
                  </h2>
                  <StatusBadge status={sub.status} label={sub.status_label} />
                </div>
                <p className="mt-1 text-sm text-muted-foreground">
                  {formatMoney(sub.amount, currency)} · {sub.term_label}
                </p>
              </div>
              <div className="text-right">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Renews</p>
                <p className="mt-1 text-lg font-semibold text-foreground">{fmtDate(sub.current_period_end)}</p>
                {sub.days_to_renewal != null ? (
                  <p className="text-xs text-muted-foreground">in {sub.days_to_renewal} days</p>
                ) : null}
              </div>
            </div>

            <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <StatCard label="Billing cycle start" value={fmtDate(sub.current_period_start)} />
              <StatCard label="Billing cycle end" value={fmtDate(sub.current_period_end)} />
              <StatCard label="Credit balance" value={formatMoney(data?.creditBalance ?? 0, currency)} />
              <StatCard
                label="Access"
                value={sub.has_access ? "Active" : "Blocked"}
                hint={cancelScheduled ? "Cancels at period end" : undefined}
              />
            </div>
          </section>

          {/* Usage */}
          {data?.usage && data.usage.meters.length > 0 ? (
            <section className="rounded-lg border border-border bg-card p-5" aria-labelledby="usage">
              <div className="flex items-center justify-between">
                <h2 id="usage" className="text-lg font-semibold text-foreground">
                  Usage
                </h2>
                <span className="text-xs text-muted-foreground">
                  {fmtDate(data.usage.periodStart)} – {fmtDate(data.usage.periodEnd)}
                </span>
              </div>
              <div className="mt-4 space-y-4">
                {data.usage.meters.map((m) => {
                  const pct = m.percent == null ? null : Math.min(100, Math.round(m.percent))
                  return (
                    <div key={m.key}>
                      <div className="flex items-center justify-between text-sm">
                        <span className="font-medium text-foreground">{m.label}</span>
                        <span className="text-muted-foreground">
                          {m.used.toLocaleString()}
                          {m.limit != null ? ` / ${m.limit.toLocaleString()}` : ""} {m.unit}
                        </span>
                      </div>
                      {pct != null ? (
                        <div className="mt-1.5 h-2 w-full overflow-hidden rounded-full bg-muted">
                          <div
                            className={`h-full rounded-full ${USAGE_TONE[m.status] ?? "bg-primary"}`}
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                      ) : (
                        <p className="mt-1 text-xs text-muted-foreground">No limit — metered</p>
                      )}
                    </div>
                  )
                })}
              </div>
            </section>
          ) : null}

          {/* Upgrade / downgrade */}
          {!isTerminal ? (
            <section className="rounded-lg border border-border bg-card p-5" aria-labelledby="plans">
              <h2 id="plans" className="text-lg font-semibold text-foreground">
                Change plan
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Prices shown for your current term ({TERM_OPTIONS.find((t) => t.value === data?.currentTerm)?.label ?? data?.currentTerm}).
                Upgrades are prorated immediately; downgrades are credited to your account.
              </p>
              <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {data?.planOptions.map((plan) => (
                  <div
                    key={plan.id}
                    className={`flex flex-col rounded-lg border p-4 ${
                      plan.is_current ? "border-primary ring-1 ring-primary/30" : "border-border"
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <h3 className="font-semibold text-foreground">{plan.name}</h3>
                      {plan.is_current ? (
                        <Pill tone="bg-primary/15 text-primary">Current</Pill>
                      ) : plan.direction === "upgrade" ? (
                        <Pill tone="bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">Upgrade</Pill>
                      ) : (
                        <Pill tone="bg-sky-500/15 text-sky-600 dark:text-sky-400">Downgrade</Pill>
                      )}
                    </div>
                    <p className="mt-1 text-2xl font-semibold text-foreground">
                      {formatMoney(plan.amount, plan.currency)}
                    </p>
                    {plan.description ? (
                      <p className="mt-1 text-sm text-muted-foreground">{plan.description}</p>
                    ) : null}
                    <button
                      type="button"
                      disabled={plan.is_current || busy}
                      onClick={() => changePlan(plan.id, plan.name, plan.direction)}
                      className="mt-4 inline-flex items-center justify-center rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {plan.is_current ? "Current plan" : plan.direction === "upgrade" ? "Upgrade" : "Downgrade"}
                    </button>
                  </div>
                ))}
              </div>
            </section>
          ) : null}

          {/* Payment methods */}
          <section className="rounded-lg border border-border bg-card p-5" aria-labelledby="methods">
            <h2 id="methods" className="text-lg font-semibold text-foreground">
              Payment methods
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">Gateways enabled on your account.</p>
            <div className="mt-3 flex flex-wrap gap-2">
              {(data?.paymentMethods ?? []).length > 0 ? (
                data!.paymentMethods.map((g) => (
                  <Pill key={g} tone="bg-muted text-foreground">
                    {GATEWAY_LABELS[g] ?? g}
                  </Pill>
                ))
              ) : (
                <p className="text-sm text-muted-foreground">No payment methods configured.</p>
              )}
            </div>
          </section>
        </>
      )}

      {/* Invoices */}
      <section className="rounded-lg border border-border bg-card p-5" aria-labelledby="invoices">
        <h2 id="invoices" className="text-lg font-semibold text-foreground">
          Invoices
        </h2>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[560px] text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="pb-2 pr-4 font-medium">Invoice</th>
                <th className="pb-2 pr-4 font-medium">Date</th>
                <th className="pb-2 pr-4 font-medium">Status</th>
                <th className="pb-2 pr-4 text-right font-medium">Total</th>
                <th className="pb-2 text-right font-medium">Due</th>
              </tr>
            </thead>
            <tbody>
              {(data?.invoices ?? []).length === 0 ? (
                <tr>
                  <td colSpan={5} className="py-4 text-center text-muted-foreground">
                    No invoices yet.
                  </td>
                </tr>
              ) : (
                data!.invoices.map((inv) => (
                  <tr key={inv.id} className="border-b border-border/60 last:border-0">
                    <td className="py-2.5 pr-4 font-medium text-foreground">{inv.invoice_no}</td>
                    <td className="py-2.5 pr-4 text-muted-foreground">{fmtDate(inv.issued_at ?? inv.created_at)}</td>
                    <td className="py-2.5 pr-4">
                      <InvoiceStatusBadge status={inv.status} />
                    </td>
                    <td className="py-2.5 pr-4 text-right text-foreground">{formatMoney(inv.total, inv.currency)}</td>
                    <td className="py-2.5 text-right text-muted-foreground">
                      {formatMoney(inv.amount_due ?? 0, inv.currency)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* Payment history */}
      <section className="rounded-lg border border-border bg-card p-5" aria-labelledby="payments">
        <h2 id="payments" className="text-lg font-semibold text-foreground">
          Payment history
        </h2>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[560px] text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="pb-2 pr-4 font-medium">Payment</th>
                <th className="pb-2 pr-4 font-medium">Invoice</th>
                <th className="pb-2 pr-4 font-medium">Date</th>
                <th className="pb-2 pr-4 font-medium">Method</th>
                <th className="pb-2 pr-4 font-medium">Status</th>
                <th className="pb-2 text-right font-medium">Amount</th>
              </tr>
            </thead>
            <tbody>
              {(data?.payments ?? []).length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-4 text-center text-muted-foreground">
                    No payments recorded yet.
                  </td>
                </tr>
              ) : (
                data!.payments.map((p) => (
                  <tr key={p.id} className="border-b border-border/60 last:border-0">
                    <td className="py-2.5 pr-4 font-medium text-foreground">{p.payment_no}</td>
                    <td className="py-2.5 pr-4 text-muted-foreground">{p.invoice_no ?? "—"}</td>
                    <td className="py-2.5 pr-4 text-muted-foreground">{fmtDate(p.created_at)}</td>
                    <td className="py-2.5 pr-4 text-muted-foreground">{GATEWAY_LABELS[p.method] ?? p.method}</td>
                    <td className="py-2.5 pr-4">
                      <Pill
                        tone={
                          p.status === "succeeded"
                            ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                            : p.status === "pending"
                              ? "bg-amber-500/15 text-amber-600 dark:text-amber-400"
                              : "bg-red-500/15 text-red-600 dark:text-red-400"
                        }
                      >
                        {p.status}
                      </Pill>
                    </td>
                    <td className="py-2.5 text-right text-foreground">{formatMoney(p.amount, p.currency)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* Credits */}
      <section className="rounded-lg border border-border bg-card p-5" aria-labelledby="credits">
        <div className="flex items-center justify-between">
          <h2 id="credits" className="text-lg font-semibold text-foreground">
            Credits
          </h2>
          <span className="text-sm text-muted-foreground">
            Balance: <span className="font-semibold text-foreground">{formatMoney(data?.creditBalance ?? 0, currency)}</span>
          </span>
        </div>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[480px] text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="pb-2 pr-4 font-medium">Reference</th>
                <th className="pb-2 pr-4 font-medium">Type</th>
                <th className="pb-2 pr-4 font-medium">Reason</th>
                <th className="pb-2 pr-4 font-medium">Status</th>
                <th className="pb-2 text-right font-medium">Amount</th>
              </tr>
            </thead>
            <tbody>
              {(data?.credits ?? []).length === 0 ? (
                <tr>
                  <td colSpan={5} className="py-4 text-center text-muted-foreground">
                    No credits on your account.
                  </td>
                </tr>
              ) : (
                data!.credits.map((c) => (
                  <tr key={c.id} className="border-b border-border/60 last:border-0">
                    <td className="py-2.5 pr-4 font-medium text-foreground">{c.credit_no}</td>
                    <td className="py-2.5 pr-4 text-muted-foreground capitalize">{c.entry_type}</td>
                    <td className="py-2.5 pr-4 text-muted-foreground">{c.reason}</td>
                    <td className="py-2.5 pr-4 text-muted-foreground capitalize">{c.status}</td>
                    <td className="py-2.5 text-right text-foreground">{formatMoney(c.amount, c.currency)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* Cancellation */}
      {sub && !isTerminal ? (
        <section className="rounded-lg border border-red-500/30 bg-red-500/5 p-5" aria-labelledby="cancel">
          <h2 id="cancel" className="text-lg font-semibold text-foreground">
            Cancel subscription
          </h2>
          {cancelScheduled ? (
            <p className="mt-1 text-sm text-muted-foreground">
              Your subscription is scheduled to cancel at the end of the current billing period
              ({fmtDate(sub.current_period_end)}). You retain access until then.
            </p>
          ) : (
            <p className="mt-1 text-sm text-muted-foreground">
              You can cancel at the end of your billing period (keep access until {fmtDate(sub.current_period_end)}) or
              immediately.
            </p>
          )}
          {!cancelScheduled ? (
            !confirmCancel ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => setConfirmCancel(true)}
                className="mt-4 inline-flex items-center justify-center rounded-md border border-red-500/40 px-3 py-2 text-sm font-medium text-red-600 transition hover:bg-red-500/10 disabled:opacity-50 dark:text-red-400"
              >
                Cancel subscription
              </button>
            ) : (
              <div className="mt-4 flex flex-wrap items-center gap-3">
                <span className="text-sm font-medium text-foreground">Are you sure?</span>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => cancelSubscription(true)}
                  className="inline-flex items-center justify-center rounded-md border border-border px-3 py-2 text-sm font-medium text-foreground transition hover:bg-muted disabled:opacity-50"
                >
                  Cancel at period end
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => cancelSubscription(false)}
                  className="inline-flex items-center justify-center rounded-md bg-red-600 px-3 py-2 text-sm font-medium text-white transition hover:bg-red-700 disabled:opacity-50"
                >
                  Cancel immediately
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setConfirmCancel(false)}
                  className="inline-flex items-center justify-center rounded-md px-3 py-2 text-sm font-medium text-muted-foreground transition hover:text-foreground disabled:opacity-50"
                >
                  Keep subscription
                </button>
              </div>
            )
          ) : null}
        </section>
      ) : null}
    </div>
  )
}
