"use client"

import { useEffect, useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { KeyRound, Loader2, Lock, RotateCw, ShieldAlert, Trash2, History } from "lucide-react"
import type { PublicSecret, PublicAuditEvent, RotationStatus, SecretSource } from "@/lib/secrets/model"
import { SECRET_CATEGORY_LABELS, type SecretCategory } from "@/lib/secrets/inventory"
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

const ROTATION_STYLES: Record<RotationStatus, { label: string; className: string }> = {
  never: { label: "Never rotated", className: "border-border text-muted-foreground" },
  ok: { label: "Rotation current", className: "border-emerald-500/40 text-emerald-600 dark:text-emerald-400" },
  due: { label: "Rotation due", className: "border-amber-500/40 text-amber-600 dark:text-amber-400" },
  overdue: { label: "Rotation overdue", className: "border-destructive/40 text-destructive" },
}

const SOURCE_LABELS: Record<SecretSource, string> = {
  env: "Deployment env",
  stored: "Encrypted store",
  unset: "Not set",
}

function groupByCategory(secrets: PublicSecret[]): { category: SecretCategory; items: PublicSecret[] }[] {
  const order: SecretCategory[] = []
  const groups = new Map<SecretCategory, PublicSecret[]>()
  for (const s of secrets) {
    if (!groups.has(s.category)) {
      groups.set(s.category, [])
      order.push(s.category)
    }
    groups.get(s.category)!.push(s)
  }
  return order.map((category) => ({ category, items: groups.get(category)! }))
}

export function SecretsManager({
  secrets,
  canEdit,
  encryptionConfigured,
}: {
  secrets: PublicSecret[]
  canEdit: boolean
  encryptionConfigured: boolean
}) {
  const groups = useMemo(() => groupByCategory(secrets), [secrets])
  const [target, setTarget] = useState<{ secret: PublicSecret; mode: "set" | "rotate" } | null>(null)
  const [auditFor, setAuditFor] = useState<PublicSecret | null>(null)

  const summary = useMemo(() => {
    const overdue = secrets.filter((s) => s.rotationStatus === "overdue").length
    const due = secrets.filter((s) => s.rotationStatus === "due").length
    const present = secrets.filter((s) => s.present).length
    return { overdue, due, present, total: secrets.length }
  }, [secrets])

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

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <SummaryStat label="Inventoried" value={summary.total} />
        <SummaryStat label="Configured" value={summary.present} />
        <SummaryStat label="Rotation due" value={summary.due} tone={summary.due ? "warn" : undefined} />
        <SummaryStat label="Overdue" value={summary.overdue} tone={summary.overdue ? "bad" : undefined} />
      </div>

      {groups.map(({ category, items }) => (
        <Card key={category}>
          <CardHeader className="border-b">
            <CardTitle className="flex items-center gap-2 text-base">
              <KeyRound className="size-4 text-muted-foreground" />
              {SECRET_CATEGORY_LABELS[category]}
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col divide-y divide-border p-0">
            {items.map((secret) => (
              <SecretRow
                key={secret.key}
                secret={secret}
                canEdit={canEdit}
                onSet={() => setTarget({ secret, mode: "set" })}
                onRotate={() => setTarget({ secret, mode: "rotate" })}
                onAudit={() => setAuditFor(secret)}
              />
            ))}
          </CardContent>
        </Card>
      ))}

      {target ? (
        <SecretValueDialog
          secret={target.secret}
          mode={target.mode}
          onClose={() => setTarget(null)}
        />
      ) : null}

      {auditFor ? <AuditDialog secret={auditFor} onClose={() => setAuditFor(null)} /> : null}
    </div>
  )
}

function SummaryStat({ label, value, tone }: { label: string; value: number; tone?: "warn" | "bad" }) {
  const color = tone === "bad" ? "text-destructive" : tone === "warn" ? "text-amber-600 dark:text-amber-400" : ""
  return (
    <div className="rounded-lg border border-border bg-background p-3">
      <div className={`text-2xl font-semibold tabular-nums ${color}`}>{value}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
  )
}

