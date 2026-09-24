"use client"

import { useState } from "react"
import useSWR from "swr"
import { toast } from "sonner"
import { fetcher } from "@/lib/fetcher"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Checkbox } from "@/components/ui/checkbox"
import { Separator } from "@/components/ui/separator"
import { Textarea } from "@/components/ui/textarea"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Copy, FileStack, KeyRound, Loader2, Plus, ShieldCheck, Trash2, UserPlus } from "lucide-react"
import {
  PORTAL_ITEM_RESOURCES,
  PORTAL_RESOURCE_META,
  PORTAL_RESOURCES,
  type PortalItemResource,
  type PortalResource,
} from "@/lib/portal/config"
import type { ClientRow } from "@/components/clients/clients-client"

type PortalUser = {
  id: number
  client_id: number
  email: string
  name: string
  status: "invited" | "active" | "disabled"
  last_login_at: string | null
  client_name: string | null
}

type SharedItem = {
  id: number
  resource: string
  reference: string | null
  title: string
  description: string | null
  status: string | null
  amount: number | null
  currency: string | null
  issue_date: string | null
  due_date: string | null
  file_url: string | null
  file_name: string | null
  created_at: string
}

const EMPTY_ITEM = {
  resource: "invoices" as PortalItemResource,
  title: "",
  reference: "",
  status: "",
  amount: "",
  currency: "",
  issueDate: "",
  dueDate: "",
  description: "",
  fileUrl: "",
  fileName: "",
}

