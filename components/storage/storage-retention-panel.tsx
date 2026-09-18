"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import {
  ShieldCheck,
  Loader2,
  Plus,
  Trash2,
  Infinity as InfinityIcon,
  CalendarClock,
  PlayCircle,
  ScanSearch,
  Gavel,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { Switch } from "@/components/ui/switch"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { MIGRATION_MODULES } from "@/lib/storage/migration-catalog"
import {
  RETENTION_UNIT_OPTIONS,
  describeRetentionRule,
  type RetentionMode,
  type RetentionRule,
  type RetentionUnit,
} from "@/lib/storage/retention-policy"

type ModuleRule = { module: string; rule: RetentionRule }
type Settings = { defaultRule: RetentionRule; autoCleanupEnabled: boolean; lastRunAt: string | null }
type Summary = {
  settings: Settings
  moduleRules: ModuleRule[]
  totalFiles: number
  onLegalHold: number
  overridden: number
  permanent: number
  expiringSoon: number
  expired: number
}

type SweepResult = {
  scanned: number
  deleted: number
  skippedLegalHold: number
  failed: number
  dryRun: boolean
}

const PERMANENT = "permanent" as const

function moduleLabel(key: string): string {
  return MIGRATION_MODULES.find((m) => m.key === key)?.label ?? key
}

