"use client"

import { useEffect, useState } from "react"
import useSWR from "swr"
import { AlertTriangle, Database, Loader2, Settings2 } from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { formatBytes, bytesToGb } from "@/lib/storage/format"

async function fetcher<T>(url: string): Promise<T> {
  const res = await fetch(url)
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Request failed")
  return res.json()
}

type Dashboard = {
  usedBytes: number
  files: number
  quotaBytes: number | null
  source: "custom" | "plan"
  percent: number | null
  status: "ok" | "warning" | "over" | "unlimited"
  remainingBytes: number | null
  settings: { customQuotaBytes: number | null; warnThresholdPercent: number; hardLimit: boolean; enforced: boolean }
  perModule: { module: string; files: number; bytes: number }[]
  alerts: { level: "warning" | "critical"; message: string }[]
}

const STATUS_LABEL: Record<string, { label: string; className: string }> = {
  ok: { label: "Normal", className: "border-transparent bg-emerald-600 text-white" },
  warning: { label: "Approaching limit", className: "border-transparent bg-amber-600 text-white" },
  over: { label: "Limit reached", className: "border-transparent bg-destructive text-white" },
  unlimited: { label: "Unlimited", className: "border-transparent bg-blue-600 text-white" },
}

/**
 * Storage usage & quota dashboard. Reads the real, already-modeled
 * quota resolution (plan ⊕ custom override) and per-module usage breakdown.
 */
export function StorageUsageDashboard() {
  const { data, isLoading, error, mutate } = useSWR<Dashboard>("/api/admin/storage/usage", fetcher, {
    revalidateOnFocus: false,
  })

  if (error) return <p className="text-sm text-destructive">Could not load storage usage.</p>
  if (isLoading || !data) {
    return (
      <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Loading usage…
      </div>
    )
  }

  const status = STATUS_LABEL[data.status]
  const quotaLabel = data.quotaBytes == null ? "Unlimited" : formatBytes(data.quotaBytes)

  return (
    <div className="flex flex-col gap-6">
      {data.alerts.map((a, i) => (
        <div
          key={i}
          className={`flex items-start gap-2 rounded-lg border p-3 text-sm ${
            a.level === "critical"
              ? "border-destructive/30 bg-destructive/5 text-destructive"
              : "border-amber-500/30 bg-amber-500/5 text-amber-700 dark:text-amber-300"
          }`}
        >
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          {a.message}
        </div>
      ))}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <MetricCard label="Used" value={formatBytes(data.usedBytes)} />
        <MetricCard label="Available" value={data.remainingBytes == null ? "Unlimited" : formatBytes(data.remainingBytes)} />
        <MetricCard label="Plan quota" value={data.source === "plan" ? quotaLabel : "Overridden"} />
        <MetricCard label="Custom quota" value={data.settings.customQuotaBytes == null ? "Not set" : formatBytes(data.settings.customQuotaBytes)} />
        <MetricCard label="Usage %" value={data.percent == null ? "—" : `${Math.round(data.percent)}%`} />
      </div>

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle className="flex items-center gap-2 text-base">
                <Database className="size-4 text-muted-foreground" />
                Storage usage
              </CardTitle>
              <CardDescription>
                {data.files} file(s) · {formatBytes(data.usedBytes)} of {quotaLabel}
              </CardDescription>
            </div>
            <Badge className={status.className}>{status.label}</Badge>
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <Progress value={data.percent == null ? 0 : Math.min(100, data.percent)} />
          <QuotaSettingsDialog dashboard={data} onSaved={() => mutate()} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Usage by module</CardTitle>
          <CardDescription>Where the tenant&apos;s stored bytes are coming from.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {data.perModule.length === 0 && <p className="text-sm text-muted-foreground">No files stored yet.</p>}
          {data.perModule.map((m) => {
            const pct = data.usedBytes > 0 ? (m.bytes / data.usedBytes) * 100 : 0
            return (
              <div key={m.module} className="flex flex-col gap-1">
                <div className="flex items-center justify-between text-sm">
                  <span className="font-medium capitalize">{m.module}</span>
                  <span className="text-muted-foreground">
                    {formatBytes(m.bytes)} · {m.files} file(s)
                  </span>
                </div>
                <Progress value={pct} className="h-1.5" />
              </div>
            )
          })}
        </CardContent>
      </Card>
    </div>
  )
}

function MetricCard({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardDescription>{label}</CardDescription>
        <CardTitle className="text-2xl">{value}</CardTitle>
      </CardHeader>
    </Card>
  )
}

function QuotaSettingsDialog({ dashboard, onSaved }: { dashboard: Dashboard; onSaved: () => void }) {
  const [open, setOpen] = useState(false)
  const [customGb, setCustomGb] = useState<string>(
    dashboard.settings.customQuotaBytes != null ? String(Math.round(bytesToGb(dashboard.settings.customQuotaBytes))) : "",
  )
  const [warnThreshold, setWarnThreshold] = useState(dashboard.settings.warnThresholdPercent)
  const [hardLimit, setHardLimit] = useState(dashboard.settings.hardLimit)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")

  useEffect(() => {
    if (open) {
      setCustomGb(dashboard.settings.customQuotaBytes != null ? String(Math.round(bytesToGb(dashboard.settings.customQuotaBytes))) : "")
      setWarnThreshold(dashboard.settings.warnThresholdPercent)
      setHardLimit(dashboard.settings.hardLimit)
      setError("")
    }
  }, [open, dashboard])

  async function save() {
    setSaving(true)
    setError("")
    try {
      const res = await fetch("/api/admin/storage/usage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          customQuotaGb: customGb === "" ? null : Number(customGb),
          warnThresholdPercent: warnThreshold,
          hardLimit,
        }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error || "Save failed")
      onSaved()
      setOpen(false)
    } catch (err: any) {
      setError(err.message || "Save failed")
    } finally {
      setSaving(false)
    }
  }

  async function resetToDefault() {
    setCustomGb("")
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="self-start">
          <Settings2 className="size-4" /> Quota settings
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Storage quota settings</DialogTitle>
          <DialogDescription>Overrides the plan&apos;s default storage quota for this tenant.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <div className="grid gap-2">
            <Label htmlFor="custom-quota">Custom quota (GB)</Label>
            <Input
              id="custom-quota"
              type="number"
              min={0}
              placeholder="Leave blank to use the plan default"
              value={customGb}
              onChange={(e) => setCustomGb(e.target.value)}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="warn-threshold">Warning threshold (%)</Label>
            <Input
              id="warn-threshold"
              type="number"
              min={1}
              max={100}
              value={warnThreshold}
              onChange={(e) => setWarnThreshold(Number(e.target.value))}
            />
          </div>
          <div className="flex items-center justify-between rounded-md border p-3">
            <div>
              <Label htmlFor="hard-limit" className="cursor-pointer">
                Hard limit
              </Label>
              <p className="text-xs text-muted-foreground">Block new uploads once the quota is reached.</p>
            </div>
            <Switch id="hard-limit" checked={hardLimit} onCheckedChange={setHardLimit} />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter className="gap-2">
          <Button variant="ghost" onClick={resetToDefault} disabled={saving}>
            Reset to plan default
          </Button>
          <Button onClick={save} disabled={saving}>
            {saving ? <Loader2 className="size-4 animate-spin" /> : null}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
