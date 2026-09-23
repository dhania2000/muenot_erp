"use client"

import { useMemo, useState } from "react"
import useSWR from "swr"
import { fetcher } from "@/lib/fetcher"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import {
  Clock,
  KeyRound,
  Loader2,
  MoreHorizontal,
  RefreshCw,
  ShieldCheck,
  ShieldOff,
  UserMinus,
  UserPlus,
  UserRoundCog,
} from "lucide-react"
import { toast } from "sonner"

// -----------------------------------------------------------------------------
// SPEC 14 — User lifecycle admin console.
//   - Directory tab: every tenant user with their lifecycle state and the full
//     joiner→mover→leaver action set (invite, activate, suspend/reactivate,
//     temporary access, role/department assignment, password/MFA reset,
//     offboarding with data-ownership transfer, rehire).
//   - Activity tab : the append-only lifecycle audit trail for the tenant.
// All actions call the tenant-scoped, admin-guarded routes under
// /api/admin/users; this component only orchestrates them.
// -----------------------------------------------------------------------------

const TENANT_ROLES = [
  { value: "employee", label: "Employee" },
  { value: "module_admin", label: "Department/Module Admin" },
  { value: "tenant_admin", label: "Tenant Admin" },
  { value: "tenant_owner", label: "Tenant Owner" },
] as const

type LifecycleState = "invited" | "active" | "suspended" | "deactivated"

type LifecycleUser = {
  id: number
  name: string
  email: string
  role: "admin" | "employee"
  tenantRole: string
  lifecycleState: LifecycleState
  status: "active" | "inactive"
  emailVerifiedAt: string | null
  activatedAt: string | null
  invitedAt: string | null
  suspendedAt: string | null
  suspendedReason: string | null
  deactivatedAt: string | null
  deactivatedReason: string | null
  accessExpiresAt: string | null
  mfaEnabled: boolean
  mustChangePassword: boolean
  createdAt: string | null
}

type LifecycleEvent = {
  id: number
  userId: number | null
  action: string
  fromState: string | null
  toState: string | null
  actorEmail: string | null
  detail: Record<string, unknown> | null
  createdAt: string
}

type Directory = { users: LifecycleUser[]; events: LifecycleEvent[] }

const STATE_META: Record<LifecycleState, { label: string; variant: "default" | "secondary" | "destructive" | "outline" }> = {
  active: { label: "Active", variant: "default" },
  invited: { label: "Invited", variant: "secondary" },
  suspended: { label: "Suspended", variant: "destructive" },
  deactivated: { label: "Deactivated", variant: "outline" },
}

function fmt(value: string | null): string {
  if (!value) return "—"
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString()
}

function tenantRoleLabel(role: string): string {
  return TENANT_ROLES.find((r) => r.value === role)?.label ?? role
}

