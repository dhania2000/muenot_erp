"use client"

import useSWR from "swr"
import { Gauge, ShieldAlert, Activity, AlertTriangle } from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Skeleton } from "@/components/ui/skeleton"
import { EmptyState } from "@/components/security/security-ui"

type Tier = { second: number; minute: number; hour: number; day: number }

type LiveWindow = {
  window: "second" | "minute" | "hour" | "day"
  used: number
  limit: number
  remaining: number
  resetAt: number | null
}

type LiveScope = {
  scope: string
  keyId: number
  keyName: string
  environment: string | null
  blocked: boolean
  blockedUntil: number | null
  windows: LiveWindow[]
}

type RateLimitData = {
  enforced: boolean
  plan: string
  effectiveTier: Tier
  defaultTier: Tier
  plans: { plan: string; tier: Tier }[]
  apiKeyCount: number
  liveScopes: LiveScope[]
  usage: {
    totalRequests: number
    rateLimitedRequests: number
    requestsLast24h: number
    requestsLastHour: number
  }
}

const fetcher = (url: string) =>
  fetch(url).then((r) => {
    if (!r.ok) throw new Error(`Request failed: ${r.status}`)
    return r.json() as Promise<RateLimitData>
  })

const WINDOW_LABEL: Record<LiveWindow["window"], string> = {
  second: "Burst / sec",
  minute: "Minute",
  hour: "Hour",
  day: "Day",
}

/**
 * SPEC 53 — Live rate-limit monitor. Limits are plan-derived and ENFORCED on
 * every `/api/v1/*` request by lib/api-platform/handler.ts. This screen reads
 * the real enforced tier, the live in-process counters for the tenant's own API
 * keys, and the blocked-request (429) count from the request audit trail — no
 * preview state, nothing faked.
 */
export function RateLimitsClient() {
  const { data, error, isLoading } = useSWR<RateLimitData>(
    "/api/admin/security/rate-limits",
    fetcher,
    { refreshInterval: 5000 },
  )

  if (isLoading) {
    return (
      <div className="flex flex-col gap-4">
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    )
  }

  if (error) {
    return (
      <Card>
        <CardContent className="flex items-center gap-3 py-6 text-sm text-destructive">
          <AlertTriangle className="size-4" />
          Could not load rate-limit telemetry. Please retry.
        </CardContent>
      </Card>
    )
  }

  if (!data) return null

  return (
    <div className="flex flex-col gap-4">
      {/* Blocked-request telemetry */}
      <div className="grid gap-4 sm:grid-cols-4">
        <StatCard label="Requests (24h)" value={data.usage.requestsLast24h} icon={<Activity className="size-4" />} />
        <StatCard label="Requests (1h)" value={data.usage.requestsLastHour} icon={<Activity className="size-4" />} />
        <StatCard
          label="Blocked (429)"
          value={data.usage.rateLimitedRequests}
          icon={<ShieldAlert className="size-4" />}
          tone={data.usage.rateLimitedRequests > 0 ? "warning" : "default"}
        />
        <StatCard label="Total logged" value={data.usage.totalRequests} icon={<Gauge className="size-4" />} />
      </div>

      {/* Enforced tier for this tenant */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Gauge className="size-4 text-muted-foreground" />
              <CardTitle className="text-base">Enforced limits</CardTitle>
            </div>
            <Badge variant="secondary" className="uppercase">
              {data.plan} plan
            </Badge>
          </div>
          <CardDescription>
            Ceilings applied to every public API request for this tenant. A request must fit under every window.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {(["second", "minute", "hour", "day"] as const).map((w) => (
              <div key={w} className="rounded-md border p-3">
                <p className="text-xs text-muted-foreground">{WINDOW_LABEL[w]}</p>
                <p className="text-lg font-semibold tabular-nums">{data.effectiveTier[w].toLocaleString()}</p>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Live usage per API key */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Activity className="size-4 text-muted-foreground" />
            <CardTitle className="text-base">Live usage by API key</CardTitle>
          </div>
          <CardDescription>Current window counters for this tenant&apos;s keys. Refreshes every 5s.</CardDescription>
        </CardHeader>
        <CardContent>
          {data.liveScopes.length === 0 ? (
            <EmptyState icon={<Activity className="size-5" />} title="No active traffic">
              {data.apiKeyCount === 0
                ? "No API keys exist yet. Create a key to start making requests against the public API."
                : "No requests have hit the public API within the current windows. Counters appear here as traffic arrives."}
            </EmptyState>
          ) : (
            <div className="overflow-x-auto rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>API key</TableHead>
                    <TableHead>Burst / sec</TableHead>
                    <TableHead>Minute</TableHead>
                    <TableHead>Hour</TableHead>
                    <TableHead>Day</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.liveScopes.map((s) => (
                    <TableRow key={s.scope}>
                      <TableCell>
                        <span className="font-medium">{s.keyName}</span>{" "}
                        {s.environment ? (
                          <Badge variant="outline" className="ml-1 text-xs">
                            {s.environment}
                          </Badge>
                        ) : null}
                      </TableCell>
                      {(["second", "minute", "hour", "day"] as const).map((w) => {
                        const win = s.windows.find((x) => x.window === w)
                        return (
                          <TableCell key={w} className="tabular-nums">
                            {win ? (
                              <span className={win.remaining === 0 ? "text-destructive" : undefined}>
                                {win.used}/{win.limit}
                              </span>
                            ) : (
                              <span className="text-muted-foreground">0/{data.effectiveTier[w]}</span>
                            )}
                          </TableCell>
                        )
                      })}
                      <TableCell>
                        {s.blocked ? (
                          <Badge variant="destructive">Blocked</Badge>
                        ) : (
                          <Badge variant="outline" className="text-emerald-600">
                            Active
                          </Badge>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Plan reference table */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Plan reference</CardTitle>
          <CardDescription>Per-plan throughput ceilings. A tenant&apos;s enforced tier follows its plan.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Plan</TableHead>
                  <TableHead>Burst / sec</TableHead>
                  <TableHead>Minute</TableHead>
                  <TableHead>Hour</TableHead>
                  <TableHead>Day</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.plans.map((p) => (
                  <TableRow key={p.plan} className={p.plan === data.plan ? "bg-muted/40" : undefined}>
                    <TableCell className="font-medium capitalize">
                      {p.plan}
                      {p.plan === data.plan ? <Badge className="ml-2 text-xs">current</Badge> : null}
                    </TableCell>
                    <TableCell className="tabular-nums">{p.tier.second.toLocaleString()}</TableCell>
                    <TableCell className="tabular-nums">{p.tier.minute.toLocaleString()}</TableCell>
                    <TableCell className="tabular-nums">{p.tier.hour.toLocaleString()}</TableCell>
                    <TableCell className="tabular-nums">{p.tier.day.toLocaleString()}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

function StatCard({
  label,
  value,
  icon,
  tone = "default",
}: {
  label: string
  value: number
  icon: React.ReactNode
  tone?: "default" | "warning"
}) {
  return (
    <Card>
      <CardContent className="flex items-center justify-between py-4">
        <div>
          <p className="text-xs text-muted-foreground">{label}</p>
          <p className={`text-xl font-semibold tabular-nums ${tone === "warning" ? "text-amber-600" : ""}`}>
            {value.toLocaleString()}
          </p>
        </div>
        <span className="text-muted-foreground">{icon}</span>
      </CardContent>
    </Card>
  )
}
