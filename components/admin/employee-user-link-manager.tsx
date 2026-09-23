"use client"

import { useMemo, useState } from "react"
import useSWR from "swr"
import { fetcher } from "@/lib/fetcher"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Link2, Link2Off, Loader2, RefreshCw, ServerCog, UserRoundCog } from "lucide-react"
import { toast } from "sonner"

// -----------------------------------------------------------------------------
// Employee ⇄ User link console.
//   - Mappings tab : every employee, its resolved login, relation classification,
//                    and link / unlink / sync actions.
//   - Logins tab   : users with no employee (service accounts + unlinked logins),
//                    with a person↔service toggle.
//   - Activity tab : the append-only link/sync audit trail.
// All actions hit the tenant-scoped, admin-guarded /api/admin/employee-links
// routes; this component only orchestrates them.
// -----------------------------------------------------------------------------

type AccountType = "person" | "service"
type Relation = "linked" | "historical" | "unlinked_employee" | "unlinked_user" | "service_account"
type Tone = "ok" | "warn" | "muted" | "info"

type EmployeeRow = {
  employeePk: number
  employeeCode: string
  employeeName: string
  department: string | null
  designation: string | null
  employmentStatus: string | null
  entityId: number | null
  archived: boolean
  relation: Relation
  relationLabel: string
  relationTone: Tone
  user: { id: number; name: string; email: string; role: string; status: string; accountType: AccountType } | null
}

type LoneUser = {
  id: number
  name: string
  email: string
  role: string
  status: string
  accountType: AccountType
  relation: Relation
  relationLabel: string
  relationTone: Tone
}

type LinkableUser = { id: number; name: string; email: string; linkedCount: number }

type LinkEvent = {
  id: number
  employeePk: number | null
  userId: number | null
  action: string
  detail: Record<string, unknown> | null
  actorName: string | null
  createdAt: string
}

type Overview = {
  employees: EmployeeRow[]
  loneUsers: LoneUser[]
  linkableUsers: LinkableUser[]
  events: LinkEvent[]
  stats: {
    linked: number
    historical: number
    unlinkedEmployees: number
    unlinkedUsers: number
    serviceAccounts: number
    outOfSync: number
  }
}

const TONE_VARIANT: Record<Tone, "default" | "secondary" | "destructive" | "outline"> = {
  ok: "default",
  warn: "destructive",
  info: "secondary",
  muted: "outline",
}

const ACTION_LABEL: Record<string, string> = {
  linked: "Linked",
  unlinked: "Unlinked",
  account_type_changed: "Account type changed",
  access_synced: "Access synchronized",
}

function fmt(value: string | null): string {
  if (!value) return "—"
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString()
}

async function post(url: string, method: "POST" | "DELETE", body?: unknown): Promise<void> {
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    throw new Error(data?.error || `Request failed (${res.status})`)
  }
}

