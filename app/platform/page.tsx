import Link from "next/link"
import {
  Building2,
  Users,
  CreditCard,
  DollarSign,
  Activity,
  ShieldAlert,
  ArrowUpRight,
} from "lucide-react"
import { requirePlatformStaff } from "@/lib/platform-guard"
import { getPlatformMetrics, getSystemHealth, listSecurityEvents } from "@/lib/platform-metrics"
import { formatCurrency, formatNumber, formatDateTime, humanizeAction } from "@/lib/platform-format"
import { StatCard } from "@/components/platform/stat-card"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"

export const dynamic = "force-dynamic"

const healthTone: Record<string, "default" | "secondary" | "destructive"> = {
  ok: "default",
  warn: "secondary",
  down: "destructive",
}

export default async function PlatformOverviewPage() {
  const guard = await requirePlatformStaff()
  if (!guard.ok) return null

  const [metrics, health, security] = await Promise.all([
    getPlatformMetrics(),
    getSystemHealth(),
    listSecurityEvents(6),
  ])

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Platform overview</h1>
        <p className="text-sm text-muted-foreground">
          Live operational snapshot of the Muenot platform. Every figure is derived from real tenant,
          subscription and system state.
        </p>
      </header>

      <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Tenants"
          value={formatNumber(metrics.tenants.total)}
          hint={`${metrics.tenants.active} active · ${metrics.tenants.suspended} suspended`}
          icon={Building2}
        />
        <StatCard
          label="Users"
          value={formatNumber(metrics.users.total)}
          hint={`${metrics.users.superAdmins} super admins · ${metrics.users.platformStaff} staff`}
          icon={Users}
        />
        <StatCard
          label="Monthly recurring"
          value={formatCurrency(metrics.revenue.mrr, metrics.revenue.currency)}
          hint={`${formatCurrency(metrics.revenue.arr, metrics.revenue.currency)} ARR`}
          icon={DollarSign}
          accent="positive"
        />
        <StatCard
          label="Open invoices"
          value={formatNumber(metrics.revenue.openInvoices)}
          hint={formatCurrency(metrics.revenue.openInvoiceTotal, metrics.revenue.currency)}
          icon={CreditCard}
          accent={metrics.revenue.openInvoices > 0 ? "warning" : "default"}
        />
      </section>

      <section className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader className="border-b">
            <CardTitle className="flex items-center gap-2">
              <CreditCard className="size-4 text-muted-foreground" />
              Subscriptions
            </CardTitle>
            <CardDescription>Distribution across the tenant roster.</CardDescription>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            {[
              { label: "Active", value: metrics.subscriptions.active, tone: "positive" as const },
              { label: "Trialing", value: metrics.subscriptions.trialing, tone: "default" as const },
              { label: "Past due", value: metrics.subscriptions.pastDue, tone: "warning" as const },
              { label: "Canceled", value: metrics.subscriptions.canceled, tone: "danger" as const },
            ].map((s) => (
              <div key={s.label} className="flex flex-col gap-1">
                <span
                  className={
                    "text-2xl font-semibold tabular-nums " +
                    (s.tone === "positive"
                      ? "text-emerald-600 dark:text-emerald-400"
                      : s.tone === "warning"
                        ? "text-amber-600 dark:text-amber-400"
                        : s.tone === "danger"
                          ? "text-destructive"
                          : "text-foreground")
                  }
                >
                  {formatNumber(s.value)}
                </span>
                <span className="text-xs text-muted-foreground">{s.label}</span>
              </div>
            ))}
            <div className="col-span-2 mt-2 sm:col-span-4">
              <Link
                href="/platform/subscriptions"
                className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
              >
                Manage subscriptions & billing
                <ArrowUpRight className="size-3.5" />
              </Link>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="border-b">
            <CardTitle className="flex items-center gap-2">
              <Activity className="size-4 text-muted-foreground" />
              System health
            </CardTitle>
            <CardDescription>
              Overall status{" "}
              <Badge variant={healthTone[health.overall]} className="ml-1 capitalize">
                {health.overall}
              </Badge>
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {health.checks.map((c) => (
              <div key={c.name} className="flex items-center justify-between gap-3 text-sm">
                <span className="text-muted-foreground">{c.name}</span>
                <Badge variant={healthTone[c.status]} className="capitalize">
                  {c.status}
                </Badge>
              </div>
            ))}
            <Link
              href="/platform/health"
              className="mt-1 inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
            >
              View health & jobs
              <ArrowUpRight className="size-3.5" />
            </Link>
          </CardContent>
        </Card>
      </section>

      <section>
        <Card>
          <CardHeader className="border-b">
            <CardTitle className="flex items-center gap-2">
              <ShieldAlert className="size-4 text-muted-foreground" />
              Recent security events
            </CardTitle>
            <CardDescription>Impersonation and privilege changes from the platform audit log.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col divide-y divide-border">
            {security.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">No security events recorded yet.</p>
            ) : (
              security.map((e) => (
                <div key={e.id} className="flex items-center justify-between gap-3 py-3 text-sm">
                  <div className="flex min-w-0 flex-col">
                    <span className="font-medium">{humanizeAction(e.action)}</span>
                    <span className="truncate text-xs text-muted-foreground">
                      {e.actor_email ?? `User #${e.actor_user_id}`}
                    </span>
                  </div>
                  <span className="shrink-0 text-xs text-muted-foreground">{formatDateTime(e.created_at)}</span>
                </div>
              ))
            )}
            <Link
              href="/platform/security"
              className="inline-flex items-center gap-1 pt-3 text-sm font-medium text-primary hover:underline"
            >
              View security & audit log
              <ArrowUpRight className="size-3.5" />
            </Link>
          </CardContent>
        </Card>
      </section>
    </div>
  )
}
