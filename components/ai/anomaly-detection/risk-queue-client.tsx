"use client"

import { useState } from "react"
import { useSearchParams } from "next/navigation"
import useSWR from "swr"
import { toast } from "sonner"
import { Loader2, Radar, ShieldAlert } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Switch } from "@/components/ui/switch"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Textarea } from "@/components/ui/textarea"
// Mirrors lib/ai/anomaly-detection/model.ts, which imports node:crypto and so
// cannot ship to the browser. The server re-validates every transition.
const ALERT_STATUSES = ["open", "investigating", "confirmed", "dismissed", "resolved"] as const
const ANOMALY_CATEGORIES = ["payment", "invoice", "access", "usage"] as const
const SEVERITIES = ["low", "medium", "high", "critical"] as const
type AlertStatus = (typeof ALERT_STATUSES)[number]
const TRANSITIONS: Record<AlertStatus, AlertStatus[]> = {
  open: ["investigating", "confirmed", "dismissed", "resolved"],
  investigating: ["confirmed", "dismissed", "resolved", "open"],
  confirmed: ["resolved", "dismissed", "investigating"],
  dismissed: ["open", "investigating"],
  resolved: ["open", "investigating"],
}
const canTransitionStatus = (from: AlertStatus, to: AlertStatus) => TRANSITIONS[from]?.includes(to) ?? false
const isTerminal = (s: AlertStatus) => s === "dismissed" || s === "resolved"

type Alert = {
  id: number
  signal: string
  category: string
  entityType: string
  entityId: string
  entityLabel: string | null
  severity: string
  score: number
  method: string
  status: AlertStatus
  title: string
  summary: string | null
  evidence: Record<string, unknown> | null
  occurrenceCount: number
  firstSeenAt: string | null
  lastSeenAt: string | null
  ownerId: number | null
  resolutionNote: string | null
  reviewedBy: number | null
  reviewedAt: string | null
}

type AuditEntry = {
  id: number
  action: string
  fromStatus: string | null
  toStatus: string | null
  actorId: number | null
  note: string | null
  createdAt: string | null
}

const fetcher = async (url: string) => {
  const res = await fetch(url)
  const data = await res.json()
  if (!res.ok) throw new Error(data.error ?? "Request failed")
  return data
}

const SEVERITY_CLASS: Record<string, string> = {
  critical: "bg-destructive text-destructive-foreground",
  high: "bg-orange-600 text-white",
  medium: "bg-amber-500 text-black",
  low: "bg-muted text-muted-foreground",
}

function formatDate(value: string | null) {
  return value ? new Date(value).toLocaleString() : "—"
}

