"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import {
  Archive,
  Download,
  Loader2,
  Lock,
  Play,
  RefreshCw,
  Save,
  ShieldCheck,
} from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Switch } from "@/components/ui/switch"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  BACKUP_SCOPES,
  BACKUP_SCOPE_DESCRIPTIONS,
  BACKUP_SCOPE_LABELS,
  type BackupFrequency,
  type BackupScope,
  type RestoreTestFrequency,
  formatBytes,
} from "@/lib/backup/model"

type Policy = {
  id: number
  tenantId: number | null
  scope: BackupScope
  enabled: boolean
  frequency: BackupFrequency
  retentionDays: number
  minKeep: number
  encrypt: boolean
  verifyAfter: boolean
  restoreTestFrequency: RestoreTestFrequency
  lastRunAt: string | null
  lastRestoreTestAt: string | null
  updatedAt: string
}

type Run = {
  id: number
  tenantId: number | null
  scope: BackupScope
  status: string
  triggerSource: string
  tableCount: number
  rowCount: number
  plaintextSize: number
  artifactSize: number
  checksum: string | null
  encrypted: boolean
  encryptionAlgo: string | null
  verificationStatus: string
  verifiedAt: string | null
  error: string | null
  requestedByName: string | null
  expiresAt: string | null
  createdAt: string
  finishedAt: string | null
}

type RestoreTest = {
  id: number
  runId: number
  scope: BackupScope
  status: string
  tablesValidated: number
  rowsValidated: number
  issues: string[]
  detail: string | null
  createdByName: string | null
  createdAt: string
}

type TenantOption = { id: number; name: string; slug: string; status: string }

const BASELINE = "baseline"

function fmtDate(value: string | null): string {
  if (!value) return "—"
  return String(value).replace("T", " ").slice(0, 19)
}

