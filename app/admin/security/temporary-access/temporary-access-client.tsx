"use client"

import { useState, useTransition } from "react"
import useSWR from "swr"
import { toast } from "sonner"
import { Clock3, UserPlus2, ShieldCheck } from "lucide-react"
import { fetcher } from "@/lib/fetcher"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import { EmptyState } from "@/components/security/security-ui"

type UserRow = { id: number; name: string; email: string; tenantRole: string }

type Grant = {
  id: number
  status: "pending" | "active" | "expired" | "revoked" | "rejected"
  userId: number
  userName: string | null
  userEmail: string | null
  grantedRole: "module_admin" | "tenant_admin" | null
  scope: string
  reason: string
  approverName: string | null
  requestedByName: string | null
  startAt: string
  expiresAt: string
  endedAt: string | null
  endReason: string | null
}

const NO_ROLE = "__none__"
const ROLE_LABELS: Record<string, string> = {
  module_admin: "Department/Module Admin",
  tenant_admin: "Tenant Admin",
}

const STATUS_BADGE: Record<Grant["status"], string> = {
  active: "border-transparent bg-emerald-600 text-white",
  pending: "border-transparent bg-amber-600 text-white",
  expired: "border-transparent bg-muted-foreground/70 text-background",
  revoked: "border-transparent bg-muted-foreground/70 text-background",
  rejected: "border-transparent bg-muted-foreground/70 text-background",
}

function fmt(value: string | null) {
  if (!value) return "—"
  const d = new Date(value.includes("T") ? value : value.replace(" ", "T") + "Z")
  return Number.isNaN(d.getTime()) ? value : d.toLocaleString()
}

