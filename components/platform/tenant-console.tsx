"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Building2, Home, Loader2, LogIn, LogOut } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"

type TenantRow = {
  id: number
  name: string
  slug: string
  status: "active" | "suspended" | "inactive"
  plan: string
  isPlatformOwner: boolean
}

const statusVariant: Record<TenantRow["status"], "default" | "secondary" | "destructive"> = {
  active: "default",
  suspended: "destructive",
  inactive: "secondary",
}

export function TenantConsole({
  tenants,
  homeTenantId,
  impersonatingId,
}: {
  tenants: TenantRow[]
  homeTenantId: number | null
  impersonatingId: number | null
}) {
  const router = useRouter()
  const [pendingId, setPendingId] = useState<number | null>(null)

  async function enter(tenant: TenantRow) {
    setPendingId(tenant.id)
    try {
      const res = await fetch("/api/platform/impersonation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tenantId: tenant.id }),
      })
      const json = await res.json().catch(() => ({}) as Record<string, unknown>)
      if (!res.ok) {
        toast.error((json as { error?: string }).error || "Could not enter tenant")
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

  async function exit() {
    setPendingId(-1)
    try {
      const res = await fetch("/api/platform/impersonation", { method: "DELETE" })
      if (!res.ok) {
        const json = await res.json().catch(() => ({}) as Record<string, unknown>)
        toast.error((json as { error?: string }).error || "Could not exit impersonation")
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

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-background">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Tenant</TableHead>
            <TableHead>Plan</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="text-right">Action</TableHead>
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
                <TableCell>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge variant={statusVariant[tenant.status]} className="capitalize">
                      {tenant.status}
                    </Badge>
                    {tenant.isPlatformOwner && (
                      <Badge variant="secondary" className="gap-1">
                        <Home className="size-3" />
                        Platform
                      </Badge>
                    )}
                  </div>
                </TableCell>
                <TableCell className="text-right">
                  {isHome ? (
                    <span className="text-xs text-muted-foreground">Your home tenant</span>
                  ) : isActive ? (
                    <Button size="sm" variant="outline" onClick={exit} disabled={pendingId === -1}>
                      {pendingId === -1 ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : (
                        <LogOut className="size-3.5" />
                      )}
                      Exit
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => enter(tenant)}
                      disabled={busy || tenant.status !== "active"}
                    >
                      {busy ? <Loader2 className="size-3.5 animate-spin" /> : <LogIn className="size-3.5" />}
                      Enter
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
    </div>
  )
}
