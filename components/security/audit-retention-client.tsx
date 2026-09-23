"use client"

// Audit log retention admin. Configure the tenant's retention window,
// archive/purge behavior, place and release legal holds, run the lifecycle on
// demand, and export sealed immutable archives.
import { useState } from "react"
import useSWR, { mutate as globalMutate } from "swr"
import { toast } from "sonner"
import {
  ArchiveIcon,
  CircleCheckIcon,
  CircleXIcon,
  DownloadIcon,
  GavelIcon,
  PlayIcon,
  ShieldCheckIcon,
  LockIcon,
  DatabaseIcon,
} from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Badge } from "@/components/ui/badge"
import { Textarea } from "@/components/ui/textarea"
import { Separator } from "@/components/ui/separator"
import { Skeleton } from "@/components/ui/skeleton"
import { Field, FieldLabel } from "@/components/ui/field"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { describeRetention } from "@/lib/audit-retention-policy"

const ENDPOINT = "/api/admin/security/audit-retention"

type Summary = {
  scope: number
  policy: {
    retentionDays: number
    archiveEnabled: boolean
    purgeAfterArchive: boolean
    enabled: boolean
    source: "tenant" | "platform"
    hasOverride: boolean
  }
  platform: {
    defaultRetentionDays: number
    minRetentionDays: number
    archiveEnabled: boolean
    purgeAfterArchive: boolean
  }
  liveEntries: number
  oldestEntryTs: string | null
  eligibleForArchive: number
  archivedBatches: number
  archivedEntries: number
  underHold: number
  activeHolds: number
  lastRunAt: string | null
}

type LegalHold = {
  id: number
  name: string
  reason: string | null
  filter: {
    action: string | null
    entityType: string | null
    actorUserId: number | null
    fromDate: string | null
    toDate: string | null
  }
  status: "active" | "released"
  createdByName: string | null
  createdAt: string
  releasedByName: string | null
  releasedAt: string | null
  releaseReason: string | null
}

type ArchiveBatch = {
  id: number
  batchUuid: string
  fromEntryId: number
  toEntryId: number
  fromTs: string | null
  toTs: string | null
  entryCount: number
  payloadBytes: number
  contentHash: string
  createdAt: string
}

type ApiResponse = { summary: Summary; holds: LegalHold[]; archives: ArchiveBatch[] }

const fetcher = (url: string) =>
  fetch(url).then((r) => {
    if (!r.ok) throw new Error("Failed to load audit retention")
    return r.json() as Promise<ApiResponse>
  })

