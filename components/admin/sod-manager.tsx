"use client"

import { useMemo, useState } from "react"
import useSWR from "swr"
import { fetcher } from "@/lib/fetcher"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
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
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Loader2, Plus, RefreshCw, ShieldAlert, ShieldCheck, ShieldOff, Trash2 } from "lucide-react"
import { toast } from "sonner"

// -----------------------------------------------------------------------------
// SPEC 13 — Segregation of Duties admin console.
//   - Conflicts tab : the configurable conflict matrix (enable/disable,
//                     enforcement, severity) plus custom conflict authoring.
//   - Violations tab: users who currently hold an incompatible pair of duties.
//   - Audit tab     : append-only log of config changes, blocked/overridden
//                     assignments, scans and waivers.
// -----------------------------------------------------------------------------

type Severity = "low" | "medium" | "high" | "critical"
type Enforcement = "block" | "warn"

type Duty = { key: string; label: string; domain: string; side: "create" | "approve"; description: string }

type Conflict = {
  key: string
  label: string
  description: string
  dutyA: string
  dutyB: string
  severity: Severity
  enforcement: Enforcement
  enabled: boolean
  custom: boolean
}

type Violation = {
  id: number
  userId: number
  userName: string | null
  conflictKey: string
  conflictLabel: string | null
  dutyA: string | null
  dutyB: string | null
  severity: Severity
  enforcement: Enforcement
  status: "open" | "waived" | "resolved"
  note: string | null
  detectedAt: string
  resolvedAt: string | null
}

type AuditRow = {
  id: number
  action: string
  actorName: string | null
  targetUserName: string | null
  conflictKey: string | null
  summary: string | null
  createdAt: string
}

type ApiResponse = {
  duties: Duty[]
  severities: Severity[]
  enforcements: Enforcement[]
  conflicts: Conflict[]
  violations: Violation[]
  audit: AuditRow[]
}

const SEVERITY_STYLES: Record<Severity, string> = {
  low: "bg-muted text-muted-foreground",
  medium: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  high: "bg-orange-100 text-orange-800 dark:bg-orange-950 dark:text-orange-300",
  critical: "bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-300",
}

const ACTION_LABEL: Record<string, string> = {
  config_updated: "Config updated",
  custom_conflict_created: "Custom conflict created",
  custom_conflict_deleted: "Custom conflict deleted",
  assignment_blocked: "Assignment blocked",
  assignment_overridden: "Assignment overridden",
  scan_run: "Scan run",
  violation_waived: "Violation waived",
  violation_reopened: "Violation re-opened",
}

