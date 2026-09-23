"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import useSWR from "swr"
import { AlertTriangle, CalendarClock, ClipboardCheck, History, Loader2, Plus, ShieldAlert } from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Progress } from "@/components/ui/progress"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { EmptyState } from "@/components/security/security-ui"
import {
  DECISIONS,
  ESCALATION_LABELS,
  FREQUENCIES,
  SUBJECT_TYPES,
  subjectMeta,
  type DerivedCampaignStatus,
  type EscalationLevel,
  type ReviewDecision,
  type ReviewFrequency,
  type ReviewSubjectType,
} from "@/lib/access-review-core"

// Mirror of the server ReviewCampaign / ReviewItem / AuditEntry shapes.
type Progress = {
  total: number
  pending: number
  approved: number
  revoked: number
  remediated: number
  reviewed: number
  percent: number
  complete: boolean
}
type Campaign = {
  id: number
  name: string
  description: string | null
  scopeTypes: ReviewSubjectType[]
  frequency: ReviewFrequency
  status: DerivedCampaignStatus
  dueAt: string
  createdByName: string | null
  completedAt: string | null
  nextRunAt: string | null
  createdAt: string
  progress: Progress
  escalation: EscalationLevel
}
type Item = {
  id: number
  subjectType: ReviewSubjectType
  subjectRef: string
  subjectLabel: string
  subjectDetail: Record<string, unknown> | null
  decision: ReviewDecision
  note: string | null
  remediation: string | null
  execution: string | null
  decidedByName: string | null
  decidedAt: string | null
}
type AuditEntry = {
  id: number
  campaignId: number | null
  itemId: number | null
  action: string
  actorName: string | null
  detail: Record<string, unknown> | null
  createdAt: string
}

const fetcher = (url: string) => fetch(url).then((r) => r.json())
const fmtDate = (v: string | null) => (v ? new Date(v).toLocaleDateString() : "—")

const STATUS_BADGE: Record<DerivedCampaignStatus, { label: string; className?: string; variant?: "outline" | "destructive" }> = {
  active: { label: "In progress", variant: "outline" },
  overdue: { label: "Overdue", variant: "destructive" },
  completed: { label: "Completed", className: "border-transparent bg-emerald-600 text-white" },
  cancelled: { label: "Cancelled", variant: "outline" },
}

const ESCALATION_BADGE: Record<EscalationLevel, string> = {
  0: "border-transparent bg-muted text-muted-foreground",
  1: "border-transparent bg-amber-500 text-white",
  2: "border-transparent bg-orange-600 text-white",
  3: "border-transparent bg-destructive text-white",
}