export function EmployeeUserLinkManager() {
  const { data, isLoading, mutate } = useSWR<Overview>("/api/admin/employee-links", fetcher)
  const [busy, setBusy] = useState<string | null>(null)
  const [search, setSearch] = useState("")
  const [linkTarget, setLinkTarget] = useState<EmployeeRow | null>(null)
  const [selectedUserId, setSelectedUserId] = useState<string>("")

  const employees = data?.employees ?? []
  const loneUsers = data?.loneUsers ?? []
  const linkableUsers = data?.linkableUsers ?? []
  const events = data?.events ?? []
  const stats = data?.stats

  const filteredEmployees = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return employees
    return employees.filter((e) =>
      [e.employeeName, e.employeeCode, e.department, e.designation, e.user?.email, e.user?.name]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(q)),
    )
  }, [employees, search])

  async function run(key: string, fn: () => Promise<void>, successMsg: string) {
    setBusy(key)
    try {
      await fn()
      await mutate()
      toast.success(successMsg)
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setBusy(null)
    }
  }

  function openLink(row: EmployeeRow) {
    setLinkTarget(row)
    setSelectedUserId(row.user ? String(row.user.id) : "")
  }

  async function confirmLink() {
    if (!linkTarget || !selectedUserId) return
    const employeePk = linkTarget.employeePk
    const userId = Number(selectedUserId)
    setLinkTarget(null)
    await run(`link-${employeePk}`, () => post("/api/admin/employee-links/link", "POST", { employeePk, userId }), "Employee linked")
  }

  return (
    <div className="flex flex-col gap-6 p-4 md:p-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Employee ⇄ User Links</h1>
        <p className="text-sm text-muted-foreground">
          Map ERP employees to login accounts, keep service accounts and historical users straight, and synchronize
          access status from employment across every entity.
        </p>
      </header>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <StatCard label="Linked" value={stats?.linked} />
        <StatCard label="Historical" value={stats?.historical} />
        <StatCard label="Unlinked staff" value={stats?.unlinkedEmployees} />
        <StatCard label="Unlinked logins" value={stats?.unlinkedUsers} />
        <StatCard label="Service accts" value={stats?.serviceAccounts} />
        <StatCard label="Out of sync" value={stats?.outOfSync} highlight={(stats?.outOfSync ?? 0) > 0} />
      </div>

      <Tabs defaultValue="mappings" className="w-full">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <TabsList>
            <TabsTrigger value="mappings">Mappings</TabsTrigger>
            <TabsTrigger value="logins">Logins</TabsTrigger>
            <TabsTrigger value="activity">Activity</TabsTrigger>
          </TabsList>
          <Button
            variant="outline"
            size="sm"
            disabled={busy === "sync-all"}
            onClick={() =>
              run(
                "sync-all",
                async () => {
                  const res = await fetch("/api/admin/employee-links/sync", { method: "POST" })
                  if (!res.ok) throw new Error("Sync failed")
                },
                "Access status synchronized",
              )
            }
          >
            {busy === "sync-all" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
            Sync all access
          </Button>
        </div>

        <TabsContent value="mappings" className="mt-4">
          <Card>
            <CardHeader className="gap-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <CardTitle>Employee mappings</CardTitle>
                  <CardDescription>One employee links to at most one login. Employees may repeat per entity.</CardDescription>
                </div>
                <Input
                  placeholder="Search staff, code, login…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="w-full sm:w-64"
                />
              </div>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Employee</TableHead>
                      <TableHead>Employment</TableHead>
                      <TableHead>Login</TableHead>
                      <TableHead>Relation</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {isLoading ? (
                      <TableRow>
                        <TableCell colSpan={5} className="py-10 text-center text-muted-foreground">
                          <Loader2 className="mx-auto h-5 w-5 animate-spin" />
                        </TableCell>
                      </TableRow>
                    ) : filteredEmployees.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={5} className="py-10 text-center text-muted-foreground">
                          No employees found.
                        </TableCell>
                      </TableRow>
                    ) : (
                      filteredEmployees.map((e) => (
                        <TableRow key={e.employeePk}>
                          <TableCell>
                            <div className="font-medium">{e.employeeName}</div>
                            <div className="text-xs text-muted-foreground">
                              {e.employeeCode}
                              {e.entityId != null ? ` · entity ${e.entityId}` : ""}
                              {e.department ? ` · ${e.department}` : ""}
                            </div>
                          </TableCell>
                          <TableCell>
                            <span className="text-sm">{e.employmentStatus || "—"}</span>
                          </TableCell>
                          <TableCell>
                            {e.user ? (
                              <div>
                                <div className="text-sm">{e.user.name}</div>
                                <div className="text-xs text-muted-foreground">{e.user.email}</div>
                              </div>
                            ) : (
                              <span className="text-sm text-muted-foreground">—</span>
                            )}
                          </TableCell>
                          <TableCell>
                            <Badge variant={TONE_VARIANT[e.relationTone]}>{e.relationLabel}</Badge>
                          </TableCell>
                          <TableCell className="text-right">
                            <div className="flex justify-end gap-2">
                              {e.user ? (
                                <>
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    disabled={busy === `sync-${e.user.id}`}
                                    onClick={() =>
                                      run(
                                        `sync-${e.user!.id}`,
                                        () => post("/api/admin/employee-links/sync", "POST", { userId: e.user!.id }),
                                        "Access synchronized",
                                      )
                                    }
                                  >
                                    <RefreshCw className="h-4 w-4" />
                                    <span className="sr-only">Sync access</span>
                                  </Button>
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    disabled={busy === `unlink-${e.employeePk}`}
                                    onClick={() =>
                                      run(
                                        `unlink-${e.employeePk}`,
                                        () => post("/api/admin/employee-links/link", "DELETE", { employeePk: e.employeePk }),
                                        "Employee unlinked",
                                      )
                                    }
                                  >
                                    <Link2Off className="h-4 w-4" />
                                    <span className="sr-only">Unlink</span>
                                  </Button>
                                </>
                              ) : (
                                <Button variant="outline" size="sm" onClick={() => openLink(e)}>
                                  <Link2 className="mr-2 h-4 w-4" />
                                  Link
                                </Button>
                              )}
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
        </TabsContent>

        <TabsContent value="logins" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle>Logins without an employee</CardTitle>
              <CardDescription>
                Service accounts are intentionally employee-less and never touched by access sync. Unlinked logins are
                people awaiting a mapping.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Login</TableHead>
                      <TableHead>Role</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Kind</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {loneUsers.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={5} className="py-10 text-center text-muted-foreground">
                          Every login is mapped to an employee.
                        </TableCell>
                      </TableRow>
                    ) : (
                      loneUsers.map((u) => (
                        <TableRow key={u.id}>
                          <TableCell>
                            <div className="text-sm font-medium">{u.name}</div>
                            <div className="text-xs text-muted-foreground">{u.email}</div>
                          </TableCell>
                          <TableCell className="text-sm">{u.role}</TableCell>
                          <TableCell>
                            <Badge variant={u.status === "active" ? "default" : "outline"}>{u.status}</Badge>
                          </TableCell>
                          <TableCell>
                            <Badge variant={TONE_VARIANT[u.relationTone]}>{u.relationLabel}</Badge>
                          </TableCell>
                          <TableCell className="text-right">
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={busy === `type-${u.id}`}
                              onClick={() =>
                                run(
                                  `type-${u.id}`,
                                  () =>
                                    post("/api/admin/employee-links/account-type", "POST", {
                                      userId: u.id,
                                      accountType: u.accountType === "service" ? "person" : "service",
                                    }),
                                  "Account type updated",
                                )
                              }
                            >
                              {u.accountType === "service" ? (
                                <>
                                  <UserRoundCog className="mr-2 h-4 w-4" />
                                  Mark as person
                                </>
                              ) : (
                                <>
                                  <ServerCog className="mr-2 h-4 w-4" />
                                  Mark as service
                                </>
                              )}
                            </Button>
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="activity" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle>Link activity</CardTitle>
              <CardDescription>Append-only audit of links, account-type changes, and access syncs.</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>When</TableHead>
                      <TableHead>Action</TableHead>
                      <TableHead>Detail</TableHead>
                      <TableHead>Actor</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {events.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={4} className="py-10 text-center text-muted-foreground">
                          No activity yet.
                        </TableCell>
                      </TableRow>
                    ) : (
                      events.map((ev) => (
                        <TableRow key={ev.id}>
                          <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                            {fmt(ev.createdAt)}
                          </TableCell>
                          <TableCell>
                            <Badge variant="secondary">{ACTION_LABEL[ev.action] ?? ev.action}</Badge>
                          </TableCell>
                          <TableCell className="text-sm text-muted-foreground">
                            {ev.detail ? summarizeDetail(ev.detail) : "—"}
                          </TableCell>
                          <TableCell className="text-sm">{ev.actorName || "System"}</TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <Dialog open={linkTarget !== null} onOpenChange={(open) => !open && setLinkTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Link employee to a login</DialogTitle>
            <DialogDescription>
              {linkTarget ? `${linkTarget.employeeName} (${linkTarget.employeeCode})` : ""}
            </DialogDescription>
          </DialogHeader>
          <div className="py-2">
            <Select value={selectedUserId} onValueChange={setSelectedUserId}>
              <SelectTrigger>
                <SelectValue placeholder="Select a login account" />
              </SelectTrigger>
              <SelectContent>
                {linkableUsers.map((u) => (
                  <SelectItem key={u.id} value={String(u.id)}>
                    {u.name} · {u.email}
                    {u.linkedCount > 0 ? ` (linked ×${u.linkedCount})` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="mt-2 text-xs text-muted-foreground">
              Only non-service logins are listed. A login already linked in another entity can be linked again here.
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setLinkTarget(null)}>
              Cancel
            </Button>
            <Button disabled={!selectedUserId} onClick={confirmLink}>
              Link
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function StatCard({ label, value, highlight }: { label: string; value?: number; highlight?: boolean }) {
  return (
    <Card className={highlight ? "border-destructive/50" : undefined}>
      <CardContent className="flex flex-col gap-1 p-4">
        <span className="text-xs text-muted-foreground">{label}</span>
        <span className={`text-2xl font-semibold ${highlight ? "text-destructive" : ""}`}>{value ?? "—"}</span>
      </CardContent>
    </Card>
  )
}

function summarizeDetail(detail: Record<string, unknown>): string {
  const parts: string[] = []
  if (detail.employeeName) parts.push(String(detail.employeeName))
  if (detail.userName) parts.push(`→ ${detail.userName}`)
  if (detail.accountType) parts.push(`type: ${detail.accountType}`)
  if (detail.from && detail.to) parts.push(`${detail.from} → ${detail.to}`)
  if (detail.entityId != null) parts.push(`entity ${detail.entityId}`)
  return parts.join(" · ") || "—"
}
