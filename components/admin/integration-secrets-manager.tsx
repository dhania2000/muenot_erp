"use client"

import { useState } from "react"
import useSWR from "swr"
import { toast } from "sonner"
import { KeyRound, Loader2, Lock, RotateCw, ShieldAlert, History, Undo2, Activity, Vault } from "lucide-react"
import type { PublicIntegration, PublicIntegrationField } from "@/lib/secrets/tenant-integrations"
import type { RotationStatus } from "@/lib/secrets/model"
import type { HealthState, VaultKind } from "@/lib/secrets/providers/types"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

type AvailableVaults = { aws: boolean; azure: boolean; defaultKind: VaultKind | null }

type AuditEvent = {
  id: number
  integrationKey: string
  fieldKey: string | null
  action: string
  actorEmail: string | null
  detail: string | null
  at: string
}

const ROTATION_STYLES: Record<RotationStatus, { label: string; className: string }> = {
  never: { label: "Never rotated", className: "border-border text-muted-foreground" },
  ok: { label: "Rotation current", className: "border-emerald-500/40 text-emerald-600 dark:text-emerald-400" },
  due: { label: "Rotation due", className: "border-amber-500/40 text-amber-600 dark:text-amber-400" },
  overdue: { label: "Rotation overdue", className: "border-destructive/40 text-destructive" },
}

const HEALTH_STYLES: Record<HealthState, { label: string; className: string }> = {
  healthy: { label: "Healthy", className: "border-emerald-500/40 text-emerald-600 dark:text-emerald-400" },
  degraded: { label: "Degraded", className: "border-amber-500/40 text-amber-600 dark:text-amber-400" },
  down: { label: "Down", className: "border-destructive/40 text-destructive" },
  unknown: { label: "Untested", className: "border-border text-muted-foreground" },
}

const VAULT_LABELS: Record<VaultKind, string> = {
  db: "Encrypted DB vault",
  aws_secrets_manager: "AWS Secrets Manager",
  azure_key_vault: "Azure Key Vault",
}

const fetcher = (url: string) => fetch(url).then((r) => r.json())

function newIdemKey(): string {
  return typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random())
}

