"use client"

import { useMemo, useState } from "react"
import { toast } from "sonner"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { StatusBadge, portalStatusTone } from "./shared"
import {
  ACTIVITY_LOG,
  AUDIT_LOG,
  DOCUMENTS,
  NOTIFICATION_TEMPLATES,
  ONBOARDING_LABELS,
  PORTAL_RESOURCE_LIST,
  PORTAL_USERS,
  SESSIONS,
  SHARED_RESOURCES,
  STATUS_LABELS,
  USER_STATUS_LABELS,
  type PortalClient,
} from "./data"
import {
  Building2,
  ChevronDown,
  KeyRound,
  Mail,
  MoreHorizontal,
  UserCog,
} from "lucide-react"

const APPROVAL_STEPS = [
  "Application",
  "Verification",
  "Company Review",
  "Documents",
  "Admin Approval",
  "Activation",
]

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 py-1.5 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right font-medium">{value ?? "—"}</span>
    </div>
  )
}

export function ClientDetailDrawer({
  client,
  open,
  onOpenChange,
}: {
  client: PortalClient | null
  open: boolean
  onOpenChange: (v: boolean) => void
}) {
  const [confirm, setConfirm] = useState<{ title: string; description: string; action: string } | null>(null)

  const users = useMemo(
    () => (client ? PORTAL_USERS.filter((u) => u.clientId === client.id) : []),
    [client],
  )
  const docs = useMemo(
    () => (client ? DOCUMENTS.filter((d) => d.client === client.name) : []),
    [client],
  )
  const resources = useMemo(
    () => (client ? SHARED_RESOURCES.filter((r) => r.client === client.name) : []),
    [client],
  )
  const sessions = useMemo(
    () => (client ? SESSIONS.filter((s) => s.client === client.name) : []),
    [client],
  )
  const activity = useMemo(
    () => (client ? ACTIVITY_LOG.filter((a) => a.client === client.name) : []),
    [client],
  )
  const audit = useMemo(
    () => (client ? AUDIT_LOG.filter((a) => a.client === client.name) : []),
    [client],
  )

  if (!client) return null

  function act(label: string) {
    toast.success(`${label} — ${client!.name}`)
  }

  function confirmAction(title: string, description: string, action: string) {
    setConfirm({ title, description, action })
  }

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent className="w-full sm:max-w-3xl">
          <SheetHeader>
            <div className="flex items-start gap-3">
              <span className="flex size-11 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <Building2 className="size-6" />
              </span>
              <div className="min-w-0 flex-1">
                <SheetTitle className="flex flex-wrap items-center gap-2">
                  {client.name}
                  <span className="font-mono text-xs font-normal text-muted-foreground">{client.clientId}</span>
                  <StatusBadge label={STATUS_LABELS[client.status]} tone={portalStatusTone(client.status)} />
                </SheetTitle>
                <SheetDescription>{client.company}</SheetDescription>
              </div>
            </div>

            {/* Admin actions */}
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Button size="sm" variant="outline" onClick={() => act("Edit opened")}>
                <UserCog className="size-4" /> Edit
              </Button>
              {client.status === "pending" ? (
                <>
                  <Button size="sm" onClick={() => act("Application approved")}>
                    Approve
                  </Button>
                  <Button
                    size="sm"
                    variant="destructive"
                    onClick={() => confirmAction("Reject client?", `${client.name} will be rejected and notified.`, "Application rejected")}
                  >
                    Reject
                  </Button>
                </>
              ) : null}
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button size="sm" variant="outline">
                      More <ChevronDown className="size-4" />
                    </Button>
                  }
                />
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={() => act("Activated")}>Activate</DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() => confirmAction("Suspend client?", `Portal access for ${client.name} will be paused.`, "Client suspended")}
                  >
                    Suspend
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() => confirmAction("Disable client?", `${client.name} will lose all portal access.`, "Client disabled")}
                  >
                    Disable
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => act("Access reset")}>Reset Access</DropdownMenuItem>
                  <DropdownMenuItem onClick={() => act("Welcome email sent")}>Resend Welcome Email</DropdownMenuItem>
                  <DropdownMenuItem onClick={() => act("Impersonation session (placeholder)")}>Impersonate (placeholder)</DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onClick={() => confirmAction("Revoke all sessions?", `All active sessions for ${client.name} will end immediately.`, "All sessions revoked")}
                  >
                    Revoke Sessions
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </SheetHeader>

          <Tabs defaultValue="overview" className="min-h-0">
            <TabsList variant="line" className="w-full flex-wrap justify-start overflow-x-auto">
              <TabsTrigger value="overview">Overview</TabsTrigger>
              <TabsTrigger value="users">Users</TabsTrigger>
              <TabsTrigger value="access">Access</TabsTrigger>
              <TabsTrigger value="onboarding">Onboarding</TabsTrigger>
              <TabsTrigger value="resources">Resources</TabsTrigger>
              <TabsTrigger value="documents">Documents</TabsTrigger>
              <TabsTrigger value="sessions">Sessions</TabsTrigger>
              <TabsTrigger value="security">Security</TabsTrigger>
              <TabsTrigger value="notifications">Notifications</TabsTrigger>
              <TabsTrigger value="activity">Activity</TabsTrigger>
              <TabsTrigger value="audit">Audit</TabsTrigger>
            </TabsList>

            {/* OVERVIEW */}
            <TabsContent value="overview" className="grid gap-4 pt-2">
              <div className="grid gap-3 sm:grid-cols-3">
                <Stat label="Users" value={client.users} />
                <Stat label="Active sessions" value={client.activeSessions} />
                <Stat label="Resources shared" value={client.resourcesShared} />
                <Stat label="Open requests" value={client.openRequests} />
                <Stat label="Access profile" value={client.accessProfile} />
                <Stat label="Onboarding" value={ONBOARDING_LABELS[client.onboarding]} />
              </div>
              <div className="rounded-lg border border-border p-4">
                <Row label="Primary contact" value={client.contact} />
                <Row label="Email" value={client.contactEmail} />
                <Row label="Phone" value={client.contactPhone} />
                <Row label="Account manager" value={client.accountManager} />
                <Row label="Created" value={client.created} />
                <Row label="Approved" value={client.approved} />
                <Row label="Last login" value={client.lastLogin ?? "Never"} />
              </div>
            </TabsContent>

            {/* USERS */}
            <TabsContent value="users" className="grid gap-3 pt-2">
              <div className="flex items-center justify-between">
                <p className="text-sm text-muted-foreground">{users.length} portal user(s)</p>
                <Button size="sm" onClick={() => act("Create user opened")}>
                  <KeyRound className="size-4" /> Create user
                </Button>
              </div>
              {users.length === 0 ? (
                <p className="rounded-lg border border-dashed border-border p-4 text-center text-sm text-muted-foreground">
                  No portal users yet.
                </p>
              ) : (
                users.map((u) => (
                  <div key={u.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border p-3">
                    <div className="grid gap-0.5">
                      <span className="text-sm font-medium">
                        {u.firstName} {u.lastName}
                        <span className="ml-2 text-xs font-normal text-muted-foreground">{u.role}</span>
                      </span>
                      <span className="text-xs text-muted-foreground">{u.email}</span>
                      <span className="text-xs text-muted-foreground">
                        {u.lastLogin ? `Last login ${u.lastLogin}` : "Never signed in"} · MFA {u.mfa ? "on" : "off"}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <StatusBadge label={USER_STATUS_LABELS[u.status]} tone={portalStatusTone(u.status)} />
                      <DropdownMenu>
                        <DropdownMenuTrigger render={<Button size="icon-sm" variant="ghost" aria-label="User actions" />}>
                          <MoreHorizontal className="size-4" />
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => act("User edited")}>Edit</DropdownMenuItem>
                          <DropdownMenuItem onClick={() => act("Password reset sent")}>Send password reset</DropdownMenuItem>
                          <DropdownMenuItem onClick={() => act("Invitation resent")}>Resend invitation</DropdownMenuItem>
                          <DropdownMenuItem onClick={() => act("Account unlocked")}>Unlock account</DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem onClick={() => act("User suspended")}>Suspend</DropdownMenuItem>
                          <DropdownMenuItem onClick={() => act("Sessions revoked")}>Force logout</DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </div>
                ))
              )}
            </TabsContent>

            {/* ACCESS */}
            <TabsContent value="access" className="grid gap-3 pt-2">
              <p className="text-sm text-muted-foreground">
                Resource access for this client. Individual overrides take precedence over the assigned access profile
                <span className="font-medium text-foreground"> ({client.accessProfile})</span>.
              </p>
              <div className="grid gap-2 sm:grid-cols-2">
                {PORTAL_RESOURCE_LIST.slice(0, 12).map((r, i) => (
                  <label key={r} className="flex items-center justify-between gap-2 rounded-lg border border-border p-2.5 text-sm">
                    <span>{r}</span>
                    <div className="flex items-center gap-2">
                      {i % 4 === 0 ? <Badge variant="outline" className="text-[10px]">Override</Badge> : null}
                      <Switch defaultChecked={i % 3 !== 0} onCheckedChange={() => act(`${r} access changed`)} />
                    </div>
                  </label>
                ))}
              </div>
            </TabsContent>

            {/* ONBOARDING */}
            <TabsContent value="onboarding" className="grid gap-3 pt-2">
              <div className="rounded-lg border border-border p-4">
                <p className="mb-3 text-sm font-medium">Onboarding progress — {ONBOARDING_LABELS[client.onboarding]}</p>
                <ol className="grid gap-2">
                  {APPROVAL_STEPS.map((step, i) => {
                    const done = client.onboarding === "complete" || i < 3
                    return (
                      <li key={step} className="flex items-center gap-3 text-sm">
                        <span
                          className={
                            "flex size-5 items-center justify-center rounded-full text-[10px] font-medium " +
                            (done ? "bg-primary text-primary-foreground" : "border border-border text-muted-foreground")
                          }
                        >
                          {i + 1}
                        </span>
                        <span className={done ? "" : "text-muted-foreground"}>{step}</span>
                      </li>
                    )
                  })}
                </ol>
              </div>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" onClick={() => act("Documents requested")}>Request documents</Button>
                <Button size="sm" variant="outline" onClick={() => act("Onboarding advanced")}>Advance step</Button>
              </div>
            </TabsContent>

            {/* RESOURCES */}
            <TabsContent value="resources" className="grid gap-3 pt-2">
              {resources.length === 0 ? (
                <p className="rounded-lg border border-dashed border-border p-4 text-center text-sm text-muted-foreground">
                  Nothing shared with this client yet.
                </p>
              ) : (
                <div className="overflow-hidden rounded-lg border border-border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Resource</TableHead>
                        <TableHead>Type</TableHead>
                        <TableHead>Permission</TableHead>
                        <TableHead>Status</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {resources.map((r) => (
                        <TableRow key={r.id}>
                          <TableCell className="font-medium">{r.name}</TableCell>
                          <TableCell className="text-muted-foreground">{r.type}</TableCell>
                          <TableCell className="capitalize">{r.permission}</TableCell>
                          <TableCell>
                            <StatusBadge label={r.status} tone={portalStatusTone(r.status)} className="capitalize" />
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </TabsContent>

            {/* DOCUMENTS */}
            <TabsContent value="documents" className="grid gap-3 pt-2">
              {docs.length === 0 ? (
                <p className="rounded-lg border border-dashed border-border p-4 text-center text-sm text-muted-foreground">
                  No documents for this client.
                </p>
              ) : (
                docs.map((d) => (
                  <div key={d.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border p-3">
                    <div className="grid gap-0.5">
                      <span className="text-sm font-medium">{d.name}</span>
                      <span className="text-xs text-muted-foreground">{d.category} · {d.uploadedDate}</span>
                    </div>
                    <StatusBadge label={d.verification} tone={portalStatusTone(d.verification)} className="capitalize" />
                  </div>
                ))
              )}
            </TabsContent>

            {/* SESSIONS */}
            <TabsContent value="sessions" className="grid gap-3 pt-2">
              {sessions.length === 0 ? (
                <p className="rounded-lg border border-dashed border-border p-4 text-center text-sm text-muted-foreground">
                  No active sessions.
                </p>
              ) : (
                sessions.map((s) => (
                  <div key={s.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border p-3">
                    <div className="grid gap-0.5">
                      <span className="text-sm font-medium">{s.user}</span>
                      <span className="text-xs text-muted-foreground">{s.device} · {s.browser} · {s.location}</span>
                      <span className="text-xs text-muted-foreground">{s.ip} · since {s.loginTime}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <StatusBadge label={s.status} tone={portalStatusTone(s.status)} className="capitalize" />
                      <Button size="sm" variant="outline" onClick={() => act("Session revoked")}>Revoke</Button>
                    </div>
                  </div>
                ))
              )}
            </TabsContent>

            {/* SECURITY */}
            <TabsContent value="security" className="grid gap-3 pt-2">
              <div className="rounded-lg border border-border p-4">
                {[
                  ["Require MFA", true],
                  ["Enforce password expiry (90 days)", false],
                  ["Restrict to verified email domains", true],
                  ["Block concurrent sessions", false],
                ].map(([label, checked]) => (
                  <div key={label as string} className="flex items-center justify-between py-2 text-sm">
                    <span>{label}</span>
                    <Switch defaultChecked={checked as boolean} onCheckedChange={() => act("Security setting changed")} />
                  </div>
                ))}
              </div>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" onClick={() => act("Password reset forced")}>Force password reset</Button>
                <Button size="sm" variant="outline" onClick={() => act("MFA reset")}>Reset MFA</Button>
              </div>
            </TabsContent>

            {/* NOTIFICATIONS */}
            <TabsContent value="notifications" className="grid gap-2 pt-2">
              {NOTIFICATION_TEMPLATES.slice(0, 6).map((n) => (
                <div key={n.id} className="flex items-center justify-between gap-2 rounded-lg border border-border p-3 text-sm">
                  <span>{n.event}</span>
                  <div className="flex items-center gap-1.5">
                    {n.email ? <Badge variant="outline" className="text-[10px]"><Mail className="size-3" /> Email</Badge> : null}
                    {n.portal ? <Badge variant="outline" className="text-[10px]">Portal</Badge> : null}
                  </div>
                </div>
              ))}
            </TabsContent>

            {/* ACTIVITY */}
            <TabsContent value="activity" className="grid gap-2 pt-2">
              {activity.length === 0 ? (
                <p className="rounded-lg border border-dashed border-border p-4 text-center text-sm text-muted-foreground">
                  No recent activity.
                </p>
              ) : (
                activity.map((a) => (
                  <div key={a.id} className="flex items-center justify-between gap-2 rounded-lg border border-border p-3 text-sm">
                    <div className="grid gap-0.5">
                      <span className="font-medium">{a.event}</span>
                      <span className="text-xs text-muted-foreground">{a.user} · {a.ip}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <StatusBadge label={a.result} tone={portalStatusTone(a.result)} className="capitalize" />
                      <span className="text-xs text-muted-foreground">{a.at}</span>
                    </div>
                  </div>
                ))
              )}
            </TabsContent>

            {/* AUDIT */}
            <TabsContent value="audit" className="grid gap-2 pt-2">
              {audit.length === 0 ? (
                <p className="rounded-lg border border-dashed border-border p-4 text-center text-sm text-muted-foreground">
                  No audit entries.
                </p>
              ) : (
                audit.map((a) => (
                  <div key={a.id} className="grid gap-0.5 rounded-lg border border-border p-3 text-sm">
                    <div className="flex items-center justify-between">
                      <span className="font-medium">{a.action}</span>
                      <span className="text-xs text-muted-foreground">{a.at}</span>
                    </div>
                    <span className="text-xs text-muted-foreground">
                      {a.actor} · {a.resource} · {a.oldValue} → {a.newValue}
                    </span>
                  </div>
                ))
              )}
            </TabsContent>
          </Tabs>
        </SheetContent>
      </Sheet>

      <AlertDialog open={!!confirm} onOpenChange={(v) => !v && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirm?.title}</AlertDialogTitle>
            <AlertDialogDescription>{confirm?.description}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (confirm) act(confirm.action)
                setConfirm(null)
              }}
            >
              Confirm
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-muted/20 p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 text-lg font-semibold tabular-nums">{value}</div>
    </div>
  )
}
