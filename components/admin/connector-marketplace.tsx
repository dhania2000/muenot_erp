"use client"

import { useState } from "react"
import useSWR from "swr"
import { toast } from "sonner"
import {
  Activity,
  History,
  Loader2,
  Lock,
  Plug,
  PlugZap,
  RotateCw,
  ShieldAlert,
  ShieldCheck,
  Unplug,
} from "lucide-react"
import type { InstallStatus, PublicConnector, ScopeReview } from "@/lib/marketplace/connectors"
import type { HealthState } from "@/lib/secrets/providers/types"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

type AuditEvent = {
  id: number
  connectorKey: string
  action: string
  actorEmail: string | null
  detail: string | null
  at: string
}

const STATUS_STYLES: Record<InstallStatus, { label: string; className: string }> = {
  not_installed: { label: "Not installed", className: "border-border text-muted-foreground" },
  installed: { label: "Installed", className: "border-emerald-500/40 text-emerald-600 dark:text-emerald-400" },
  disconnected: { label: "Disconnected", className: "border-amber-500/40 text-amber-600 dark:text-amber-400" },
}

const HEALTH_STYLES: Record<HealthState, { label: string; className: string }> = {
  healthy: { label: "Healthy", className: "border-emerald-500/40 text-emerald-600 dark:text-emerald-400" },
  degraded: { label: "Degraded", className: "border-amber-500/40 text-amber-600 dark:text-amber-400" },
  down: { label: "Down", className: "border-destructive/40 text-destructive" },
  unknown: { label: "Untested", className: "border-border text-muted-foreground" },
}

const CATEGORY_LABELS: Record<PublicConnector["category"], string> = {
  accounting: "Accounting",
  productivity: "Productivity",
  identity: "Identity",
  communication: "Communication",
}

const fetcher = (url: string) =>
  fetch(url).then(async (r) => {
    const json = await r.json().catch(() => ({}))
    if (!r.ok) throw new Error(json?.error ?? "Request failed")
    return json
  })

function newIdemKey(): string {
  return typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random())
}

function formatDate(value: string | null): string {
  if (!value) return "—"
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? value : d.toLocaleString()
}

