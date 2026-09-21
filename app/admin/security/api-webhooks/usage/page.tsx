import { redirect } from "next/navigation"
import { Activity } from "lucide-react"
import { getSession } from "@/lib/auth"
import { getCurrentTenant } from "@/lib/tenant-context"
import { listApiKeys } from "@/lib/api-keys-store"
import { SecurityHeading } from "@/components/security/security-ui"
import { BackendStatus } from "@/components/security/backend-status"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"

export const dynamic = "force-dynamic"

// SPEC 53 — API usage. Per-request rate tracking does not exist on the
// backend yet (lib/rate-limit.ts only guards pre-auth login/signup), so this
// screen is honest: it shows the real key inventory and a "not connected"
// state for the metrics that need request-level telemetry.
export default async function ApiUsagePage() {
  const session = await getSession()
  if (!session || session.role !== "admin") redirect("/dashboard")

  const tenant = getCurrentTenant()
  const keys = await listApiKeys(tenant?.tenantId ?? 0)
  const active = keys.filter((k) => k.status === "active")
  const lastUsed = keys
    .filter((k) => k.last_used_at)
    .sort((a, b) => new Date(b.last_used_at as string).getTime() - new Date(a.last_used_at as string).getTime())[0]

  return (
    <div className="space-y-6">
      <SecurityHeading title="API usage" spec="Spec 53">
        Request-level telemetry for the public API — how many calls are being made, against which limits.
      </SecurityHeading>

      <BackendStatus level="planned">
        Per-request counters (per minute / hour / day) are not tracked yet — only key issuance, scopes and last-used
        timestamps are real today. The cards below show what this dashboard will report once Codex wires request
        metering into the API middleware.
      </BackendStatus>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <MetricCard label="Requests today" value="Not connected" />
        <MetricCard label="Requests this hour" value="Not connected" />
        <MetricCard label="Current plan limit" value="Not configured" />
        <MetricCard label="Remaining requests" value="Not connected" />
        <MetricCard label="Rate limit status" value={<Badge variant="outline">Unknown</Badge>} />
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Activity className="size-4 text-muted-foreground" />
            <CardTitle className="text-base">Key inventory</CardTitle>
          </div>
          <CardDescription>Real data from the API key store — request counting is not yet attached to it.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-3">
          <Field label="Active keys" value={String(active.length)} />
          <Field label="Total keys (incl. revoked)" value={String(keys.length)} />
          <Field label="Most recently used" value={lastUsed ? lastUsed.name : "—"} />
        </CardContent>
      </Card>
    </div>
  )
}

function MetricCard({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardDescription>{label}</CardDescription>
        <CardTitle className="text-lg text-muted-foreground">{value}</CardTitle>
      </CardHeader>
    </Card>
  )
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-sm font-medium">{value}</span>
    </div>
  )
}
