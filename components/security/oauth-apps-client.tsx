"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import {
  AppWindow,
  Plus,
  Loader2,
  Trash2,
  RotateCcw,
  Copy,
  Check,
  ChevronDown,
  ChevronUp,
  History,
  ShieldOff,
} from "lucide-react"
import { EmptyState } from "@/components/security/security-ui"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogTrigger } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Checkbox } from "@/components/ui/checkbox"
import { Textarea } from "@/components/ui/textarea"
import type { PublicOAuthApp, PublicOAuthToken, OAuthEventRow } from "@/lib/oauth/oauth-apps-store"

type ScopeOption = { value: string; label: string }
type TokenTtl = { default: number; min: number; max: number }
type RotationGrace = { default: number; max: number }

function CopyableSecret({ value }: { value: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="flex items-center gap-2 rounded-md border bg-muted/50 p-2">
      <code className="flex-1 overflow-x-auto whitespace-nowrap text-xs">{value}</code>
      <Button
        variant="outline"
        size="sm"
        onClick={() => {
          navigator.clipboard.writeText(value).catch(() => {})
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        }}
      >
        {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      </Button>
    </div>
  )
}

const EVENT_LABELS: Record<string, string> = {
  created: "Created",
  secret_rotated: "Secret rotated",
  scopes_updated: "Scopes updated",
  revoked: "Revoked",
  deleted: "Deleted",
  token_issued: "Token issued",
  token_revoked: "Token revoked",
  token_denied: "Token denied",
}

function eventBadge(event: string) {
  if (event === "token_denied" || event === "revoked" || event === "token_revoked") {
    return <Badge variant="destructive">{EVENT_LABELS[event] ?? event}</Badge>
  }
  if (event === "created" || event === "token_issued") {
    return <Badge className="border-transparent bg-emerald-600 text-white">{EVENT_LABELS[event] ?? event}</Badge>
  }
  if (event === "deleted") return <Badge variant="secondary">{EVENT_LABELS[event] ?? event}</Badge>
  return <Badge variant="outline">{EVENT_LABELS[event] ?? event}</Badge>
}

function OAuthEventTrail({ refreshToken }: { refreshToken: number }) {
  const [events, setEvents] = useState<OAuthEventRow[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [open, setOpen] = useState(false)

  async function load() {
    setLoading(true)
    try {
      const res = await fetch("/api/admin/security/oauth-apps/events")
      const data = await res.json()
      setEvents(data.events ?? [])
    } finally {
      setLoading(false)
    }
  }

  function toggle() {
    const next = !open
    setOpen(next)
    if (next) void load()
  }

  if (open && refreshToken > 0 && events === null && !loading) void load()

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3">
        <div>
          <CardTitle className="text-base">OAuth audit trail</CardTitle>
          <CardDescription>
            Every registration, secret rotation, scope change, revocation and token issuance across this tenant.
          </CardDescription>
        </div>
        <Button variant="outline" size="sm" className="gap-1.5" onClick={toggle}>
          <History className="size-4" /> {open ? "Hide" : "Show"} activity
        </Button>
      </CardHeader>
      {open && (
        <CardContent>
          {loading ? (
            <p className="text-sm text-muted-foreground">Loading activity…</p>
          ) : !events || events.length === 0 ? (
            <p className="text-sm text-muted-foreground">No OAuth activity recorded yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Event</TableHead>
                    <TableHead>App</TableHead>
                    <TableHead>Detail</TableHead>
                    <TableHead>When</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {events.map((e) => (
                    <TableRow key={e.id}>
                      <TableCell>{eventBadge(e.event)}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">#{e.app_id ?? "—"}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">{e.detail ?? "—"}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {new Date(e.created_at).toLocaleString()}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      )}
    </Card>
  )
}

function TokensRow({ appId }: { appId: number }) {
  const [tokens, setTokens] = useState<PublicOAuthToken[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState<number | null>(null)

  useState(() => {
    fetch(`/api/admin/security/oauth-apps/${appId}/tokens`)
      .then((r) => r.json())
      .then((data) => setTokens(data.tokens ?? []))
      .finally(() => setLoading(false))
  })

  async function revoke(tokenId: number) {
    setBusyId(tokenId)
    try {
      const res = await fetch(`/api/admin/security/oauth-apps/${appId}/tokens/${tokenId}`, { method: "DELETE" })
      if (res.ok) {
        setTokens((prev) =>
          prev?.map((t) => (t.id === tokenId ? { ...t, active: false, revoked_at: new Date().toISOString() } : t)) ??
          prev,
        )
      }
    } finally {
      setBusyId(null)
    }
  }

  if (loading) return <p className="p-3 text-sm text-muted-foreground">Loading tokens…</p>
  if (!tokens || tokens.length === 0) return <p className="p-3 text-sm text-muted-foreground">No tokens issued yet.</p>

  return (
    <div className="space-y-1.5 p-3">
      {tokens.map((t) => (
        <div key={t.id} className="flex items-center justify-between gap-3 rounded-md border p-2 text-xs">
          <div className="flex items-center gap-2">
            {t.active ? (
              <Badge className="border-transparent bg-emerald-600 text-white">Active</Badge>
            ) : t.revoked_at ? (
              <Badge variant="destructive">Revoked</Badge>
            ) : (
              <Badge variant="secondary">Expired</Badge>
            )}
            <code className="text-muted-foreground">{t.token_prefix}…</code>
            <span className="text-muted-foreground">{t.scopeList.join(", ") || "no scopes"}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground">expires {new Date(t.expires_at).toLocaleString()}</span>
            {t.active && (
              <Button variant="outline" size="sm" onClick={() => revoke(t.id)} disabled={busyId === t.id}>
                {busyId === t.id ? <Loader2 className="size-3 animate-spin" /> : "Revoke"}
              </Button>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}

export function OAuthAppsClient({
  initialApps,
  scopeOptions,
  tokenTtl,
  rotationGrace,
}: {
  initialApps: PublicOAuthApp[]
  scopeOptions: readonly ScopeOption[]
  tokenTtl: TokenTtl
  rotationGrace: RotationGrace
}) {
  const router = useRouter()
  const [apps, setApps] = useState(initialApps)
  const [open, setOpen] = useState(false)
  const [name, setName] = useState("")
  const [description, setDescription] = useState("")
  const [scopes, setScopes] = useState<string[]>([])
  const [ttlHours, setTtlHours] = useState(String(Math.round(tokenTtl.default / 3600)))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [created, setCreated] = useState<{ clientId: string; clientSecret: string } | null>(null)
  const [busyId, setBusyId] = useState<number | null>(null)
  const [expandedId, setExpandedId] = useState<number | null>(null)
  const [rotated, setRotated] = useState<{ appId: number; clientSecret: string; graceSeconds: number } | null>(null)
  const [auditToken, setAuditToken] = useState(0)

  function toggleScope(value: string) {
    setScopes((prev) => (prev.includes(value) ? prev.filter((s) => s !== value) : [...prev, value]))
  }

  function resetForm() {
    setName("")
    setDescription("")
    setScopes([])
    setTtlHours(String(Math.round(tokenTtl.default / 3600)))
  }

  async function createApp() {
    setSaving(true)
    setError(null)
    try {
      const hours = Number(ttlHours)
      const tokenTtlSeconds = Number.isFinite(hours) && hours > 0 ? Math.round(hours * 3600) : undefined
      const res = await fetch("/api/admin/security/oauth-apps", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, description, scopes, tokenTtlSeconds }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || "Failed to create app")
      setApps((prev) => [data.app, ...prev])
      setCreated({ clientId: data.app.client_id, clientSecret: data.clientSecret })
      resetForm()
      setAuditToken((t) => t + 1)
      router.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create app")
    } finally {
      setSaving(false)
    }
  }

  async function rotate(app: PublicOAuthApp) {
    setBusyId(app.id)
    try {
      const res = await fetch(`/api/admin/security/oauth-apps/${app.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "rotate", graceSeconds: rotationGrace.default }),
      })
      const data = await res.json()
      if (res.ok) {
        setRotated({ appId: app.id, clientSecret: data.clientSecret, graceSeconds: data.graceSeconds })
        setApps((prev) => prev.map((a) => (a.id === app.id ? { ...a, secretRotating: data.graceSeconds > 0 } : a)))
        setAuditToken((t) => t + 1)
      }
    } finally {
      setBusyId(null)
    }
  }

  async function revoke(app: PublicOAuthApp) {
    setBusyId(app.id)
    try {
      const res = await fetch(`/api/admin/security/oauth-apps/${app.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "revoke" }),
      })
      if (res.ok) {
        setApps((prev) => prev.map((a) => (a.id === app.id ? { ...a, status: "revoked" } : a)))
        setAuditToken((t) => t + 1)
      }
    } finally {
      setBusyId(null)
    }
  }

  async function remove(app: PublicOAuthApp) {
    setBusyId(app.id)
    try {
      const res = await fetch(`/api/admin/security/oauth-apps/${app.id}`, { method: "DELETE" })
      if (res.ok) {
        setApps((prev) => prev.filter((a) => a.id !== app.id))
        setAuditToken((t) => t + 1)
      }
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-3">
          <div>
            <CardTitle className="text-base">OAuth applications</CardTitle>
            <CardDescription>
              Register a machine-to-machine app to obtain tokens via the client-credentials grant at{" "}
              <code className="rounded bg-muted px-1">/api/v1/oauth/token</code>. Tokens are least-privilege — never
              broader than the scopes you consent to here.
            </CardDescription>
          </div>
          <Dialog
            open={open}
            onOpenChange={(v) => {
              setOpen(v)
              if (!v) {
                setCreated(null)
                setError(null)
              }
            }}
          >
            <DialogTrigger asChild>
              <Button className="gap-1.5" size="sm">
                <Plus className="size-4" /> Register app
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-md">
              <DialogHeader>
                <DialogTitle>{created ? "App registered" : "Register OAuth app"}</DialogTitle>
              </DialogHeader>
              {created ? (
                <div className="space-y-3">
                  <div className="grid gap-1.5">
                    <Label className="text-xs">Client ID</Label>
                    <CopyableSecret value={created.clientId} />
                  </div>
                  <div className="grid gap-1.5">
                    <Label className="text-xs">Client secret</Label>
                    <CopyableSecret value={created.clientSecret} />
                  </div>
                  <p className="text-sm text-muted-foreground">
                    Copy the client secret now — it is shown once and only a hash is stored. Rotate it any time from the
                    app list.
                  </p>
                </div>
              ) : (
                <div className="space-y-4">
                  {error && <p className="text-sm text-destructive">{error}</p>}
                  <div className="grid gap-2">
                    <Label>App name</Label>
                    <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Warehouse sync" />
                  </div>
                  <div className="grid gap-2">
                    <Label>Description (optional)</Label>
                    <Input
                      value={description}
                      onChange={(e) => setDescription(e.target.value)}
                      placeholder="Nightly inventory reconciliation"
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label>Consented scopes</Label>
                    <p className="text-xs text-muted-foreground">
                      Grant the minimum required. A token can request a subset, never more than these.
                    </p>
                    {scopeOptions.map((s) => (
                      <label key={s.value} className="flex items-center gap-2 text-sm">
                        <Checkbox checked={scopes.includes(s.value)} onCheckedChange={() => toggleScope(s.value)} />
                        {s.label}
                      </label>
                    ))}
                  </div>
                  <div className="grid gap-2">
                    <Label>Access token lifetime (hours)</Label>
                    <Input
                      type="number"
                      min={Math.max(1, Math.round(tokenTtl.min / 3600))}
                      max={Math.round(tokenTtl.max / 3600)}
                      value={ttlHours}
                      onChange={(e) => setTtlHours(e.target.value)}
                    />
                    <p className="text-xs text-muted-foreground">
                      Between {Math.max(1, Math.round(tokenTtl.min / 3600))} and {Math.round(tokenTtl.max / 3600)} hours.
                    </p>
                  </div>
                </div>
              )}
              <DialogFooter>
                {created ? (
                  <Button
                    onClick={() => {
                      setOpen(false)
                      setCreated(null)
                    }}
                  >
                    Done
                  </Button>
                ) : (
                  <>
                    <Button variant="outline" onClick={() => setOpen(false)} disabled={saving}>
                      Cancel
                    </Button>
                    <Button onClick={createApp} disabled={saving || !name.trim() || scopes.length === 0}>
                      {saving && <Loader2 className="size-4 animate-spin" />} Register app
                    </Button>
                  </>
                )}
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Client ID</TableHead>
                  <TableHead>Scopes</TableHead>
                  <TableHead>Token TTL</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {apps.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} className="p-0">
                      <EmptyState icon={<AppWindow className="size-5" />} title="No OAuth apps yet">
                        Register an app to issue revocable client credentials for the /api/v1 surface.
                      </EmptyState>
                    </TableCell>
                  </TableRow>
                ) : (
                  apps.map((a) => (
                    <>
                      <TableRow key={a.id}>
                        <TableCell>
                          <div className="flex flex-col">
                            <span className="text-sm font-medium">{a.name}</span>
                            {a.description && <span className="text-xs text-muted-foreground">{a.description}</span>}
                          </div>
                        </TableCell>
                        <TableCell>
                          <code className="text-xs text-muted-foreground">{a.client_id}</code>
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {a.scopeList.join(", ") || "none"}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {Math.round(a.token_ttl_seconds / 60)} min
                        </TableCell>
                        <TableCell>
                          {a.status === "active" ? (
                            <Badge className="border-transparent bg-emerald-600 text-white">Active</Badge>
                          ) : (
                            <Badge variant="secondary">Revoked</Badge>
                          )}
                          {a.secretRotating && (
                            <Badge variant="outline" className="ml-1">
                              Rotating
                            </Badge>
                          )}
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-1.5">
                            {a.status === "active" && (
                              <Button
                                variant="outline"
                                size="sm"
                                className="gap-1"
                                onClick={() => rotate(a)}
                                disabled={busyId === a.id}
                                title="Rotate client secret"
                              >
                                <RotateCcw className="size-3.5" /> Rotate
                              </Button>
                            )}
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => setExpandedId(expandedId === a.id ? null : a.id)}
                            >
                              {expandedId === a.id ? (
                                <ChevronUp className="size-3.5" />
                              ) : (
                                <ChevronDown className="size-3.5" />
                              )}
                            </Button>
                            {a.status === "active" && (
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => revoke(a)}
                                disabled={busyId === a.id}
                                title="Revoke app and all its tokens"
                              >
                                <ShieldOff className="size-3.5" />
                              </Button>
                            )}
                            <Button variant="ghost" size="sm" onClick={() => remove(a)} disabled={busyId === a.id}>
                              <Trash2 className="size-3.5 text-destructive" />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                      {rotated?.appId === a.id && (
                        <TableRow key={`${a.id}-rotated`}>
                          <TableCell colSpan={6} className="bg-muted/30">
                            <div className="space-y-2 p-1">
                              <p className="text-xs text-muted-foreground">
                                New client secret — copy it now.{" "}
                                {rotated.graceSeconds > 0
                                  ? `The previous secret keeps working for ${Math.round(
                                      rotated.graceSeconds / 60,
                                    )} more minutes.`
                                  : "The previous secret is invalid immediately."}
                              </p>
                              <CopyableSecret value={rotated.clientSecret} />
                              <Button variant="outline" size="sm" onClick={() => setRotated(null)}>
                                Dismiss
                              </Button>
                            </div>
                          </TableCell>
                        </TableRow>
                      )}
                      {expandedId === a.id && (
                        <TableRow key={`${a.id}-tokens`}>
                          <TableCell colSpan={6} className="bg-muted/30 p-0">
                            <TokensRow appId={a.id} />
                          </TableCell>
                        </TableRow>
                      )}
                    </>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <OAuthEventTrail refreshToken={auditToken} />
    </div>
  )
}
