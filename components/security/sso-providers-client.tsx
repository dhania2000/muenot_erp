"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { KeyRound, Plus, Loader2, Trash2, FlaskConical } from "lucide-react"
import { EmptyState } from "@/components/security/security-ui"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogTrigger } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import type { PublicSsoProvider } from "@/lib/sso-store"

type FormState = {
  type: "oidc" | "saml"
  name: string
  domains: string
  autoProvision: boolean
  defaultRole: "admin" | "employee"
  discoveryUrl: string
  clientId: string
  clientSecret: string
  scopes: string
  entityId: string
  ssoUrl: string
  certificate: string
}

const EMPTY_FORM: FormState = {
  type: "oidc",
  name: "",
  domains: "",
  autoProvision: true,
  defaultRole: "employee",
  discoveryUrl: "",
  clientId: "",
  clientSecret: "",
  scopes: "openid email profile",
  entityId: "",
  ssoUrl: "",
  certificate: "",
}

function statusBadge(status: string) {
  if (status === "enabled") return <Badge className="border-transparent bg-emerald-600 text-white">Enabled</Badge>
  if (status === "disabled") return <Badge variant="secondary">Disabled</Badge>
  return <Badge variant="outline">Draft</Badge>
}

export function SsoProvidersClient({
  initialProviders,
  callbackOrigin,
}: {
  initialProviders: PublicSsoProvider[]
  callbackOrigin: string
}) {
  const router = useRouter()
  const [providers, setProviders] = useState(initialProviders)
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<number | null>(null)
  const [testMessages, setTestMessages] = useState<Record<number, string>>({})

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }))
  }

  async function createProvider() {
    setSaving(true)
    setError(null)
    try {
      const res = await fetch("/api/admin/security/sso", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || "Failed to create provider")
      setOpen(false)
      setForm(EMPTY_FORM)
      router.refresh()
      const listRes = await fetch("/api/admin/security/sso")
      if (listRes.ok) setProviders((await listRes.json()).providers)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create provider")
    } finally {
      setSaving(false)
    }
  }

  async function toggleStatus(p: PublicSsoProvider) {
    setBusyId(p.id)
    try {
      const nextStatus = p.status === "enabled" ? "disabled" : "enabled"
      const res = await fetch(`/api/admin/security/sso/${p.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: nextStatus }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || "Failed to update provider")
      setProviders((prev) => prev.map((x) => (x.id === p.id ? data.provider : x)))
    } catch (err) {
      setTestMessages((prev) => ({ ...prev, [p.id]: err instanceof Error ? err.message : "Failed to update" }))
    } finally {
      setBusyId(null)
    }
  }

  async function testConnection(p: PublicSsoProvider) {
    setBusyId(p.id)
    try {
      const res = await fetch(`/api/admin/security/sso/${p.id}/test`, { method: "POST" })
      const data = await res.json()
      setTestMessages((prev) => ({ ...prev, [p.id]: data.message || (data.ok ? "OK" : "Failed") }))
      router.refresh()
    } catch {
      setTestMessages((prev) => ({ ...prev, [p.id]: "Test failed" }))
    } finally {
      setBusyId(null)
    }
  }

  async function remove(p: PublicSsoProvider) {
    setBusyId(p.id)
    try {
      const res = await fetch(`/api/admin/security/sso/${p.id}`, { method: "DELETE" })
      if (!res.ok) throw new Error("Failed to delete provider")
      setProviders((prev) => prev.filter((x) => x.id !== p.id))
    } catch (err) {
      setTestMessages((prev) => ({ ...prev, [p.id]: err instanceof Error ? err.message : "Failed to delete" }))
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          Callback URL for OIDC providers: <code className="rounded bg-muted px-1 py-0.5">{callbackOrigin}/api/auth/sso/&#123;id&#125;/callback</code>
        </p>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button className="gap-1.5">
              <Plus className="size-4" /> Add provider
            </Button>
          </DialogTrigger>
          <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto">
            <DialogHeader>
              <DialogTitle>Add identity provider</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              {error && <p className="text-sm text-destructive">{error}</p>}
              <div className="grid gap-2">
                <Label>Type</Label>
                <Select value={form.type} onValueChange={(v) => set("type", v as "oidc" | "saml")}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="oidc">Generic OIDC (Google, Okta, Entra ID)</SelectItem>
                    <SelectItem value="saml">SAML 2.0</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-2">
                <Label>Provider name</Label>
                <Input value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="Google Workspace" />
              </div>
              <div className="grid gap-2">
                <Label>Allowed domains (comma-separated, optional)</Label>
                <Input value={form.domains} onChange={(e) => set("domains", e.target.value)} placeholder="company.com" />
              </div>
              <div className="flex items-center justify-between rounded-md border p-3">
                <div>
                  <p className="text-sm font-medium">Auto-provision users</p>
                  <p className="text-xs text-muted-foreground">Create an account on first successful login</p>
                </div>
                <Switch checked={form.autoProvision} onCheckedChange={(v) => set("autoProvision", v)} />
              </div>
              <div className="grid gap-2">
                <Label>Default role for new users</Label>
                <Select value={form.defaultRole} onValueChange={(v) => set("defaultRole", v as "admin" | "employee")}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="employee">Employee</SelectItem>
                    <SelectItem value="admin">Admin</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {form.type === "oidc" ? (
                <>
                  <div className="grid gap-2">
                    <Label>Discovery URL</Label>
                    <Input
                      value={form.discoveryUrl}
                      onChange={(e) => set("discoveryUrl", e.target.value)}
                      placeholder="https://accounts.google.com/.well-known/openid-configuration"
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label>Client ID</Label>
                    <Input value={form.clientId} onChange={(e) => set("clientId", e.target.value)} />
                  </div>
                  <div className="grid gap-2">
                    <Label>Client secret</Label>
                    <Input type="password" value={form.clientSecret} onChange={(e) => set("clientSecret", e.target.value)} />
                  </div>
                  <div className="grid gap-2">
                    <Label>Scopes</Label>
                    <Input value={form.scopes} onChange={(e) => set("scopes", e.target.value)} />
                  </div>
                </>
              ) : (
                <>
                  <div className="grid gap-2">
                    <Label>Entity ID</Label>
                    <Input value={form.entityId} onChange={(e) => set("entityId", e.target.value)} />
                  </div>
                  <div className="grid gap-2">
                    <Label>SSO URL</Label>
                    <Input value={form.ssoUrl} onChange={(e) => set("ssoUrl", e.target.value)} />
                  </div>
                  <div className="grid gap-2">
                    <Label>X.509 certificate (PEM)</Label>
                    <Textarea rows={4} value={form.certificate} onChange={(e) => set("certificate", e.target.value)} />
                  </div>
                </>
              )}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setOpen(false)} disabled={saving}>Cancel</Button>
              <Button onClick={createProvider} disabled={saving || !form.name.trim()}>
                {saving && <Loader2 className="size-4 animate-spin" />} Save provider
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Configured providers</CardTitle>
          <CardDescription>provider · type · status · domains · last login · test</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Provider</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Domains</TableHead>
                  <TableHead>Last login</TableHead>
                  <TableHead>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {providers.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} className="p-0">
                      <EmptyState icon={<KeyRound className="size-5" />} title="No identity providers configured">
                        Add Google Workspace, Microsoft Entra ID, Okta, a generic OIDC provider, or SAML 2.0.
                      </EmptyState>
                    </TableCell>
                  </TableRow>
                ) : (
                  providers.map((p) => (
                    <TableRow key={p.id}>
                      <TableCell>
                        <div className="flex flex-col">
                          <span className="text-sm font-medium">{p.name}</span>
                          {testMessages[p.id] && (
                            <span className="text-xs text-muted-foreground">{testMessages[p.id]}</span>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="uppercase text-xs">{p.type}</TableCell>
                      <TableCell>{statusBadge(p.status)}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">{p.domains || "Any"}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {p.last_login_at ? new Date(p.last_login_at).toLocaleString() : "Never"}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1.5">
                          <Button variant="outline" size="sm" onClick={() => testConnection(p)} disabled={busyId === p.id}>
                            <FlaskConical className="size-3.5" />
                          </Button>
                          <Button variant="outline" size="sm" onClick={() => toggleStatus(p)} disabled={busyId === p.id}>
                            {p.status === "enabled" ? "Disable" : "Enable"}
                          </Button>
                          <Button variant="ghost" size="sm" onClick={() => remove(p)} disabled={busyId === p.id}>
                            <Trash2 className="size-3.5 text-destructive" />
                          </Button>
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
