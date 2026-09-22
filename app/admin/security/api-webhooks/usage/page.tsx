import { redirect } from "next/navigation"
import { Activity } from "lucide-react"
import { getSession } from "@/lib/auth"
import { getCurrentTenant } from "@/lib/tenant-context"
import { listApiKeys } from "@/lib/api-keys-store"
import { getApiUsageSummary, listRecentApiRequests } from "@/lib/api-platform/audit"
import { SecurityHeading } from "@/components/security/security-ui"
import { BackendStatus } from "@/components/security/backend-status"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"

export const dynamic = "force-dynamic"

// SPEC 53 + SPEC 51 — API usage. Request metering is now wired into the shared
// API middleware (lib/api-platform/handler.ts logs every /api/v1 request into
// api_request_audit), so these numbers are real telemetry, not placeholders.
export default async function ApiUsagePage() {
  const session = await getSession()
  if (!session || session.role !== "admin") redirect("/dashboard")

  const tenant = getCurrentTenant()
  const tenantId = tenant?.tenantId ?? 0
  const [keys, usage, recent] = await Promise.all([
    listApiKeys(tenantId),
    getApiUsageSummary(tenantId),
    listRecentApiRequests(tenantId, 25),
  ])
  const active = keys.filter((k) => k.status === "active")
  const lastUsed = keys
    .filter((k) => k.last_used_at)
    .sort((a, b) => new Date(b.last_used_at as string).getTime() - new Date(a.last_used_at as string).getTime())[0]

  const errorRate = usage.totalRequests > 0 ? Math.round((usage.errorRequests / usage.totalRequests) * 100) : 0

  return (
    <div className="space-y-6">
      <SecurityHeading title="API usage" spec="Specs 51 / 53">
        Request-level telemetry for the public API — how many calls are being made, and how they resolve.
      </SecurityHeading>

      <BackendStatus level="full">
        Every request to <code className="rounded bg-muted px-1">/api/v1</code> is metered by the shared API middleware
        — method, path, status, latency, environment, and source IP are recorded per request and aggregated below. Rate
        limiting is enforced per key (default 120 requests / minute) with standard{" "}
        <code className="rounded bg-muted px-1">X-RateLimit-*</code> response headers.
      </BackendStatus>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <MetricCard label="Requests (last 24h)" value={usage.requestsLast24h.toLocaleString()} />
        <MetricCard label="Requests (last hour)" value={usage.requestsLastHour.toLocaleString()} />
        <MetricCard label="Total requests" value={usage.totalRequests.toLocaleString()} />
        <MetricCard label="Error rate" value={`${errorRate}%`} />
        <MetricCard
          label="Rate limited"
          value={
            usage.rateLimitedRequests > 0 ? (
              <Badge variant="destructive">{usage.rateLimitedRequests.toLocaleString()}</Badge>
            ) : (
              <Badge variant="outline">0</Badge>
            )
          }
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <Activity className="size-4 text-muted-foreground" />
              <CardTitle className="text-base">Key inventory</CardTitle>
            </div>
            <CardDescription>Live data from the API key store.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-3">
            <Field label="Active keys" value={String(active.length)} />
            <Field label="Total keys (incl. revoked)" value={String(keys.length)} />
            <Field label="Most recently used" value={lastUsed ? lastUsed.name : "—"} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Responses by status class</CardTitle>
            <CardDescription>Distribution of outcomes across all recorded requests.</CardDescription>
          </CardHeader>
          <CardContent>
            {usage.byStatusClass.length === 0 ? (
              <p className="text-sm text-muted-foreground">No requests recorded yet.</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {usage.byStatusClass.map((s) => (
                  <Badge key={s.class} variant={s.class.startsWith("2") ? "default" : "secondary"}>
                    {s.class}: {s.count.toLocaleString()}
                  </Badge>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Recent requests</CardTitle>
          <CardDescription>The latest calls to the public API, newest first.</CardDescription>
        </CardHeader>
        <CardContent>
          {recent.length === 0 ? (
            <p className="text-sm text-muted-foreground">No API requests recorded yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Method</TableHead>
                    <TableHead>Path</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Env</TableHead>
                    <TableHead>IP</TableHead>
                    <TableHead>Latency</TableHead>
                    <TableHead>When</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {recent.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell className="text-xs font-medium">{r.method}</TableCell>
                      <TableCell className="max-w-[220px] truncate text-xs text-muted-foreground">{r.path}</TableCell>
                      <TableCell>
                        <Badge variant={r.status < 400 ? "default" : r.status === 429 ? "destructive" : "secondary"}>
                          {r.status}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">{r.environment ?? "—"}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">{r.ip ?? "—"}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {r.duration_ms != null ? `${r.duration_ms} ms` : "—"}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {new Date(r.created_at).toLocaleString()}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
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
        <CardTitle className="text-lg">{value}</CardTitle>
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