function fmt(value: string | null): string {
  if (!value) return "—"
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return value
  return d.toLocaleString(undefined, { year: "numeric", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" })
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

export function AuditRetentionClient() {
  const { data, error, isLoading } = useSWR(ENDPOINT, fetcher)

  const revalidate = () => globalMutate(ENDPOINT)

  if (error) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <CircleXIcon />
          </EmptyMedia>
          <EmptyTitle>Unable to load audit retention</EmptyTitle>
          <EmptyDescription>Please retry in a moment.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }

  if (isLoading || !data) {
    return (
      <div className="flex flex-col gap-4">
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-56 w-full" />
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-6">
      <StatsGrid summary={data.summary} />
      <PolicyCard summary={data.summary} onSaved={revalidate} />
      <RunCard summary={data.summary} onRan={revalidate} />
      <LegalHoldsCard holds={data.holds} onChanged={revalidate} />
      <ArchivesCard archives={data.archives} />
    </div>
  )
}

function Stat({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-lg border p-4">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="text-2xl font-semibold tabular-nums">{value}</span>
      {hint ? <span className="text-xs text-muted-foreground">{hint}</span> : null}
    </div>
  )
}

function StatsGrid({ summary }: { summary: Summary }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
      <Stat label="Live entries" value={summary.liveEntries.toLocaleString()} hint={`Oldest ${fmt(summary.oldestEntryTs)}`} />
      <Stat label="Past retention" value={summary.eligibleForArchive.toLocaleString()} hint="Eligible to archive" />
      <Stat label="Archived entries" value={summary.archivedEntries.toLocaleString()} hint={`${summary.archivedBatches} batches`} />
      <Stat label="Under legal hold" value={summary.underHold.toLocaleString()} hint={`${summary.activeHolds} active holds`} />
      <Stat label="Last run" value={fmt(summary.lastRunAt)} />
    </div>
  )
}

function PolicyCard({ summary, onSaved }: { summary: Summary; onSaved: () => void }) {
  const [retentionDays, setRetentionDays] = useState(String(summary.policy.retentionDays))
  const [archiveEnabled, setArchiveEnabled] = useState(summary.policy.archiveEnabled)
  const [purgeAfterArchive, setPurgeAfterArchive] = useState(summary.policy.purgeAfterArchive)
  const [enabled, setEnabled] = useState(summary.policy.enabled)
  const [saving, setSaving] = useState(false)

  const floor = summary.platform.minRetentionDays
  const daysNum = Number(retentionDays)
  const belowFloor = Number.isFinite(daysNum) && daysNum < floor

  async function save() {
    setSaving(true)
    try {
      const res = await fetch(ENDPOINT, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ retentionDays: daysNum, archiveEnabled, purgeAfterArchive, enabled }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? "Save failed")
      toast.success("Retention policy saved", {
        description: `Keeping audit entries for ${describeRetention(json.policy.retentionDays)}.`,
      })
      onSaved()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShieldCheckIcon data-icon="inline-start" />
          Tenant retention policy
        </CardTitle>
        <CardDescription>
          {summary.policy.hasOverride ? "Custom tenant policy." : "Following the platform default."} The platform floor is{" "}
          {describeRetention(floor)} — you may retain longer, but not shorter.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <div className="grid gap-5 md:grid-cols-2">
          <Field>
            <FieldLabel htmlFor="retention-days">Retention window (days)</FieldLabel>
            <Input
              id="retention-days"
              type="number"
              min={floor}
              value={retentionDays}
              onChange={(e) => setRetentionDays(e.target.value)}
              aria-invalid={belowFloor}
            />
            <span className="text-xs text-muted-foreground">
              {Number.isFinite(daysNum) ? `≈ ${describeRetention(daysNum)}. ` : ""}
              {belowFloor ? `Will be raised to the ${describeRetention(floor)} platform floor.` : "Entries older than this are archived."}
            </span>
          </Field>
          <div className="flex flex-col gap-4">
            <ToggleRow
              id="policy-enabled"
              label="Retention enabled"
              hint="Master switch for the scheduled lifecycle job."
              checked={enabled}
              onChange={setEnabled}
            />
            <ToggleRow
              id="policy-archive"
              label="Archive aged entries"
              hint="Seal entries past the window into the immutable archive."
              checked={archiveEnabled}
              onChange={setArchiveEnabled}
            />
            <ToggleRow
              id="policy-purge"
              label="Purge originals after archive"
              hint="Remove sealed originals from the hot log (never under legal hold)."
              checked={purgeAfterArchive}
              onChange={setPurgeAfterArchive}
            />
          </div>
        </div>
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Badge variant={summary.policy.source === "tenant" ? "secondary" : "outline"}>
              {summary.policy.source === "tenant" ? "Tenant override" : "Platform default"}
            </Badge>
            {purgeAfterArchive ? (
              <span className="flex items-center gap-1 text-amber-600 dark:text-amber-500">
                <LockIcon className="size-3.5" /> Purge deletes sealed originals
              </span>
            ) : null}
          </div>
          <Button onClick={save} disabled={saving}>
            {saving ? "Saving…" : "Save policy"}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

function ToggleRow({
  id,
  label,
  hint,
  checked,
  onChange,
}: {
  id: string
  label: string
  hint: string
  checked: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="flex flex-col">
        <Label htmlFor={id}>{label}</Label>
        <span className="text-xs text-muted-foreground">{hint}</span>
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
    </div>
  )
}

function RunCard({ summary, onRan }: { summary: Summary; onRan: () => void }) {
  const [running, setRunning] = useState(false)

  async function run(dryRun: boolean) {
    setRunning(true)
    try {
      const res = await fetch(`${ENDPOINT}/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dryRun }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? "Run failed")
      const r = json.result
      const summaryText = `${r.archived} archived · ${r.batches} batches · ${r.purged} purged · ${r.heldSkipped} held`
      toast.success(dryRun ? "Dry run complete" : "Retention run complete", { description: summaryText })
      if (!dryRun) onRan()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setRunning(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <PlayIcon data-icon="inline-start" />
          Run retention now
        </CardTitle>
        <CardDescription>
          Manually run the archive and purge lifecycle for this tenant. {summary.eligibleForArchive.toLocaleString()}{" "}
          {summary.eligibleForArchive === 1 ? "entry is" : "entries are"} currently past the retention window.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap gap-3">
        <Button variant="outline" onClick={() => run(true)} disabled={running}>
          Preview (dry run)
        </Button>
        <Button onClick={() => run(false)} disabled={running}>
          {running ? "Running…" : "Run archive & purge"}
        </Button>
      </CardContent>
    </Card>
  )
}

function LegalHoldsCard({ holds, onChanged }: { holds: LegalHold[]; onChanged: () => void }) {
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex flex-col gap-1.5">
            <CardTitle className="flex items-center gap-2">
              <GavelIcon data-icon="inline-start" />
              Legal holds
            </CardTitle>
            <CardDescription>Frozen entries are never purged until the hold is released.</CardDescription>
          </div>
          <CreateHoldDialog onCreated={onChanged} />
        </div>
      </CardHeader>
      <CardContent className="p-0">
        {holds.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <GavelIcon />
              </EmptyMedia>
              <EmptyTitle>No legal holds</EmptyTitle>
              <EmptyDescription>Place a hold to freeze a slice of the audit trail from purge.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Hold</TableHead>
                  <TableHead>Scope</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {holds.map((hold) => (
                  <HoldRow key={hold.id} hold={hold} onChanged={onChanged} />
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function describeFilter(f: LegalHold["filter"]): string {
  const parts: string[] = []
  if (f.action) parts.push(`action=${f.action}`)
  if (f.entityType) parts.push(`entity=${f.entityType}`)
  if (f.actorUserId != null) parts.push(`actor#${f.actorUserId}`)
  if (f.fromDate) parts.push(`from ${f.fromDate.slice(0, 10)}`)
  if (f.toDate) parts.push(`to ${f.toDate.slice(0, 10)}`)
  return parts.length ? parts.join(" · ") : "All entries in scope"
}

function HoldRow({ hold, onChanged }: { hold: LegalHold; onChanged: () => void }) {
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState("")
  const [busy, setBusy] = useState(false)

  async function release() {
    setBusy(true)
    try {
      const res = await fetch(`${ENDPOINT}/legal-holds/${hold.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? "Release failed")
      toast.success("Legal hold released")
      setOpen(false)
      onChanged()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <TableRow>
      <TableCell>
        <div className="flex flex-col">
          <span className="font-medium">{hold.name}</span>
          {hold.reason ? <span className="text-xs text-muted-foreground">{hold.reason}</span> : null}
        </div>
      </TableCell>
      <TableCell className="text-xs text-muted-foreground">{describeFilter(hold.filter)}</TableCell>
      <TableCell>
        {hold.status === "active" ? (
          <Badge variant="secondary">Active</Badge>
        ) : (
          <Badge variant="outline">Released</Badge>
        )}
      </TableCell>
      <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
        {fmt(hold.createdAt)}
        {hold.createdByName ? <div>by {hold.createdByName}</div> : null}
      </TableCell>
      <TableCell className="text-right">
        {hold.status === "active" ? (
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
              <Button variant="outline" size="sm">
                Release
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Release legal hold</DialogTitle>
                <DialogDescription>
                  Releasing “{hold.name}” lets its frozen entries be purged on the next run if they are past the
                  retention window.
                </DialogDescription>
              </DialogHeader>
              <Field>
                <FieldLabel htmlFor={`release-reason-${hold.id}`}>Reason</FieldLabel>
                <Textarea
                  id={`release-reason-${hold.id}`}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="e.g. Matter settled, hold no longer required"
                />
              </Field>
              <DialogFooter>
                <Button variant="outline" onClick={() => setOpen(false)} disabled={busy}>
                  Cancel
                </Button>
                <Button onClick={release} disabled={busy}>
                  {busy ? "Releasing…" : "Release hold"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        ) : (
          <span className="text-xs text-muted-foreground">{hold.releaseReason ?? "—"}</span>
        )}
      </TableCell>
    </TableRow>
  )
}

function CreateHoldDialog({ onCreated }: { onCreated: () => void }) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [form, setForm] = useState({ name: "", reason: "", action: "", entityType: "", actorUserId: "", fromDate: "", toDate: "" })

  function update(key: keyof typeof form, value: string) {
    setForm((f) => ({ ...f, [key]: value }))
  }

  async function create() {
    if (!form.name.trim()) {
      toast.error("A hold name is required")
      return
    }
    setBusy(true)
    try {
      const res = await fetch(`${ENDPOINT}/legal-holds`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? "Create failed")
      toast.success("Legal hold placed")
      setOpen(false)
      setForm({ name: "", reason: "", action: "", entityType: "", actorUserId: "", fromDate: "", toDate: "" })
      onCreated()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <GavelIcon data-icon="inline-start" />
          Place hold
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Place a legal hold</DialogTitle>
          <DialogDescription>
            Freeze matching audit entries from purge. Leave filters blank to hold every entry in scope.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <Field>
            <FieldLabel htmlFor="hold-name">Name</FieldLabel>
            <Input id="hold-name" value={form.name} onChange={(e) => update("name", e.target.value)} placeholder="Litigation — Vendor dispute #2291" />
          </Field>
          <Field>
            <FieldLabel htmlFor="hold-reason">Reason</FieldLabel>
            <Textarea id="hold-reason" value={form.reason} onChange={(e) => update("reason", e.target.value)} />
          </Field>
          <Separator />
          <p className="text-xs font-medium text-muted-foreground">Scope filters (optional, combined with AND)</p>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="hold-action">Action</FieldLabel>
              <Input id="hold-action" value={form.action} onChange={(e) => update("action", e.target.value)} placeholder="e.g. user.update" />
            </Field>
            <Field>
              <FieldLabel htmlFor="hold-entity">Entity type</FieldLabel>
              <Input id="hold-entity" value={form.entityType} onChange={(e) => update("entityType", e.target.value)} placeholder="e.g. invoice" />
            </Field>
            <Field>
              <FieldLabel htmlFor="hold-actor">Actor user ID</FieldLabel>
              <Input id="hold-actor" type="number" value={form.actorUserId} onChange={(e) => update("actorUserId", e.target.value)} />
            </Field>
            <div className="grid grid-cols-2 gap-2">
              <Field>
                <FieldLabel htmlFor="hold-from">From</FieldLabel>
                <Input id="hold-from" type="date" value={form.fromDate} onChange={(e) => update("fromDate", e.target.value)} />
              </Field>
              <Field>
                <FieldLabel htmlFor="hold-to">To</FieldLabel>
                <Input id="hold-to" type="date" value={form.toDate} onChange={(e) => update("toDate", e.target.value)} />
              </Field>
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={create} disabled={busy}>
            {busy ? "Placing…" : "Place hold"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ArchivesCard({ archives }: { archives: ArchiveBatch[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ArchiveIcon data-icon="inline-start" />
          Immutable archives
        </CardTitle>
        <CardDescription>
          Sealed, hash-chained snapshots of aged entries. Each export re-verifies its SHA-256 seal.
        </CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        {archives.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <DatabaseIcon />
              </EmptyMedia>
              <EmptyTitle>No archives yet</EmptyTitle>
              <EmptyDescription>Archives appear once aged entries are sealed by a retention run.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Batch</TableHead>
                  <TableHead>Range</TableHead>
                  <TableHead>Entries</TableHead>
                  <TableHead>Size</TableHead>
                  <TableHead>Sealed</TableHead>
                  <TableHead className="text-right">Export</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {archives.map((a) => (
                  <TableRow key={a.id}>
                    <TableCell>
                      <div className="flex flex-col">
                        <span className="font-medium">#{a.id}</span>
                        <span className="font-mono text-[10px] text-muted-foreground">{a.batchUuid.slice(0, 8)}</span>
                      </div>
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                      {fmt(a.fromTs)} → {fmt(a.toTs)}
                    </TableCell>
                    <TableCell className="tabular-nums">{a.entryCount.toLocaleString()}</TableCell>
                    <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{fmtBytes(a.payloadBytes)}</TableCell>
                    <TableCell>
                      <Badge variant="secondary" title={a.contentHash}>
                        <CircleCheckIcon data-icon="inline-start" />
                        {a.contentHash.slice(0, 10)}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => window.open(`${ENDPOINT}/archives/${a.id}?format=json`, "_blank")}
                        >
                          <DownloadIcon data-icon="inline-start" />
                          JSON
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => window.open(`${ENDPOINT}/archives/${a.id}?format=csv`, "_blank")}
                        >
                          CSV
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