export function ClientPortalDialog({
  client,
  open,
  onOpenChange,
}: {
  client: ClientRow | null
  open: boolean
  onOpenChange: (v: boolean) => void
}) {
  const clientId = client?.id ?? null

  const access = useSWR<{ resources: PortalResource[] }>(
    open && clientId ? `/api/admin/portal/access?clientId=${clientId}` : null,
    fetcher,
  )
  const usersReq = useSWR<{ users: PortalUser[] }>(
    open && clientId ? "/api/admin/portal/users" : null,
    fetcher,
  )
  const itemsReq = useSWR<{ items: SharedItem[] }>(
    open && clientId ? `/api/admin/portal/items?clientId=${clientId}` : null,
    fetcher,
  )

  const [savingAccess, setSavingAccess] = useState(false)
  const [pending, setPending] = useState<Set<PortalResource> | null>(null)

  // Local view of the granted set: pending edits until "Save access" persists.
  const granted = pending ?? new Set(access.data?.resources ?? [])
  const dirty = pending !== null

  const clientUsers = (usersReq.data?.users ?? []).filter((u) => u.client_id === clientId)

  function toggle(resource: PortalResource) {
    const next = new Set(granted)
    if (next.has(resource)) next.delete(resource)
    else next.add(resource)
    setPending(next)
  }

  async function saveAccess() {
    if (!clientId) return
    setSavingAccess(true)
    const res = await fetch("/api/admin/portal/access", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientId, resources: Array.from(granted) }),
    })
    setSavingAccess(false)
    if (res.ok) {
      const body = await res.json().catch(() => ({}) as any)
      access.mutate({ resources: body.resources ?? Array.from(granted) }, { revalidate: false })
      setPending(null)
      toast.success("Portal access updated")
    } else {
      toast.error("Unable to update access")
    }
  }

  // ---- New portal user ----
  const [name, setName] = useState("")
  const [email, setEmail] = useState("")
  const [creating, setCreating] = useState(false)
  const [tempPassword, setTempPassword] = useState<string | null>(null)

  async function createUser() {
    if (!clientId || !name.trim() || !email.trim()) {
      toast.error("Name and email are required")
      return
    }
    setCreating(true)
    const res = await fetch("/api/admin/portal/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientId, name: name.trim(), email: email.trim() }),
    })
    setCreating(false)
    const body = await res.json().catch(() => ({}) as any)
    if (res.ok) {
      setTempPassword(body.tempPassword ?? null)
      setName("")
      setEmail("")
      usersReq.mutate()
      toast.success("Portal login created")
    } else {
      toast.error(body.error || "Unable to create portal login")
    }
  }

  async function setStatus(userId: number, status: "active" | "disabled") {
    const res = await fetch("/api/admin/portal/users", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId, status }),
    })
    if (res.ok) {
      usersReq.mutate()
      toast.success(status === "active" ? "Login enabled" : "Login disabled")
    } else {
      toast.error("Unable to update login")
    }
  }

  function copyPassword() {
    if (tempPassword) {
      navigator.clipboard?.writeText(tempPassword)
      toast.success("Password copied")
    }
  }

  // ---- Shared records (published items) ----
  const [item, setItem] = useState({ ...EMPTY_ITEM })
  const [publishing, setPublishing] = useState(false)
  const sharedItems = itemsReq.data?.items ?? []
  const setItemField = (k: keyof typeof EMPTY_ITEM, v: string) => setItem((p) => ({ ...p, [k]: v }))

  async function publishItem() {
    if (!clientId || !item.title.trim()) {
      toast.error("A title is required to share a record")
      return
    }
    setPublishing(true)
    const res = await fetch("/api/admin/portal/items", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientId,
        resource: item.resource,
        title: item.title.trim(),
        reference: item.reference.trim() || null,
        status: item.status.trim() || null,
        amount: item.amount.trim() ? Number(item.amount) : null,
        currency: item.currency.trim() || null,
        issueDate: item.issueDate || null,
        dueDate: item.dueDate || null,
        description: item.description.trim() || null,
        fileUrl: item.fileUrl.trim() || null,
        fileName: item.fileName.trim() || null,
      }),
    })
    setPublishing(false)
    const body = await res.json().catch(() => ({}) as any)
    if (res.ok) {
      setItem({ ...EMPTY_ITEM, resource: item.resource })
      itemsReq.mutate()
      toast.success("Record shared to the portal")
    } else {
      toast.error(body.error || "Unable to share record")
    }
  }

  async function removeItem(itemId: number) {
    if (!clientId) return
    const res = await fetch("/api/admin/portal/items", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientId, itemId }),
    })
    if (res.ok) {
      itemsReq.mutate()
      toast.success("Record removed from the portal")
    } else {
      toast.error("Unable to remove record")
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) {
          setPending(null)
          setTempPassword(null)
          setName("")
          setEmail("")
          setItem({ ...EMPTY_ITEM })
        }
        onOpenChange(v)
      }}
    >
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldCheck className="size-5 text-primary" /> Portal access
          </DialogTitle>
          <DialogDescription>
            Control what {client?.company_name || client?.client_name} can see and do in the client portal, and manage
            their login accounts.
          </DialogDescription>
        </DialogHeader>

        {/* Resource grants */}
        <section className="grid gap-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold">Allowed sections</h3>
            <Button size="sm" onClick={saveAccess} disabled={!dirty || savingAccess}>
              {savingAccess ? <Loader2 className="size-4 animate-spin" /> : null}
              Save access
            </Button>
          </div>
          {access.isLoading ? (
            <p className="text-sm text-muted-foreground">Loading access…</p>
          ) : (
            <div className="grid gap-2 sm:grid-cols-2">
              {PORTAL_RESOURCES.map((r) => {
                const meta = PORTAL_RESOURCE_META[r]
                const id = `portal-res-${r}`
                return (
                  <label
                    key={r}
                    htmlFor={id}
                    className="flex cursor-pointer items-start gap-3 rounded-lg border border-border bg-muted/20 p-3 transition-colors hover:bg-muted/40"
                  >
                    <Checkbox id={id} checked={granted.has(r)} onCheckedChange={() => toggle(r)} className="mt-0.5" />
                    <span className="grid gap-0.5">
                      <span className="flex items-center gap-2 text-sm font-medium">
                        {meta.labelPlural}
                        {meta.clientCanCreate ? (
                          <Badge variant="outline" className="text-[10px]">
                            Can create
                          </Badge>
                        ) : null}
                      </span>
                      <span className="text-xs text-muted-foreground">{meta.description}</span>
                    </span>
                  </label>
                )
              })}
            </div>
          )}
        </section>

        <Separator />

        {/* Portal login accounts */}
        <section className="grid gap-3">
          <h3 className="text-sm font-semibold">Login accounts</h3>

          {usersReq.isLoading ? (
            <p className="text-sm text-muted-foreground">Loading logins…</p>
          ) : clientUsers.length === 0 ? (
            <p className="rounded-lg border border-dashed border-border p-4 text-center text-sm text-muted-foreground">
              No portal logins yet. Create one below to give this client portal access.
            </p>
          ) : (
            <ul className="grid gap-2">
              {clientUsers.map((u) => (
                <li
                  key={u.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border p-3"
                >
                  <div className="grid gap-0.5">
                    <span className="text-sm font-medium">{u.name}</span>
                    <span className="text-xs text-muted-foreground">{u.email}</span>
                    <span className="text-xs text-muted-foreground">
                      {u.last_login_at ? `Last login ${String(u.last_login_at).slice(0, 10)}` : "Never signed in"}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge
                      variant={u.status === "active" ? "default" : u.status === "disabled" ? "destructive" : "outline"}
                    >
                      {u.status}
                    </Badge>
                    {u.status === "disabled" ? (
                      <Button size="sm" variant="outline" onClick={() => setStatus(u.id, "active")}>
                        Enable
                      </Button>
                    ) : (
                      <Button size="sm" variant="outline" onClick={() => setStatus(u.id, "disabled")}>
                        Disable
                      </Button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}

          {/* Create login */}
          <div className="grid gap-3 rounded-lg border border-border bg-muted/20 p-4">
            <h4 className="flex items-center gap-2 text-sm font-medium">
              <UserPlus className="size-4 text-primary" /> Create a login
            </h4>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="grid gap-1.5">
                <Label htmlFor="portal-user-name">Name</Label>
                <Input
                  id="portal-user-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Contact name"
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="portal-user-email">Email</Label>
                <Input
                  id="portal-user-email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="name@company.com"
                />
              </div>
            </div>
            <div className="flex justify-end">
              <Button size="sm" onClick={createUser} disabled={creating}>
                {creating ? <Loader2 className="size-4 animate-spin" /> : <KeyRound className="size-4" />}
                Create login
              </Button>
            </div>

            {tempPassword ? (
              <div className="flex items-center justify-between gap-3 rounded-md border border-primary/40 bg-primary/5 p-3">
                <div className="grid gap-0.5">
                  <span className="text-xs font-medium text-muted-foreground">Temporary password</span>
                  <span className="font-mono text-sm">{tempPassword}</span>
                  <span className="text-xs text-muted-foreground">
                    Share this securely. The client must change it on first login.
                  </span>
                </div>
                <Button size="icon-sm" variant="outline" onClick={copyPassword} aria-label="Copy password">
                  <Copy className="size-4" />
                </Button>
              </div>
            ) : null}
          </div>
        </section>

        <Separator />

        {/* Shared records (published items) */}
        <section className="grid gap-3">
          <div className="flex items-center gap-2">
            <FileStack className="size-4 text-primary" />
            <h3 className="text-sm font-semibold">Shared records</h3>
          </div>
          <p className="-mt-1 text-xs text-muted-foreground">
            Publish quotes, orders, invoices, payments, documents and projects so this client can see them in their
            portal.
          </p>

          {itemsReq.isLoading ? (
            <p className="text-sm text-muted-foreground">Loading shared records…</p>
          ) : sharedItems.length === 0 ? (
            <p className="rounded-lg border border-dashed border-border p-4 text-center text-sm text-muted-foreground">
              Nothing shared yet. Publish a record below to make it visible in the portal.
            </p>
          ) : (
            <ul className="grid gap-2">
              {sharedItems.map((it) => {
                const meta = PORTAL_RESOURCE_META[it.resource as PortalResource]
                return (
                  <li
                    key={it.id}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border p-3"
                  >
                    <div className="grid gap-0.5">
                      <span className="flex items-center gap-2 text-sm font-medium">
                        {it.title}
                        {it.reference ? (
                          <span className="font-mono text-xs text-muted-foreground">{it.reference}</span>
                        ) : null}
                      </span>
                      <span className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                        <Badge variant="outline" className="text-[10px]">
                          {meta?.label ?? it.resource}
                        </Badge>
                        {it.status ? <span>{it.status}</span> : null}
                        {it.amount != null ? (
                          <span>
                            {it.currency ? `${it.currency} ` : ""}
                            {Number(it.amount).toLocaleString()}
                          </span>
                        ) : null}
                        {it.issue_date ? <span>{String(it.issue_date).slice(0, 10)}</span> : null}
                      </span>
                    </div>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      onClick={() => removeItem(it.id)}
                      aria-label={`Remove ${it.title}`}
                    >
                      <Trash2 className="size-4 text-destructive" />
                    </Button>
                  </li>
                )
              })}
            </ul>
          )}

          {/* Publish a record */}
          <div className="grid gap-3 rounded-lg border border-border bg-muted/20 p-4">
            <h4 className="flex items-center gap-2 text-sm font-medium">
              <Plus className="size-4 text-primary" /> Share a record
            </h4>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="grid gap-1.5">
                <Label htmlFor="item-resource">Type</Label>
                <Select
                  value={item.resource}
                  onValueChange={(v) => setItemField("resource", v as string)}
                >
                  <SelectTrigger id="item-resource">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PORTAL_ITEM_RESOURCES.map((r) => (
                      <SelectItem key={r} value={r}>
                        {PORTAL_RESOURCE_META[r].label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="item-title">Title</Label>
                <Input
                  id="item-title"
                  value={item.title}
                  onChange={(e) => setItemField("title", e.target.value)}
                  placeholder="e.g. Invoice for September"
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="item-reference">Reference</Label>
                <Input
                  id="item-reference"
                  value={item.reference}
                  onChange={(e) => setItemField("reference", e.target.value)}
                  placeholder="e.g. INV-00042"
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="item-status">Status</Label>
                <Input
                  id="item-status"
                  value={item.status}
                  onChange={(e) => setItemField("status", e.target.value)}
                  placeholder="e.g. Paid, Pending"
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="item-amount">Amount</Label>
                <Input
                  id="item-amount"
                  type="number"
                  value={item.amount}
                  onChange={(e) => setItemField("amount", e.target.value)}
                  placeholder="0.00"
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="item-currency">Currency</Label>
                <Input
                  id="item-currency"
                  value={item.currency}
                  onChange={(e) => setItemField("currency", e.target.value)}
                  placeholder="e.g. INR"
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="item-issue-date">Issue date</Label>
                <Input
                  id="item-issue-date"
                  type="date"
                  value={item.issueDate}
                  onChange={(e) => setItemField("issueDate", e.target.value)}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="item-due-date">Due date</Label>
                <Input
                  id="item-due-date"
                  type="date"
                  value={item.dueDate}
                  onChange={(e) => setItemField("dueDate", e.target.value)}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="item-file-url">File URL</Label>
                <Input
                  id="item-file-url"
                  value={item.fileUrl}
                  onChange={(e) => setItemField("fileUrl", e.target.value)}
                  placeholder="https://…"
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="item-file-name">File name</Label>
                <Input
                  id="item-file-name"
                  value={item.fileName}
                  onChange={(e) => setItemField("fileName", e.target.value)}
                  placeholder="document.pdf"
                />
              </div>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="item-description">Description</Label>
              <Textarea
                id="item-description"
                rows={2}
                value={item.description}
                onChange={(e) => setItemField("description", e.target.value)}
                placeholder="Optional note shown to the client"
              />
            </div>
            <div className="flex justify-end">
              <Button size="sm" onClick={publishItem} disabled={publishing}>
                {publishing ? <Loader2 className="size-4 animate-spin" /> : <FileStack className="size-4" />}
                Share record
              </Button>
            </div>
          </div>
        </section>
      </DialogContent>
    </Dialog>
  )
}