async function postAction(path: string, body: Record<string, unknown>) {
  const res = await fetch(`/api/settings/marketplace/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": newIdemKey() },
    body: JSON.stringify(body),
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(json?.error ?? "Request failed")
  return json
}

type ConnectDialogState = { connector: PublicConnector; mode: "install" | "reconnect" }

export function ConnectorMarketplace({ encryptionConfigured }: { encryptionConfigured: boolean }) {
  const { data, error, isLoading, mutate } = useSWR<{ connectors: PublicConnector[] }>(
    "/api/settings/marketplace",
    fetcher,
  )
  const connectors = data?.connectors ?? []

  const [connectTarget, setConnectTarget] = useState<ConnectDialogState | null>(null)
  const [disconnectTarget, setDisconnectTarget] = useState<PublicConnector | null>(null)
  const [permissionsFor, setPermissionsFor] = useState<PublicConnector | null>(null)
  const [auditFor, setAuditFor] = useState<PublicConnector | null>(null)
  const [checking, setChecking] = useState<string | null>(null)

  async function runHealthCheck(connector: PublicConnector) {
    setChecking(connector.key)
    try {
      const result = await postAction("health", { connectorKey: connector.key })
      const health = (result.health ?? "unknown") as HealthState
      if (health === "healthy") toast.success(`${connector.name} is healthy`)
      else toast.warning(`${connector.name}: ${HEALTH_STYLES[health].label}${result.detail ? ` — ${result.detail}` : ""}`)
      await mutate()
    } catch (err: any) {
      toast.error(err?.message ?? "Health check failed")
    } finally {
      setChecking(null)
    }
  }

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
              {" before installing connectors — credentials cannot be encrypted at rest until it is present."}
            </span>
          </div>
        </div>
      ) : null}

      {isLoading ? (
        <p className="py-10 text-center text-sm text-muted-foreground">
          <Loader2 className="mr-1.5 inline size-4 animate-spin" />
          Loading connectors…
        </p>
      ) : error ? (
        <p className="py-10 text-center text-sm text-destructive">{error.message}</p>
      ) : connectors.length === 0 ? (
        <p className="py-10 text-center text-sm text-muted-foreground">No connectors are available.</p>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {connectors.map((connector) => (
            <ConnectorCard
              key={connector.key}
              connector={connector}
              encryptionConfigured={encryptionConfigured}
              checking={checking === connector.key}
              onInstall={() => setConnectTarget({ connector, mode: "install" })}
              onReconnect={() => setConnectTarget({ connector, mode: "reconnect" })}
              onDisconnect={() => setDisconnectTarget(connector)}
              onHealth={() => runHealthCheck(connector)}
              onPermissions={() => setPermissionsFor(connector)}
              onAudit={() => setAuditFor(connector)}
            />
          ))}
        </div>
      )}

      {connectTarget ? (
        <ConnectDialog
          target={connectTarget}
          onClose={() => setConnectTarget(null)}
          onDone={async () => {
            setConnectTarget(null)
            await mutate()
          }}
        />
      ) : null}

      {disconnectTarget ? (
        <DisconnectDialog
          connector={disconnectTarget}
          onClose={() => setDisconnectTarget(null)}
          onDone={async () => {
            setDisconnectTarget(null)
            await mutate()
          }}
        />
      ) : null}

      {permissionsFor ? <PermissionsDialog connector={permissionsFor} onClose={() => setPermissionsFor(null)} /> : null}

      {auditFor ? <AuditDialog connector={auditFor} onClose={() => setAuditFor(null)} /> : null}
    </div>
  )
}

function ConnectorCard({
  connector,
  encryptionConfigured,
  checking,
  onInstall,
  onReconnect,
  onDisconnect,
  onHealth,
  onPermissions,
  onAudit,
}: {
  connector: PublicConnector
  encryptionConfigured: boolean
  checking: boolean
  onInstall: () => void
  onReconnect: () => void
  onDisconnect: () => void
  onHealth: () => void
  onPermissions: () => void
  onAudit: () => void
}) {
  const status = STATUS_STYLES[connector.status]
  const health = HEALTH_STYLES[connector.health] ?? HEALTH_STYLES.unknown
  const grantedCount = connector.scopes.filter((s) => s.granted).length

  return (
    <Card>
      <CardHeader className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-base">{connector.name}</CardTitle>
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge variant="outline">{CATEGORY_LABELS[connector.category] ?? connector.category}</Badge>
            <Badge variant="outline" className={status.className}>
              {status.label}
            </Badge>
            {connector.status === "installed" ? (
              <Badge variant="outline" className={health.className}>
                {health.label}
              </Badge>
            ) : null}
          </div>
        </div>
        <CardDescription>{connector.description}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 text-sm">
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
          <dt className="text-muted-foreground">Scopes granted</dt>
          <dd>
            {grantedCount} / {connector.scopes.length}
          </dd>
          <dt className="text-muted-foreground">Events</dt>
          <dd>{connector.events.length}</dd>
          <dt className="text-muted-foreground">Last connected</dt>
          <dd>{formatDate(connector.lastConnectedAt)}</dd>
          <dt className="text-muted-foreground">Last health check</dt>
          <dd>{formatDate(connector.lastHealthAt)}</dd>
        </dl>

        <div className="flex flex-wrap gap-1.5">
          {connector.credentials.map((c) => (
            <span
              key={c.key}
              className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-0.5 text-xs text-muted-foreground"
            >
              {c.secret ? <Lock className="size-3" aria-hidden="true" /> : null}
              {c.label}
              <span className="sr-only">{c.present ? "(stored)" : "(not set)"}</span>
              <span aria-hidden="true">{c.present ? "••••" : "—"}</span>
            </span>
          ))}
        </div>

        {connector.lastError ? (
          <p className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
            {connector.lastError}
          </p>
        ) : null}

        <div className="flex flex-wrap gap-2">
          {connector.status === "not_installed" ? (
            <Button size="sm" onClick={onInstall} disabled={!encryptionConfigured}>
              <Plug data-icon="inline-start" />
              Install
            </Button>
          ) : (
            <Button size="sm" variant="outline" onClick={onReconnect} disabled={!encryptionConfigured}>
              <RotateCw data-icon="inline-start" />
              Reconnect
            </Button>
          )}
          {connector.status === "installed" ? (
            <>
              <Button size="sm" variant="outline" onClick={onHealth} disabled={checking}>
                {checking ? <Loader2 data-icon="inline-start" className="animate-spin" /> : <Activity data-icon="inline-start" />}
                Health check
              </Button>
              <Button size="sm" variant="outline" onClick={onDisconnect}>
                <Unplug data-icon="inline-start" />
                Disconnect
              </Button>
            </>
          ) : null}
          <Button size="sm" variant="ghost" onClick={onPermissions}>
            <ShieldCheck data-icon="inline-start" />
            Permissions
          </Button>
          <Button size="sm" variant="ghost" onClick={onAudit}>
            <History data-icon="inline-start" />
            History
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

function ConnectDialog({
  target,
  onClose,
  onDone,
}: {
  target: ConnectDialogState
  onClose: () => void
  onDone: () => void | Promise<void>
}) {
  const { connector, mode } = target
  const [values, setValues] = useState<Record<string, string>>({})
  const [scopes, setScopes] = useState<Set<string>>(
    () =>
      new Set(
        connector.scopes.filter((s) => s.required || (mode === "reconnect" && s.granted)).map((s) => s.key),
      ),
  )
  const [busy, setBusy] = useState(false)

  function toggleScope(scope: ScopeReview, checked: boolean) {
    if (scope.required) return
    setScopes((prev) => {
      const next = new Set(prev)
      if (checked) next.add(scope.key)
      else next.delete(scope.key)
      return next
    })
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    try {
      const credentials = Object.fromEntries(Object.entries(values).filter(([, v]) => v.trim() !== ""))
      const hasCredentials = Object.keys(credentials).length > 0
      await postAction(mode, {
        connectorKey: connector.key,
        requestedScopes: Array.from(scopes),
        credentials: mode === "reconnect" && !hasCredentials ? null : credentials,
      })
      toast.success(`${connector.name} ${mode === "install" ? "installed" : "reconnected"}`)
      await onDone()
    } catch (err: any) {
      toast.error(err?.message ?? `Failed to ${mode} connector`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <form onSubmit={submit} className="flex flex-col gap-5">
          <DialogHeader>
            <DialogTitle>
              {mode === "install" ? "Install" : "Reconnect"} {connector.name}
            </DialogTitle>
            <DialogDescription>
              {mode === "install"
                ? "Credentials are encrypted at rest and never shown again after saving."
                : "Enter new credentials to rotate them, or leave fields blank to reuse the stored credentials."}
            </DialogDescription>
          </DialogHeader>

          <fieldset className="flex flex-col gap-3">
            <legend className="mb-2 text-sm font-medium">Credentials</legend>
            {connector.credentials.map((field) => {
              const id = `cred-${connector.key}-${field.key}`
              const required = mode === "install" && field.required
              return (
                <div key={field.key} className="flex flex-col gap-1.5">
                  <Label htmlFor={id}>
                    {field.label}
                    {required ? <span className="text-destructive">{" *"}</span> : null}
                  </Label>
                  <Input
                    id={id}
                    type={field.secret ? "password" : "text"}
                    autoComplete="off"
                    required={required}
                    placeholder={field.present ? "Stored — leave blank to keep" : undefined}
                    value={values[field.key] ?? ""}
                    onChange={(e) => setValues((v) => ({ ...v, [field.key]: e.target.value }))}
                  />
                </div>
              )
            })}
          </fieldset>

          <fieldset className="flex flex-col gap-2">
            <legend className="mb-2 text-sm font-medium">Permissions</legend>
            {connector.scopes.map((scope) => {
              const id = `scope-${connector.key}-${scope.key}`
              return (
                <div key={scope.key} className="flex items-start gap-3">
                  <Checkbox
                    id={id}
                    className="mt-0.5"
                    checked={scopes.has(scope.key)}
                    disabled={scope.required}
                    onCheckedChange={(checked) => toggleScope(scope, Boolean(checked))}
                  />
                  <Label htmlFor={id} className="flex flex-col items-start gap-0.5 font-normal">
                    <span className="font-medium">
                      {scope.label}
                      {scope.required ? <span className="ml-1.5 text-xs text-muted-foreground">(required)</span> : null}
                    </span>
                    <span className="text-xs text-muted-foreground">{scope.description}</span>
                  </Label>
                </div>
              )
            })}
          </fieldset>

          <DialogFooter>
            <DialogClose render={<Button type="button" variant="ghost" disabled={busy} />}>Cancel</DialogClose>
            <Button type="submit" disabled={busy}>
              {busy ? <Loader2 data-icon="inline-start" className="animate-spin" /> : <PlugZap data-icon="inline-start" />}
              {mode === "install" ? "Install" : "Reconnect"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function DisconnectDialog({
  connector,
  onClose,
  onDone,
}: {
  connector: PublicConnector
  onClose: () => void
  onDone: () => void | Promise<void>
}) {
  const [busy, setBusy] = useState(false)

  async function confirm() {
    setBusy(true)
    try {
      await postAction("disconnect", { connectorKey: connector.key })
      toast.success(`${connector.name} disconnected`)
      await onDone()
    } catch (err: any) {
      toast.error(err?.message ?? "Failed to disconnect connector")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Disconnect {connector.name}?</DialogTitle>
          <DialogDescription>
            All active credentials will be revoked and syncing will stop. Credential and audit history are preserved,
            and you can reconnect later.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose render={<Button variant="ghost" disabled={busy} />}>Cancel</DialogClose>
          <Button variant="destructive" onClick={confirm} disabled={busy}>
            {busy ? <Loader2 data-icon="inline-start" className="animate-spin" /> : <Unplug data-icon="inline-start" />}
            Disconnect
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function PermissionsDialog({ connector, onClose }: { connector: PublicConnector; onClose: () => void }) {
  const { data, error, isLoading } = useSWR<{ scopes: ScopeReview[] }>(
    `/api/settings/marketplace/permissions?connectorKey=${encodeURIComponent(connector.key)}`,
    fetcher,
  )
  const scopes = data?.scopes ?? connector.scopes

  return (
    <Dialog open onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{connector.name} permissions</DialogTitle>
          <DialogDescription>Scopes this connector requests and which are granted for your workspace.</DialogDescription>
        </DialogHeader>
        {isLoading ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            <Loader2 className="mr-1.5 inline size-4 animate-spin" />
            Loading…
          </p>
        ) : (
          <div className="flex flex-col gap-4">
            {error ? <p className="text-sm text-destructive">{error.message}</p> : null}
            <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
              {scopes.map((s) => (
                <li key={s.key} className="flex items-start justify-between gap-3 p-3 text-sm">
                  <div className="flex flex-col gap-0.5">
                    <span className="font-medium">{s.label}</span>
                    <span className="text-xs text-muted-foreground">{s.description}</span>
                    <code className="font-mono text-xs text-muted-foreground">{s.key}</code>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    <Badge
                      variant="outline"
                      className={
                        s.granted
                          ? "border-emerald-500/40 text-emerald-600 dark:text-emerald-400"
                          : "border-border text-muted-foreground"
                      }
                    >
                      {s.granted ? "Granted" : "Not granted"}
                    </Badge>
                    {s.required ? <span className="text-xs text-muted-foreground">Required</span> : null}
                  </div>
                </li>
              ))}
            </ul>
            {connector.events.length > 0 ? (
              <div className="flex flex-col gap-2">
                <h3 className="text-sm font-medium">Events emitted</h3>
                <ul className="flex flex-col gap-1.5 text-sm">
                  {connector.events.map((ev) => (
                    <li key={ev.key}>
                      <span className="font-medium">{ev.label}</span>
                      <span className="text-muted-foreground">{` — ${ev.description}`}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

function AuditDialog({ connector, onClose }: { connector: PublicConnector; onClose: () => void }) {
  const { data, error, isLoading } = useSWR<{ events: AuditEvent[] }>(
    `/api/settings/marketplace/audit?connectorKey=${encodeURIComponent(connector.key)}&limit=50`,
    fetcher,
  )
  const events = data?.events ?? []

  return (
    <Dialog open onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{connector.name} history</DialogTitle>
          <DialogDescription>Lifecycle events for this connector in your workspace.</DialogDescription>
        </DialogHeader>
        {isLoading ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            <Loader2 className="mr-1.5 inline size-4 animate-spin" />
            Loading…
          </p>
        ) : error ? (
          <p className="py-6 text-center text-sm text-destructive">{error.message}</p>
        ) : events.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">No events recorded yet.</p>
        ) : (
          <ol className="flex flex-col divide-y divide-border rounded-md border border-border">
            {events.map((ev) => (
              <li key={ev.id} className="flex flex-col gap-0.5 p-3 text-sm">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium capitalize">{ev.action.replace(/_/g, " ")}</span>
                  <time className="text-xs text-muted-foreground" dateTime={ev.at}>
                    {formatDate(ev.at)}
                  </time>
                </div>
                {ev.actorEmail ? <span className="text-xs text-muted-foreground">{ev.actorEmail}</span> : null}
                {ev.detail ? <span className="text-xs text-muted-foreground">{ev.detail}</span> : null}
              </li>
            ))}
          </ol>
        )}
      </DialogContent>
    </Dialog>
  )
}