export function RiskQueueClient() {
  const params = useSearchParams()
  const [status, setStatus] = useState("open")
  const [severity, setSeverity] = useState("all")
  const [category, setCategory] = useState("all")
  const [selectedId, setSelectedId] = useState<number | null>(() => {
    const raw = Number(params.get("alert"))
    return Number.isInteger(raw) && raw > 0 ? raw : null
  })
  const [useModel, setUseModel] = useState(false)
  const [scanning, setScanning] = useState(false)

  const qs = new URLSearchParams()
  if (status !== "all") qs.set("status", status)
  if (severity !== "all") qs.set("severity", severity)
  if (category !== "all") qs.set("category", category)

  const alerts = useSWR<{ alerts: Alert[]; counts: Record<string, number> }>(
    `/api/ai/anomaly-detection/alerts?${qs.toString()}`,
    fetcher,
  )
  const scans = useSWR<{ scans: { id: number; status: string; startedAt: string | null; createdCount: number; dedupedCount: number; findingsCount: number; modelScoring: boolean; error: string | null }[]; modelScoringAvailable: boolean }>(
    "/api/ai/anomaly-detection/scan",
    fetcher,
  )

  async function runScan() {
    setScanning(true)
    try {
      const res = await fetch("/api/ai/anomaly-detection/scan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ useModelScoring: useModel }),
      })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error ?? "Scan failed")
      toast.success(`Scan complete: ${body.createdCount ?? 0} new, ${body.dedupedCount ?? 0} merged into existing alerts`)
      alerts.mutate()
      scans.mutate()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Scan failed")
    } finally {
      setScanning(false)
    }
  }

  const lastScan = scans.data?.scans?.[0]
  const counts = alerts.data?.counts ?? {}

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardContent className="flex flex-col gap-4 p-4 md:flex-row md:items-center md:justify-between">
          <div className="flex flex-wrap gap-4 text-sm">
            {ALERT_STATUSES.map((s) => (
              <div key={s} className="flex flex-col">
                <span className="text-muted-foreground capitalize">{s}</span>
                <span className="text-xl font-semibold tabular-nums">{counts[s] ?? 0}</span>
              </div>
            ))}
          </div>
          <div className="flex flex-col gap-2 md:items-end">
            <div className="flex items-center gap-3">
              {scans.data?.modelScoringAvailable ? (
                <div className="flex items-center gap-2">
                  <Switch id="model-scoring" checked={useModel} onCheckedChange={setUseModel} />
                  <Label htmlFor="model-scoring" className="text-sm">
                    Model scoring
                  </Label>
                </div>
              ) : null}
              <Button onClick={runScan} disabled={scanning}>
                {scanning ? <Loader2 className="animate-spin" aria-hidden /> : <Radar aria-hidden />}
                Run scan
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              {lastScan
                ? `Last scan ${formatDate(lastScan.startedAt)} · ${lastScan.status}${lastScan.error ? ` · ${lastScan.error}` : ""}`
                : "No scans yet"}
            </p>
          </div>
        </CardContent>
      </Card>

      <div className="flex flex-wrap gap-2">
        <FilterSelect label="Status" value={status} onChange={setStatus} options={ALERT_STATUSES} />
        <FilterSelect label="Severity" value={severity} onChange={setSeverity} options={SEVERITIES} />
        <FilterSelect label="Category" value={category} onChange={setCategory} options={ANOMALY_CATEGORIES} />
      </div>

      <Card>
        <CardContent className="p-0">
          {alerts.error ? (
            <p className="p-6 text-sm text-destructive">{alerts.error.message}</p>
          ) : alerts.isLoading ? (
            <p className="p-6 text-sm text-muted-foreground">Loading risk queue…</p>
          ) : (alerts.data?.alerts ?? []).length === 0 ? (
            <div className="flex flex-col items-center gap-2 p-10 text-center">
              <ShieldAlert className="size-8 text-muted-foreground" aria-hidden />
              <p className="font-medium">No alerts match these filters</p>
              <p className="text-sm text-muted-foreground">Run a scan to evaluate the latest activity.</p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Severity</TableHead>
                  <TableHead>Alert</TableHead>
                  <TableHead className="hidden md:table-cell">Category</TableHead>
                  <TableHead className="hidden md:table-cell">Seen</TableHead>
                  <TableHead>Owner</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {alerts.data!.alerts.map((a) => (
                  <TableRow key={a.id} className="cursor-pointer" onClick={() => setSelectedId(a.id)}>
                    <TableCell>
                      <Badge className={SEVERITY_CLASS[a.severity]}>{a.severity}</Badge>
                    </TableCell>
                    <TableCell>
                      <button type="button" className="text-left font-medium hover:underline" onClick={() => setSelectedId(a.id)}>
                        {a.title}
                      </button>
                      <div className="text-xs text-muted-foreground">
                        {a.entityLabel ?? `${a.entityType} ${a.entityId}`} · score {a.score.toFixed(2)} · {a.method}
                      </div>
                    </TableCell>
                    <TableCell className="hidden capitalize md:table-cell">{a.category}</TableCell>
                    <TableCell className="hidden tabular-nums md:table-cell">{a.occurrenceCount}×</TableCell>
                    <TableCell>{a.ownerId ? `User #${a.ownerId}` : <span className="text-muted-foreground">Unassigned</span>}</TableCell>
                    <TableCell className="capitalize">{a.status}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <AlertDetail
        alertId={selectedId}
        onClose={() => setSelectedId(null)}
        onChanged={() => alerts.mutate()}
      />
    </div>
  )
}

function FilterSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  options: readonly string[]
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="w-40" aria-label={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="all">All {label.toLowerCase()}</SelectItem>
        {options.map((o) => (
          <SelectItem key={o} value={o} className="capitalize">
            {o}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

function AlertDetail({
  alertId,
  onClose,
  onChanged,
}: {
  alertId: number | null
  onClose: () => void
  onChanged: () => void
}) {
  const { data, error, mutate } = useSWR<{ alert: Alert; audit: AuditEntry[] }>(
    alertId ? `/api/ai/anomaly-detection/alerts/${alertId}` : null,
    fetcher,
  )
  const [toStatus, setToStatus] = useState<string>("")
  const [ownerId, setOwnerId] = useState("")
  const [note, setNote] = useState("")
  const [saving, setSaving] = useState(false)

  const alert = data?.alert
  const nextStatuses = alert ? ALERT_STATUSES.filter((s) => s !== alert.status && canTransitionStatus(alert.status, s)) : []
  const needsNote = toStatus === "dismissed" || toStatus === "resolved"

  async function submit() {
    if (!alert || !toStatus) return
    if (needsNote && !note.trim()) {
      toast.error("A resolution note is required to dismiss or resolve an alert")
      return
    }
    const payload: Record<string, unknown> = { status: toStatus, note: note.trim() || null }
    if (ownerId.trim()) payload.ownerId = Number(ownerId)
    setSaving(true)
    try {
      const res = await fetch(`/api/ai/anomaly-detection/alerts/${alert.id}/review`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error ?? "Review failed")
      toast.success("Review recorded")
      setToStatus("")
      setNote("")
      setOwnerId("")
      mutate()
      onChanged()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Review failed")
    } finally {
      setSaving(false)
    }
  }

  return (
    <Sheet open={alertId != null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>{alert?.title ?? "Alert"}</SheetTitle>
          <SheetDescription>{alert?.summary ?? (error ? error.message : "Loading…")}</SheetDescription>
        </SheetHeader>

        {alert ? (
          <div className="flex flex-col gap-5 px-4 pb-6">
            <dl className="grid grid-cols-2 gap-3 text-sm">
              <Fact label="Severity" value={<Badge className={SEVERITY_CLASS[alert.severity]}>{alert.severity}</Badge>} />
              <Fact label="Score" value={`${alert.score.toFixed(3)} (${alert.method})`} />
              <Fact label="Status" value={<span className="capitalize">{alert.status}</span>} />
              <Fact label="Owner" value={alert.ownerId ? `User #${alert.ownerId}` : "Unassigned"} />
              <Fact label="Entity" value={alert.entityLabel ?? `${alert.entityType} ${alert.entityId}`} />
              <Fact label="Occurrences" value={`${alert.occurrenceCount} · last ${formatDate(alert.lastSeenAt)}`} />
            </dl>

            {alert.resolutionNote ? (
              <div className="rounded-md border p-3 text-sm">
                <p className="font-medium">Resolution</p>
                <p className="text-muted-foreground">{alert.resolutionNote}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Reviewed by User #{alert.reviewedBy ?? "?"} · {formatDate(alert.reviewedAt)}
                </p>
              </div>
            ) : null}

            <section className="flex flex-col gap-2">
              <h3 className="text-sm font-medium">Evidence</h3>
              <pre className="max-h-72 overflow-auto rounded-md bg-muted p-3 text-xs leading-relaxed">
                {JSON.stringify(alert.evidence ?? {}, null, 2)}
              </pre>
            </section>

            {!isTerminal(alert.status) || nextStatuses.length > 0 ? (
              <section className="flex flex-col gap-3 rounded-md border p-3">
                <h3 className="text-sm font-medium">Human review</h3>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="review-status">Move to</Label>
                  <Select value={toStatus} onValueChange={setToStatus}>
                    <SelectTrigger id="review-status">
                      <SelectValue placeholder="Choose next status" />
                    </SelectTrigger>
                    <SelectContent>
                      {nextStatuses.map((s) => (
                        <SelectItem key={s} value={s} className="capitalize">
                          {s}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="review-owner">Assign owner (user ID, optional)</Label>
                  <Input
                    id="review-owner"
                    inputMode="numeric"
                    value={ownerId}
                    onChange={(e) => setOwnerId(e.target.value.replace(/\D/g, ""))}
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="review-note">Note{needsNote ? " (required)" : ""}</Label>
                  <Textarea id="review-note" value={note} onChange={(e) => setNote(e.target.value)} rows={3} />
                </div>
                <Button onClick={submit} disabled={!toStatus || saving}>
                  {saving ? <Loader2 className="animate-spin" aria-hidden /> : null}
                  Record decision
                </Button>
                <p className="text-xs text-muted-foreground">
                  Recording a decision never changes payments, invoices or access. Take any corrective action in the
                  owning module.
                </p>
              </section>
            ) : null}

            <section className="flex flex-col gap-2">
              <h3 className="text-sm font-medium">Review trail</h3>
              <ol className="flex flex-col gap-2 text-sm">
                {(data?.audit ?? []).map((entry) => (
                  <li key={entry.id} className="rounded-md border p-2">
                    <div className="flex justify-between gap-2">
                      <span className="font-medium">{entry.action}</span>
                      <span className="text-xs text-muted-foreground">{formatDate(entry.createdAt)}</span>
                    </div>
                    {entry.fromStatus || entry.toStatus ? (
                      <p className="text-xs text-muted-foreground">
                        {entry.fromStatus ?? "—"} {"→"} {entry.toStatus ?? "—"} · User #{entry.actorId ?? "system"}
                      </p>
                    ) : null}
                    {entry.note ? <p className="mt-1">{entry.note}</p> : null}
                  </li>
                ))}
              </ol>
            </section>
          </div>
        ) : null}
      </SheetContent>
    </Sheet>
  )
}

function Fact({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd>{value}</dd>
    </div>
  )
}
