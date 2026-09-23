"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import {
  AlertTriangle,
  CheckCircle2,
  CircleHelp,
  Clock,
  LifeBuoy,
  Loader2,
  Play,
  RefreshCw,
  Save,
  ShieldAlert,
  Siren,
  Waypoints,
} from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DR_DRILL_TYPES,
  DR_READINESS_LABELS,
  DR_SEVERITIES,
  DR_SEVERITY_LABELS,
  type DrDrillStatus,
  type DrDrillType,
  type DrIncidentStatus,
  type DrReadiness,
  type DrSeverity,
  formatDuration,
  nextIncidentStatuses,
  rollUpReadiness,
} from "@/lib/dr/model"

type Service = {
  key: string
  label: string
  description: string
  backupScope: string | null
  tier: string
  rpoMinutes: number
  rtoMinutes: number
  recoveryMethod: string
  failoverStrategy: string
  readiness: DrReadiness
  reasons: string[]
  recoveryPointAgeMinutes: number | null
  tenantsWithBackup: number
  tenantsTotal: number
  lastRestorePassed: boolean | null
  lastRestoreTestAt: string | null
  lastDrillStatus: DrDrillStatus | null
  lastDrillAt: string | null
  measuredRtoMinutes: number | null
}

type Drill = {
  id: number
  serviceKey: string
  drillType: DrDrillType
  status: DrDrillStatus
  backupRunId: number | null
  measuredRtoMinutes: number | null
  recoveryPointAgeMinutes: number | null
  summary: string
  issues: string[]
  triggeredByName: string | null
  createdAt: string
}

type Incident = {
  id: number
  reference: string
  title: string
  severity: DrSeverity
  status: DrIncidentStatus
  serviceKey: string | null
  summary: string | null
  declaredByName: string | null
  declaredAt: string
  resolvedAt: string | null
  closedAt: string | null
  updatedAt: string
}

type IncidentEvent = {
  id: number
  kind: string
  fromStatus: DrIncidentStatus | null
  toStatus: DrIncidentStatus | null
  message: string
  actorName: string | null
  createdAt: string
}

const DRILL_LABELS: Record<DrDrillType, string> = {
  restore: "Restore",
  failover: "Failover",
  tabletop: "Tabletop",
}

function fmtDate(value: string | null): string {
  if (!value) return "—"
  return String(value).replace("T", " ").slice(0, 16)
}

function fmtAge(minutes: number | null): string {
  if (minutes == null) return "—"
  return `${formatDuration(minutes)} ago`
}

function readinessBadgeVariant(level: DrReadiness): "default" | "destructive" | "secondary" | "outline" {
  if (level === "ready") return "default"
  if (level === "not_ready") return "destructive"
  if (level === "at_risk") return "secondary"
  return "outline"
}

function ReadinessIcon({ level }: { level: DrReadiness }) {
  if (level === "ready") return <CheckCircle2 className="size-4 text-primary" />
  if (level === "not_ready") return <ShieldAlert className="size-4 text-destructive" />
  if (level === "at_risk") return <AlertTriangle className="size-4 text-amber-500" />
  return <CircleHelp className="size-4 text-muted-foreground" />
}

const SEVERITY_VARIANT: Record<DrSeverity, "destructive" | "secondary" | "outline"> = {
  sev1: "destructive",
  sev2: "secondary",
  sev3: "outline",
}

const INCIDENT_STATUS_LABEL: Record<DrIncidentStatus, string> = {
  declared: "Declared",
  investigating: "Investigating",
  mitigating: "Mitigating",
  recovered: "Recovered",
  closed: "Closed",
}

