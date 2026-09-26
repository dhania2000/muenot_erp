"use client"

/**
 * Shared client types and presentation helpers for the SaaS
 * subscription engine UI (subscriptions, plans, renewals).
 */

export type Plan = {
  id: number
  plan_code: string
  name: string
  description: string | null
  currency: string
  price_monthly: number
  price_yearly: number
  price_two_year: number
  price_five_year: number
  price_enterprise: number
  trial_days: number
  seats: number | null
  past_due_days: number
  grace_days: number
  suspend_days: number
  is_active: boolean
  is_public: boolean
}

export type SubscriptionView = {
  id: number
  subscription_no: string
  plan_id: number | null
  plan_code: string | null
  plan_name: string
  term: string
  currency: string
  amount: number
  seats: number | null
  status: string
  status_label: string
  term_label: string
  term_months: number
  auto_renew: boolean
  cancel_at_period_end: boolean
  trial_end_date: string | null
  start_date: string
  current_period_start: string
  current_period_end: string
  renewal_count: number
  days_to_renewal: number | null
  has_access: boolean
  monthly_amount: number
}

export type Summary = {
  total: number
  by_status: Record<string, number>
  active_mrr: number
  currency: string
  renewals_due_30d: number
  at_risk: number
}

export const TERM_OPTIONS = [
  { value: "monthly", label: "Monthly" },
  { value: "yearly", label: "Yearly" },
  { value: "two_year", label: "2-Year" },
  { value: "five_year", label: "5-Year" },
  { value: "enterprise", label: "Enterprise" },
] as const

export const STATUS_TONE: Record<string, string> = {
  active: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  trial: "bg-sky-500/15 text-sky-600 dark:text-sky-400",
  past_due: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  grace: "bg-orange-500/15 text-orange-600 dark:text-orange-400",
  suspended: "bg-red-500/15 text-red-600 dark:text-red-400",
  cancelled: "bg-muted text-muted-foreground",
  expired: "bg-muted text-muted-foreground",
}

export function StatusBadge({ status, label }: { status: string; label: string }) {
  const tone = STATUS_TONE[status] ?? "bg-muted text-muted-foreground"
  return <span className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium ${tone}`}>{label}</span>
}

export function formatMoney(amount: number, currency = "USD"): string {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      maximumFractionDigits: amount % 1 === 0 ? 0 : 2,
    }).format(amount)
  } catch {
    return `${currency} ${amount.toFixed(2)}`
  }
}
