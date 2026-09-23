"use client"

import { useState } from "react"
import useSWR from "swr"
import { Gauge, ShieldAlert, Activity, AlertTriangle } from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Skeleton } from "@/components/ui/skeleton"
import { EmptyState } from "@/components/security/security-ui"

type Tier = { second: number; minute: number; hour: number; day: number }
type Policy = { id: number; name: string; targetType: "tenant" | "api_key" | "endpoint"; targetValue: string; tier: Tier; enabled: boolean }
type PolicyForm = { name: string; targetType: Policy["targetType"]; targetValue: string; second: string; minute: string; hour: string; day: string; enabled: boolean }
const emptyForm: PolicyForm = { name: "", targetType: "tenant", targetValue: "", second: "5", minute: "60", hour: "1000", day: "10000", enabled: true }

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
  apiKeys: { id: number; name: string }[]
  policies: Policy[]
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
 * the real enforced tier, the shared counters for the tenant's own API
 * keys, and the blocked-request (429) count from the request audit trail — no
 * preview state, nothing faked.
 */
export function RateLimitsClient() {
  const { data, error, isLoading, mutate } = useSWR<RateLimitData>(
    "/api/admin/security/rate-limits",
    fetcher,
    { refreshInterval: 5000 },
  )
  const [form, setForm] = useState<PolicyForm | null>(null)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState("")
  function edit(policy: Policy, clone = false) {
    setEditingId(clone ? null : policy.id)
    setForm({ name: clone ? `${policy.name} copy` : policy.name, targetType: policy.targetType, targetValue: policy.targetValue, second: String(policy.tier.second), minute: String(policy.tier.minute), hour: String(policy.tier.hour), day: String(policy.tier.day), enabled: policy.enabled })
    setActionError("")
  }
  async function save() {
    if (!form) return
    setBusy(true); setActionError("")
    try {
      const payload = { name: form.name, targetType: form.targetType, targetValue: form.targetType === "tenant" ? "" : form.targetValue, enabled: form.enabled, tier: { second: Number(form.second), minute: Number(form.minute), hour: Number(form.hour), day: Number(form.day) } }
      const response = await fetch(editingId ? `/api/admin/security/rate-limits/${editingId}` : "/api/admin/security/rate-limits", { method: editingId ? "PATCH" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) })
      const body = await response.json()
      if (!response.ok) throw new Error(body.error || "Could not save policy")
      setForm(null); setEditingId(null); await mutate()
    } catch (cause) { setActionError(cause instanceof Error ? cause.message : "Could not save policy") } finally { setBusy(false) }
  }
  async function change(policy: Policy, remove = false) {
    if (remove && !window.confirm(`Delete rate-limit policy “${policy.name}”?`)) return
    setBusy(true); setActionError("")
    try {
      const response = await fetch(`/api/admin/security/rate-limits/${policy.id}`, remove ? { method: "DELETE" } : { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...policy, enabled: !policy.enabled }) })
      const body = await response.json()
      if (!response.ok) throw new Error(body.error || "Could not change policy")
      await mutate()
    } catch (cause) { setActionError(cause instanceof Error ? cause.message : "Could not change policy") } finally { setBusy(false) }
  }

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
      <Card><CardHeader><div className="flex items-center justify-between"><div><CardTitle className="text-base">Custom rate-limit policies</CardTitle><CardDescription>These rules are enforced on the server across all workers. They can tighten, not loosen, plan limits.</CardDescription></div><button className="rounded-md border px-3 py-2 text-sm" onClick={() => { setEditingId(null); setForm(emptyForm); setActionError("") }}>Create policy</button></div></CardHeader><CardContent className="space-y-4">
        {actionError && <p role="alert" className="text-sm text-destructive">{actionError}</p>}
        {form && <div className="space-y-3 rounded-md border p-4"><div className="grid gap-3 sm:grid-cols-2"><label className="text-sm">Name<input className="mt-1 w-full rounded-md border bg-background p-2" value={form.name} onChange={event => setForm({ ...form, name: event.target.value })} /></label><label className="text-sm">Target<select className="mt-1 w-full rounded-md border bg-background p-2" value={form.targetType} onChange={event => setForm({ ...form, targetType: event.target.value as Policy["targetType"], targetValue: "" })}><option value="tenant">Whole tenant</option><option value="api_key">One API key</option><option value="endpoint">Exact endpoint</option></select></label></div>{form.targetType === "api_key" && <label className="block text-sm">API key<select className="mt-1 w-full rounded-md border bg-background p-2" value={form.targetValue} onChange={event => setForm({ ...form, targetValue: event.target.value })}><option value="">Choose key</option>{data.apiKeys.map(key => <option key={key.id} value={String(key.id)}>{key.name}</option>)}</select></label>}{form.targetType === "endpoint" && <label className="block text-sm">Exact path<input className="mt-1 w-full rounded-md border bg-background p-2" placeholder="/api/v1/clients" value={form.targetValue} onChange={event => setForm({ ...form, targetValue: event.target.value })} /></label>}<div className="grid gap-3 sm:grid-cols-4">{(["second", "minute", "hour", "day"] as const).map(key => <label key={key} className="text-sm capitalize">{key}<input type="number" min="1" className="mt-1 w-full rounded-md border bg-background p-2" value={form[key]} onChange={event => setForm({ ...form, [key]: event.target.value })} /></label>)}</div><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.enabled} onChange={event => setForm({ ...form, enabled: event.target.checked })} />Enabled</label><div className="flex gap-2"><button disabled={busy} className="rounded-md border px-3 py-2 text-sm disabled:opacity-50" onClick={save}>Save policy</button><button className="rounded-md border px-3 py-2 text-sm" onClick={() => setForm(null)}>Cancel</button></div></div>}
        {data.policies.length ? <div className="overflow-x-auto rounded-md border"><Table><TableHeader><TableRow><TableHead>Policy</TableHead><TableHead>Target</TableHead><TableHead>Second</TableHead><TableHead>Minute</TableHead><TableHead>Hour</TableHead><TableHead>Day</TableHead><TableHead>Status</TableHead><TableHead>Actions</TableHead></TableRow></TableHeader><TableBody>{data.policies.map(policy => <TableRow key={policy.id}><TableCell>{policy.name}</TableCell><TableCell>{policy.targetType}{policy.targetValue ? `: ${policy.targetValue}` : ""}</TableCell><TableCell>{policy.tier.second}</TableCell><TableCell>{policy.tier.minute}</TableCell><TableCell>{policy.tier.hour}</TableCell><TableCell>{policy.tier.day}</TableCell><TableCell>{policy.enabled ? "Enabled" : "Disabled"}</TableCell><TableCell><div className="flex gap-2"><button disabled={busy} className="text-primary disabled:opacity-50" onClick={() => edit(policy)}>Edit</button><button disabled={busy} className="text-primary disabled:opacity-50" onClick={() => edit(policy, true)}>Clone</button><button disabled={busy} className="text-primary disabled:opacity-50" onClick={() => change(policy)}>{policy.enabled ? "Disable" : "Enable"}</button><button disabled={busy} className="text-destructive disabled:opacity-50" onClick={() => change(policy, true)}>Delete</button></div></TableCell></TableRow>)}</TableBody></Table></div> : <p className="text-sm text-muted-foreground">No custom policy. Plan limits still apply.</p>}
      </CardContent></Card>
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
            <Badge variant="destructive">At limit</Badge>
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
