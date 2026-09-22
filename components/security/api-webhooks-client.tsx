"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { KeyRound, Plus, Loader2, Trash2, Webhook, Send, ChevronDown, ChevronUp, Copy, Check, History } from "lucide-react"
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import type { PublicApiKey, ApiKeyEnvironment, ApiKeyEventRow } from "@/lib/api-keys-store"
import type { PublicWebhookEndpoint, WebhookDeliveryRow } from "@/lib/webhooks-store"

type ScopeOption = { value: string; label: string }
type EventOption = { value: string; label: string }
type EnvOption = { value: ApiKeyEnvironment; label: string }

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

function deliveryStatusBadge(status: string) {
  if (status === "success") return <Badge className="border-transparent bg-emerald-600 text-white">Success</Badge>
  if (status === "failed") return <Badge variant="destructive">Failed</Badge>
  return <Badge variant="secondary">Pending</Badge>
}

// ---------------------------------------------------------------------------
// API keys
// ---------------------------------------------------------------------------

const EVENT_LABELS: Record<string, string> = {
  created: "Created",
  revoked: "Revoked",
  deleted: "Deleted",
  authenticated: "Authenticated",
  auth_failed: "Auth failed",
}

function eventBadge(event: string) {
  if (event === "auth_failed") return <Badge variant="destructive">{EVENT_LABELS[event]}</Badge>
  if (event === "revoked" || event === "deleted") return <Badge variant="secondary">{EVENT_LABELS[event] ?? event}</Badge>
  if (event === "created") return <Badge className="border-transparent bg-emerald-600 text-white">Created</Badge>
  return <Badge variant="outline">{EVENT_LABELS[event] ?? event}</Badge>
}

