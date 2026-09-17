"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import type { AccessUser } from "@/lib/platform-roles"
import { type PlatformRole, platformRoleLabel, tenantRoleLabel } from "@/lib/role-model"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

const PLATFORM_ROLE_OPTIONS: PlatformRole[] = ["none", "platform_staff", "platform_super_admin"]

function initials(name: string, email: string): string {
  const base = name.trim() || email
  const parts = base.split(/\s+/)
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase()
  return base.slice(0, 2).toUpperCase()
}

export function AccessManager({
  users,
  currentUserId,
  canAssignSuperAdmin,
}: {
  users: AccessUser[]
  currentUserId: number
  canAssignSuperAdmin: boolean
}) {
  const router = useRouter()
  const [pending, setPending] = useState<number | null>(null)

  const operators = users.filter((u) => u.platformRole !== "none")
  const others = users.filter((u) => u.platformRole === "none")

  async function assign(user: AccessUser, role: PlatformRole) {
    setPending(user.id)
    try {
      const res = await fetch(`/api/platform/users/${user.id}/platform-role`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast.error(json.error || "Could not update role")
        return
      }
      toast.success(`${user.name || user.email} is now ${platformRoleLabel(role) === "—" ? "a tenant user" : platformRoleLabel(role)}`)
      router.refresh()
    } catch {
      toast.error("Network error — please try again")
    } finally {
      setPending(null)
    }
  }

  function renderTable(rows: AccessUser[]) {
    return (
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>User</TableHead>
            <TableHead>Tenant</TableHead>
            <TableHead>Tenant role</TableHead>
            <TableHead className="w-[13rem]">Platform role</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((u) => {
            const isSelf = u.id === currentUserId
            return (
              <TableRow key={u.id}>
                <TableCell>
                  <div className="flex items-center gap-2.5">
                    <Avatar className="size-8">
                      <AvatarFallback className="text-xs">{initials(u.name, u.email)}</AvatarFallback>
                    </Avatar>
                    <div className="flex min-w-0 flex-col leading-tight">
                      <span className="flex items-center gap-1.5 font-medium">
                        {u.name || u.email}
                        {isSelf ? <Badge variant="secondary" className="text-[10px]">You</Badge> : null}
                      </span>
                      <span className="truncate text-xs text-muted-foreground">{u.email}</span>
                    </div>
                  </div>
                </TableCell>
                <TableCell className="text-muted-foreground">{u.tenantName ?? "—"}</TableCell>
                <TableCell className="text-muted-foreground">{tenantRoleLabel(u.tenantRole)}</TableCell>
                <TableCell>
                  <Select
                    value={u.platformRole}
                    onValueChange={(v) => assign(u, v as PlatformRole)}
                    disabled={pending === u.id || isSelf}
                  >
                    <SelectTrigger className="h-8">
                      <SelectValue asChild>
                        <span className="text-sm">
                          {u.platformRole === "none" ? "Tenant user" : platformRoleLabel(u.platformRole)}
                        </span>
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {PLATFORM_ROLE_OPTIONS.map((role) => (
                        <SelectItem
                          key={role}
                          value={role}
                          disabled={role === "platform_super_admin" && !canAssignSuperAdmin}
                        >
                          {role === "none" ? "Tenant user" : platformRoleLabel(role)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
    )
  }

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader className="border-b">
          <CardTitle>Platform operators</CardTitle>
          <CardDescription>{operators.length} users hold platform authority. You cannot change your own role.</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {operators.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">No platform operators yet.</p>
          ) : (
            renderTable(operators)
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="border-b">
          <CardTitle>Tenant users</CardTitle>
          <CardDescription>Grant platform access by assigning a platform role.</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {others.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">No other users.</p>
          ) : (
            renderTable(others)
          )}
        </CardContent>
      </Card>
    </div>
  )
}