export function TemporaryAccessClient({ initialUsers }: { initialUsers: UserRow[] }) {
  const { data, mutate, isLoading } = useSWR<{ grants: Grant[] }>(
    "/api/admin/security/temporary-access",
    fetcher,
    { refreshInterval: 15000 },
  )
  const grants = data?.grants ?? []
  const current = grants.filter((g) => g.status === "active" || g.status === "pending")
  const history = grants.filter((g) => g.status !== "active" && g.status !== "pending")

  const [userId, setUserId] = useState("")
  const [role, setRole] = useState(NO_ROLE)
  const [scope, setScope] = useState("")
  const [reason, setReason] = useState("")
  const [startAt, setStartAt] = useState("")
  const [expiresAt, setExpiresAt] = useState("")
  const [approver, setApprover] = useState("")
  const [isPending, startTransition] = useTransition()

  function resetForm() {
    setUserId("")
    setRole(NO_ROLE)
    setScope("")
    setReason("")
    setStartAt("")
    setExpiresAt("")
    setApprover("")
  }

  function handleGrant() {
    if (!userId) return toast.error("Choose a user")
    if (!scope.trim()) return toast.error("Enter a scope")
    if (!reason.trim()) return toast.error("Enter a reason")
    if (!expiresAt) return toast.error("Choose an expiry date and time")

    startTransition(async () => {
      try {
        const res = await fetch("/api/admin/security/temporary-access", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            userId: Number(userId),
            grantedRole: role === NO_ROLE ? null : role,
            scope: scope.trim(),
            reason: reason.trim(),
            approverName: approver.trim() || null,
            startAt: startAt ? new Date(startAt).toISOString() : new Date().toISOString(),
            expiresAt: new Date(expiresAt).toISOString(),
          }),
        })
        const body = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(body?.error ?? "Request failed")
        await mutate()
        resetForm()
        toast.success("Temporary access granted")
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to grant access")
      }
    })
  }

  function handleRevoke(id: number) {
    startTransition(async () => {
      try {
        const res = await fetch(`/api/admin/security/temporary-access/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reason: "Revoked from Temporary access console" }),
        })
        const body = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(body?.error ?? "Request failed")
        await mutate()
        toast.success("Access revoked")
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to revoke access")
      }
    })
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <UserPlus2 className="size-4 text-muted-foreground" />
            <CardTitle className="text-base">Grant temporary access</CardTitle>
          </div>
          <CardDescription>
            Access is time-boxed and revoked automatically at expiry. Leave the start time empty to begin now, or
            schedule it for the future.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label className="text-xs">User</Label>
            <Select value={userId} onValueChange={(v) => setUserId(v ?? "")}>
              <SelectTrigger>
                <SelectValue placeholder="Select a user" />
              </SelectTrigger>
              <SelectContent>
                {initialUsers.map((u) => (
                  <SelectItem key={u.id} value={String(u.id)}>
                    {u.name} · {u.email}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Temporary role (optional)</Label>
            <Select value={role} onValueChange={(v) => setRole(v ?? "")}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_ROLE}>Access only — no role change</SelectItem>
                <SelectItem value="module_admin">Department/Module Admin</SelectItem>
                <SelectItem value="tenant_admin">Tenant Admin</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label className="text-xs">Scope</Label>
            <Input value={scope} onChange={(e) => setScope(e.target.value)} placeholder="e.g. Finance module — read/write" />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label className="text-xs">Reason</Label>
            <Textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Why is this access needed?"
              rows={2}
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Starts at (optional)</Label>
            <Input type="datetime-local" value={startAt} onChange={(e) => setStartAt(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Expires at</Label>
            <Input type="datetime-local" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label className="text-xs">Approver (optional)</Label>
            <Input value={approver} onChange={(e) => setApprover(e.target.value)} placeholder="Name of the approving manager" />
          </div>
          <div className="sm:col-span-2">
            <Button onClick={handleGrant} disabled={isPending} className="gap-1.5">
              <Clock3 className="size-4" /> Grant access
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Active &amp; scheduled grants</CardTitle>
          <CardDescription>Currently active windows and grants scheduled to start later.</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="space-y-2 p-6">
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
            </div>
          ) : current.length === 0 ? (
            <div className="p-6">
              <EmptyState icon={<Clock3 className="size-5" />} title="No active or scheduled grants">
                Grant a user time-boxed access above to see it listed here.
              </EmptyState>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>User</TableHead>
                    <TableHead>Role</TableHead>
                    <TableHead>Scope</TableHead>
                    <TableHead>Starts</TableHead>
                    <TableHead>Expires</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {current.map((g) => (
                    <TableRow key={g.id}>
                      <TableCell>
                        <div className="font-medium">{g.userName}</div>
                        <div className="text-xs text-muted-foreground">{g.userEmail}</div>
                      </TableCell>
                      <TableCell>
                        {g.grantedRole ? (
                          <span className="inline-flex items-center gap-1 text-sm">
                            <ShieldCheck className="size-3.5 text-muted-foreground" />
                            {ROLE_LABELS[g.grantedRole]}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">Access only</span>
                        )}
                      </TableCell>
                      <TableCell className="max-w-56 truncate">{g.scope}</TableCell>
                      <TableCell className="text-muted-foreground">{fmt(g.startAt)}</TableCell>
                      <TableCell className="text-muted-foreground">{fmt(g.expiresAt)}</TableCell>
                      <TableCell>
                        <Badge className={STATUS_BADGE[g.status]}>{g.status === "pending" ? "scheduled" : g.status}</Badge>
                      </TableCell>
                      <TableCell className="text-right">
                        <Button variant="outline" size="sm" disabled={isPending} onClick={() => handleRevoke(g.id)}>
                          Revoke
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">History</CardTitle>
          <CardDescription>Expired and revoked grants, retained for audit.</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {history.length === 0 ? (
            <div className="p-6">
              <EmptyState icon={<Clock3 className="size-5" />} title="No past grants yet">
                Expired or revoked temporary grants will be listed here.
              </EmptyState>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>User</TableHead>
                    <TableHead>Scope</TableHead>
                    <TableHead>Reason</TableHead>
                    <TableHead>Ended</TableHead>
                    <TableHead>Outcome</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {history.map((g) => (
                    <TableRow key={g.id}>
                      <TableCell className="font-medium">{g.userName}</TableCell>
                      <TableCell className="max-w-48 truncate">{g.scope}</TableCell>
                      <TableCell className="max-w-56 truncate text-muted-foreground">{g.reason}</TableCell>
                      <TableCell className="text-muted-foreground">{fmt(g.endedAt)}</TableCell>
                      <TableCell className="max-w-40 truncate text-muted-foreground">{g.endReason ?? "—"}</TableCell>
                      <TableCell>
                        <Badge className={STATUS_BADGE[g.status]}>{g.status}</Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