export function DisasterRecoveryConsole({ canManage }: { canManage: boolean }) {
  const [services, setServices] = useState<Service[]>([])
  const [drills, setDrills] = useState<Drill[]>([])
  const [incidents, setIncidents] = useState<Incident[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [drafts, setDrafts] = useState<Record<string, Service>>({})
  const [drillType, setDrillType] = useState<Record<string, DrDrillType>>({})

  // Declare-incident dialog
  const [declareOpen, setDeclareOpen] = useState(false)
  const [incTitle, setIncTitle] = useState("")
  const [incSeverity, setIncSeverity] = useState<DrSeverity>("sev2")
  const [incService, setIncService] = useState<string>("none")
  const [incSummary, setIncSummary] = useState("")

  // Incident detail dialog
  const [openIncidentId, setOpenIncidentId] = useState<number | null>(null)
  const [incidentDetail, setIncidentDetail] = useState<{ incident: Incident; events: IncidentEvent[] } | null>(null)
  const [note, setNote] = useState("")

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch("/api/platform/disaster-recovery", { cache: "no-store" })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || "Unable to load disaster recovery")
      setServices(data.services ?? [])
      setDrills(data.drills ?? [])
      setIncidents(data.incidents ?? [])
      const nextDrafts: Record<string, Service> = {}
      for (const s of data.services ?? []) nextDrafts[s.key] = s
      setDrafts(nextDrafts)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to load disaster recovery")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const posture = useMemo(() => rollUpReadiness(services.map((s) => s.readiness)), [services])
  const openIncidents = useMemo(() => incidents.filter((i) => i.status !== "closed"), [incidents])

  const setDraft = (key: string, patch: Partial<Service>) =>
    setDrafts((cur) => ({ ...cur, [key]: { ...cur[key], ...patch } }))

  async function saveService(key: string) {
    const s = drafts[key]
    if (!s) return
    setBusy(`save:${key}`)
    try {
      const res = await fetch("/api/platform/disaster-recovery", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          serviceKey: key,
          rpoMinutes: s.rpoMinutes,
          rtoMinutes: s.rtoMinutes,
          recoveryMethod: s.recoveryMethod,
          failoverStrategy: s.failoverStrategy,
          tier: s.tier,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || "Unable to save")
      toast.success(`${s.label} objectives saved`)
      await load()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to save")
    } finally {
      setBusy(null)
    }
  }

  async function runDrill(key: string) {
    const type = drillType[key] ?? "restore"
    setBusy(`drill:${key}`)
    try {
      const res = await fetch("/api/platform/disaster-recovery/drills", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serviceKey: key, drillType: type }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || "Drill failed")
      const st = data.drill?.status
      if (st === "passed") toast.success(`${DRILL_LABELS[type]} drill passed`)
      else if (st === "partial") toast.warning(`${DRILL_LABELS[type]} drill partially succeeded`)
      else toast.error(`${DRILL_LABELS[type]} drill failed: ${(data.drill?.issues ?? []).slice(0, 1).join("") || "see history"}`)
      await load()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Drill failed")
    } finally {
      setBusy(null)
    }
  }

  async function declare() {
    if (!incTitle.trim()) {
      toast.error("An incident title is required")
      return
    }
    setBusy("declare")
    try {
      const res = await fetch("/api/platform/disaster-recovery/incidents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: incTitle.trim(),
          severity: incSeverity,
          serviceKey: incService === "none" ? null : incService,
          summary: incSummary.trim() || null,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || "Unable to declare incident")
      toast.success(`Incident ${data.incident?.reference ?? ""} declared`)
      setDeclareOpen(false)
      setIncTitle("")
      setIncSummary("")
      setIncSeverity("sev2")
      setIncService("none")
      await load()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to declare incident")
    } finally {
      setBusy(null)
    }
  }

  const loadIncident = useCallback(async (id: number) => {
    setOpenIncidentId(id)
    setIncidentDetail(null)
    try {
      const res = await fetch(`/api/platform/disaster-recovery/incidents/${id}`, { cache: "no-store" })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || "Unable to load incident")
      setIncidentDetail(data)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to load incident")
      setOpenIncidentId(null)
    }
  }, [])

  async function transition(id: number, status: DrIncidentStatus) {
    setBusy(`inc:${id}`)
    try {
      const res = await fetch(`/api/platform/disaster-recovery/incidents/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "transition", status }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || "Unable to update incident")
      toast.success(`Incident moved to ${INCIDENT_STATUS_LABEL[status]}`)
      await Promise.all([loadIncident(id), load()])
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to update incident")
    } finally {
      setBusy(null)
    }
  }

  async function addNote(id: number) {
    if (!note.trim()) return
    setBusy(`note:${id}`)
    try {
      const res = await fetch(`/api/platform/disaster-recovery/incidents/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "note", message: note.trim() }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || "Unable to add note")
      setNote("")
      await loadIncident(id)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to add note")
    } finally {
      setBusy(null)
    }
  }

  if (loading && services.length === 0) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Loading disaster-recovery posture…
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Posture banner */}
      <div className="flex flex-col gap-3 rounded-xl border border-primary/20 bg-primary/5 p-4 text-sm sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <ReadinessIcon level={posture} />
          <div>
            <p className="font-medium">
              Overall recovery posture: {DR_READINESS_LABELS[posture]}
            </p>
            <p className="text-xs text-muted-foreground">
              Derived from live backup recency, restore verification and drill history — never asserted.
              {openIncidents.length > 0 ? ` ${openIncidents.length} open incident(s).` : " No open incidents."}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {canManage && (
            <Button size="sm" variant="destructive" onClick={() => setDeclareOpen(true)}>
              <Siren className="size-4" /> Declare incident
            </Button>
          )}
          <Button size="icon" variant="outline" onClick={() => void load()} aria-label="Refresh">
            <RefreshCw className="size-4" />
          </Button>
        </div>
      </div>

      <Tabs defaultValue="services">
        <TabsList>
          <TabsTrigger value="services">Recovery plan</TabsTrigger>
          <TabsTrigger value="drills">Drills</TabsTrigger>
          <TabsTrigger value="incidents">
            Incidents{openIncidents.length > 0 ? ` (${openIncidents.length})` : ""}
          </TabsTrigger>
        </TabsList>

        {/* --- Recovery plan --- */}
        <TabsContent value="services" className="mt-4">
          <div className="grid gap-4 xl:grid-cols-2">
            {services.map((s) => {
              const draft = drafts[s.key] ?? s
              const stateless = s.backupScope == null
              return (
                <section key={s.key} className="flex flex-col gap-4 rounded-xl border border-border bg-card p-5">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <LifeBuoy className="size-4 text-muted-foreground" />
                        <h2 className="font-semibold">{s.label}</h2>
                        <Badge variant="outline" className="text-[10px] capitalize">{s.tier}</Badge>
                        <Badge variant={readinessBadgeVariant(s.readiness)} className="inline-flex items-center gap-1 text-[10px]">
                          <ReadinessIcon level={s.readiness} />
                          {DR_READINESS_LABELS[s.readiness]}
                        </Badge>
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">{s.description}</p>
                    </div>
                  </div>

                  {/* Objectives */}
                  <div className="grid grid-cols-2 gap-3">
                    <label className="flex flex-col gap-1 text-xs font-medium">
                      RPO — max data loss (min)
                      <Input
                        type="number"
                        min={0}
                        max={525600}
                        value={draft.rpoMinutes}
                        disabled={!canManage || stateless}
                        onChange={(e) => setDraft(s.key, { rpoMinutes: Number(e.target.value) })}
                      />
                      <span className="text-[10px] font-normal text-muted-foreground">= {formatDuration(draft.rpoMinutes)}</span>
                    </label>
                    <label className="flex flex-col gap-1 text-xs font-medium">
                      RTO — max downtime (min)
                      <Input
                        type="number"
                        min={1}
                        max={525600}
                        value={draft.rtoMinutes}
                        disabled={!canManage}
                        onChange={(e) => setDraft(s.key, { rtoMinutes: Number(e.target.value) })}
                      />
                      <span className="text-[10px] font-normal text-muted-foreground">= {formatDuration(draft.rtoMinutes)}</span>
                    </label>
                  </div>

                  <label className="flex flex-col gap-1 text-xs font-medium">
                    Recovery procedure
                    <Textarea
                      rows={2}
                      value={draft.recoveryMethod}
                      disabled={!canManage}
                      onChange={(e) => setDraft(s.key, { recoveryMethod: e.target.value })}
                    />
                  </label>
                  <label className="flex flex-col gap-1 text-xs font-medium">
                    Failover strategy
                    <Textarea
                      rows={2}
                      value={draft.failoverStrategy}
                      disabled={!canManage}
                      onChange={(e) => setDraft(s.key, { failoverStrategy: e.target.value })}
                    />
                  </label>

                  {/* Live signals */}
                  <div className="grid grid-cols-2 gap-x-4 gap-y-1 rounded-lg bg-muted/40 p-3 text-[11px] text-muted-foreground">
                    <span>Recovery point</span>
                    <span className="text-right font-medium text-foreground">{stateless ? "N/A (stateless)" : fmtAge(s.recoveryPointAgeMinutes)}</span>
                    <span>Backup coverage</span>
                    <span className="text-right font-medium text-foreground">{stateless ? "N/A" : `${s.tenantsWithBackup}/${s.tenantsTotal} tenants`}</span>
                    <span>Restore verified</span>
                    <span className="text-right font-medium text-foreground">
                      {stateless ? "N/A" : s.lastRestorePassed == null ? "Never" : s.lastRestorePassed ? "Passed" : "Failed"}
                    </span>
                    <span>Last drill</span>
                    <span className="text-right font-medium capitalize text-foreground">
                      {s.lastDrillStatus == null ? "Never" : `${s.lastDrillStatus} · ${fmtDate(s.lastDrillAt)}`}
                    </span>
                    <span>Data verification</span>
                    <span className="text-right font-medium text-foreground">{fmtDate(s.lastRestoreTestAt)}</span>
                  </div>

                  {s.reasons.length > 0 && (
                    <ul className="flex flex-col gap-1 text-[11px] text-muted-foreground">
                      {s.reasons.map((r, i) => (
                        <li key={i} className="flex items-start gap-1.5">
                          <span className="mt-1 size-1 shrink-0 rounded-full bg-current" />
                          {r}
                        </li>
                      ))}
                    </ul>
                  )}

                  {canManage && (
                    <div className="mt-auto flex flex-wrap items-center gap-2">
                      <Button size="sm" variant="outline" onClick={() => void saveService(s.key)} disabled={busy === `save:${s.key}`}>
                        {busy === `save:${s.key}` ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />}
                        Save objectives
                      </Button>
                      <div className="ml-auto flex items-center gap-2">
                        <Select
                          value={drillType[s.key] ?? "restore"}
                          onValueChange={(v) => setDrillType((cur) => ({ ...cur, [s.key]: v as DrDrillType }))}
                        >
                          <SelectTrigger className="h-9 w-32">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {DR_DRILL_TYPES.filter((t) => !(stateless && t === "restore")).map((t) => (
                              <SelectItem key={t} value={t}>{DRILL_LABELS[t]}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <Button size="sm" onClick={() => void runDrill(s.key)} disabled={busy === `drill:${s.key}`}>
                          {busy === `drill:${s.key}` ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}
                          Run drill
                        </Button>
                      </div>
                    </div>
                  )}
                </section>
              )
            })}
          </div>
        </TabsContent>

        {/* --- Drills --- */}
        <TabsContent value="drills" className="mt-4">
          <section className="rounded-xl border border-border bg-card">
            <div className="flex items-center gap-2 border-b border-border px-5 py-4">
              <Waypoints className="size-4 text-muted-foreground" />
              <h2 className="font-semibold">Drill history</h2>
              <span className="text-xs text-muted-foreground">{drills.length} recorded</span>
            </div>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Service</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Measured RTO</TableHead>
                    <TableHead>Recovery point</TableHead>
                    <TableHead>Summary</TableHead>
                    <TableHead>By</TableHead>
                    <TableHead>When</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {drills.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={8} className="py-8 text-center text-sm text-muted-foreground">
                        No drills have been run yet.
                      </TableCell>
                    </TableRow>
                  ) : (
                    drills.map((d) => (
                      <TableRow key={d.id}>
                        <TableCell className="text-sm font-medium capitalize">{d.serviceKey}</TableCell>
                        <TableCell className="text-xs">{DRILL_LABELS[d.drillType]}</TableCell>
                        <TableCell>
                          <Badge
                            variant={d.status === "passed" ? "default" : d.status === "failed" ? "destructive" : "secondary"}
                            className="text-[10px]"
                          >
                            {d.status}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {d.measuredRtoMinutes == null ? "—" : formatDuration(d.measuredRtoMinutes)}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">{fmtAge(d.recoveryPointAgeMinutes)}</TableCell>
                        <TableCell className="max-w-[22rem] text-xs text-muted-foreground">{d.summary}</TableCell>
                        <TableCell className="text-xs text-muted-foreground">{d.triggeredByName ?? "—"}</TableCell>
                        <TableCell className="text-xs text-muted-foreground">{fmtDate(d.createdAt)}</TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>
          </section>
        </TabsContent>

        {/* --- Incidents --- */}
        <TabsContent value="incidents" className="mt-4">
          <section className="rounded-xl border border-border bg-card">
            <div className="flex items-center gap-2 border-b border-border px-5 py-4">
              <Siren className="size-4 text-muted-foreground" />
              <h2 className="font-semibold">Incident workflow</h2>
              <span className="text-xs text-muted-foreground">{incidents.length} total</span>
            </div>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Reference</TableHead>
                    <TableHead>Title</TableHead>
                    <TableHead>Severity</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Service</TableHead>
                    <TableHead>Declared</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {incidents.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={7} className="py-8 text-center text-sm text-muted-foreground">
                        No incidents declared.
                      </TableCell>
                    </TableRow>
                  ) : (
                    incidents.map((i) => (
                      <TableRow key={i.id}>
                        <TableCell className="font-mono text-xs">{i.reference}</TableCell>
                        <TableCell className="text-sm font-medium">{i.title}</TableCell>
                        <TableCell>
                          <Badge variant={SEVERITY_VARIANT[i.severity]} className="text-[10px]">
                            {DR_SEVERITY_LABELS[i.severity]}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <Badge variant={i.status === "closed" ? "outline" : "secondary"} className="text-[10px]">
                            {INCIDENT_STATUS_LABEL[i.status]}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-xs capitalize text-muted-foreground">{i.serviceKey ?? "—"}</TableCell>
                        <TableCell className="text-xs text-muted-foreground">{fmtDate(i.declaredAt)}</TableCell>
                        <TableCell className="text-right">
                          <Button size="sm" variant="ghost" onClick={() => void loadIncident(i.id)}>
                            <Clock className="size-3.5" /> Timeline
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>
          </section>
        </TabsContent>
      </Tabs>

      {/* Declare incident dialog */}
      <Dialog open={declareOpen} onOpenChange={setDeclareOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Declare disaster-recovery incident</DialogTitle>
            <DialogDescription>Opens the incident timeline and starts the recovery workflow.</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <label className="flex flex-col gap-1 text-xs font-medium">
              Title
              <Input value={incTitle} onChange={(e) => setIncTitle(e.target.value)} placeholder="Primary database unavailable" />
            </label>
            <div className="grid grid-cols-2 gap-3">
              <label className="flex flex-col gap-1 text-xs font-medium">
                Severity
                <Select value={incSeverity} onValueChange={(v) => setIncSeverity(v as DrSeverity)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {DR_SEVERITIES.map((s) => (
                      <SelectItem key={s} value={s}>{DR_SEVERITY_LABELS[s]}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </label>
              <label className="flex flex-col gap-1 text-xs font-medium">
                Affected service
                <Select value={incService} onValueChange={setIncService}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Not specified</SelectItem>
                    {services.map((s) => (
                      <SelectItem key={s.key} value={s.key}>{s.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </label>
            </div>
            <label className="flex flex-col gap-1 text-xs font-medium">
              Summary
              <Textarea rows={3} value={incSummary} onChange={(e) => setIncSummary(e.target.value)} placeholder="What happened and current impact" />
            </label>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeclareOpen(false)}>Cancel</Button>
            <Button variant="destructive" onClick={() => void declare()} disabled={busy === "declare"}>
              {busy === "declare" ? <Loader2 className="size-4 animate-spin" /> : <Siren className="size-4" />}
              Declare
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Incident detail dialog */}
      <Dialog open={openIncidentId != null} onOpenChange={(o) => !o && setOpenIncidentId(null)}>
        <DialogContent className="max-w-2xl">
          {incidentDetail ? (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <span className="font-mono text-sm">{incidentDetail.incident.reference}</span>
                  <Badge variant={SEVERITY_VARIANT[incidentDetail.incident.severity]} className="text-[10px]">
                    {DR_SEVERITY_LABELS[incidentDetail.incident.severity]}
                  </Badge>
                  <Badge variant={incidentDetail.incident.status === "closed" ? "outline" : "secondary"} className="text-[10px]">
                    {INCIDENT_STATUS_LABEL[incidentDetail.incident.status]}
                  </Badge>
                </DialogTitle>
                <DialogDescription>{incidentDetail.incident.title}</DialogDescription>
              </DialogHeader>

              {incidentDetail.incident.summary && (
                <p className="rounded-lg bg-muted/40 p-3 text-xs text-muted-foreground">{incidentDetail.incident.summary}</p>
              )}

              {/* Lifecycle actions */}
              {canManage && nextIncidentStatuses(incidentDetail.incident.status).length > 0 && (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs font-medium text-muted-foreground">Advance:</span>
                  {nextIncidentStatuses(incidentDetail.incident.status).map((st) => (
                    <Button
                      key={st}
                      size="sm"
                      variant={st === "closed" ? "outline" : "secondary"}
                      onClick={() => void transition(incidentDetail.incident.id, st)}
                      disabled={busy === `inc:${incidentDetail.incident.id}`}
                    >
                      {INCIDENT_STATUS_LABEL[st]}
                    </Button>
                  ))}
                </div>
              )}

              {/* Timeline */}
              <div className="max-h-64 overflow-y-auto rounded-lg border border-border">
                <ol className="flex flex-col divide-y divide-border">
                  {incidentDetail.events.map((e) => (
                    <li key={e.id} className="flex flex-col gap-0.5 px-3 py-2">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs font-medium">
                          {e.kind === "status_change"
                            ? `${e.fromStatus ? INCIDENT_STATUS_LABEL[e.fromStatus] : "—"} → ${e.toStatus ? INCIDENT_STATUS_LABEL[e.toStatus] : "—"}`
                            : e.kind === "declared"
                              ? "Declared"
                              : "Note"}
                        </span>
                        <span className="text-[10px] text-muted-foreground">{fmtDate(e.createdAt)}</span>
                      </div>
                      <p className="text-xs text-muted-foreground">{e.message}</p>
                      {e.actorName && <span className="text-[10px] text-muted-foreground">— {e.actorName}</span>}
                    </li>
                  ))}
                </ol>
              </div>

              {/* Add note */}
              {canManage && (
                <div className="flex items-end gap-2">
                  <label className="flex flex-1 flex-col gap-1 text-xs font-medium">
                    Add timeline note
                    <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Update or action taken" />
                  </label>
                  <Button
                    size="sm"
                    onClick={() => void addNote(incidentDetail.incident.id)}
                    disabled={!note.trim() || busy === `note:${incidentDetail.incident.id}`}
                  >
                    Add
                  </Button>
                </div>
              )}
            </>
          ) : (
            <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Loading incident…
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
