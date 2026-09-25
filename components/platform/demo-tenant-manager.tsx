"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Copy, FlaskConical, Loader2, MoreHorizontal, Plus, RotateCcw, Timer, Trash2, Ban, KeyRound } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
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
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import type { DemoTenant } from "@/lib/demo-tenant-store"

type Credentials = { title: string; email: string; password: string }
type Pending = { kind: "cleanup" | "expire"; demo: DemoTenant } | null

async function call(url: string, init: RequestInit) {
  const res = await fetch(url, { ...init, headers: { "Content-Type": "application/json", ...(init.headers ?? {}) } })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data?.error ?? `Request failed (${res.status})`)
  return data
}

function statusBadge(d: DemoTenant) {
  if (d.kind === "template") return <Badge variant="secondary">Template</Badge>
  if (d.status === "cleaned") return <Badge variant="outline">Cleaned</Badge>
  if (d.expired) return <Badge variant="destructive">Expired</Badge>
  return <Badge>Active</Badge>
}

function formatDate(v: string | null) {
  if (!v) return "—"
  const d = new Date(/^\d{4}-\d{2}-\d{2} /.test(v) ? `${v.replace(" ", "T")}Z` : v)
  return Number.isNaN(d.getTime()) ? v : d.toLocaleString()
}

export function DemoTenantManager({ demoTenants, canManage }: { demoTenants: DemoTenant[]; canManage: boolean }) {
  const router = useRouter()
  const [busy, setBusy] = useState<string | null>(null)
  const [label, setLabel] = useState("")
  const [ttlDays, setTtlDays] = useState("14")
  const [credentials, setCredentials] = useState<Credentials | null>(null)
  const [pending, setPending] = useState<Pending>(null)

  const template = demoTenants.find((d) => d.kind === "template" && d.status === "active") ?? null
  const clones = demoTenants.filter((d) => d.kind === "clone")

  async function run(key: string, fn: () => Promise<void>) {
    setBusy(key)
    try {
      await fn()
      router.refresh()
    } catch (err: any) {
      toast.error(err?.message ?? "Request failed")
    } finally {
      setBusy(null)
    }
  }

  const ensureTemplate = () =>
    run("template", async () => {
      await call("/api/platform/demo-tenants", { method: "POST", body: JSON.stringify({ action: "ensure_template" }) })
      toast.success("Demo template is ready")
    })

  const clone = (e: React.FormEvent) => {
    e.preventDefault()
    run("clone", async () => {
      const data = await call("/api/platform/demo-tenants", {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ action: "clone", label, ttlDays: Number(ttlDays) }),
      })
      setLabel("")
      if (data.adminTempPassword) {
        setCredentials({ title: "Demo tenant created", email: data.adminEmail, password: data.adminTempPassword })
      }
      toast.success("Demo tenant cloned")
    })
  }

  const sweep = () =>
    run("sweep", async () => {
      const { summary } = await call("/api/platform/demo-tenants", {
        method: "POST",
        body: JSON.stringify({ action: "cleanup" }),
      })
      if (summary.failed.length) toast.error(`${summary.failed.length} demo(s) could not be cleaned up`)
      toast.success(`Expired ${summary.expired}, purged ${summary.purged}`)
    })

  const act = (demo: DemoTenant, body: Record<string, unknown>, message: string) =>
    run(`${demo.id}`, async () => {
      const data = await call(`/api/platform/demo-tenants/${demo.id}`, { method: "POST", body: JSON.stringify(body) })
      if (data.adminTempPassword && demo.adminEmail) {
        setCredentials({ title: "Credentials rotated", email: demo.adminEmail, password: data.adminTempPassword })
      }
      toast.success(message)
    })

  const confirmPending = () => {
    if (!pending) return
    const { kind, demo } = pending
    setPending(null)
    if (kind === "expire") return act(demo, { action: "expire" }, "Demo tenant expired")
    run(`${demo.id}`, async () => {
      await call(`/api/platform/demo-tenants/${demo.id}`, { method: "DELETE" })
      toast.success("Demo tenant cleaned up")
    })
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <FlaskConical className="size-4" aria-hidden="true" />
              Demo template
            </CardTitle>
            <CardDescription>The source every clone is copied from. It holds synthetic data only.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 text-sm">
            {template ? (
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
                <dt className="text-muted-foreground">Tenant ID</dt>
                <dd className="font-mono">{template.tenantId}</dd>
                <dt className="text-muted-foreground">Seeded</dt>
                <dd>{formatDate(template.seededAt)}</dd>
              </dl>
            ) : (
              <p className="text-muted-foreground">No template yet. It is created automatically on the first clone.</p>
            )}
            {canManage && !template && (
              <Button variant="outline" size="sm" className="self-start" onClick={ensureTemplate} disabled={!!busy}>
                {busy === "template" && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}
                Create template
              </Button>
            )}
          </CardContent>
        </Card>

        {canManage && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Clone a demo tenant</CardTitle>
              <CardDescription>Creates an isolated tenant with a fresh admin login that expires automatically.</CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={clone} className="flex flex-col gap-3">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="demo-label">Label</Label>
                  <Input
                    id="demo-label"
                    value={label}
                    onChange={(e) => setLabel(e.target.value)}
                    placeholder="Acme sales demo"
                    maxLength={120}
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="demo-ttl">Expires after (days)</Label>
                  <Input
                    id="demo-ttl"
                    type="number"
                    min={1}
                    max={90}
                    value={ttlDays}
                    onChange={(e) => setTtlDays(e.target.value)}
                    className="w-32"
                  />
                </div>
                <Button type="submit" className="self-start" disabled={!!busy}>
                  {busy === "clone" ? (
                    <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                  ) : (
                    <Plus className="size-4" aria-hidden="true" />
                  )}
                  Clone demo
                </Button>
              </form>
            </CardContent>
          </Card>
        )}
      </div>

      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-4">
          <div className="flex flex-col gap-1.5">
            <CardTitle className="text-base">Demo clones</CardTitle>
            <CardDescription>Cleanup runs hourly; you can also run it now.</CardDescription>
          </div>
          {canManage && (
            <Button variant="outline" size="sm" onClick={sweep} disabled={!!busy}>
              {busy === "sweep" && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}
              Run cleanup
            </Button>
          )}
        </CardHeader>
        <CardContent>
          {clones.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">No demo tenants have been cloned yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Label</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Admin login</TableHead>
                  <TableHead>Expires</TableHead>
                  <TableHead>Last reset</TableHead>
                  {canManage && <TableHead className="w-10"><span className="sr-only">Actions</span></TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {clones.map((d) => (
                  <TableRow key={d.id}>
                    <TableCell>
                      <div className="font-medium">{d.label ?? "Demo"}</div>
                      <div className="font-mono text-xs text-muted-foreground">tenant #{d.tenantId}</div>
                    </TableCell>
                    <TableCell>{statusBadge(d)}</TableCell>
                    <TableCell className="font-mono text-xs">{d.adminEmail ?? "—"}</TableCell>
                    <TableCell className="text-sm">
                      {d.status === "cleaned" ? formatDate(d.cleanedAt) : formatDate(d.expiresAt)}
                      {d.daysRemaining != null && (
                        <div className="text-xs text-muted-foreground">{d.daysRemaining} day(s) left</div>
                      )}
                    </TableCell>
                    <TableCell className="text-sm">{formatDate(d.lastResetAt)}</TableCell>
                    {canManage && (
                      <TableCell>
                        {d.status !== "cleaned" && (
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button variant="ghost" size="icon" disabled={!!busy} aria-label={`Actions for ${d.label ?? "demo"}`}>
                                {busy === `${d.id}` ? (
                                  <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                                ) : (
                                  <MoreHorizontal className="size-4" aria-hidden="true" />
                                )}
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem onSelect={() => act(d, { action: "extend", days: 7 }, "Extended by 7 days")}>
                                <Timer className="size-4" aria-hidden="true" />
                                Extend 7 days
                              </DropdownMenuItem>
                              <DropdownMenuItem onSelect={() => act(d, { action: "reset" }, "Demo data reset")}>
                                <RotateCcw className="size-4" aria-hidden="true" />
                                Reset data
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                onSelect={() => act(d, { action: "reset", rotateCredentials: true }, "Data reset and credentials rotated")}
                              >
                                <KeyRound className="size-4" aria-hidden="true" />
                                Reset and rotate login
                              </DropdownMenuItem>
                              <DropdownMenuSeparator />
                              {d.status === "active" && (
                                <DropdownMenuItem onSelect={() => setPending({ kind: "expire", demo: d })}>
                                  <Ban className="size-4" aria-hidden="true" />
                                  Expire now
                                </DropdownMenuItem>
                              )}
                              <DropdownMenuItem
                                className="text-destructive focus:text-destructive"
                                onSelect={() => setPending({ kind: "cleanup", demo: d })}
                              >
                                <Trash2 className="size-4" aria-hidden="true" />
                                Clean up
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        )}
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Dialog open={!!credentials} onOpenChange={(open) => !open && setCredentials(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{credentials?.title}</DialogTitle>
            <DialogDescription>
              This temporary password is shown only once. The admin must change it at first sign-in.
            </DialogDescription>
          </DialogHeader>
          {credentials && (
            <dl className="grid grid-cols-[auto_1fr_auto] items-center gap-x-3 gap-y-2 text-sm">
              {(["email", "password"] as const).map((field) => (
                <div key={field} className="contents">
                  <dt className="capitalize text-muted-foreground">{field}</dt>
                  <dd className="break-all font-mono">{credentials[field]}</dd>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Copy ${field}`}
                    onClick={() => navigator.clipboard.writeText(credentials[field]).then(() => toast.success("Copied"))}
                  >
                    <Copy className="size-4" aria-hidden="true" />
                  </Button>
                </div>
              ))}
            </dl>
          )}
          <DialogFooter>
            <Button onClick={() => setCredentials(null)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!pending} onOpenChange={(open) => !open && setPending(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{pending?.kind === "cleanup" ? "Clean up demo tenant?" : "Expire demo tenant?"}</AlertDialogTitle>
            <AlertDialogDescription>
              {pending?.kind === "cleanup"
                ? "This permanently deletes the demo tenant and all of its data. The template is not affected."
                : "Sign-in is blocked immediately and active sessions are revoked. You can extend it later to reactivate."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmPending}>
              {pending?.kind === "cleanup" ? "Clean up" : "Expire now"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