export function IntegrationSecretsManager({
  encryptionConfigured,
  availableVaults,
}: {
  encryptionConfigured: boolean
  availableVaults: AvailableVaults
}) {
  const { data, isLoading, mutate } = useSWR<{ integrations: PublicIntegration[] }>(
    "/api/settings/integration-secrets",
    fetcher,
  )
  const integrations = data?.integrations ?? []

  const [valueTarget, setValueTarget] = useState<{
    integration: PublicIntegration
    field: PublicIntegrationField
    mode: "set" | "rotate"
  } | null>(null)
  const [rollbackTarget, setRollbackTarget] = useState<{
    integration: PublicIntegration
    field: PublicIntegrationField
  } | null>(null)
  const [auditFor, setAuditFor] = useState<PublicIntegration | null>(null)

  const vaultOptions: VaultKind[] = ["db", ...(availableVaults.aws ? (["aws_secrets_manager"] as const) : []), ...(availableVaults.azure ? (["azure_key_vault"] as const) : [])]

  return (
    <div className="flex flex-col gap-6">
      {!encryptionConfigured ? (
        <div className="flex items-start gap-3 rounded-lg border border-destructive/40 bg-destructive/5 p-4">
          <ShieldAlert className="mt-0.5 size-5 shrink-0 text-destructive" />
          <div className="flex flex-col gap-0.5 text-sm">
            <span className="font-medium text-destructive">Encryption key not configured</span>
            <span className="text-muted-foreground">
              {"Set "}
              <code className="font-mono">SETTINGS_ENCRYPTION_KEY</code>
              {" before storing secrets — values cannot be encrypted at rest until it is present."}
            </span>
          </div>
        </div>
      ) : null}

      <div className="flex items-start gap-3 rounded-lg border border-border bg-muted/30 p-4 text-sm">
        <Vault className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
        <div className="flex flex-col gap-0.5">
          <span className="font-medium">Vault providers</span>
          <span className="text-muted-foreground">
            External vaults available:{" "}
            {[
              availableVaults.aws ? "AWS Secrets Manager" : null,
              availableVaults.azure ? "Azure Key Vault" : null,
            ]
              .filter(Boolean)
              .join(", ") || "none configured"}
            {". "}
            The encrypted database vault is always available as a fallback
            {availableVaults.defaultKind ? ` (default: ${VAULT_LABELS[availableVaults.defaultKind]})` : ""}.
          </span>
        </div>
      </div>

      {isLoading ? (
        <p className="py-10 text-center text-sm text-muted-foreground">
          <Loader2 className="mr-1.5 inline size-4 animate-spin" />
          Loading integrations…
        </p>
      ) : (
        integrations.map((integration) => (
          <IntegrationCard
            key={integration.key}
            integration={integration}
            vaultOptions={vaultOptions}
            onMutate={mutate}
            onSet={(field) => setValueTarget({ integration, field, mode: "set" })}
            onRotate={(field) => setValueTarget({ integration, field, mode: "rotate" })}
            onRollback={(field) => setRollbackTarget({ integration, field })}
            onAudit={() => setAuditFor(integration)}
          />
        ))
      )}

      {valueTarget ? (
        <SecretValueDialog
          integration={valueTarget.integration}
          field={valueTarget.field}
          mode={valueTarget.mode}
          vaultOptions={vaultOptions}
          onClose={() => setValueTarget(null)}
          onDone={() => mutate()}
        />
      ) : null}

      {rollbackTarget ? (
        <RollbackDialog
          integration={rollbackTarget.integration}
          field={rollbackTarget.field}
          onClose={() => setRollbackTarget(null)}
          onDone={() => mutate()}
        />
      ) : null}

      {auditFor ? <AuditDialog integration={auditFor} onClose={() => setAuditFor(null)} /> : null}
    </div>
  )
}

function IntegrationCard({
  integration,
  vaultOptions,
  onMutate,
  onSet,
  onRotate,
  onRollback,
  onAudit,
}: {
  integration: PublicIntegration
  vaultOptions: VaultKind[]
  onMutate: () => void
  onSet: (field: PublicIntegrationField) => void
  onRotate: (field: PublicIntegrationField) => void
  onRollback: (field: PublicIntegrationField) => void
  onAudit: () => void
}) {
  const [testing, setTesting] = useState(false)
  const health = HEALTH_STYLES[integration.health]

  async function testConnection() {
    setTesting(true)
    try {
      const res = await fetch("/api/settings/integration-secrets/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ integrationKey: integration.key }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast.error(json.error || "Connection test failed")
        return
      }
      const label = HEALTH_STYLES[json.health as HealthState]?.label ?? json.health
      if (json.health === "healthy") toast.success(`${integration.label}: ${label}`)
      else toast.warning(`${integration.label}: ${label}${json.detail ? ` — ${json.detail}` : ""}`)
      onMutate()
    } catch {
      toast.error("Network error — please try again")
    } finally {
      setTesting(false)
    }
  }

  return (
    <Card>
      <CardHeader className="border-b">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <KeyRound className="size-4 text-muted-foreground" />
            {integration.label}
            <Badge variant="secondary" className="font-normal capitalize">
              {integration.category}
            </Badge>
          </CardTitle>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline" className="gap-1 font-normal">
              <Lock className="size-3" />
              {integration.vaultLabel}
            </Badge>
            <Badge variant="outline" className={health.className}>
              {health.label}
            </Badge>
            <Button size="sm" variant="ghost" onClick={onAudit}>
              <History className="mr-1.5 size-3.5" />
              Audit
            </Button>
            <Button size="sm" variant="outline" onClick={testConnection} disabled={testing}>
              {testing ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : <Activity className="mr-1.5 size-3.5" />}
              Test connection
            </Button>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">{integration.description}</p>
      </CardHeader>
      <CardContent className="flex flex-col divide-y divide-border p-0">
        {integration.fields.map((field) => (
          <FieldRow
            key={field.key}
            field={field}
            onSet={() => onSet(field)}
            onRotate={() => onRotate(field)}
            onRollback={() => onRollback(field)}
          />
        ))}
      </CardContent>
    </Card>
  )
}