function ApiKeyAuditTrail({ refreshToken }: { refreshToken: number }) {
  const [events, setEvents] = useState<ApiKeyEventRow[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [open, setOpen] = useState(false)

  async function load() {
    setLoading(true)
    try {
      const res = await fetch("/api/admin/security/api-keys/audit")
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

  // Reload whenever a key mutation bumps the token and the panel is open.
  if (open && refreshToken > 0 && events === null && !loading) void load()

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3">
        <div>
          <CardTitle className="text-base">Key audit trail</CardTitle>
          <CardDescription>Every issuance, revocation, and authentication attempt across this tenant&apos;s keys.</CardDescription>
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
            <p className="text-sm text-muted-foreground">No key activity recorded yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Event</TableHead>
                    <TableHead>Key</TableHead>
                    <TableHead>IP</TableHead>
                    <TableHead>Detail</TableHead>
                    <TableHead>When</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {events.map((e) => (
                    <TableRow key={e.id}>
                      <TableCell>{eventBadge(e.event)}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">#{e.key_id ?? "—"}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">{e.ip ?? "—"}</TableCell>
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

function ApiKeysSection({
  initialKeys,
  scopeOptions,
  envOptions,
}: {
  initialKeys: PublicApiKey[]
  scopeOptions: readonly ScopeOption[]
  envOptions: readonly EnvOption[]
}) {
  const router = useRouter()
  const [keys, setKeys] = useState(initialKeys)
  const [open, setOpen] = useState(false)
  const [name, setName] = useState("")
  const [scopes, setScopes] = useState<string[]>([])
  const [environment, setEnvironment] = useState<ApiKeyEnvironment>("live")
  const [ipText, setIpText] = useState("")
  const [expiresAt, setExpiresAt] = useState("")
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [revealed, setRevealed] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<number | null>(null)
  const [auditToken, setAuditToken] = useState(0)

  function toggleScope(value: string) {
    setScopes((prev) => (prev.includes(value) ? prev.filter((s) => s !== value) : [...prev, value]))
  }

  function resetForm() {
    setName("")
    setScopes([])
    setEnvironment("live")
    setIpText("")
    setExpiresAt("")
  }

  async function createKey() {
    setSaving(true)
    setError(null)
    try {
      const ipRestrictions = ipText
        .split(/[\n,]+/)
        .map((s) => s.trim())
        .filter(Boolean)
      const res = await fetch("/api/admin/security/api-keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          scopes,
          environment,
          ipRestrictions,
          expiresAt: expiresAt || null,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || "Failed to create key")
      setKeys((prev) => [data.key, ...prev])
      setRevealed(data.plaintext)
      resetForm()
      setAuditToken((t) => t + 1)
      router.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create key")
    } finally {
      setSaving(false)
    }
  }

  async function revoke(key: PublicApiKey) {
    setBusyId(key.id)
    try {
      const res = await fetch(`/api/admin/security/api-keys/${key.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "revoke" }),
      })
      if (!res.ok) throw new Error("Failed to revoke")
      setKeys((prev) => prev.map((k) => (k.id === key.id ? { ...k, status: "revoked" } : k)))
      setAuditToken((t) => t + 1)
    } finally {
      setBusyId(null)
    }
  }

  async function remove(key: PublicApiKey) {
    setBusyId(key.id)
    try {
      const res = await fetch(`/api/admin/security/api-keys/${key.id}`, { method: "DELETE" })
      if (!res.ok) throw new Error("Failed to delete")
      setKeys((prev) => prev.filter((k) => k.id !== key.id))
      setAuditToken((t) => t + 1)
    } finally {
      setBusyId(null)
    }
  }

  function isExpired(k: PublicApiKey): boolean {
    return Boolean(k.expires_at && new Date(k.expires_at).getTime() < Date.now())
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-3">
          <div>
            <CardTitle className="text-base">API keys</CardTitle>
            <CardDescription>Bearer keys for the public /api/v1 surface, scoped to what each key may do.</CardDescription>
          </div>
          <Dialog
            open={open}
            onOpenChange={(v) => {
              setOpen(v)
              if (!v) {
                setRevealed(null)
                setError(null)
              }
            }}
          >
            <DialogTrigger asChild>
              <Button className="gap-1.5" size="sm">
                <Plus className="size-4" /> New key
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-md">
              <DialogHeader>
                <DialogTitle>{revealed ? "Key created" : "Create API key"}</DialogTitle>
              </DialogHeader>
              {revealed ? (
                <div className="space-y-3">
                  <p className="text-sm text-muted-foreground">
                    Copy this key now — it will not be shown again. Store it somewhere safe.
                  </p>
                  <CopyableSecret value={revealed} />
                </div>
              ) : (
                <div className="space-y-4">
                  {error && <p className="text-sm text-destructive">{error}</p>}
                  <div className="grid gap-2">
                    <Label>Key name</Label>
                    <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Zapier integration" />
                  </div>
                  <div className="grid gap-2">
                    <Label>Environment</Label>
                    <Select value={environment} onValueChange={(v) => setEnvironment(v as ApiKeyEnvironment)}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {envOptions.map((e) => (
                          <SelectItem key={e.value} value={e.value}>
                            {e.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="grid gap-2">
                    <Label>Scopes</Label>
                    {scopeOptions.map((s) => (
                      <label key={s.value} className="flex items-center gap-2 text-sm">
                        <Checkbox checked={scopes.includes(s.value)} onCheckedChange={() => toggleScope(s.value)} />
                        {s.label}
                      </label>
                    ))}
                  </div>
                  <div className="grid gap-2">
                    <Label>IP restrictions (optional)</Label>
                    <Textarea
                      value={ipText}
                      onChange={(e) => setIpText(e.target.value)}
                      placeholder={"203.0.113.10\n198.51.100.0/24"}
                      rows={2}
                    />
                    <p className="text-xs text-muted-foreground">
                      One CIDR range or IP per line. Leave empty to allow any source IP.
                    </p>
                  </div>
                  <div className="grid gap-2">
                    <Label>Expiration (optional)</Label>
                    <Input type="date" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} />
                  </div>
                </div>
              )}
              <DialogFooter>
                {revealed ? (
                  <Button
                    onClick={() => {
                      setOpen(false)
                      setRevealed(null)
                    }}
                  >
                    Done
                  </Button>
                ) : (
                  <>
                    <Button variant="outline" onClick={() => setOpen(false)} disabled={saving}>
                      Cancel
                    </Button>
                    <Button onClick={createKey} disabled={saving || !name.trim() || scopes.length === 0}>
                      {saving && <Loader2 className="size-4 animate-spin" />} Create key
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
                  <TableHead>Key</TableHead>
                  <TableHead>Env</TableHead>
                  <TableHead>Scopes</TableHead>
                  <TableHead>IPs</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Expires</TableHead>
                  <TableHead>Last used</TableHead>
                  <TableHead>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {keys.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={9} className="p-0">
                      <EmptyState icon={<KeyRound className="size-5" />} title="No API keys yet">
                        Create a key to let integrations call the /api/v1 surface.
                      </EmptyState>
                    </TableCell>
                  </TableRow>
                ) : (
                  keys.map((k) => {
                    const ipCount = (k.ip_restrictions ?? "").split(",").map((s) => s.trim()).filter(Boolean).length
                    const expired = isExpired(k)
                    return (
                      <TableRow key={k.id}>
                        <TableCell className="text-sm font-medium">{k.name}</TableCell>
                        <TableCell>
                          <code className="text-xs text-muted-foreground">mn_{k.key_prefix}…</code>
                        </TableCell>
                        <TableCell>
                          <Badge variant={k.environment === "live" ? "default" : "outline"}>{k.environment}</Badge>
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">{k.scopes.split(",").join(", ")}</TableCell>
                        <TableCell className="text-xs text-muted-foreground" title={k.ip_restrictions || "Any IP"}>
                          {ipCount === 0 ? "Any" : `${ipCount} range${ipCount === 1 ? "" : "s"}`}
                        </TableCell>
                        <TableCell>
                          {k.status !== "active" ? (
                            <Badge variant="secondary">Revoked</Badge>
                          ) : expired ? (
                            <Badge variant="destructive">Expired</Badge>
                          ) : (
                            <Badge className="border-transparent bg-emerald-600 text-white">Active</Badge>
                          )}
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {k.expires_at ? new Date(k.expires_at).toLocaleDateString() : "Never"}
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {k.last_used_at ? new Date(k.last_used_at).toLocaleString() : "Never"}
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-1.5">
                            {k.status === "active" && (
                              <Button variant="outline" size="sm" onClick={() => revoke(k)} disabled={busyId === k.id}>
                                Revoke
                              </Button>
                            )}
                            <Button variant="ghost" size="sm" onClick={() => remove(k)} disabled={busyId === k.id}>
                              <Trash2 className="size-3.5 text-destructive" />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    )
                  })
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <ApiKeyAuditTrail refreshToken={auditToken} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

function DeliveriesRow({ endpointId }: { endpointId: number }) {
  const [deliveries, setDeliveries] = useState<WebhookDeliveryRow[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [retryingId, setRetryingId] = useState<number | null>(null)

  useState(() => {
    fetch(`/api/admin/security/webhooks/${endpointId}/deliveries`)
      .then((r) => r.json())
      .then((data) => setDeliveries(data.deliveries ?? []))
      .finally(() => setLoading(false))
  })

  async function retry(deliveryId: number) {
    setRetryingId(deliveryId)
    try {
      const res = await fetch(`/api/admin/security/webhooks/${endpointId}/deliveries`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deliveryId }),
      })
      const data = await res.json()
      if (data.delivery) {
        setDeliveries((prev) => prev?.map((d) => (d.id === deliveryId ? data.delivery : d)) ?? prev)
      }
    } finally {
      setRetryingId(null)
    }
  }

  if (loading) return <p className="p-3 text-sm text-muted-foreground">Loading deliveries…</p>
  if (!deliveries || deliveries.length === 0) return <p className="p-3 text-sm text-muted-foreground">No deliveries yet.</p>

  return (
    <div className="space-y-1.5 p-3">
      {deliveries.map((d) => (
        <div key={d.id} className="flex items-center justify-between gap-3 rounded-md border p-2 text-xs">
          <div className="flex items-center gap-2">
            {deliveryStatusBadge(d.status)}
            <span className="font-medium">{d.event_type}</span>
            <span className="text-muted-foreground">
              {d.response_code ? `HTTP ${d.response_code}` : ""} · {d.attempts} attempt{d.attempts === 1 ? "" : "s"}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground">{new Date(d.created_at).toLocaleString()}</span>
            {d.status !== "success" && (
              <Button variant="outline" size="sm" onClick={() => retry(d.id)} disabled={retryingId === d.id}>
                {retryingId === d.id ? <Loader2 className="size-3 animate-spin" /> : "Retry"}
              </Button>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}

function WebhooksSection({
  initialEndpoints,
  eventOptions,
}: {
  initialEndpoints: PublicWebhookEndpoint[]
  eventOptions: readonly EventOption[]
}) {
  const router = useRouter()
  const [endpoints, setEndpoints] = useState(initialEndpoints)
  const [open, setOpen] = useState(false)
  const [url, setUrl] = useState("")
  const [description, setDescription] = useState("")
  const [events, setEvents] = useState<string[]>([])
  const [headerRows, setHeaderRows] = useState<{ key: string; value: string }[]>([])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [revealed, setRevealed] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<number | null>(null)
  const [expandedId, setExpandedId] = useState<number | null>(null)
  const [testMessages, setTestMessages] = useState<Record<number, string>>({})

  function toggleEvent(value: string) {
    setEvents((prev) => (prev.includes(value) ? prev.filter((e) => e !== value) : [...prev, value]))
  }

  function updateHeaderRow(index: number, field: "key" | "value", value: string) {
    setHeaderRows((prev) => prev.map((row, i) => (i === index ? { ...row, [field]: value } : row)))
  }

  function addHeaderRow() {
    setHeaderRows((prev) => [...prev, { key: "", value: "" }])
  }

  function removeHeaderRow(index: number) {
    setHeaderRows((prev) => prev.filter((_, i) => i !== index))
  }

  function collectHeaders(): Record<string, string> {
    const out: Record<string, string> = {}
    for (const row of headerRows) {
      const key = row.key.trim()
      if (key) out[key] = row.value
    }
    return out
  }

  async function createEndpoint() {
    setSaving(true)
    setError(null)
    try {
      const res = await fetch("/api/admin/security/webhooks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, description, events, headers: collectHeaders() }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || "Failed to create endpoint")
      setEndpoints((prev) => [data.endpoint, ...prev])
      setRevealed(data.secret)
      setUrl("")
      setDescription("")
      setEvents([])
      setHeaderRows([])
      router.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create endpoint")
    } finally {
      setSaving(false)
    }
  }

  async function toggleStatus(e: PublicWebhookEndpoint) {
    setBusyId(e.id)
    try {
      const nextStatus = e.status === "active" ? "disabled" : "active"
      const res = await fetch(`/api/admin/security/webhooks/${e.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: nextStatus }),
      })
      if (!res.ok) throw new Error("Failed to update")
      setEndpoints((prev) => prev.map((x) => (x.id === e.id ? { ...x, status: nextStatus } : x)))
    } finally {
      setBusyId(null)
    }
  }

  async function sendTest(e: PublicWebhookEndpoint) {
    setBusyId(e.id)
    try {
      const res = await fetch(`/api/admin/security/webhooks/${e.id}/test`, { method: "POST" })
      const data = await res.json()
      setTestMessages((prev) => ({
        ...prev,
        [e.id]: data.delivery?.status === "success" ? "Test delivered successfully" : "Test failed — check deliveries",
      }))
      setExpandedId(e.id)
    } finally {
      setBusyId(null)
    }
  }

  async function remove(e: PublicWebhookEndpoint) {
    setBusyId(e.id)
    try {
      const res = await fetch(`/api/admin/security/webhooks/${e.id}`, { method: "DELETE" })
      if (!res.ok) throw new Error("Failed to delete")
      setEndpoints((prev) => prev.filter((x) => x.id !== e.id))
    } finally {
      setBusyId(null)
    }
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3">
        <div>
          <CardTitle className="text-base">Webhook endpoints</CardTitle>
          <CardDescription>Subscribe an endpoint to business events; deliveries are signed and retried on failure.</CardDescription>
        </div>
        <Dialog
          open={open}
          onOpenChange={(v) => {
            setOpen(v)
            if (!v) setRevealed(null)
          }}
        >
          <DialogTrigger asChild>
            <Button className="gap-1.5" size="sm">
              <Plus className="size-4" /> New endpoint
            </Button>
          </DialogTrigger>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>{revealed ? "Endpoint created" : "Create webhook endpoint"}</DialogTitle>
            </DialogHeader>
            {revealed ? (
              <div className="space-y-3">
                <p className="text-sm text-muted-foreground">
                  Copy this signing secret now — it will not be shown again. Use it to verify the{" "}
                  <code className="rounded bg-muted px-1">X-Webhook-Signature</code> header.
                </p>
                <CopyableSecret value={revealed} />
              </div>
            ) : (
              <div className="space-y-4">
                {error && <p className="text-sm text-destructive">{error}</p>}
                <div className="grid gap-2">
                  <Label>Endpoint URL</Label>
                  <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/webhooks/muenot" />
                </div>
                <div className="grid gap-2">
                  <Label>Description (optional)</Label>
                  <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Sync clients to CRM" />
                </div>
                <div className="grid gap-2">
                  <Label>Events</Label>
                  {eventOptions.map((ev) => (
                    <label key={ev.value} className="flex items-center gap-2 text-sm">
                      <Checkbox checked={events.includes(ev.value)} onCheckedChange={() => toggleEvent(ev.value)} />
                      {ev.label}
                    </label>
                  ))}
                </div>
                <div className="grid gap-2">
                  <Label>Custom headers (optional)</Label>
                  {headerRows.map((row, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <Input
                        value={row.key}
                        onChange={(e) => updateHeaderRow(i, "key", e.target.value)}
                        placeholder="X-Api-Key"
                        aria-label="Header name"
                        className="flex-1"
                      />
                      <Input
                        value={row.value}
                        onChange={(e) => updateHeaderRow(i, "value", e.target.value)}
                        placeholder="value"
                        aria-label="Header value"
                        className="flex-1"
                      />
                      <Button variant="ghost" size="sm" onClick={() => removeHeaderRow(i)} aria-label="Remove header">
                        <Trash2 className="size-3.5 text-destructive" />
                      </Button>
                    </div>
                  ))}
                  <Button variant="outline" size="sm" className="gap-1.5 justify-self-start" onClick={addHeaderRow}>
                    <Plus className="size-3.5" /> Add header
                  </Button>
                  <p className="text-xs text-muted-foreground">
                    Sent with every delivery to this endpoint. Signature headers cannot be overridden.
                  </p>
                </div>
              </div>
            )}
            <DialogFooter>
              {revealed ? (
                <Button
                  onClick={() => {
                    setOpen(false)
                    setRevealed(null)
                  }}
                >
                  Done
                </Button>
              ) : (
                <>
                  <Button variant="outline" onClick={() => setOpen(false)} disabled={saving}>
                    Cancel
                  </Button>
                  <Button onClick={createEndpoint} disabled={saving || !url.trim() || events.length === 0}>
                    {saving && <Loader2 className="size-4 animate-spin" />} Create endpoint
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
                <TableHead>Endpoint</TableHead>
                <TableHead>Events</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Last delivery</TableHead>
                <TableHead>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {endpoints.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="p-0">
                    <EmptyState icon={<Webhook className="size-5" />} title="No webhook endpoints configured">
                      Add an endpoint to receive events like client.created in real time.
                    </EmptyState>
                  </TableCell>
                </TableRow>
              ) : (
                endpoints.map((e) => (
                  <>
                    <TableRow key={e.id}>
                      <TableCell>
                        <div className="flex flex-col">
                          <span className="max-w-[220px] truncate text-sm font-medium">{e.url}</span>
                          {e.description && <span className="text-xs text-muted-foreground">{e.description}</span>}
                          {testMessages[e.id] && <span className="text-xs text-muted-foreground">{testMessages[e.id]}</span>}
                        </div>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">{e.events.split(",").join(", ")}</TableCell>
                      <TableCell>
                        {e.status === "active" ? (
                          <Badge className="border-transparent bg-emerald-600 text-white">Active</Badge>
                        ) : (
                          <Badge variant="secondary">Disabled</Badge>
                        )}
                        {e.failure_count > 0 && (
                          <Badge variant="destructive" className="ml-1">
                            {e.failure_count} failing
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {e.last_delivery_at ? new Date(e.last_delivery_at).toLocaleString() : "Never"}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1.5">
                          <Button variant="outline" size="sm" onClick={() => sendTest(e)} disabled={busyId === e.id}>
                            <Send className="size-3.5" />
                          </Button>
                          <Button variant="outline" size="sm" onClick={() => toggleStatus(e)} disabled={busyId === e.id}>
                            {e.status === "active" ? "Disable" : "Enable"}
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => setExpandedId(expandedId === e.id ? null : e.id)}
                          >
                            {expandedId === e.id ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
                          </Button>
                          <Button variant="ghost" size="sm" onClick={() => remove(e)} disabled={busyId === e.id}>
                            <Trash2 className="size-3.5 text-destructive" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                    {expandedId === e.id && (
                      <TableRow key={`${e.id}-deliveries`}>
                        <TableCell colSpan={5} className="bg-muted/30 p-0">
                          <DeliveriesRow endpointId={e.id} />
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
  )
}

export function ApiWebhooksClient({
  initialKeys,
  scopeOptions,
  envOptions,
  initialEndpoints,
  eventOptions,
}: {
  initialKeys: PublicApiKey[]
  scopeOptions: readonly ScopeOption[]
  envOptions: readonly EnvOption[]
  initialEndpoints: PublicWebhookEndpoint[]
  eventOptions: readonly EventOption[]
}) {
  return (
    <div className="space-y-6">
      <ApiKeysSection initialKeys={initialKeys} scopeOptions={scopeOptions} envOptions={envOptions} />
      <WebhooksSection initialEndpoints={initialEndpoints} eventOptions={eventOptions} />
    </div>
  )
}
