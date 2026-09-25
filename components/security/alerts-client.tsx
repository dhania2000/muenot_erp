"use client"

import { useState } from "react"
import useSWR from "swr"
import { ShieldAlert, Loader2, Check, CheckCheck } from "lucide-react"
import { EmptyState } from "@/components/security/security-ui"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import type { SecurityAlert, SecuritySeverity, SecurityAlertStatus } from "@/lib/security-alerts-store"

type AlertsResponse = {
  alerts: SecurityAlert[]
  summary: { open: number; critical: number; acknowledged: number }
}

const fetcher = (url: string) =>
  fetch(url).then((r) => {
    if (!r.ok) throw new Error("Failed to load alerts")
    return r.json() as Promise<AlertsResponse>
  })

const TYPE_LABELS: Record<string, string> = {
  failed_login_burst: "Failed logins",
  new_admin: "New admin",
  role_escalation: "Role change",
  api_key_created: "API key",
  breached_password: "Breached password",
  critical_compromise: "Compromise",
}

function severityVariant(sev: SecuritySeverity): "destructive" | "default" | "secondary" {
  if (sev === "critical") return "destructive"
  if (sev === "warning") return "default"
  return "secondary"
}

function formatRelative(iso: string) {
  const diffMs = Date.now() - new Date(iso).getTime()
  const mins = Math.round(diffMs / 60000)
  if (mins < 1) return "just now"
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.round(hrs / 24)}d ago`
}

const FILTERS: { value: string; label: string }[] = [
  { value: "open", label: "Open" },
  { value: "acknowledged", label: "Acknowledged" },
  { value: "resolved", label: "Resolved" },
  { value: "all", label: "All" },
]

export function AlertsClient() {
  const [filter, setFilter] = useState<string>("open")
  const [busyId, setBusyId] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  const queryKey =
    filter === "all" ? "/api/admin/security/alerts" : `/api/admin/security/alerts?status=${filter}`
  const { data, isLoading, mutate } = useSWR<AlertsResponse>(queryKey, fetcher, {
    refreshInterval: 30_000,
  })

  async function triage(alertId: number, status: SecurityAlertStatus) {
    setBusyId(alertId)
    setError(null)
    try {
      const res = await fetch("/api/admin/security/alerts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ alertId, status }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error || "Failed to update alert")
      }
      await mutate()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update alert")
    } finally {
      setBusyId(null)
    }
  }

  const alerts = data?.alerts ?? []
  const summary = data?.summary ?? { open: 0, critical: 0, acknowledged: 0 }

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <SummaryCard label="Open" value={summary.open} tone={summary.open > 0 ? "warning" : "muted"} />
        <SummaryCard label="Critical" value={summary.critical} tone={summary.critical > 0 ? "critical" : "muted"} />
        <SummaryCard label="Acknowledged" value={summary.acknowledged} tone="muted" />
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      <div className="flex items-center justify-between gap-2">
        <Tabs value={filter} onValueChange={setFilter}>
          <TabsList>
            {FILTERS.map((f) => (
              <TabsTrigger key={f.value} value={f.value}>
                {f.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <ShieldAlert className="size-4 text-muted-foreground" />
            <CardTitle className="text-base">Security alerts</CardTitle>
          </div>
          <CardDescription>
            Correlated login-protection signals — failed-login bursts, new admins, role changes, API-key creation and
            breached passwords — with deduplicated, actionable alerts.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Alert</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Severity</TableHead>
                  <TableHead>Count</TableHead>
                  <TableHead>Last seen</TableHead>
                  <TableHead className="text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  <TableRow>
                    <TableCell colSpan={6} className="py-10 text-center text-sm text-muted-foreground">
                      <Loader2 className="mx-auto size-5 animate-spin" />
                    </TableCell>
                  </TableRow>
                ) : alerts.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} className="p-0">
                      <EmptyState icon={<ShieldAlert className="size-5" />} title="No alerts">
                        Correlated security alerts will appear here as login-protection signals are detected.
                      </EmptyState>
                    </TableCell>
                  </TableRow>
                ) : (
                  alerts.map((a) => (
                    <TableRow key={a.id}>
                      <TableCell>
                        <div className="flex flex-col">
                          <span className="text-sm font-medium">{a.title}</span>
                          {a.subjectLabel && (
                            <span className="text-xs text-muted-foreground">{a.subjectLabel}</span>
                          )}
                          {a.sourceIp && <span className="text-xs text-muted-foreground">IP {a.sourceIp}</span>}
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline">{TYPE_LABELS[a.type] ?? a.type}</Badge>
                      </TableCell>
                      <TableCell>
                        <Badge variant={severityVariant(a.severity)} className="capitalize">
                          {a.severity}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-sm tabular-nums">{a.occurrenceCount}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">{formatRelative(a.lastSeen)}</TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-1.5">
                          {a.status === "open" && (
                            <Button
                              variant="outline"
                              size="sm"
                              className="gap-1"
                              onClick={() => triage(a.id, "acknowledged")}
                              disabled={busyId === a.id}
                            >
                              {busyId === a.id ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}
                              Ack
                            </Button>
                          )}
                          {a.status !== "resolved" && (
                            <Button
                              variant="secondary"
                              size="sm"
                              className="gap-1"
                              onClick={() => triage(a.id, "resolved")}
                              disabled={busyId === a.id}
                            >
                              {busyId === a.id ? (
                                <Loader2 className="size-4 animate-spin" />
                              ) : (
                                <CheckCheck className="size-4" />
                              )}
                              Resolve
                            </Button>
                          )}
                          {a.status === "resolved" && <Badge variant="secondary">Resolved</Badge>}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

function SummaryCard({
  label,
  value,
  tone,
}: {
  label: string
  value: number
  tone: "critical" | "warning" | "muted"
}) {
  const toneClass =
    tone === "critical"
      ? "text-destructive"
      : tone === "warning"
        ? "text-foreground"
        : "text-muted-foreground"
  return (
    <Card>
      <CardContent className="flex flex-col gap-1 p-4">
        <span className="text-xs uppercase tracking-wide text-muted-foreground">{label}</span>
        <span className={`text-2xl font-semibold tabular-nums ${toneClass}`}>{value}</span>
      </CardContent>
    </Card>
  )
}