export function SodManager() {
  const { data, isLoading, mutate } = useSWR<ApiResponse>("/api/admin/sod", fetcher)
  const [busy, setBusy] = useState<string | null>(null)

  const dutyLabel = useMemo(() => {
    const m = new Map<string, string>()
    for (const d of data?.duties ?? []) m.set(d.key, d.label)
    return (k: string | null) => (k ? (m.get(k) ?? k) : "—")
  }, [data?.duties])

  const conflicts = data?.conflicts ?? []
  const violations = data?.violations ?? []
  const audit = data?.audit ?? []
  const openCount = violations.filter((v) => v.status === "open").length

  async function patchConflict(key: string, patch: Partial<Pick<Conflict, "enabled" | "enforcement" | "severity">>) {
    setBusy(key)
    mutate(
      (curr) =>
        curr ? { ...curr, conflicts: curr.conflicts.map((c) => (c.key === key ? { ...c, ...patch } : c)) } : curr,
      { revalidate: false },
    )
    try {
      const res = await fetch("/api/admin/sod", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conflictKey: key, ...patch }),
      })
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Update failed")
      toast.success("Conflict updated")
      mutate()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Update failed")
      mutate()
    } finally {
      setBusy(null)
    }
  }

  async function deleteConflict(key: string) {
    setBusy(key)
    try {
      const res = await fetch(`/api/admin/sod/conflicts/${encodeURIComponent(key)}`, { method: "DELETE" })
      if (!res.ok) throw new Error("Delete failed")
      toast.success("Custom conflict deleted")
      mutate()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Delete failed")
    } finally {
      setBusy(null)
    }
  }

  async function runScan() {
    setBusy("scan")
    try {
      const res = await fetch("/api/admin/sod/scan", { method: "POST" })
      if (!res.ok) throw new Error("Scan failed")
      const json = await res.json()
      toast.success(`Scan complete — ${json.violations?.length ?? 0} active violation(s)`)
      mutate()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Scan failed")
    } finally {
      setBusy(null)
    }
  }

  async function setViolation(id: number, status: "open" | "waived", note?: string) {
    setBusy(`v-${id}`)
    try {
      const res = await fetch(`/api/admin/sod/violations/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status, note }),
      })
      if (!res.ok) throw new Error("Update failed")
      toast.success(status === "waived" ? "Violation waived" : "Violation re-opened")
      mutate()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Update failed")
    } finally {
      setBusy(null)
    }
  }

  return (
    <Tabs defaultValue="conflicts" className="flex flex-col gap-4">
      <TabsList className="self-start">
        <TabsTrigger value="conflicts">Conflict matrix</TabsTrigger>
        <TabsTrigger value="violations">
          Violations
          {openCount > 0 && (
            <Badge variant="secondary" className="ml-2">
              {openCount}
            </Badge>
          )}
        </TabsTrigger>
        <TabsTrigger value="audit">Audit log</TabsTrigger>
      </TabsList>

      {/* Conflict matrix -------------------------------------------------- */}
      <TabsContent value="conflicts" className="flex flex-col gap-3">
        <div className="flex justify-end">
          <NewConflictDialog duties={data?.duties ?? []} severities={data?.severities ?? []} onCreated={() => mutate()} />
        </div>
        {isLoading ? (
          <Loading label="Loading conflicts…" />
        ) : (
          conflicts.map((c) => (
            <Card key={c.key}>
              <CardHeader className="flex flex-col gap-3">
                <div className="flex flex-row items-start justify-between gap-4">
                  <div className="flex flex-col gap-1.5">
                    <div className="flex flex-wrap items-center gap-2">
                      {c.enabled ? (
                        <ShieldCheck className="h-4 w-4 text-emerald-600" aria-hidden />
                      ) : (
                        <ShieldOff className="h-4 w-4 text-muted-foreground" aria-hidden />
                      )}
                      <CardTitle className="text-base">{c.label}</CardTitle>
                      <Badge className={SEVERITY_STYLES[c.severity]} variant="secondary">
                        {c.severity}
                      </Badge>
                      {c.custom && <Badge variant="outline">custom</Badge>}
                    </div>
                    <CardDescription className="max-w-2xl">{c.description}</CardDescription>
                    <p className="text-xs text-muted-foreground">
                      {dutyLabel(c.dutyA)} <span aria-hidden>&harr;</span> {dutyLabel(c.dutyB)}
                    </p>
                  </div>
                  <div className="flex items-center gap-2 pt-0.5">
                    {busy === c.key && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
                    <Switch
                      checked={c.enabled}
                      disabled={busy === c.key}
                      onCheckedChange={(v) => patchConflict(c.key, { enabled: v })}
                      aria-label={`Enable ${c.label}`}
                    />
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-4">
                  <div className="flex items-center gap-2">
                    <Label className="text-xs text-muted-foreground">Enforcement</Label>
                    <Select
                      value={c.enforcement}
                      onValueChange={(v) => patchConflict(c.key, { enforcement: v as Enforcement })}
                    >
                      <SelectTrigger className="h-8 w-28">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="block">Block</SelectItem>
                        <SelectItem value="warn">Warn only</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="flex items-center gap-2">
                    <Label className="text-xs text-muted-foreground">Severity</Label>
                    <Select value={c.severity} onValueChange={(v) => patchConflict(c.key, { severity: v as Severity })}>
                      <SelectTrigger className="h-8 w-28">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {(data?.severities ?? []).map((s) => (
                          <SelectItem key={s} value={s}>
                            {s}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  {c.custom && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="ml-auto text-destructive hover:text-destructive"
                      disabled={busy === c.key}
                      onClick={() => deleteConflict(c.key)}
                    >
                      <Trash2 className="mr-1.5 h-3.5 w-3.5" /> Delete
                    </Button>
                  )}
                </div>
              </CardHeader>
            </Card>
          ))
        )}
      </TabsContent>

      {/* Violations ------------------------------------------------------- */}
      <TabsContent value="violations">
        <Card>
          <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
            <div>
              <CardTitle className="text-base">Segregation-of-duties violations</CardTitle>
              <CardDescription>
                Users who currently hold an incompatible pair of duties. Run a scan to refresh after permission or
                approval changes.
              </CardDescription>
            </div>
            <Button variant="outline" size="sm" onClick={runScan} disabled={busy === "scan"}>
              {busy === "scan" ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
              )}
              Run scan
            </Button>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <Loading label="Loading violations…" />
            ) : violations.length === 0 ? (
              <div className="flex flex-col items-center gap-2 py-10 text-center text-sm text-muted-foreground">
                <ShieldCheck className="h-8 w-8 text-emerald-600" aria-hidden />
                No active violations. Run a scan to re-check.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>User</TableHead>
                      <TableHead>Conflict</TableHead>
                      <TableHead>Duties</TableHead>
                      <TableHead>Severity</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="text-right">Action</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {violations.map((v) => (
                      <TableRow key={v.id}>
                        <TableCell className="font-medium">{v.userName || `#${v.userId}`}</TableCell>
                        <TableCell>
                          <span className="flex items-center gap-1.5">
                            <ShieldAlert className="h-3.5 w-3.5 text-rose-600" aria-hidden />
                            {v.conflictLabel || v.conflictKey}
                          </span>
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {dutyLabel(v.dutyA)} + {dutyLabel(v.dutyB)}
                        </TableCell>
                        <TableCell>
                          <Badge className={SEVERITY_STYLES[v.severity]} variant="secondary">
                            {v.severity}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          {v.status === "waived" ? (
                            <Badge variant="outline">Waived</Badge>
                          ) : (
                            <Badge className="bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-300" variant="secondary">
                              Open
                            </Badge>
                          )}
                        </TableCell>
                        <TableCell className="text-right">
                          {v.status === "waived" ? (
                            <Button
                              variant="ghost"
                              size="sm"
                              disabled={busy === `v-${v.id}`}
                              onClick={() => setViolation(v.id, "open")}
                            >
                              Re-open
                            </Button>
                          ) : (
                            <Button
                              variant="ghost"
                              size="sm"
                              disabled={busy === `v-${v.id}`}
                              onClick={() => setViolation(v.id, "waived", "Accepted by admin")}
                            >
                              Waive
                            </Button>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      </TabsContent>

      {/* Audit ------------------------------------------------------------ */}
      <TabsContent value="audit">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Audit log</CardTitle>
            <CardDescription>Every SoD configuration change, blocked or overridden assignment, scan and waiver.</CardDescription>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <Loading label="Loading audit log…" />
            ) : audit.length === 0 ? (
              <p className="py-6 text-sm text-muted-foreground">No audit entries yet.</p>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>When</TableHead>
                      <TableHead>Action</TableHead>
                      <TableHead>Actor</TableHead>
                      <TableHead>Detail</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {audit.map((a) => (
                      <TableRow key={a.id}>
                        <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                          {new Date(a.createdAt).toLocaleString()}
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline">{ACTION_LABEL[a.action] ?? a.action}</Badge>
                        </TableCell>
                        <TableCell className="text-muted-foreground">{a.actorName || "—"}</TableCell>
                        <TableCell className="text-muted-foreground">{a.summary || "—"}</TableCell>
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
  )
}

function Loading({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
      <Loader2 className="h-4 w-4 animate-spin" /> {label}
    </div>
  )
}

function NewConflictDialog({
  duties,
  severities,
  onCreated,
}: {
  duties: Duty[]
  severities: Severity[]
  onCreated: () => void
}) {
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [label, setLabel] = useState("")
  const [description, setDescription] = useState("")
  const [dutyA, setDutyA] = useState("")
  const [dutyB, setDutyB] = useState("")
  const [severity, setSeverity] = useState<Severity>("high")
  const [enforcement, setEnforcement] = useState<Enforcement>("block")

  async function submit() {
    if (!label.trim() || !dutyA || !dutyB) {
      toast.error("Label and both duties are required")
      return
    }
    if (dutyA === dutyB) {
      toast.error("Pick two different duties")
      return
    }
    setSaving(true)
    try {
      const res = await fetch("/api/admin/sod", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label, description, dutyA, dutyB, severity, enforcement }),
      })
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Create failed")
      toast.success("Custom conflict created")
      setOpen(false)
      setLabel("")
      setDescription("")
      setDutyA("")
      setDutyB("")
      onCreated()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Create failed")
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus className="mr-1.5 h-3.5 w-3.5" /> New conflict
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New conflict rule</DialogTitle>
          <DialogDescription>Define a custom incompatible pair of duties.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="sod-label">Label</Label>
            <Input id="sod-label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Create journal + approve payment" />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="sod-desc">Description</Label>
            <Textarea id="sod-desc" value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label>Duty A</Label>
              <Select value={dutyA} onValueChange={setDutyA}>
                <SelectTrigger>
                  <SelectValue placeholder="Select duty" />
                </SelectTrigger>
                <SelectContent>
                  {duties.map((d) => (
                    <SelectItem key={d.key} value={d.key}>
                      {d.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>Duty B</Label>
              <Select value={dutyB} onValueChange={setDutyB}>
                <SelectTrigger>
                  <SelectValue placeholder="Select duty" />
                </SelectTrigger>
                <SelectContent>
                  {duties.map((d) => (
                    <SelectItem key={d.key} value={d.key}>
                      {d.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label>Severity</Label>
              <Select value={severity} onValueChange={(v) => setSeverity(v as Severity)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {severities.map((s) => (
                    <SelectItem key={s} value={s}>
                      {s}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>Enforcement</Label>
              <Select value={enforcement} onValueChange={(v) => setEnforcement(v as Enforcement)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="block">Block</SelectItem>
                  <SelectItem value="warn">Warn only</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={saving}>
            {saving && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
