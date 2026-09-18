"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import {
  HardDrive,
  Plus,
  Trash2,
  Pencil,
  CheckCircle2,
  Loader2,
  Zap,
  Power,
  ShieldCheck,
  RefreshCw,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Switch } from "@/components/ui/switch"
import { Separator } from "@/components/ui/separator"
import {
  Dialog,
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
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { cn } from "@/lib/utils"
import {
  PROVIDER_LIST,
  getProviderDefinition,
  type StorageProviderId,
} from "@/lib/storage/providers"

type MaskedConnection = {
  id: number
  provider: StorageProviderId
  providerLabel: string
  name: string
  bucket: string
  region: string | null
  endpoint: string | null
  accessKeyIdMasked: string | null
  hasSecret: boolean
  forcePathStyle: boolean
  publicBaseUrl: string | null
  isActive: boolean
  createdAt: string | null
  updatedAt: string | null
}

type AuditEntry = {
  id: number
  connection_id: number | null
  action: string
  detail: string | null
  user_id: number | null
  created_at: string | null
}

type FormState = {
  id: number | null
  provider: StorageProviderId
  name: string
  bucket: string
  region: string
  endpoint: string
  accessKeyId: string
  secretAccessKey: string
  forcePathStyle: boolean
  publicBaseUrl: string
}

const emptyForm = (provider: StorageProviderId = "aws_s3"): FormState => {
  const def = getProviderDefinition(provider)
  return {
    id: null,
    provider,
    name: "",
    bucket: "",
    region: def?.defaultRegion ?? "",
    endpoint: "",
    accessKeyId: "",
    secretAccessKey: "",
    forcePathStyle: def?.forcePathStyle ?? false,
    publicBaseUrl: "",
  }
}

function actionLabel(a: string) {
  return a.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
}

export function StorageConnections() {
  const [connections, setConnections] = useState<MaskedConnection[]>([])
  const [audit, setAudit] = useState<AuditEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [form, setForm] = useState<FormState>(emptyForm())
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null)
  const [formError, setFormError] = useState("")
  const [deleteTarget, setDeleteTarget] = useState<MaskedConnection | null>(null)
  const [busyId, setBusyId] = useState<number | null>(null)

  const providerDef = useMemo(() => getProviderDefinition(form.provider), [form.provider])
  const isBlob = form.provider === "vercel_blob"

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [c, a] = await Promise.all([
        fetch("/api/admin/storage/connections").then((r) => (r.ok ? r.json() : { connections: [] })),
        fetch("/api/admin/storage/audit").then((r) => (r.ok ? r.json() : { entries: [] })),
      ])
      setConnections(c.connections ?? [])
      setAudit(a.entries ?? [])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  function openCreate() {
    setForm(emptyForm())
    setTestResult(null)
    setFormError("")
    setDialogOpen(true)
  }

  function openEdit(c: MaskedConnection) {
    setForm({
      id: c.id,
      provider: c.provider,
      name: c.name,
      bucket: c.bucket,
      region: c.region ?? "",
      endpoint: c.endpoint ?? "",
      accessKeyId: c.accessKeyIdMasked ?? "",
      secretAccessKey: "",
      forcePathStyle: c.forcePathStyle,
      publicBaseUrl: c.publicBaseUrl ?? "",
    })
    setTestResult(null)
    setFormError("")
    setDialogOpen(true)
  }

  function onProviderChange(provider: StorageProviderId) {
    const def = getProviderDefinition(provider)
    setForm((f) => ({
      ...f,
      provider,
      region: f.region || def?.defaultRegion || "",
      forcePathStyle: def?.forcePathStyle ?? f.forcePathStyle,
    }))
    setTestResult(null)
  }

  // When editing, a masked access key must not be sent back as the real value.
  function payload() {
    const accessKeyId =
      form.id != null && form.accessKeyId.includes("*") ? undefined : form.accessKeyId || undefined
    return {
      id: form.id ?? undefined,
      provider: form.provider,
      name: form.name,
      bucket: form.bucket,
      region: form.region || undefined,
      endpoint: form.endpoint || undefined,
      accessKeyId,
      secretAccessKey: form.secretAccessKey || undefined,
      forcePathStyle: form.forcePathStyle,
      publicBaseUrl: form.publicBaseUrl || undefined,
    }
  }

  async function testConnection() {
    setTesting(true)
    setTestResult(null)
    try {
      const res = await fetch("/api/admin/storage/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload()),
      })
      const data = await res.json()
      setTestResult({ ok: Boolean(data.ok), message: data.message || data.error || "Unknown result" })
    } catch (e: any) {
      setTestResult({ ok: false, message: e?.message || "Request failed" })
    } finally {
      setTesting(false)
    }
  }

  async function save() {
    setSaving(true)
    setFormError("")
    try {
      const editing = form.id != null
      const res = await fetch(
        editing ? `/api/admin/storage/connections/${form.id}` : "/api/admin/storage/connections",
        {
          method: editing ? "PUT" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload()),
        },
      )
      const data = await res.json()
      if (!res.ok) {
        setFormError(data.error || "Failed to save connection")
        return
      }
      setDialogOpen(false)
      await load()
    } finally {
      setSaving(false)
    }
  }

  async function toggleActive(c: MaskedConnection) {
    setBusyId(c.id)
    try {
      await fetch(`/api/admin/storage/connections/${c.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: c.isActive ? "deactivate" : "activate" }),
      })
      await load()
    } finally {
      setBusyId(null)
    }
  }

  async function remove() {
    if (!deleteTarget) return
    setBusyId(deleteTarget.id)
    try {
      await fetch(`/api/admin/storage/connections/${deleteTarget.id}`, { method: "DELETE" })
      setDeleteTarget(null)
      await load()
    } finally {
      setBusyId(null)
    }
  }

  const activeConn = connections.find((c) => c.isActive)

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2">
              <HardDrive className="size-5 text-primary" />
              Customer-Owned Storage
            </CardTitle>
            <CardDescription className="mt-1 max-w-2xl">
              Connect your own object storage (Amazon S3, Cloudflare R2, Wasabi, Backblaze B2, DigitalOcean Spaces,
              MinIO or any S3-compatible provider). Uploads for your workspace are written to the active connection;
              with none active, the managed platform storage is used.
            </CardDescription>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={load} disabled={loading}>
              <RefreshCw className={cn("size-4", loading && "animate-spin")} />
              Refresh
            </Button>
            <Button size="sm" onClick={openCreate}>
              <Plus className="size-4" />
              Add connection
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <div className="flex items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-sm">
          <ShieldCheck className="size-4 text-primary" />
          <span className="text-muted-foreground">
            Active storage:{" "}
            <span className="font-medium text-foreground">
              {activeConn ? `${activeConn.name} (${activeConn.providerLabel})` : "Managed platform storage (default)"}
            </span>
          </span>
        </div>

        {loading ? (
          <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            Loading connections…
          </div>
        ) : connections.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border py-10 text-center text-sm text-muted-foreground">
            No storage connections yet. Add one to route uploads to your own infrastructure.
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {connections.map((c) => (
              <div
                key={c.id}
                className={cn(
                  "flex flex-wrap items-center justify-between gap-3 rounded-lg border p-4",
                  c.isActive ? "border-primary/50 bg-primary/5" : "border-border",
                )}
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium">{c.name}</span>
                    <Badge variant="secondary">{c.providerLabel}</Badge>
                    {c.isActive && (
                      <Badge className="gap-1">
                        <CheckCircle2 className="size-3" />
                        Active
                      </Badge>
                    )}
                  </div>
                  <p className="mt-1 truncate text-xs text-muted-foreground">
                    {c.bucket && <>bucket: {c.bucket} · </>}
                    {c.region && <>region: {c.region} · </>}
                    {c.endpoint ? `endpoint: ${c.endpoint}` : "default endpoint"}
                    {c.accessKeyIdMasked && <> · key: {c.accessKeyIdMasked}</>}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <div className="flex items-center gap-2 pr-1">
                    <Power className="size-4 text-muted-foreground" />
                    <Switch
                      checked={c.isActive}
                      disabled={busyId === c.id}
                      onCheckedChange={() => toggleActive(c)}
                      aria-label={c.isActive ? "Deactivate connection" : "Activate connection"}
                    />
                  </div>
                  <Button variant="ghost" size="icon" onClick={() => openEdit(c)} aria-label="Edit connection">
                    <Pencil className="size-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => setDeleteTarget(c)}
                    aria-label="Delete connection"
                  >
                    <Trash2 className="size-4 text-destructive" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}

        {audit.length > 0 && (
          <>
            <Separator />
            <div>
              <h3 className="mb-2 text-sm font-medium">Recent storage activity</h3>
              <ul className="flex flex-col gap-1.5">
                {audit.slice(0, 8).map((e) => (
                  <li key={e.id} className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
                    <span>
                      <span className="font-medium text-foreground">{actionLabel(e.action)}</span>
                      {e.detail ? ` — ${e.detail}` : ""}
                    </span>
                    <span className="shrink-0">
                      {e.created_at ? new Date(e.created_at).toLocaleString() : ""}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </>
        )}
      </CardContent>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{form.id != null ? "Edit connection" : "Add storage connection"}</DialogTitle>
            <DialogDescription>
              Credentials are encrypted at rest and never returned to the browser. Test before saving.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-4 py-2">
            <div className="grid gap-2">
              <Label>Provider</Label>
              <Select value={form.provider} onValueChange={(v) => onProviderChange(v as StorageProviderId)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PROVIDER_LIST.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {providerDef && <p className="text-xs text-muted-foreground">{providerDef.description}</p>}
            </div>

            <div className="grid gap-2">
              <Label htmlFor="conn-name">Connection name</Label>
              <Input
                id="conn-name"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="e.g. Production bucket"
              />
            </div>

            {!isBlob && (
              <>
                <div className="grid gap-2">
                  <Label htmlFor="conn-bucket">Bucket</Label>
                  <Input
                    id="conn-bucket"
                    value={form.bucket}
                    onChange={(e) => setForm((f) => ({ ...f, bucket: e.target.value }))}
                    placeholder="my-bucket"
                  />
                </div>

                {providerDef?.region !== "hidden" && (
                  <div className="grid gap-2">
                    <Label htmlFor="conn-region">
                      Region{providerDef?.region === "optional" ? " (optional)" : ""}
                    </Label>
                    <Input
                      id="conn-region"
                      value={form.region}
                      onChange={(e) => setForm((f) => ({ ...f, region: e.target.value }))}
                      placeholder={providerDef?.defaultRegion || "us-east-1"}
                    />
                  </div>
                )}

                {providerDef?.endpoint !== "hidden" && (
                  <div className="grid gap-2">
                    <Label htmlFor="conn-endpoint">
                      Endpoint{providerDef?.endpoint === "optional" ? " (optional)" : ""}
                    </Label>
                    <Input
                      id="conn-endpoint"
                      value={form.endpoint}
                      onChange={(e) => setForm((f) => ({ ...f, endpoint: e.target.value }))}
                      placeholder={providerDef?.endpointPlaceholder || "https://s3.example.com"}
                    />
                  </div>
                )}

                <div className="grid gap-2">
                  <Label htmlFor="conn-key">Access key ID</Label>
                  <Input
                    id="conn-key"
                    value={form.accessKeyId}
                    onChange={(e) => setForm((f) => ({ ...f, accessKeyId: e.target.value }))}
                    placeholder="AKIA…"
                    autoComplete="off"
                  />
                </div>

                <div className="grid gap-2">
                  <Label htmlFor="conn-secret">
                    Secret access key{form.id != null ? " (leave blank to keep current)" : ""}
                  </Label>
                  <Input
                    id="conn-secret"
                    type="password"
                    value={form.secretAccessKey}
                    onChange={(e) => setForm((f) => ({ ...f, secretAccessKey: e.target.value }))}
                    placeholder="••••••••"
                    autoComplete="new-password"
                  />
                </div>

                <div className="grid gap-2">
                  <Label htmlFor="conn-public">Public base URL (optional)</Label>
                  <Input
                    id="conn-public"
                    value={form.publicBaseUrl}
                    onChange={(e) => setForm((f) => ({ ...f, publicBaseUrl: e.target.value }))}
                    placeholder="https://cdn.example.com"
                  />
                </div>

                <div className="flex items-center justify-between rounded-md border border-border px-3 py-2">
                  <div>
                    <Label htmlFor="conn-path" className="cursor-pointer">
                      Force path-style addressing
                    </Label>
                    <p className="text-xs text-muted-foreground">Required for MinIO and some self-hosted gateways.</p>
                  </div>
                  <Switch
                    id="conn-path"
                    checked={form.forcePathStyle}
                    onCheckedChange={(v) => setForm((f) => ({ ...f, forcePathStyle: v }))}
                  />
                </div>
              </>
            )}

            {testResult && (
              <div
                className={cn(
                  "flex items-center gap-2 rounded-md px-3 py-2 text-sm",
                  testResult.ok
                    ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                    : "bg-destructive/10 text-destructive",
                )}
              >
                {testResult.ok ? <CheckCircle2 className="size-4" /> : <Zap className="size-4" />}
                {testResult.message}
              </div>
            )}
            {formError && <p className="text-sm text-destructive">{formError}</p>}
          </div>

          <DialogFooter className="gap-2 sm:justify-between">
            <Button variant="outline" onClick={testConnection} disabled={testing || saving}>
              {testing ? <Loader2 className="size-4 animate-spin" /> : <Zap className="size-4" />}
              Test connection
            </Button>
            <div className="flex gap-2">
              <Button variant="ghost" onClick={() => setDialogOpen(false)} disabled={saving}>
                Cancel
              </Button>
              <Button onClick={save} disabled={saving || !form.name.trim()}>
                {saving && <Loader2 className="size-4 animate-spin" />}
                {form.id != null ? "Save changes" : "Create connection"}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={deleteTarget != null} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete storage connection?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget?.name} will be removed. Files already stored there are not deleted, but the workspace will
              stop using this connection. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={remove} className="bg-destructive text-destructive-foreground">
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  )
}