export function AccessReviewCampaigns() {
  const { data, isLoading, mutate } = useSWR<{ campaigns: Campaign[]; audit: AuditEntry[] }>(
    "/api/admin/security/access-reviews",
    fetcher,
  )
  const campaigns = data?.campaigns ?? []
  const audit = data?.audit ?? []

  const [createOpen, setCreateOpen] = useState(false)
  const [reviewingId, setReviewingId] = useState<number | null>(null)
  const [tab, setTab] = useState("campaigns")

  const overdue = useMemo(() => campaigns.filter((c) => c.status === "overdue"), [campaigns])
  const completed = useMemo(() => campaigns.filter((c) => c.status === "completed"), [campaigns])
  const openList = useMemo(() => campaigns.filter((c) => c.status === "active" || c.status === "overdue"), [campaigns])

  function CampaignTable({ list }: { list: Campaign[] }) {
    if (list.length === 0) {
      return (
        <EmptyState icon={<ClipboardCheck className="size-5" />} title="No campaigns in this view">
          Create a review campaign to start certifying access.
        </EmptyState>
      )
    }
    return (
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Campaign</TableHead>
              <TableHead>Scope</TableHead>
              <TableHead>Owner</TableHead>
              <TableHead>Due</TableHead>
              <TableHead>Progress</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Escalation</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {list.map((c) => {
              const badge = STATUS_BADGE[c.status]
              return (
                <TableRow key={c.id}>
                  <TableCell className="font-medium">
                    {c.name}
                    {c.frequency !== "once" && (
                      <span className="ml-1.5 text-[11px] text-muted-foreground">
                        ({FREQUENCIES.find((f) => f.key === c.frequency)?.label})
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {c.scopeTypes.map((t) => subjectMeta(t).label).join(", ")}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{c.createdByName ?? "—"}</TableCell>
                  <TableCell className="text-muted-foreground">{fmtDate(c.dueAt)}</TableCell>
                  <TableCell className="w-36">
                    <Progress value={c.progress.percent} className="h-1.5" />
                    <span className="text-[11px] text-muted-foreground">
                      {c.progress.reviewed}/{c.progress.total} reviewed
                    </span>
                  </TableCell>
                  <TableCell>
                    <Badge variant={badge.variant} className={badge.className}>
                      {badge.label}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    {c.escalation === 0 ? (
                      <span className="text-xs text-muted-foreground">—</span>
                    ) : (
                      <Badge className={ESCALATION_BADGE[c.escalation]}>{ESCALATION_LABELS[c.escalation]}</Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button variant="outline" size="sm" onClick={() => setReviewingId(c.id)}>
                      Review
                    </Button>
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </div>
    )
  }

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
        <div>
          <CardTitle className="text-base">Access review campaigns</CardTitle>
          <CardDescription>Spec 66 — snapshot access, certify each item, and auto-escalate overdue reviews.</CardDescription>
        </div>
        <Button size="sm" className="gap-1.5" onClick={() => setCreateOpen(true)}>
          <Plus className="size-3.5" /> Create campaign
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading ? (
          <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Loading campaigns…
          </div>
        ) : (
          <Tabs value={tab} onValueChange={setTab}>
            <TabsList className="flex w-full flex-wrap justify-start gap-1 sm:w-auto">
              <TabsTrigger value="campaigns">All</TabsTrigger>
              <TabsTrigger value="open">Open</TabsTrigger>
              <TabsTrigger value="overdue">
                Overdue
                {overdue.length > 0 && (
                  <Badge variant="destructive" className="ml-1.5 text-[10px]">
                    {overdue.length}
                  </Badge>
                )}
              </TabsTrigger>
              <TabsTrigger value="completed">Completed</TabsTrigger>
              <TabsTrigger value="audit">Audit</TabsTrigger>
            </TabsList>
            <TabsContent value="campaigns" className="pt-4">
              <CampaignTable list={campaigns} />
            </TabsContent>
            <TabsContent value="open" className="pt-4">
              <CampaignTable list={openList} />
            </TabsContent>
            <TabsContent value="overdue" className="pt-4">
              <CampaignTable list={overdue} />
            </TabsContent>
            <TabsContent value="completed" className="pt-4">
              <CampaignTable list={completed} />
            </TabsContent>
            <TabsContent value="audit" className="pt-4">
              <AuditTrail entries={audit} />
            </TabsContent>
          </Tabs>
        )}
      </CardContent>

      <CreateCampaignDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={() => {
          setCreateOpen(false)
          mutate()
        }}
      />

      <ReviewDialog
        campaignId={reviewingId}
        onClose={() => setReviewingId(null)}
        onChanged={() => mutate()}
      />
    </Card>
  )
}

function AuditTrail({ entries }: { entries: AuditEntry[] }) {
  if (entries.length === 0) {
    return (
      <EmptyState icon={<History className="size-5" />} title="No activity yet">
        Campaign creation, decisions, revocations, and escalations are recorded here.
      </EmptyState>
    )
  }
  return (
    <div className="space-y-2">
      {entries.map((e) => (
        <div key={e.id} className="flex items-start gap-3 rounded-md border p-2.5 text-sm">
          <History className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <p className="font-medium">{e.action.replace(/_/g, " ")}</p>
            <p className="truncate text-xs text-muted-foreground">
              {e.actorName ?? "System"} · {new Date(e.createdAt).toLocaleString()}
              {e.detail?.subjectLabel ? ` · ${String(e.detail.subjectLabel)}` : ""}
            </p>
          </div>
        </div>
      ))}
    </div>
  )
}

function CreateCampaignDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  onCreated: () => void
}) {
  const [name, setName] = useState("")
  const [description, setDescription] = useState("")
  const [frequency, setFrequency] = useState<ReviewFrequency>("once")
  const [dueInDays, setDueInDays] = useState("14")
  const [scopeTypes, setScopeTypes] = useState<ReviewSubjectType[]>(["user"])
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function reset() {
    setName("")
    setDescription("")
    setFrequency("once")
    setDueInDays("14")
    setScopeTypes(["user"])
    setError(null)
  }

  function toggle(t: ReviewSubjectType) {
    setScopeTypes((cur) => (cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t]))
  }

  async function submit() {
    setSubmitting(true)
    setError(null)
    try {
      const res = await fetch("/api/admin/security/access-reviews", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name,
          description: description || null,
          scopeTypes,
          frequency,
          dueInDays: Number(dueInDays) || 14,
        }),
      })
      const body = await res.json()
      if (!res.ok) {
        setError(body?.error ?? "Failed to create campaign")
        return
      }
      reset()
      onCreated()
    } catch {
      setError("Network error — please try again")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) reset()
        onOpenChange(v)
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Create review campaign</DialogTitle>
          <DialogDescription>
            Snapshot the selected access types now. Every matching subject becomes an item to certify.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid gap-2">
            <Label htmlFor="camp-name">Campaign name</Label>
            <Input
              id="camp-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Q1 privileged access review"
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="camp-desc">Description</Label>
            <Textarea
              id="camp-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Purpose or compliance driver (optional)"
              rows={2}
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="camp-freq">Recurrence</Label>
              <Select value={frequency} onValueChange={(v) => setFrequency(v as ReviewFrequency)}>
                <SelectTrigger id="camp-freq" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {FREQUENCIES.map((f) => (
                    <SelectItem key={f.key} value={f.key}>
                      {f.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="camp-due">Due in (days)</Label>
              <Input
                id="camp-due"
                type="number"
                min={1}
                max={365}
                value={dueInDays}
                onChange={(e) => setDueInDays(e.target.value)}
              />
            </div>
          </div>
          <fieldset className="grid gap-2">
            <legend className="text-sm font-medium">Access types to review</legend>
            <div className="grid gap-1.5 sm:grid-cols-2">
              {SUBJECT_TYPES.map((s) => (
                <label
                  key={s.key}
                  className="flex items-start gap-2 rounded-md border p-2 text-xs"
                  title={s.description}
                >
                  <input
                    type="checkbox"
                    checked={scopeTypes.includes(s.key)}
                    onChange={() => toggle(s.key)}
                    className="mt-0.5 size-3.5"
                  />
                  <span>
                    <span className="font-medium">{s.label}</span>
                    <span className="block text-muted-foreground">{s.description}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          {error && (
            <p className="flex items-center gap-1.5 text-sm text-destructive">
              <AlertTriangle className="size-3.5" /> {error}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={submitting || !name.trim() || scopeTypes.length === 0}>
            {submitting && <Loader2 className="mr-1.5 size-3.5 animate-spin" />}
            Create campaign
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ReviewDialog({
  campaignId,
  onClose,
  onChanged,
}: {
  campaignId: number | null
  onClose: () => void
  onChanged: () => void
}) {
  const { data, isLoading, mutate } = useSWR<{ campaign: Campaign; items: Item[] }>(
    campaignId != null ? `/api/admin/security/access-reviews/${campaignId}` : null,
    fetcher,
  )
  const campaign = data?.campaign
  const items = data?.items ?? []
  const [busyItem, setBusyItem] = useState<number | null>(null)
  const [notes, setNotes] = useState<Record<number, string>>({})
  const [error, setError] = useState<string | null>(null)

  const setNote = useCallback((id: number, v: string) => setNotes((n) => ({ ...n, [id]: v })), [])

  useEffect(() => {
    if (campaignId == null) {
      setNotes({})
      setError(null)
    }
  }, [campaignId])

  async function decide(item: Item, decision: Exclude<ReviewDecision, "pending">) {
    setBusyItem(item.id)
    setError(null)
    try {
      const res = await fetch(`/api/admin/security/access-reviews/items/${item.id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          decision,
          note: notes[item.id] ?? null,
          remediation: decision === "remediated" ? (notes[item.id] ?? null) : null,
        }),
      })
      const body = await res.json()
      if (!res.ok) {
        setError(body?.error ?? "Failed to record decision")
        return
      }
      await mutate()
      onChanged()
    } catch {
      setError("Network error — please try again")
    } finally {
      setBusyItem(null)
    }
  }

  async function cancelCampaign() {
    if (campaignId == null) return
    setError(null)
    const res = await fetch(`/api/admin/security/access-reviews/${campaignId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "cancel" }),
    })
    if (res.ok) {
      await mutate()
      onChanged()
    } else {
      const body = await res.json().catch(() => ({}))
      setError(body?.error ?? "Failed to cancel campaign")
    }
  }

  const badge = campaign ? STATUS_BADGE[campaign.status] : null
  const readOnly = campaign?.status === "cancelled" || campaign?.status === "completed"

  return (
    <Dialog open={campaignId !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[85vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-center gap-2">
            {campaign?.name ?? "Campaign"}
            {badge && (
              <Badge variant={badge.variant} className={badge.className}>
                {badge.label}
              </Badge>
            )}
          </DialogTitle>
          <DialogDescription className="flex flex-wrap items-center gap-1.5">
            <CalendarClock className="size-3.5" /> Due {fmtDate(campaign?.dueAt ?? null)} · Owner{" "}
            {campaign?.createdByName ?? "—"}
            {campaign && campaign.escalation > 0 && (
              <span className="flex items-center gap-1 text-destructive">
                <ShieldAlert className="size-3.5" /> {ESCALATION_LABELS[campaign.escalation]}
              </span>
            )}
          </DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Loading items…
          </div>
        ) : (
          <>
            {campaign && (
              <div className="grid grid-cols-4 gap-3">
                <Stat label="Total" value={campaign.progress.total} />
                <Stat label="Approved" value={campaign.progress.approved} />
                <Stat label="Revoked" value={campaign.progress.revoked} />
                <Stat label="Pending" value={campaign.progress.pending} />
              </div>
            )}

            {error && (
              <p className="flex items-center gap-1.5 text-sm text-destructive">
                <AlertTriangle className="size-3.5" /> {error}
              </p>
            )}

            <div className="space-y-3">
              {items.map((item) => {
                const meta = subjectMeta(item.subjectType)
                return (
                  <div key={item.id} className="rounded-md border p-3">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <Badge variant="outline" className="text-[10px]">
                            {meta.label}
                          </Badge>
                          <p className="text-sm font-medium">{item.subjectLabel}</p>
                        </div>
                        {item.decidedAt && (
                          <p className="mt-1 text-xs text-muted-foreground">
                            {item.decision} by {item.decidedByName ?? "—"} on {fmtDate(item.decidedAt)}
                            {item.execution ? ` · ${item.execution}` : ""}
                          </p>
                        )}
                      </div>
                      <Badge
                        variant={item.decision === "pending" ? "outline" : "default"}
                        className={
                          item.decision === "revoked"
                            ? "bg-destructive text-white"
                            : item.decision === "approved"
                              ? "border-transparent bg-emerald-600 text-white"
                              : item.decision === "remediated"
                                ? "border-transparent bg-amber-500 text-white"
                                : undefined
                        }
                      >
                        {item.decision}
                      </Badge>
                    </div>
                    {!readOnly && (
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        {DECISIONS.map((d) => (
                          <Button
                            key={d.key}
                            size="sm"
                            variant={item.decision === d.key ? "default" : "outline"}
                            className={
                              d.key === "revoked" && item.decision === "revoked"
                                ? "bg-destructive text-white hover:bg-destructive/90"
                                : undefined
                            }
                            disabled={busyItem === item.id}
                            onClick={() => decide(item, d.key)}
                          >
                            {busyItem === item.id ? <Loader2 className="size-3.5 animate-spin" /> : d.label}
                          </Button>
                        ))}
                        <Input
                          placeholder="Note / remediation"
                          className="h-8 min-w-32 flex-1"
                          value={notes[item.id] ?? item.note ?? ""}
                          onChange={(e) => setNote(item.id, e.target.value)}
                        />
                      </div>
                    )}
                  </div>
                )
              })}
              {items.length === 0 && (
                <EmptyState icon={<ClipboardCheck className="size-5" />} title="No items in scope for this campaign" />
              )}
            </div>
          </>
        )}

        <DialogFooter className="flex-wrap gap-2 sm:justify-between">
          {campaign?.status !== "cancelled" && campaign?.status !== "completed" ? (
            <Button variant="ghost" className="text-destructive hover:text-destructive" onClick={cancelCampaign}>
              Cancel campaign
            </Button>
          ) : (
            <span />
          )}
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border p-3 text-center">
      <p className="text-lg font-semibold">{value}</p>
      <p className="text-xs text-muted-foreground">{label}</p>
    </div>
  )
}
