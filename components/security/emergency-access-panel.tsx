"use client"

import { useState, useTransition } from "react"
import useSWR from "swr"
import { toast } from "sonner"
import { AlertTriangle, ShieldAlert } from "lucide-react"
import { fetcher } from "@/lib/fetcher"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Checkbox } from "@/components/ui/checkbox"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Skeleton } from "@/components/ui/skeleton"
import { EmptyState } from "@/components/security/security-ui"

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
  activatedAt: string | null
  endedAt: string | null
  endReason: string | null
}

const DURATIONS = [
  { label: "15 minutes", minutes: 15 },
  { label: "30 minutes", minutes: 30 },
  { label: "1 hour", minutes: 60 },
  { label: "2 hours", minutes: 120 },
  { label: "Custom", minutes: -1 },
]

const ROLE_LABELS: Record<string, string> = {
  module_admin: "Department/Module Admin",
  tenant_admin: "Tenant Admin",
}

const STATUS_BADGE: Record<Grant["status"], string> = {
  pending: "border-transparent bg-amber-600 text-white",
  active: "border-transparent bg-destructive text-white",
  expired: "border-transparent bg-muted-foreground/70 text-background",
  revoked: "border-transparent bg-muted-foreground/70 text-background",
  rejected: "border-transparent bg-muted-foreground/70 text-background",
}

function fmt(value: string | null) {
  if (!value) return "—"
  const d = new Date(value.includes("T") ? value : value.replace(" ", "T") + "Z")
  return Number.isNaN(d.getTime()) ? value : d.toLocaleString()
}