function FieldRow({
  field,
  onSet,
  onRotate,
  onRollback,
}: {
  field: PublicIntegrationField
  onSet: () => void
  onRotate: () => void
  onRollback: () => void
}) {
  const rotation = ROTATION_STYLES[field.rotationStatus]
  return (
    <div className="flex flex-col gap-3 px-6 py-4 lg:flex-row lg:items-center lg:justify-between">
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium">{field.label}</span>
          <code className="text-xs text-muted-foreground">{field.key}</code>
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span className="font-mono text-foreground">{field.masked}</span>
          {field.version != null ? <span>{"v" + field.version}</span> : null}
          {field.vaultKind ? <span>{VAULT_LABELS[field.vaultKind]}</span> : null}
          {field.ageDays != null ? <span>{field.ageDays + "d since rotation"}</span> : null}
        </div>
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-2 lg:justify-end">
        <Badge variant="outline" className={rotation.className}>
          {rotation.label}
        </Badge>
        <Button size="sm" variant="outline" onClick={onSet}>
          {field.present ? "Replace" : "Set value"}
        </Button>
        <Button size="sm" variant="outline" onClick={onRotate} disabled={!field.present}>
          <RotateCw className="mr-1.5 size-3.5" />
          Rotate
        </Button>
        <Button size="sm" variant="ghost" onClick={onRollback} disabled={(field.version ?? 0) < 2}>
          <Undo2 className="mr-1.5 size-3.5" />
          Rollback
        </Button>
      </div>
    </div>
  )
}

