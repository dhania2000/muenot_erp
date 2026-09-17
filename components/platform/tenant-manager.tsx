"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import {
  Building2,
  Home,
  Loader2,
  LogIn,
  LogOut,
  MoreHorizontal,
  Plus,
  PauseCircle,
  PlayCircle,
  Ban,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
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

export type TenantRow = {
  id: number
  name: string
  slug: string
  status: "active" | "suspended" | "inactive"
  plan: string
  deploymentModel: string
  isPlatformOwner: boolean
}

const statusVariant: Record<TenantRow["status"], "default" | "secondary" | "destructive"> = {
  active: "default",
  suspended: "destructive",
  inactive: "secondary",
}

export function TenantManager({
  tenants,
  homeTenantId,
  impersonatingId,
  canManage,
}: {
  tenants: TenantRow[]
  homeTenantId: number | null
  impersonatingId: number | null
  canManage: boolean
}) {
  const router = useRouter()
  const [pendingId, setPendingId] = useState<number | null>(null)
  const [createOpen, setCreateOpen] = useState(false)

  async function impersonate(tenant: TenantRow) {
    setPendingId(tenant.id)
    try {
      const res = await fetch("/api/platform/impersonation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tenantId: tenant.id }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast.error(json.error || "Could not enter tenant")
        return
      }
      toast.success(`Now impersonating ${tenant.name}`)
      router.push("/dashboard")
      router.refresh()
    } catch {
      toast.error("Network error — please try again")
    } finally {
      setPendingId(null)
    }
  }

  async function exitImpersonation() {
    setPendingId(-1)
    try {
      const res = await fetch("/api/platform/impersonation", { method: "DELETE" })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast.error(json.error || "Could not exit impersonation")
        return
      }
      toast.success("Exited impersonation")
      router.refresh()
    } catch {
      toast.error("Network error — please try again")
    } finally {
      setPendingId(null)
    }
  }

  async function setStatus(tenant: TenantRow, status: TenantRow["status"]) {
    setPendingId(tenant.id)
    try {
      const res = await fetch(`/api/platform/tenants/${tenant.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast.error(json.error || "Could not update tenant")
        return
      }
      toast.success(`${tenant.name} is now ${status}`)
      router.refresh()
    } catch {
      toast.error("Network error — please try again")
    } finally {
      setPendingId(null)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {canManage ? (
        <div className="flex justify-end">
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <Plus className="size-4" />
            New tenant
          </Button>
        </div>
      ) : null}

      <div className="overflow-hidden rounded-lg border border-border bg-background">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Tenant</TableHead>
              <TableHead>Plan</TableHead>
              <TableHead>Deployment</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {tenants.map((tenant) => {
              const isHome = tenant.id === homeTenantId
              const isActive = tenant.id === impersonatingId
              const busy = pendingId === tenant.id
              return (
                <TableRow key={tenant.id} className={isActive ? "bg-amber-500/10" : undefined}>
                  <TableCell>
                    <div className="flex items-center gap-2.5">
                      <span className="flex size-8 items-center justify-center rounded-md bg-muted text-muted-foreground">
                        <Building2 className="size-4" />
                      </span>
                      <div className="flex flex-col leading-tight">
                        <span className="font-medium">{tenant.name}</span>
                        <span className="text-xs text-muted-foreground">{tenant.slug}</span>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell className="capitalize text-muted-foreground">{tenant.plan}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {tenant.deploymentModel.replace(/_/g, " ")}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Badge variant={statusVariant[tenant.status]} className="capitalize">
                        {tenant.status}
                      </Badge>
                      {tenant.isPlatformOwner ? (
                        <Badge variant="secondary" className="gap-1">
                          <Home className="size-3" />
                          Platform
                        </Badge>
                      ) : null}
                    </div>
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-2">
                      {isHome ? (
                        <span className="text-xs text-muted-foreground">Home tenant</span>
                      ) : isActive ? (
                        <Button size="sm" variant="outline" onClick={exitImpersonation} disabled={pendingId === -1}>
                          {pendingId === -1 ? <Loader2 className="size-3.5 animate-spin" /> : <LogOut className="size-3.5" />}
                          Exit
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => impersonate(tenant)}
                          disabled={busy || tenant.status !== "active"}
                        >
                          {busy ? <Loader2 className="size-3.5 animate-spin" /> : <LogIn className="size-3.5" />}
                          Enter
                        </Button>
                      )}

                      {canManage && !tenant.isPlatformOwner ? (
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button size="icon" variant="ghost" className="size-8" disabled={busy}>
                              <MoreHorizontal className="size-4" />
                              <span className="sr-only">Lifecycle actions</span>
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuLabel>Lifecycle</DropdownMenuLabel>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              disabled={tenant.status === "active"}
                              onClick={() => setStatus(tenant, "active")}
                            >
                              <PlayCircle className="size-4" />
                              Activate
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              disabled={tenant.status === "suspended"}
                              onClick={() => setStatus(tenant, "suspended")}
                            >
                              <PauseCircle className="size-4" />
                              Suspend
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              disabled={tenant.status === "inactive"}
                              onClick={() => setStatus(tenant, "inactive")}
                            >
                              <Ban className="size-4" />
                              Deactivate
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      ) : null}
                    </div>
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </div>

      {canManage ? (
        <CreateTenantDialog open={createOpen} onOpenChange={setCreateOpen} onCreated={() => router.refresh()} />
      ) : null}
    </div>
  )
}

function CreateTenantDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  onCreated: () => void
}) {
  const [name, setName] = useState("")
  const [slug, setSlug] = useState("")
  const [plan, setPlan] = useState("starter")
  const [deployment, setDeployment] = useState("shared_database")
  const [busy, setBusy] = useState(false)

  function updateName(v: string) {
    setName(v)
    // Auto-suggest a slug from the name until the user edits the slug directly.
    setSlug((prev) => {
      const suggested = v.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
      return prev === "" || prev === suggested.slice(0, prev.length) ? suggested : prev
    })
  }

  async function submit() {
    setBusy(true)
    try {
      const res = await fetch("/api/platform/tenants", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, slug, plan, deployment_model: deployment }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast.error(json.error || "Could not create tenant")
        return
      }
      toast.success(`Created tenant ${json.tenant?.name ?? name}`)
      onOpenChange(false)
      setName("")
      setSlug("")
      setPlan("starter")
      setDeployment("shared_database")
      onCreated()
    } catch {
      toast.error("Network error — please try again")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New tenant</DialogTitle>
          <DialogDescription>
            Provision a new customer tenant. A subscription is created automatically from the selected plan.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="tenant-name">Name</Label>
            <Input id="tenant-name" value={name} onChange={(e) => updateName(e.target.value)} placeholder="Acme Inc." />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="tenant-slug">Slug</Label>
            <Input
              id="tenant-slug"
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              placeholder="acme"
            />
            <p className="text-xs text-muted-foreground">Lowercase letters, digits and hyphens. Used as the subdomain hint.</p>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="flex flex-col gap-2">
              <Label>Plan</Label>
              <Select value={plan} onValueChange={setPlan}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="starter">Starter</SelectItem>
                  <SelectItem value="growth">Growth</SelectItem>
                  <SelectItem value="enterprise">Enterprise</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-2">
              <Label>Deployment</Label>
              <Select value={deployment} onValueChange={setDeployment}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="shared_database">Shared database</SelectItem>
                  <SelectItem value="separate_schema">Separate schema</SelectItem>
                  <SelectItem value="dedicated_database">Dedicated database</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={busy || !name.trim() || !slug.trim()}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : null}
            Create tenant
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