function SecretRow({
  secret,
  canEdit,
  onSet,
  onRotate,
  onAudit,
}: {
  secret: PublicSecret
  canEdit: boolean
  onSet: () => void
  onRotate: () => void
  onAudit: () => void
}) {
  const rotation = ROTATION_STYLES[secret.rotationStatus]
  return (
    <div className="flex flex-col gap-3 px-6 py-4 lg:flex-row lg:items-center lg:justify-between">
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <code className="text-sm font-medium">{secret.key}</code>
          {secret.critical ? (
            <Badge variant="outline" className="border-destructive/40 text-destructive">
              Critical
            </Badge>
          ) : null}
          <Badge variant="secondary" className="gap-1 font-normal">
            <Lock className="size-3" />
            {SOURCE_LABELS[secret.source]}
          </Badge>
        </div>
        <span className="text-xs text-muted-foreground">{secret.description}</span>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span className="font-mono text-foreground">{secret.masked}</span>
          <span>
            {"Policy: rotate every "}
            {secret.rotationIntervalDays}
            {" days"}
          </span>
          {secret.version > 0 ? <span>{"v" + secret.version}</span> : null}
          {secret.ageDays != null ? <span>{secret.ageDays + "d since rotation"}</span> : null}
          {secret.keyFingerprint ? <span className="font-mono">key {secret.keyFingerprint}</span> : null}
        </div>
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-2 lg:justify-end">
        <Badge variant="outline" className={rotation.className}>
          {rotation.label}
        </Badge>
        <Button size="sm" variant="ghost" onClick={onAudit}>
          <History className="mr-1.5 size-3.5" />
          Audit
        </Button>
        {canEdit ? (
          <>
            <Button size="sm" variant="outline" onClick={onSet}>
              {secret.stored ? "Replace" : "Set value"}
            </Button>
            <Button size="sm" variant="outline" onClick={onRotate} disabled={!secret.stored}>
              <RotateCw className="mr-1.5 size-3.5" />
              Rotate
            </Button>
          </>
        ) : null}
      </div>
    </div>
  )
}

function SecretValueDialog({
  secret,
  mode,
  onClose,
}: {
  secret: PublicSecret
  mode: "set" | "rotate"
  onClose: () => void
}) {
  const router = useRouter()
  const [value, setValue] = useState("")
  const [busy, setBusy] = useState(false)
  const isRotate = mode === "rotate"

  async function submit() {
    if (!value.trim()) {
      toast.error("Enter a value")
      return
    }
    setBusy(true)
    try {
      const endpoint = isRotate ? "/api/platform/secrets/rotate" : "/api/platform/secrets"
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: secret.key, value }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast.error(json.error || "Could not save secret")
        return
      }
      toast.success(`${isRotate ? "Rotated" : "Stored"} ${secret.key} (v${json.version})`)
      setValue("")
      onClose()
      router.refresh()
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
            {isRotate ? "Rotate" : "Set"} {secret.label}
          </DialogTitle>
          <DialogDescription>
            {isRotate
              ? "Enter the new value. The current version is retired and the rotation clock resets. This cannot be undone."
              : "The value is encrypted at rest and never displayed again. A deployment env value, if set, still takes precedence."}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2">
          <label htmlFor="secret-value" className="text-sm font-medium">
            {secret.key}
          </label>
          <Input
            id="secret-value"
            type="password"
            autoComplete="off"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="Paste the secret value"
            autoFocus
          />
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

function AuditDialog({ secret, onClose }: { secret: PublicSecret; onClose: () => void }) {
  const [events, setEvents] = useState<PublicAuditEvent[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    fetch(`/api/platform/secrets/audit?key=${encodeURIComponent(secret.key)}&limit=100`)
      .then((r) => r.json())
      .then((json) => {
        if (!active) return
        if (json.error) setError(json.error)
        else setEvents(json.events ?? [])
      })
      .catch(() => active && setError("Unable to load access log"))
    return () => {
      active = false
    }
  }, [secret.key])

  return (
    <Dialog open onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Access audit — {secret.label}</DialogTitle>
          <DialogDescription>Who touched this secret, and when. Values are never recorded.</DialogDescription>
        </DialogHeader>
        <div className="max-h-80 overflow-y-auto">
          {error ? (
            <p className="py-6 text-center text-sm text-destructive">{error}</p>
          ) : events == null ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              <Loader2 className="mr-1.5 inline size-4 animate-spin" />
              Loading…
            </p>
          ) : events.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">No recorded access yet.</p>
          ) : (
            <ul className="flex flex-col divide-y divide-border">
              {events.map((e) => (
                <li key={e.id} className="flex items-center justify-between gap-4 py-2.5 text-sm">
                  <div className="flex min-w-0 flex-col">
                    <span className="font-medium capitalize">{e.action}</span>
                    <span className="truncate text-xs text-muted-foreground">
                      {e.actorEmail ?? "system"}
                      {e.detail ? ` · ${e.detail}` : ""}
                    </span>
                  </div>
                  <time className="shrink-0 text-xs text-muted-foreground">
                    {new Date(e.at).toLocaleString()}
                  </time>
                </li>
              ))}
            </ul>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