function SecretValueDialog({
  integration,
  field,
  mode,
  vaultOptions,
  onClose,
  onDone,
}: {
  integration: PublicIntegration
  field: PublicIntegrationField
  mode: "set" | "rotate"
  vaultOptions: VaultKind[]
  onClose: () => void
  onDone: () => void
}) {
  const [value, setValue] = useState("")
  const [vaultChoice, setVaultChoice] = useState<VaultKind>(field.vaultKind ?? integration.vaultKind ?? "db")
  const [busy, setBusy] = useState(false)
  const isRotate = mode === "rotate"

  async function submit() {
    if (!value.trim()) {
      toast.error("Enter a value")
      return
    }
    setBusy(true)
    try {
      const endpoint = isRotate
        ? "/api/settings/integration-secrets/rotate"
        : "/api/settings/integration-secrets"
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": newIdemKey() },
        body: JSON.stringify({
          integrationKey: integration.key,
          fieldKey: field.key,
          value,
          vaultChoice,
        }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast.error(json.error || "Could not save secret")
        return
      }
      const storedIn = VAULT_LABELS[json.vaultKind as VaultKind] ?? json.vaultKind
      toast.success(`${isRotate ? "Rotated" : "Stored"} ${field.label} (v${json.version}) → ${storedIn}`)
      setValue("")
      onClose()
      onDone()
    } catch {
      toast.error("Network error — please try again")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {isRotate ? "Rotate" : "Set"} {integration.label} — {field.label}
          </DialogTitle>
          <DialogDescription>
            {isRotate
              ? "Enter the new value. A new version is appended and the previous one retired. This can be rolled back."
              : "The value is stored in the selected vault (encrypted at rest for the DB vault) and never displayed again."}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <label htmlFor="secret-value" className="text-sm font-medium">
              {field.label}
            </label>
            <Input
              id="secret-value"
              type="password"
              autoComplete="off"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={field.hint || "Paste the secret value"}
              autoFocus
            />
          </div>
          <div className="flex flex-col gap-2">
            <label className="text-sm font-medium">Vault</label>
            <Select value={vaultChoice} onValueChange={(v) => setVaultChoice(v as VaultKind)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {vaultOptions.map((v) => (
                  <SelectItem key={v} value={v}>
                    {VAULT_LABELS[v]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              If the chosen external vault is unreachable, the value is safely stored in the encrypted DB vault and the
              connection is marked unhealthy.
            </p>
          </div>
        </div>
        <DialogFooter>
          <DialogClose render={<Button variant="ghost" disabled={busy} />}>Cancel</DialogClose>
          <Button onClick={submit} disabled={busy}>
            {busy ? <Loader2 className="mr-1.5 size-4 animate-spin" /> : null}
            {isRotate ? "Rotate secret" : "Store secret"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function RollbackDialog({
  integration,
  field,
  onClose,
  onDone,
}: {
  integration: PublicIntegration
  field: PublicIntegrationField
  onClose: () => void
  onDone: () => void
}) {
  const current = field.version ?? 0
  const [targetVersion, setTargetVersion] = useState<string>(current > 1 ? String(current - 1) : "1")
  const [busy, setBusy] = useState(false)

  async function submit() {
    const target = Number(targetVersion)
    if (!Number.isInteger(target) || target < 1) {
      toast.error("Enter a valid version number")
      return
    }
    setBusy(true)
    try {
      const res = await fetch("/api/settings/integration-secrets/rollback", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": newIdemKey() },
        body: JSON.stringify({
          integrationKey: integration.key,
          fieldKey: field.key,
          targetVersion: target,
        }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast.error(json.error || "Could not roll back")
        return
      }
      toast.success(`Rolled back ${field.label} to v${json.version}`)
      onClose()
      onDone()
    } catch {
      toast.error("Network error — please try again")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            Roll back {integration.label} — {field.label}
          </DialogTitle>
          <DialogDescription>
            Reactivate a previous version. History is preserved — the current version (v{current}) is retired, not
            deleted, so you can roll forward again.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2">
          <label htmlFor="target-version" className="text-sm font-medium">
            Target version
          </label>
          <Input
            id="target-version"
            type="number"
            min={1}
            max={Math.max(current - 1, 1)}
            value={targetVersion}
            onChange={(e) => setTargetVersion(e.target.value)}
            autoFocus
          />
        </div>
        <DialogFooter>
          <DialogClose render={<Button variant="ghost" disabled={busy} />}>Cancel</DialogClose>
          <Button onClick={submit} disabled={busy}>
            {busy ? <Loader2 className="mr-1.5 size-4 animate-spin" /> : null}
            Roll back
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function AuditDialog({ integration, onClose }: { integration: PublicIntegration; onClose: () => void }) {
  const { data, isLoading, error } = useSWR<{ events: AuditEvent[] }>(
    `/api/settings/integration-secrets/audit?integrationKey=${encodeURIComponent(integration.key)}&limit=100`,
    fetcher,
  )
  const events = data?.events ?? null

  return (
    <Dialog open onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Audit history — {integration.label}</DialogTitle>
          <DialogDescription>
            Every set, rotate, rollback, test and access — scoped to your workspace. Values are never recorded.
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-80 overflow-y-auto">
          {error ? (
            <p className="py-6 text-center text-sm text-destructive">Unable to load audit history</p>
          ) : isLoading || events == null ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              <Loader2 className="mr-1.5 inline size-4 animate-spin" />
              Loading…
            </p>
          ) : events.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">No recorded activity yet.</p>
          ) : (
            <ul className="flex flex-col divide-y divide-border">
              {events.map((e) => (
                <li key={e.id} className="flex items-center justify-between gap-4 py-2.5 text-sm">
                  <div className="flex min-w-0 flex-col">
                    <span className="font-medium capitalize">
                      {e.action}
                      {e.fieldKey ? ` · ${e.fieldKey}` : ""}
                    </span>
                    <span className="truncate text-xs text-muted-foreground">
                      {e.actorEmail ?? "system"}
                      {e.detail ? ` · ${e.detail}` : ""}
                    </span>
                  </div>
                  <time className="shrink-0 text-xs text-muted-foreground">{new Date(e.at).toLocaleString()}</time>
                </li>
              ))}
            </ul>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