export function BackupsConsole({ canManage }: { canManage: boolean }) {
  const [target, setTarget] = useState<string>(BASELINE)
  const [tenants, setTenants] = useState<TenantOption[]>([])
  const [policies, setPolicies] = useState<Policy[]>([])
  const [runs, setRuns] = useState<Run[]>([])
  const [restoreTests, setRestoreTests] = useState<RestoreTest[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)

  const tenantId = target === BASELINE ? null : Number(target)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const qs = tenantId == null ? "" : `?tenantId=${tenantId}`
      const res = await fetch(`/api/platform/backups${qs}`, { cache: "no-store" })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || "Unable to load backups")
      setTenants(data.tenants ?? [])
      setPolicies(data.policies ?? [])
      setRuns(data.runs ?? [])
      setRestoreTests(data.restoreTests ?? [])
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to load backups")
    } finally {
      setLoading(false)
    }
  }, [tenantId])

  useEffect(() => {
    void load()
  }, [load])

  // The editable policy per scope for the current target: the target's own row
  // if it exists, otherwise the platform baseline values re-homed to the target.
  const editable = useMemo(() => {
    const map: Record<BackupScope, Policy> = {} as Record<BackupScope, Policy>
    for (const scope of BACKUP_SCOPES) {
      const own = policies.find((p) => p.scope === scope && p.tenantId === tenantId)
      const baseline = policies.find((p) => p.scope === scope && p.tenantId == null)
      const source = own ?? baseline
      map[scope] = source
        ? { ...source, tenantId }
        : {
            id: 0,
            tenantId,
            scope,
            enabled: false,
            frequency: "daily",
            retentionDays: 30,
            minKeep: 3,
            encrypt: true,
            verifyAfter: true,
            restoreTestFrequency: "weekly",
            lastRunAt: null,
            lastRestoreTestAt: null,
            updatedAt: "",
          }
    }
    return map
  }, [policies, tenantId])

  const [draft, setDraft] = useState<Record<BackupScope, Policy> | null>(null)
  useEffect(() => setDraft(editable), [editable])

  const setScope = (scope: BackupScope, patch: Partial<Policy>) =>
    setDraft((current) => (current ? { ...current, [scope]: { ...current[scope], ...patch } } : current))

  async function savePolicy(scope: BackupScope) {
    if (!draft) return
    const p = draft[scope]
    setBusy(`save:${scope}`)
    try {
      const res = await fetch("/api/platform/backups", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tenantId,
          scope,
          config: {
            enabled: p.enabled,
            frequency: p.frequency,
            retentionDays: p.retentionDays,
            minKeep: p.minKeep,
            encrypt: p.encrypt,
            verifyAfter: p.verifyAfter,
            restoreTestFrequency: p.restoreTestFrequency,
          },
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || "Unable to save policy")
      toast.success(`${BACKUP_SCOPE_LABELS[scope]} policy saved`)
      await load()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to save policy")
    } finally {
      setBusy(null)
    }
  }

  async function runNow(scope: BackupScope) {
    if (tenantId == null) {
      toast.error("Select a tenant to run a backup — the platform baseline only defines defaults")
      return
    }
    setBusy(`run:${scope}`)
    try {
      const res = await fetch("/api/platform/backups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope, tenantId }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || "Backup failed")
      const status = data.run?.status
      if (status === "completed") toast.success(`${BACKUP_SCOPE_LABELS[scope]} completed`)
      else toast.error(`${BACKUP_SCOPE_LABELS[scope]} ${status ?? "failed"}: ${data.run?.error ?? ""}`)
      await load()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Backup failed")
    } finally {
      setBusy(null)
    }
  }

  async function verify(run: Run) {
    setBusy(`verify:${run.id}`)
    try {
      const res = await fetch(`/api/platform/backups/${run.id}/verify?tenantId=${run.tenantId ?? ""}`, { method: "POST" })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || "Verification failed")
      const vs = data.run?.verificationStatus
      if (vs === "passed") toast.success("Integrity verified")
      else toast.error("Verification failed — artifact integrity could not be confirmed")
      await load()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Verification failed")
    } finally {
      setBusy(null)
    }
  }

  async function restoreTest(run: Run) {
    setBusy(`restore:${run.id}`)
    try {
      const res = await fetch(`/api/platform/backups/${run.id}/restore-test?tenantId=${run.tenantId ?? ""}`, {
        method: "POST",
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || "Restore test failed")
      const st = data.restoreTest?.status
      if (st === "passed") toast.success(data.restoreTest?.detail || "Restore test passed")
      else toast.error(`Restore test failed: ${(data.restoreTest?.issues ?? []).slice(0, 1).join("") || "see details"}`)
      await load()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Restore test failed")
    } finally {
      setBusy(null)
    }
  }

  if (loading && !draft) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Loading backup configuration…
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3 rounded-xl border border-primary/20 bg-primary/5 p-4 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
        <p className="max-w-2xl">
          Backups are tenant-isolated logical snapshots stored encrypted at rest (AES-256-GCM). The platform baseline
          defines defaults for every tenant; per-tenant policies override it. Nothing runs until a policy is enabled.
        </p>
        <div className="flex items-center gap-2 shrink-0">
          <label className="text-xs font-medium">Target</label>
          <Select value={target} onValueChange={(v) => setTarget(v ?? BASELINE)}>
            <SelectTrigger className="w-56 bg-background">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={BASELINE}>Platform baseline (defaults)</SelectItem>
              {tenants.map((t) => (
                <SelectItem key={t.id} value={String(t.id)}>
                  {t.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button size="icon" variant="outline" onClick={() => void load()} aria-label="Refresh">
            <RefreshCw className="size-4" />
          </Button>
        </div>
      </div>

      {/* Policies */}
      <div className="grid gap-4 lg:grid-cols-3">
        {draft &&
          BACKUP_SCOPES.map((scope) => {
            const p = draft[scope]
            return (
              <section key={scope} className="flex flex-col gap-4 rounded-xl border border-border bg-card p-5">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="font-semibold">{BACKUP_SCOPE_LABELS[scope]}</h2>
                      <Badge variant={p.enabled ? "default" : "secondary"}>{p.enabled ? "Enabled" : "Paused"}</Badge>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">{BACKUP_SCOPE_DESCRIPTIONS[scope]}</p>
                  </div>
                  <Switch
                    checked={p.enabled}
                    disabled={!canManage}
                    onCheckedChange={(v) => setScope(scope, { enabled: v })}
                    aria-label={`Enable ${BACKUP_SCOPE_LABELS[scope]}`}
                  />
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <label className="flex flex-col gap-1 text-xs font-medium">
                    Frequency
                    <Select
                      value={p.frequency}
                      onValueChange={(v) => setScope(scope, { frequency: v as BackupFrequency })}
                    >
                      <SelectTrigger className="h-9" disabled={!canManage}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="daily">Daily</SelectItem>
                        <SelectItem value="weekly">Weekly</SelectItem>
                        <SelectItem value="monthly">Monthly</SelectItem>
                      </SelectContent>
                    </Select>
                  </label>
                  <label className="flex flex-col gap-1 text-xs font-medium">
                    Restore-test cadence
                    <Select
                      value={p.restoreTestFrequency}
                      onValueChange={(v) => setScope(scope, { restoreTestFrequency: v as RestoreTestFrequency })}
                    >
                      <SelectTrigger className="h-9" disabled={!canManage}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">Never</SelectItem>
                        <SelectItem value="weekly">Weekly</SelectItem>
                        <SelectItem value="monthly">Monthly</SelectItem>
                      </SelectContent>
                    </Select>
                  </label>
                  <label className="flex flex-col gap-1 text-xs font-medium">
                    Retention (days)
                    <Input
                      type="number"
                      min={1}
                      max={3650}
                      value={p.retentionDays}
                      disabled={!canManage}
                      onChange={(e) => setScope(scope, { retentionDays: Number(e.target.value) })}
                    />
                  </label>
                  <label className="flex flex-col gap-1 text-xs font-medium">
                    Always keep (count)
                    <Input
                      type="number"
                      min={0}
                      max={100}
                      value={p.minKeep}
                      disabled={!canManage}
                      onChange={(e) => setScope(scope, { minKeep: Number(e.target.value) })}
                    />
                  </label>
                </div>

                <div className="flex flex-col gap-2 text-sm">
                  <label className="flex items-center justify-between gap-2">
                    <span className="inline-flex items-center gap-1.5 text-xs font-medium">
                      <Lock className="size-3.5" /> Encrypt at rest
                    </span>
                    <Switch
                      checked={p.encrypt}
                      disabled={!canManage}
                      onCheckedChange={(v) => setScope(scope, { encrypt: v })}
                    />
                  </label>
                  <label className="flex items-center justify-between gap-2">
                    <span className="inline-flex items-center gap-1.5 text-xs font-medium">
                      <ShieldCheck className="size-3.5" /> Verify after backup
                    </span>
                    <Switch
                      checked={p.verifyAfter}
                      disabled={!canManage}
                      onCheckedChange={(v) => setScope(scope, { verifyAfter: v })}
                    />
                  </label>
                </div>

                <p className="text-xs text-muted-foreground">
                  Last run: {fmtDate(p.lastRunAt)} · Last restore test: {fmtDate(p.lastRestoreTestAt)}
                </p>

                {canManage && (
                  <div className="mt-auto flex gap-2">
                    <Button size="sm" variant="outline" className="flex-1" onClick={() => void savePolicy(scope)} disabled={busy === `save:${scope}`}>
                      {busy === `save:${scope}` ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />}
                      Save
                    </Button>
                    <Button
                      size="sm"
                      className="flex-1"
                      onClick={() => void runNow(scope)}
                      disabled={tenantId == null || busy === `run:${scope}`}
                    >
                      {busy === `run:${scope}` ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}
                      Run now
                    </Button>
                  </div>
                )}
              </section>
            )
          })}
      </div>

      {/* Run history */}
      <section className="rounded-xl border border-border bg-card">
        <div className="flex items-center gap-2 border-b border-border px-5 py-4">
          <Archive className="size-4 text-muted-foreground" />
          <h2 className="font-semibold">Backup history</h2>
          <span className="text-xs text-muted-foreground">
            {tenantId == null ? "Select a tenant to see and run backups." : `${runs.length} run(s)`}
          </span>
        </div>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Scope</TableHead>
                <TableHead>Created</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Size</TableHead>
                <TableHead>Encryption</TableHead>
                <TableHead>Verification</TableHead>
                <TableHead>Expires</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {runs.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={8} className="py-8 text-center text-sm text-muted-foreground">
                    No backup runs yet.
                  </TableCell>
                </TableRow>
              ) : (
                runs.map((run) => (
                  <TableRow key={run.id}>
                    <TableCell className="text-sm font-medium">
                      {BACKUP_SCOPE_LABELS[run.scope]}
                      <span className="ml-1 text-[10px] text-muted-foreground">({run.triggerSource})</span>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">{fmtDate(run.createdAt)}</TableCell>
                    <TableCell>
                      <Badge
                        variant={
                          run.status === "completed"
                            ? "default"
                            : run.status === "failed"
                              ? "destructive"
                              : "secondary"
                        }
                        className="text-[10px]"
                      >
                        {run.status}
                      </Badge>
                      {run.error ? <p className="mt-1 max-w-[16rem] truncate text-[10px] text-destructive">{run.error}</p> : null}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {formatBytes(run.artifactSize)}
                      <span className="block text-[10px]">{run.rowCount} rows · {run.tableCount} tables</span>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {run.encrypted ? (
                        <span className="inline-flex items-center gap-1">
                          <Lock className="size-3" /> {run.encryptionAlgo ?? "encrypted"}
                        </span>
                      ) : (
                        "plaintext"
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={
                          run.verificationStatus === "passed"
                            ? "default"
                            : run.verificationStatus === "failed"
                              ? "destructive"
                              : "outline"
                        }
                        className="text-[10px]"
                      >
                        {run.verificationStatus}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">{fmtDate(run.expiresAt)}</TableCell>
                    <TableCell className="text-right">
                      {canManage && run.status === "completed" ? (
                        <div className="flex justify-end gap-1">
                          <Button size="sm" variant="ghost" onClick={() => void verify(run)} disabled={busy === `verify:${run.id}`}>
                            {busy === `verify:${run.id}` ? <Loader2 className="size-3.5 animate-spin" /> : <ShieldCheck className="size-3.5" />}
                            <span className="sr-only sm:not-sr-only sm:ml-1">Verify</span>
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => void restoreTest(run)} disabled={busy === `restore:${run.id}`}>
                            {busy === `restore:${run.id}` ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
                            <span className="sr-only sm:not-sr-only sm:ml-1">Restore test</span>
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            render={<a href={`/api/platform/backups/${run.id}/download?tenantId=${run.tenantId ?? ""}`} />}
                          >
                            <Download className="size-3.5" />
                            <span className="sr-only sm:not-sr-only sm:ml-1">Download</span>
                          </Button>
                        </div>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </section>

      {/* Restore tests */}
      <section className="rounded-xl border border-border bg-card">
        <div className="flex items-center gap-2 border-b border-border px-5 py-4">
          <ShieldCheck className="size-4 text-muted-foreground" />
          <h2 className="font-semibold">Restore tests</h2>
          <span className="text-xs text-muted-foreground">Non-destructive validation against the live schema.</span>
        </div>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Run</TableHead>
                <TableHead>Scope</TableHead>
                <TableHead>Result</TableHead>
                <TableHead>Validated</TableHead>
                <TableHead>Detail</TableHead>
                <TableHead>When</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {restoreTests.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="py-8 text-center text-sm text-muted-foreground">
                    No restore tests recorded yet.
                  </TableCell>
                </TableRow>
              ) : (
                restoreTests.map((t) => (
                  <TableRow key={t.id}>
                    <TableCell className="text-xs text-muted-foreground">#{t.runId}</TableCell>
                    <TableCell className="text-sm">{BACKUP_SCOPE_LABELS[t.scope]}</TableCell>
                    <TableCell>
                      <Badge variant={t.status === "passed" ? "default" : "destructive"} className="text-[10px]">
                        {t.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {t.tablesValidated} tables · {t.rowsValidated} rows
                    </TableCell>
                    <TableCell className="max-w-[20rem] text-xs text-muted-foreground">
                      {t.issues.length ? t.issues.slice(0, 3).join("; ") : t.detail ?? "—"}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">{fmtDate(t.createdAt)}</TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </section>
    </div>
  )
}