export function StorageRetentionPanel() {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [summary, setSummary] = useState<Summary | null>(null)
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")

  // Default rule editor
  const [mode, setMode] = useState<RetentionMode>("duration")
  const [amount, setAmount] = useState(7)
  const [unit, setUnit] = useState<RetentionUnit>("years")
  const [auto, setAuto] = useState(false)
  const [savingDefault, setSavingDefault] = useState(false)

  // Module rule editor
  const [modKey, setModKey] = useState("")
  const [modMode, setModMode] = useState<RetentionMode>("duration")
  const [modAmount, setModAmount] = useState(1)
  const [modUnit, setModUnit] = useState<RetentionUnit>("years")
  const [savingModule, setSavingModule] = useState(false)

  // Sweep
  const [sweeping, setSweeping] = useState(false)
  const [lastSweep, setLastSweep] = useState<SweepResult | null>(null)

  const applySummary = useCallback((s: Summary) => {
    setSummary(s)
    setMode(s.settings.defaultRule.mode)
    setAmount(s.settings.defaultRule.amount)
    setUnit(s.settings.defaultRule.unit)
    setAuto(s.settings.autoCleanupEnabled)
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    setError("")
    try {
      const res = await fetch("/api/admin/storage/retention")
      if (!res.ok) {
        setError("Failed to load retention configuration.")
        return
      }
      applySummary((await res.json()) as Summary)
    } finally {
      setLoading(false)
    }
  }, [applySummary])

  useEffect(() => {
    if (open) load()
  }, [open, load])

  async function saveDefault() {
    setSavingDefault(true)
    setError("")
    setNotice("")
    try {
      const rule: RetentionRule = { mode, amount, unit }
      const res = await fetch("/api/admin/storage/retention", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ defaultRule: rule, autoCleanupEnabled: auto }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error || "Failed to save default policy.")
        return
      }
      applySummary(data as Summary)
      setNotice("Default retention policy saved.")
    } finally {
      setSavingDefault(false)
    }
  }

  async function saveModuleRule() {
    if (!modKey) return
    setSavingModule(true)
    setError("")
    setNotice("")
    try {
      const rule: RetentionRule = { mode: modMode, amount: modAmount, unit: modUnit }
      const res = await fetch("/api/admin/storage/retention/module", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ module: modKey, rule }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error || "Failed to save module rule.")
        return
      }
      applySummary(data as Summary)
      setModKey("")
      setNotice("Module rule saved.")
    } finally {
      setSavingModule(false)
    }
  }

  async function clearModuleRule(module: string) {
    setError("")
    const res = await fetch("/api/admin/storage/retention/module", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ module, rule: null }),
    })
    const data = await res.json()
    if (res.ok) applySummary(data as Summary)
  }

  async function runSweep(dryRun: boolean) {
    setSweeping(true)
    setError("")
    setNotice("")
    setLastSweep(null)
    try {
      const res = await fetch("/api/admin/storage/retention/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dryRun }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error || "Sweep failed.")
        return
      }
      setLastSweep(data.result as SweepResult)
      if (data.summary) applySummary(data.summary as Summary)
      setNotice(
        dryRun
          ? `Preview: ${data.result.scanned} eligible, ${data.result.skippedLegalHold} held back by legal hold.`
          : `Cleanup complete: ${data.result.deleted} deleted, ${data.result.skippedLegalHold} on legal hold.`,
      )
    } finally {
      setSweeping(false)
    }
  }

  const usedModules = useMemo(
    () => new Set((summary?.moduleRules ?? []).map((r) => r.module)),
    [summary],
  )
  const availableModules = useMemo(
    () => MIGRATION_MODULES.filter((m) => !usedModules.has(m.key)),
    [usedModules],
  )

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2">
              <ShieldCheck className="size-5 text-primary" />
              Retention
            </CardTitle>
            <CardDescription className="mt-1 max-w-2xl">
              Configure how long stored files are kept — permanently or for a set number of days, months, or
              years — with per-module overrides. Enable automatic cleanup to purge aged-out files. Files under a
              legal hold are never deleted.
            </CardDescription>
          </div>
          <Button size="sm" variant={open ? "outline" : "default"} onClick={() => setOpen((v) => !v)}>
            {open ? "Close" : "Open"}
          </Button>
        </div>
      </CardHeader>

      {open && (
        <CardContent className="flex flex-col gap-6">
          {loading ? (
            <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              Loading…
            </div>
          ) : (
            <>
              {/* Summary stats */}
              {summary && (
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
                  <Stat label="Files" value={summary.totalFiles} />
                  <Stat label="Legal hold" value={summary.onLegalHold} tone="amber" icon={<Gavel className="size-3.5" />} />
                  <Stat label="Permanent" value={summary.permanent} />
                  <Stat label="Overridden" value={summary.overridden} />
                  <Stat label="Expiring ≤30d" value={summary.expiringSoon} tone="amber" />
                  <Stat label="Expired" value={summary.expired} tone="red" />
                </div>
              )}

              <Separator />

              {/* Default policy */}
              <div className="flex flex-col gap-4">
                <div>
                  <h3 className="text-sm font-medium">Default policy</h3>
                  <p className="text-xs text-muted-foreground">
                    Applies to every module without its own rule.
                  </p>
                </div>
                <div className="grid gap-4 md:grid-cols-3">
                  <div className="grid gap-2">
                    <Label>Mode</Label>
                    <Select value={mode} onValueChange={(v) => setMode((v as RetentionMode) ?? "duration")}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="duration">Keep for a period</SelectItem>
                        <SelectItem value={PERMANENT}>Permanent</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="grid gap-2">
                    <Label>Amount</Label>
                    <Input
                      type="number"
                      min={1}
                      max={3650}
                      value={amount}
                      disabled={mode === PERMANENT}
                      onChange={(e) => setAmount(Number(e.target.value))}
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label>Unit</Label>
                    <Select
                      value={unit}
                      onValueChange={(v) => setUnit((v as RetentionUnit) ?? "years")}
                      disabled={mode === PERMANENT}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {RETENTION_UNIT_OPTIONS.map((o) => (
                          <SelectItem key={o.value} value={o.value}>
                            {o.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-3">
                  <div className="flex items-center gap-3">
                    <Switch id="auto-cleanup" checked={auto} onCheckedChange={setAuto} />
                    <div>
                      <Label htmlFor="auto-cleanup" className="cursor-pointer">
                        Automatic cleanup
                      </Label>
                      <p className="text-xs text-muted-foreground">
                        Purge aged-out files daily. Legal-hold files are always skipped.
                      </p>
                    </div>
                  </div>
                  <Button onClick={saveDefault} disabled={savingDefault}>
                    {savingDefault ? <Loader2 className="size-4 animate-spin" /> : null}
                    Save default
                  </Button>
                </div>
              </div>

              <Separator />

              {/* Module-specific rules */}
              <div className="flex flex-col gap-4">
                <div>
                  <h3 className="text-sm font-medium">Module-specific retention</h3>
                  <p className="text-xs text-muted-foreground">
                    Override the default for a specific module&apos;s files.
                  </p>
                </div>

                <div className="grid gap-4 md:grid-cols-4">
                  <div className="grid gap-2">
                    <Label>Module</Label>
                    <Select value={modKey} onValueChange={(v) => setModKey(v ?? "")}>
                      <SelectTrigger>
                        <SelectValue placeholder="Choose a module" />
                      </SelectTrigger>
                      <SelectContent>
                        {availableModules.map((m) => (
                          <SelectItem key={m.key} value={m.key}>
                            {m.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="grid gap-2">
                    <Label>Mode</Label>
                    <Select value={modMode} onValueChange={(v) => setModMode((v as RetentionMode) ?? "duration")}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="duration">Keep for a period</SelectItem>
                        <SelectItem value={PERMANENT}>Permanent</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="grid gap-2">
                    <Label>Amount</Label>
                    <Input
                      type="number"
                      min={1}
                      max={3650}
                      value={modAmount}
                      disabled={modMode === PERMANENT}
                      onChange={(e) => setModAmount(Number(e.target.value))}
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label>Unit</Label>
                    <Select
                      value={modUnit}
                      onValueChange={(v) => setModUnit((v as RetentionUnit) ?? "years")}
                      disabled={modMode === PERMANENT}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {RETENTION_UNIT_OPTIONS.map((o) => (
                          <SelectItem key={o.value} value={o.value}>
                            {o.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                <div>
                  <Button onClick={saveModuleRule} disabled={!modKey || savingModule} variant="secondary">
                    {savingModule ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
                    Add module rule
                  </Button>
                </div>

                {summary && summary.moduleRules.length > 0 && (
                  <div className="flex flex-col gap-2">
                    {summary.moduleRules.map((r) => (
                      <div
                        key={r.module}
                        className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-3"
                      >
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge variant="secondary">{moduleLabel(r.module)}</Badge>
                          <span className="inline-flex items-center gap-1 text-sm font-medium">
                            {r.rule.mode === PERMANENT ? (
                              <InfinityIcon className="size-3.5 text-muted-foreground" />
                            ) : (
                              <CalendarClock className="size-3.5 text-muted-foreground" />
                            )}
                            {describeRetentionRule(r.rule)}
                          </span>
                        </div>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => clearModuleRule(r.module)}
                          aria-label={`Remove ${moduleLabel(r.module)} rule`}
                        >
                          <Trash2 className="size-4 text-destructive" />
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <Separator />

              {/* Cleanup runner */}
              <div className="flex flex-col gap-3">
                <div>
                  <h3 className="text-sm font-medium">Cleanup</h3>
                  <p className="text-xs text-muted-foreground">
                    Preview or run the retention sweep now. Runs automatically each day when enabled.
                    {summary?.settings.lastRunAt ? (
                      <> Last run {new Date(summary.settings.lastRunAt).toLocaleString()}.</>
                    ) : null}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button variant="outline" onClick={() => runSweep(true)} disabled={sweeping}>
                    {sweeping ? <Loader2 className="size-4 animate-spin" /> : <ScanSearch className="size-4" />}
                    Preview (dry run)
                  </Button>
                  <Button onClick={() => runSweep(false)} disabled={sweeping}>
                    {sweeping ? <Loader2 className="size-4 animate-spin" /> : <PlayCircle className="size-4" />}
                    Run cleanup now
                  </Button>
                </div>
                {lastSweep && (
                  <div className="rounded-lg border border-border bg-muted/40 p-3 text-sm">
                    <span className="font-medium">{lastSweep.dryRun ? "Dry run" : "Cleanup"}:</span>{" "}
                    scanned {lastSweep.scanned}, {lastSweep.dryRun ? "would delete" : "deleted"} {lastSweep.deleted},{" "}
                    skipped {lastSweep.skippedLegalHold} on legal hold
                    {lastSweep.failed ? `, ${lastSweep.failed} failed` : ""}.
                  </div>
                )}
              </div>

              {error && <p className="text-sm text-destructive">{error}</p>}
              {notice && !error && <p className="text-sm text-emerald-600 dark:text-emerald-400">{notice}</p>}
            </>
          )}
        </CardContent>
      )}
    </Card>
  )
}

function Stat({
  label,
  value,
  tone,
  icon,
}: {
  label: string
  value: number
  tone?: "amber" | "red"
  icon?: React.ReactNode
}) {
  const toneClass =
    tone === "red"
      ? "text-destructive"
      : tone === "amber"
        ? "text-amber-600 dark:text-amber-400"
        : "text-foreground"
  return (
    <div className="rounded-lg border border-border p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`mt-0.5 flex items-center gap-1 text-xl font-semibold tabular-nums ${toneClass}`}>
        {icon}
        {value}
      </p>
    </div>
  )
}