export function EmergencyAccessPanel() {
  const { data, mutate, isLoading } = useSWR<{ grants: Grant[]; currentUserId: number }>(
    "/api/admin/security/emergency-access",
    fetcher,
    { refreshInterval: 10000 },
  )
  const grants = data?.grants ?? []
  const currentUserId = data?.currentUserId
  const active = grants.filter((g) => g.status === "active")
  const pending = grants.filter((g) => g.status === "pending")
  const history = grants.filter((g) => !["active", "pending"].includes(g.status))

  const [open, setOpen] = useState(false)
  const [scope, setScope] = useState("")
  const [justification, setJustification] = useState("")
  const [durationMinutes, setDurationMinutes] = useState(30)
  const [customMinutes, setCustomMinutes] = useState(45)
  const [role, setRole] = useState<"module_admin" | "tenant_admin">("tenant_admin")
  const [approver, setApprover] = useState("")
  const [notify, setNotify] = useState(true)
  const [isPending, startTransition] = useTransition()

  function submit() {
    const minutes = durationMinutes === -1 ? customMinutes : durationMinutes
    startTransition(async () => {
      try {
        const res = await fetch("/api/admin/security/emergency-access", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            scope: scope.trim() || "Unspecified scope",
            reason: justification.trim(),
            durationMinutes: minutes,
            grantedRole: role,
            approverName: approver.trim() || null,
            notifySecurity: notify,
          }),
        })
        const body = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(body?.error ?? "Request failed")
        await mutate()
        setOpen(false)
        setScope("")
        setJustification("")
        setApprover("")
        setDurationMinutes(30)
        toast.success("Emergency access requested — awaiting approval")
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to submit request")
      }
    })
  }

  function act(id: number, action: "approve" | "reject" | "revoke", reason?: string) {
    startTransition(async () => {
      try {
        const res = await fetch(`/api/admin/security/emergency-access/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action, reason }),
        })
        const body = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(body?.error ?? "Request failed")
        await mutate()
        toast.success(`Request ${action === "approve" ? "approved" : action === "reject" ? "rejected" : "revoked"}`)
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Action failed")
      }
    })
  }

  return (
    <div className="space-y-6">
      <div
        role="note"
        className="flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm"
      >
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
        <p className="text-destructive-foreground">
          Emergency (break-glass) access grants temporary, elevated permissions for active incidents. Every request
          requires a written justification, a second administrator&apos;s approval, is time-boxed with automatic
          expiry, and is fully audited. Access is never granted silently.
        </p>
      </div>

      <div className="flex justify-end">
        <Button className="gap-1.5" onClick={() => setOpen(true)}>
          <ShieldAlert className="size-4" /> Request emergency access
        </Button>
      </div>

      {pending.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Awaiting approval</CardTitle>
            <CardDescription>Requests need a second administrator to approve or reject them.</CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Requester</TableHead>
                    <TableHead>Role</TableHead>
                    <TableHead>Scope</TableHead>
                    <TableHead>Justification</TableHead>
                    <TableHead>Expires</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {pending.map((g) => {
                    const ownRequest = currentUserId != null && g.userId === currentUserId
                    return (
                      <TableRow key={g.id}>
                        <TableCell className="font-medium">{g.userName}</TableCell>
                        <TableCell>{g.grantedRole ? ROLE_LABELS[g.grantedRole] : "—"}</TableCell>
                        <TableCell className="max-w-40 truncate">{g.scope}</TableCell>
                        <TableCell className="max-w-56 truncate text-muted-foreground">{g.reason}</TableCell>
                        <TableCell className="text-muted-foreground">{fmt(g.expiresAt)}</TableCell>
                        <TableCell className="text-right">
                          <div className="flex justify-end gap-2">
                            <Button
                              size="sm"
                              disabled={isPending || ownRequest}
                              title={ownRequest ? "You cannot approve your own request" : undefined}
                              onClick={() => act(g.id, "approve")}
                            >
                              Approve
                            </Button>
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={isPending}
                              onClick={() => act(g.id, "reject", "Rejected by administrator")}
                            >
                              Reject
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      )}

      {active.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Active emergency access</CardTitle>
            <CardDescription>Currently elevated sessions. Revoke immediately if no longer needed.</CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>User</TableHead>
                    <TableHead>Role</TableHead>
                    <TableHead>Scope</TableHead>
                    <TableHead>Approved by</TableHead>
                    <TableHead>Started</TableHead>
                    <TableHead>Expires</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {active.map((g) => (
                    <TableRow key={g.id}>
                      <TableCell className="font-medium">{g.userName}</TableCell>
                      <TableCell>{g.grantedRole ? ROLE_LABELS[g.grantedRole] : "—"}</TableCell>
                      <TableCell className="max-w-40 truncate">{g.scope}</TableCell>
                      <TableCell className="text-muted-foreground">{g.approverName ?? "—"}</TableCell>
                      <TableCell className="text-muted-foreground">{fmt(g.activatedAt)}</TableCell>
                      <TableCell className="text-muted-foreground">{fmt(g.expiresAt)}</TableCell>
                      <TableCell className="text-right">
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={isPending}
                          onClick={() => act(g.id, "revoke", "Revoked by administrator")}
                        >
                          Revoke
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <AlertTriangle className="size-4 text-muted-foreground" />
            <CardTitle className="text-base">Emergency access history</CardTitle>
          </div>
          <CardDescription>Every past request, approval and outcome, retained for audit.</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="space-y-2 p-6">
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
            </div>
          ) : history.length === 0 ? (
            <div className="p-6">
              <EmptyState icon={<ShieldAlert className="size-5" />} title="No completed emergency access requests">
                Past grants — expired, revoked or rejected — will be listed here for audit.
              </EmptyState>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Requester</TableHead>
                    <TableHead>Reason</TableHead>
                    <TableHead>Scope</TableHead>
                    <TableHead>Approved by</TableHead>
                    <TableHead>Ended</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {history.map((g) => (
                    <TableRow key={g.id}>
                      <TableCell className="font-medium">{g.userName}</TableCell>
                      <TableCell className="max-w-56 truncate text-muted-foreground">{g.reason || "—"}</TableCell>
                      <TableCell className="max-w-40 truncate">{g.scope}</TableCell>
                      <TableCell className="text-muted-foreground">{g.approverName ?? "—"}</TableCell>
                      <TableCell className="text-muted-foreground">{fmt(g.endedAt)}</TableCell>
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

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Request emergency access</DialogTitle>
            <DialogDescription>
              This request is logged and time-boxed. A second administrator must approve it before access is granted,
              and it ends automatically at expiry.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid gap-2">
              <Label htmlFor="ea-scope">Requested scope</Label>
              <Input
                id="ea-scope"
                value={scope}
                onChange={(e) => setScope(e.target.value)}
                placeholder="e.g. Finance module — read/write"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="ea-justification">Justification</Label>
              <Textarea
                id="ea-justification"
                value={justification}
                onChange={(e) => setJustification(e.target.value)}
                placeholder="Describe the incident and why elevated access is required"
                rows={3}
              />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="grid gap-2">
                <Label htmlFor="ea-role">Elevated role</Label>
                <Select value={role} onValueChange={(v) => setRole(v as "module_admin" | "tenant_admin")}>
                  <SelectTrigger id="ea-role" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="module_admin">Department/Module Admin</SelectItem>
                    <SelectItem value="tenant_admin">Tenant Admin</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="ea-duration">Duration</Label>
                <Select value={String(durationMinutes)} onValueChange={(v) => setDurationMinutes(Number(v))}>
                  <SelectTrigger id="ea-duration" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {DURATIONS.map((d) => (
                      <SelectItem key={d.label} value={String(d.minutes)}>
                        {d.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {durationMinutes === -1 && (
                <div className="grid gap-2">
                  <Label htmlFor="ea-custom">Custom minutes</Label>
                  <Input
                    id="ea-custom"
                    type="number"
                    min={5}
                    value={customMinutes}
                    onChange={(e) => setCustomMinutes(Number(e.target.value) || 5)}
                  />
                </div>
              )}
            </div>
            <div className="grid gap-2">
              <Label htmlFor="ea-approver">Suggested approver (optional)</Label>
              <Input
                id="ea-approver"
                value={approver}
                onChange={(e) => setApprover(e.target.value)}
                placeholder="Name of the approving administrator"
              />
            </div>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={notify} onCheckedChange={(v) => setNotify(Boolean(v))} />
              Notify security team
            </label>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button onClick={submit} disabled={!justification.trim() || isPending}>
              Submit request
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