export function UsersLifecycleManager() {
  const { data, isLoading, mutate } = useSWR<Directory>("/api/admin/users", fetcher)
  const [inviteOpen, setInviteOpen] = useState(false)

  const users = data?.users ?? []
  const events = data?.events ?? []

  const counts = useMemo(() => {
    const c = { invited: 0, active: 0, suspended: 0, deactivated: 0 }
    for (const u of users) c[u.lifecycleState] += 1
    return c
  }, [users])

  return (
    <div className="flex flex-col gap-6 p-6 md:p-8">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">User lifecycle</h1>
          <p className="text-sm text-muted-foreground">
            Invite, verify, assign, suspend, and offboard users across the joiner, mover, and leaver journeys.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => mutate()}>
            <RefreshCw className="mr-2 size-4" />
            Refresh
          </Button>
          <Button size="sm" onClick={() => setInviteOpen(true)}>
            <UserPlus className="mr-2 size-4" />
            Invite user
          </Button>
        </div>
      </header>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Active" value={counts.active} />
        <StatCard label="Invited" value={counts.invited} />
        <StatCard label="Suspended" value={counts.suspended} />
        <StatCard label="Deactivated" value={counts.deactivated} />
      </div>

      <Tabs defaultValue="directory">
        <TabsList>
          <TabsTrigger value="directory">Directory</TabsTrigger>
          <TabsTrigger value="activity">Activity</TabsTrigger>
        </TabsList>

        <TabsContent value="directory" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle>Directory</CardTitle>
              <CardDescription>All users in your tenant and their current lifecycle state.</CardDescription>
            </CardHeader>
            <CardContent>
              {isLoading ? (
                <div className="flex items-center justify-center py-12 text-muted-foreground">
                  <Loader2 className="mr-2 size-5 animate-spin" />
                  Loading users…
                </div>
              ) : users.length === 0 ? (
                <p className="py-12 text-center text-sm text-muted-foreground">
                  No users yet. Invite someone to get started.
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>User</TableHead>
                        <TableHead>State</TableHead>
                        <TableHead>Role</TableHead>
                        <TableHead>Verified</TableHead>
                        <TableHead>MFA</TableHead>
                        <TableHead>Temp access</TableHead>
                        <TableHead className="text-right">Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {users.map((u) => (
                        <UserRow key={u.id} user={u} users={users} onDone={() => mutate()} />
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="activity" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle>Lifecycle activity</CardTitle>
              <CardDescription>Append-only audit trail of every lifecycle change in your tenant.</CardDescription>
            </CardHeader>
            <CardContent>
              {events.length === 0 ? (
                <p className="py-12 text-center text-sm text-muted-foreground">No activity recorded yet.</p>
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>When</TableHead>
                        <TableHead>Action</TableHead>
                        <TableHead>Transition</TableHead>
                        <TableHead>Actor</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {events.map((e) => (
                        <TableRow key={e.id}>
                          <TableCell className="whitespace-nowrap text-muted-foreground">{fmt(e.createdAt)}</TableCell>
                          <TableCell className="font-medium">{e.action.replace(/_/g, " ")}</TableCell>
                          <TableCell className="text-muted-foreground">
                            {e.fromState || e.toState ? `${e.fromState ?? "—"} → ${e.toState ?? "—"}` : "—"}
                          </TableCell>
                          <TableCell className="text-muted-foreground">{e.actorEmail ?? "system"}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <InviteDialog open={inviteOpen} onOpenChange={setInviteOpen} onDone={() => mutate()} />
    </div>
  )
}

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <Card>
      <CardContent className="flex flex-col gap-1 py-4">
        <span className="text-sm text-muted-foreground">{label}</span>
        <span className="text-2xl font-semibold tabular-nums">{value}</span>
      </CardContent>
    </Card>
  )
}

// -----------------------------------------------------------------------------
// One directory row + its action menu and the dialogs those actions open.
// -----------------------------------------------------------------------------

type DialogKind =
  | null
  | "suspend"
  | "temp_access"
  | "deactivate"
  | "assign_role"
  | "assign_department"

function UserRow({ user, users, onDone }: { user: LifecycleUser; users: LifecycleUser[]; onDone: () => void }) {
  const [busy, setBusy] = useState(false)
  const [dialog, setDialog] = useState<DialogKind>(null)

  async function patch(body: Record<string, unknown>, successMsg: string) {
    setBusy(true)
    try {
      const res = await fetch(`/api/admin/users/${user.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(json.error || "Action failed")
      if (json.tempPassword) {
        toast.success(successMsg, { description: `Temporary password: ${json.tempPassword}`, duration: 15000 })
      } else {
        toast.success(successMsg)
      }
      setDialog(null)
      onDone()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Action failed")
    } finally {
      setBusy(false)
    }
  }

  const meta = STATE_META[user.lifecycleState]
  const isActive = user.lifecycleState === "active"
  const isSuspended = user.lifecycleState === "suspended"
  const isInvited = user.lifecycleState === "invited"
  const isDeactivated = user.lifecycleState === "deactivated"

  return (
    <>
      <TableRow>
        <TableCell>
          <div className="flex flex-col">
            <span className="font-medium">{user.name || "(no name)"}</span>
            <span className="text-xs text-muted-foreground">{user.email}</span>
          </div>
        </TableCell>
        <TableCell>
          <Badge variant={meta.variant}>{meta.label}</Badge>
        </TableCell>
        <TableCell className="text-muted-foreground">{tenantRoleLabel(user.tenantRole)}</TableCell>
        <TableCell>
          {user.emailVerifiedAt ? (
            <ShieldCheck className="size-4 text-emerald-600" aria-label="Email verified" />
          ) : (
            <ShieldOff className="size-4 text-muted-foreground" aria-label="Email not verified" />
          )}
        </TableCell>
        <TableCell className="text-muted-foreground">{user.mfaEnabled ? "On" : "Off"}</TableCell>
        <TableCell className="whitespace-nowrap text-muted-foreground">
          {user.accessExpiresAt ? fmt(user.accessExpiresAt) : "—"}
        </TableCell>
        <TableCell className="text-right">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" disabled={busy} aria-label={`Actions for ${user.name || user.email}`}>
                {busy ? <Loader2 className="size-4 animate-spin" /> : <MoreHorizontal className="size-4" />}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuLabel>Lifecycle</DropdownMenuLabel>
              {isInvited && (
                <DropdownMenuItem onSelect={() => patch({ action: "reactivate" }, "User activated")}>
                  <UserPlus className="mr-2 size-4" />
                  Activate now
                </DropdownMenuItem>
              )}
              {isActive && (
                <DropdownMenuItem onSelect={() => setDialog("suspend")}>
                  <ShieldOff className="mr-2 size-4" />
                  Suspend
                </DropdownMenuItem>
              )}
              {isSuspended && (
                <DropdownMenuItem onSelect={() => patch({ action: "reactivate" }, "User reactivated")}>
                  <ShieldCheck className="mr-2 size-4" />
                  Reactivate
                </DropdownMenuItem>
              )}
              {isDeactivated ? (
                <DropdownMenuItem onSelect={() => patch({ action: "rehire" }, "User rehired")}>
                  <UserPlus className="mr-2 size-4" />
                  Rehire
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem onSelect={() => setDialog("deactivate")} className="text-destructive">
                  <UserMinus className="mr-2 size-4" />
                  Offboard / deactivate
                </DropdownMenuItem>
              )}

              <DropdownMenuSeparator />
              <DropdownMenuLabel>Access</DropdownMenuLabel>
              <DropdownMenuItem onSelect={() => setDialog("temp_access")} disabled={isDeactivated}>
                <Clock className="mr-2 size-4" />
                Set temporary access
              </DropdownMenuItem>
              {user.accessExpiresAt && (
                <DropdownMenuItem onSelect={() => patch({ action: "revoke_temp_access" }, "Temporary access removed")}>
                  <Clock className="mr-2 size-4" />
                  Remove temporary access
                </DropdownMenuItem>
              )}

              <DropdownMenuSeparator />
              <DropdownMenuLabel>Assignment</DropdownMenuLabel>
              <DropdownMenuItem onSelect={() => setDialog("assign_role")}>
                <UserRoundCog className="mr-2 size-4" />
                Assign role
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setDialog("assign_department")}>
                <UserRoundCog className="mr-2 size-4" />
                Assign department
              </DropdownMenuItem>

              <DropdownMenuSeparator />
              <DropdownMenuLabel>Security</DropdownMenuLabel>
              <DropdownMenuItem
                onSelect={() => patch({ action: "reset_password" }, "Password reset")}
                disabled={isDeactivated}
              >
                <KeyRound className="mr-2 size-4" />
                Reset password
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => patch({ action: "reset_mfa" }, "MFA reset")}
                disabled={!user.mfaEnabled}
              >
                <KeyRound className="mr-2 size-4" />
                Reset MFA
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </TableCell>
      </TableRow>

      <SuspendDialog
        open={dialog === "suspend"}
        onOpenChange={(o) => !o && setDialog(null)}
        busy={busy}
        onConfirm={(reason) => patch({ action: "suspend", reason }, "User suspended")}
      />
      <TempAccessDialog
        open={dialog === "temp_access"}
        onOpenChange={(o) => !o && setDialog(null)}
        busy={busy}
        onConfirm={(expiresAt) => patch({ action: "grant_temp_access", expiresAt }, "Temporary access granted")}
      />
      <DeactivateDialog
        open={dialog === "deactivate"}
        onOpenChange={(o) => !o && setDialog(null)}
        busy={busy}
        candidates={users.filter((u) => u.id !== user.id && u.lifecycleState === "active")}
        onConfirm={(reason, transferToUserId) =>
          patch({ action: "deactivate", reason, transferToUserId }, "User offboarded")
        }
      />
      <AssignRoleDialog
        open={dialog === "assign_role"}
        onOpenChange={(o) => !o && setDialog(null)}
        busy={busy}
        current={user.tenantRole}
        onConfirm={(tenantRole) => patch({ action: "assign_role", tenantRole }, "Role assigned")}
      />
      <AssignDepartmentDialog
        open={dialog === "assign_department"}
        onOpenChange={(o) => !o && setDialog(null)}
        busy={busy}
        onConfirm={(orgUnitId, title, isPrimary) =>
          patch({ action: "assign_department", orgUnitId, title, isPrimary }, "Department assigned")
        }
      />
    </>
  )
}

// -----------------------------------------------------------------------------
// Dialogs
// -----------------------------------------------------------------------------

function InviteDialog({
  open,
  onOpenChange,
  onDone,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  onDone: () => void
}) {
  const [email, setEmail] = useState("")
  const [name, setName] = useState("")
  const [tenantRole, setTenantRole] = useState("employee")
  const [designation, setDesignation] = useState("")
  const [expiresInHours, setExpiresInHours] = useState("72")
  const [busy, setBusy] = useState(false)
  const [inviteLink, setInviteLink] = useState<string | null>(null)

  function reset() {
    setEmail("")
    setName("")
    setTenantRole("employee")
    setDesignation("")
    setExpiresInHours("72")
    setInviteLink(null)
  }

  async function submit() {
    setBusy(true)
    try {
      const res = await fetch("/api/admin/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email,
          name,
          tenantRole,
          role: tenantRole === "tenant_admin" || tenantRole === "tenant_owner" ? "admin" : "employee",
          designation: designation || null,
          expiresInHours: Number(expiresInHours) || 72,
        }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(json.error || "Invite failed")
      const link =
        typeof window !== "undefined" ? `${window.location.origin}/invite/${json.inviteToken}` : json.inviteToken
      setInviteLink(link)
      toast.success("Invitation created")
      onDone()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Invite failed")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) reset()
        onOpenChange(o)
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Invite user</DialogTitle>
          <DialogDescription>Creates an invited account and a single-use activation link.</DialogDescription>
        </DialogHeader>

        {inviteLink ? (
          <div className="flex flex-col gap-2">
            <Label>Invitation link</Label>
            <p className="text-sm text-muted-foreground">
              Share this single-use link with the user. It is shown only once.
            </p>
            <Input readOnly value={inviteLink} onFocus={(e) => e.currentTarget.select()} />
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                navigator.clipboard?.writeText(inviteLink)
                toast.success("Copied to clipboard")
              }}
            >
              Copy link
            </Button>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <div className="grid gap-2">
              <Label htmlFor="invite-email">Email</Label>
              <Input
                id="invite-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="person@company.com"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="invite-name">Name</Label>
              <Input id="invite-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Full name" />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="grid gap-2">
                <Label>Role</Label>
                <Select value={tenantRole} onValueChange={setTenantRole}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {TENANT_ROLES.map((r) => (
                      <SelectItem key={r.value} value={r.value}>
                        {r.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="invite-expiry">Invite expires (hours)</Label>
                <Input
                  id="invite-expiry"
                  type="number"
                  min={1}
                  value={expiresInHours}
                  onChange={(e) => setExpiresInHours(e.target.value)}
                />
              </div>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="invite-designation">Designation (optional)</Label>
              <Input
                id="invite-designation"
                value={designation}
                onChange={(e) => setDesignation(e.target.value)}
                placeholder="e.g. Accountant"
              />
            </div>
          </div>
        )}

        <DialogFooter>
          {inviteLink ? (
            <Button onClick={() => onOpenChange(false)}>Done</Button>
          ) : (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
                Cancel
              </Button>
              <Button onClick={submit} disabled={busy || !email || !name}>
                {busy && <Loader2 className="mr-2 size-4 animate-spin" />}
                Send invitation
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function SuspendDialog({
  open,
  onOpenChange,
  busy,
  onConfirm,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  busy: boolean
  onConfirm: (reason: string) => void
}) {
  const [reason, setReason] = useState("")
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Suspend user</DialogTitle>
          <DialogDescription>The user is blocked from signing in until reactivated.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-2">
          <Label htmlFor="suspend-reason">Reason (optional)</Label>
          <Textarea
            id="suspend-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Why is this account being suspended?"
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={() => onConfirm(reason)} disabled={busy}>
            {busy && <Loader2 className="mr-2 size-4 animate-spin" />}
            Suspend
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function TempAccessDialog({
  open,
  onOpenChange,
  busy,
  onConfirm,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  busy: boolean
  onConfirm: (expiresAt: string) => void
}) {
  const [value, setValue] = useState("")
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Set temporary access</DialogTitle>
          <DialogDescription>
            The account can sign in until this moment, then is automatically blocked — no state change needed.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-2">
          <Label htmlFor="temp-expiry">Access expires at</Label>
          <Input id="temp-expiry" type="datetime-local" value={value} onChange={(e) => setValue(e.target.value)} />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button
            onClick={() => value && onConfirm(new Date(value).toISOString())}
            disabled={busy || !value}
          >
            {busy && <Loader2 className="mr-2 size-4 animate-spin" />}
            Grant
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function DeactivateDialog({
  open,
  onOpenChange,
  busy,
  candidates,
  onConfirm,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  busy: boolean
  candidates: LifecycleUser[]
  onConfirm: (reason: string, transferToUserId: number | null) => void
}) {
  const [reason, setReason] = useState("")
  const [transferTo, setTransferTo] = useState<string>("none")
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Offboard user</DialogTitle>
          <DialogDescription>
            Deactivation blocks sign-in permanently (until an explicit rehire) and can transfer owned records to
            another active user.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <div className="grid gap-2">
            <Label htmlFor="deactivate-reason">Reason (optional)</Label>
            <Textarea
              id="deactivate-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Offboarding reason"
            />
          </div>
          <div className="grid gap-2">
            <Label>Transfer data ownership to</Label>
            <Select value={transferTo} onValueChange={setTransferTo}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Don&apos;t transfer</SelectItem>
                {candidates.map((c) => (
                  <SelectItem key={c.id} value={String(c.id)}>
                    {c.name || c.email}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={() => onConfirm(reason, transferTo === "none" ? null : Number(transferTo))}
            disabled={busy}
          >
            {busy && <Loader2 className="mr-2 size-4 animate-spin" />}
            Offboard
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function AssignRoleDialog({
  open,
  onOpenChange,
  busy,
  current,
  onConfirm,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  busy: boolean
  current: string
  onConfirm: (tenantRole: string) => void
}) {
  const [role, setRole] = useState(current)
  return (
    <Dialog open={open} onOpenChange={(o) => { if (o) setRole(current); onOpenChange(o) }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Assign role</DialogTitle>
          <DialogDescription>Change the user&apos;s tenant role. You cannot grant a role above your own.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-2">
          <Label>Tenant role</Label>
          <Select value={role} onValueChange={setRole}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TENANT_ROLES.map((r) => (
                <SelectItem key={r.value} value={r.value}>
                  {r.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => onConfirm(role)} disabled={busy}>
            {busy && <Loader2 className="mr-2 size-4 animate-spin" />}
            Assign
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function AssignDepartmentDialog({
  open,
  onOpenChange,
  busy,
  onConfirm,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  busy: boolean
  onConfirm: (orgUnitId: number, title: string | null, isPrimary: boolean) => void
}) {
  const [orgUnitId, setOrgUnitId] = useState("")
  const [title, setTitle] = useState("")
  const [isPrimary, setIsPrimary] = useState(true)
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Assign department</DialogTitle>
          <DialogDescription>Place the user in an org unit (department) within your tenant.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <div className="grid gap-2">
            <Label htmlFor="dept-id">Org unit ID</Label>
            <Input
              id="dept-id"
              type="number"
              min={1}
              value={orgUnitId}
              onChange={(e) => setOrgUnitId(e.target.value)}
              placeholder="e.g. 12"
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="dept-title">Title in department (optional)</Label>
            <Input id="dept-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Manager" />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={isPrimary} onChange={(e) => setIsPrimary(e.target.checked)} />
            Primary department
          </label>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button
            onClick={() => onConfirm(Number(orgUnitId), title || null, isPrimary)}
            disabled={busy || !orgUnitId}
          >
            {busy && <Loader2 className="mr-2 size-4 animate-spin" />}
            Assign
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
