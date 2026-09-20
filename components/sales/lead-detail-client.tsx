"use client"

import { useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import useSWR from "swr"
import { toast } from "sonner"
import { fetcher } from "@/lib/fetcher"
import { formatDateTime, formatDate } from "@/lib/utils"
import { inr0 } from "@/lib/finance-calc"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Field, FieldLabel } from "@/components/ui/field"
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
} from "@/components/ui/dialog"
import { LeadDialog } from "@/components/sales/lead-dialog"
import type { LeadRow } from "@/components/sales/leads-client"
import {
  ArrowLeft,
  ArrowUpRight,
  Building2,
  CalendarClock,
  CheckCircle2,
  Clock,
  FileText,
  Mail,
  MessageSquare,
  Phone,
  RotateCcw,
  StickyNote,
  Target,
  Trophy,
  User,
  XCircle,
} from "lucide-react"

const STAGE_OPTIONS = [
  "New",
  "Qualified",
  "Follow Up 1",
  "Follow Up 2",
  "In Discussion",
  "Proposal Sent",
  "Ready",
] as const

const STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  Open: "outline",
  Won: "default",
  Lost: "destructive",
  "Follow Up": "secondary",
}

const ACTIVITY_ICON: Record<string, typeof StickyNote> = {
  note: StickyNote,
  call: Phone,
  email: Mail,
  meeting: CalendarClock,
  whatsapp: MessageSquare,
  task: CheckCircle2,
  won: Trophy,
  lost: XCircle,
  reopened: RotateCcw,
  stage_change: Target,
  created: FileText,
  assigned: User,
}

type LeadRecord = Record<string, any>

function currency(value: any, code?: string | null) {
  const n = Number(value)
  if (!value || Number.isNaN(n)) return "—"
  return code && code !== "INR" ? `${code} ${n.toLocaleString()}` : inr0(n)
}

export function LeadDetailClient({ id, canManage }: { id: number; canManage: boolean }) {
  const router = useRouter()
  const leadKey = `/api/sales/leads/${id}`
  const timelineKey = `/api/sales/leads/${id}/timeline`
  const followupsKey = `/api/sales/leads/${id}/followups`

  const { data: leadData, isLoading, mutate: mutateLead } = useSWR<{ lead: LeadRecord }>(leadKey, fetcher)
  const { data: timelineData, mutate: mutateTimeline } = useSWR<{ timeline: any[]; stageHistory: any[] }>(
    timelineKey,
    fetcher,
  )
  const { data: followupData, mutate: mutateFollowups } = useSWR<{ followups: any[] }>(followupsKey, fetcher)

  const [editOpen, setEditOpen] = useState(false)
  const [wonOpen, setWonOpen] = useState(false)
  const [lostOpen, setLostOpen] = useState(false)
  const [reopenOpen, setReopenOpen] = useState(false)
  const [followupOpen, setFollowupOpen] = useState(false)

  const lead = leadData?.lead
  const timeline = timelineData?.timeline ?? []
  const stageHistory = timelineData?.stageHistory ?? []
  const followups = followupData?.followups ?? []

  function refreshAll() {
    mutateLead()
    mutateTimeline()
    mutateFollowups()
  }

  if (isLoading || !lead) {
    return <div className="text-sm text-muted-foreground">Loading lead...</div>
  }

  const leadStatus = lead.lead_status || "Open"
  const isClosed = leadStatus === "Won" || leadStatus === "Lost"

  return (
    <div className="flex flex-col gap-6">
      {/* Header */}
      <div className="flex flex-col gap-4">
        <Link
          href="/modules/sales/leads"
          className="flex w-fit items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="size-4" /> Back to leads
        </Link>
        <div className="flex flex-col gap-4 rounded-lg border border-border bg-card p-5 md:flex-row md:items-center md:justify-between">
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-xl font-semibold tracking-tight text-balance">
                {lead.company_name || lead.contact_person || "Lead"}
              </h2>
              <Badge variant={STATUS_VARIANT[leadStatus] || "outline"}>{leadStatus}</Badge>
              <Badge variant="outline">{lead.status}</Badge>
            </div>
            <p className="text-sm text-muted-foreground">
              {lead.lead_code} · {lead.contact_person || "—"}
              {lead.designation ? ` · ${lead.designation}` : ""}
            </p>
          </div>
          {canManage && (
            <div className="flex flex-wrap items-center gap-2">
              <Link href={`/admin/workflows?recordId=${lead.id}`} className="text-sm text-primary hover:underline">Run workflow (tenant admin)</Link>
              <Button variant="outline" size="sm" onClick={() => setEditOpen(true)}>
                Edit
              </Button>
              <Button variant="outline" size="sm" onClick={() => setFollowupOpen(true)}>
                <CalendarClock data-icon="inline-start" /> Follow-up
              </Button>
              {!isClosed && (
                <>
                  <Button size="sm" onClick={() => setWonOpen(true)}>
                    <Trophy data-icon="inline-start" /> Won
                  </Button>
                  <Button variant="destructive" size="sm" onClick={() => setLostOpen(true)}>
                    <XCircle data-icon="inline-start" /> Lost
                  </Button>
                </>
              )}
              {isClosed && (
                <Button variant="outline" size="sm" onClick={() => setReopenOpen(true)}>
                  <RotateCcw data-icon="inline-start" /> Reopen
                </Button>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        {/* Left: details */}
        <div className="flex flex-col gap-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Lead health</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <div className="flex items-center gap-3">
                <Progress value={Number(lead.lead_health_score) || 0} className="h-2 flex-1" />
                <span className="text-sm font-medium">{Number(lead.lead_health_score) || 0}%</span>
              </div>
              <div className="grid grid-cols-2 gap-4 text-sm">
                <Metric icon={Target} label="Est. value" value={currency(lead.estimated_value, lead.currency)} />
                <Metric
                  icon={Trophy}
                  label="Probability"
                  value={lead.probability != null ? `${lead.probability}%` : "—"}
                />
                <Metric
                  icon={CalendarClock}
                  label="Expected close"
                  value={lead.expected_close_date ? formatDate(lead.expected_close_date) : "—"}
                />
                <Metric
                  icon={Clock}
                  label="Next follow-up"
                  value={lead.next_follow_up_at ? formatDateTime(lead.next_follow_up_at) : "—"}
                />
              </div>
              {leadStatus === "Won" && (
                <div className="rounded-md bg-muted p-3 text-sm">
                  <p className="font-medium text-foreground">Won · {currency(lead.won_value, lead.currency)}</p>
                  <p className="text-muted-foreground">{lead.won_at ? formatDateTime(lead.won_at) : ""}</p>
                </div>
              )}
              {leadStatus === "Lost" && (
                <div className="rounded-md bg-muted p-3 text-sm">
                  <p className="font-medium text-foreground">Lost · {lead.lost_reason || "—"}</p>
                  <p className="text-muted-foreground">{lead.lost_at ? formatDateTime(lead.lost_at) : ""}</p>
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Contact & company</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3 text-sm">
              <InfoRow icon={User} label="Contact" value={lead.contact_person} />
              <InfoRow icon={Phone} label="Phone" value={lead.contact_number} />
              <InfoRow icon={Mail} label="Email" value={lead.email} />
              <InfoRow icon={Building2} label="Company" value={lead.company_name} />
              <InfoRow icon={FileText} label="Industry" value={lead.industry} />
              <InfoRow icon={Target} label="Source" value={lead.lead_source} />
              <InfoRow icon={User} label="Assigned to" value={lead.assigned_to_name || "Unassigned"} />
              {lead.remarks && (
                <div className="rounded-md bg-muted p-3 text-muted-foreground">{lead.remarks}</div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Right: tabs */}
        <div className="lg:col-span-2">
          <Tabs defaultValue="timeline">
            <TabsList>
              <TabsTrigger value="timeline">Timeline</TabsTrigger>
              <TabsTrigger value="followups">
                Follow-ups
                {followups.filter((f) => f.status === "Open").length > 0 && (
                  <Badge variant="secondary" className="ml-1.5">
                    {followups.filter((f) => f.status === "Open").length}
                  </Badge>
                )}
              </TabsTrigger>
              <TabsTrigger value="stages">Stage history</TabsTrigger>
            </TabsList>

            <TabsContent value="timeline" className="flex flex-col gap-4 pt-4">
              {canManage && <ActivityComposer leadId={id} onLogged={refreshAll} />}
              <TimelineList timeline={timeline} />
            </TabsContent>

            <TabsContent value="followups" className="flex flex-col gap-4 pt-4">
              <FollowupList followups={followups} canManage={canManage} onChanged={refreshAll} />
            </TabsContent>

            <TabsContent value="stages" className="pt-4">
              <StageHistoryList stageHistory={stageHistory} />
            </TabsContent>
          </Tabs>
        </div>
      </div>

      {/* Dialogs */}
      <LeadDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        lead={lead as unknown as LeadRow}
        onSaved={() => {
          setEditOpen(false)
          toast.success("Lead updated")
          refreshAll()
        }}
      />
      <WonDialog
        open={wonOpen}
        onOpenChange={setWonOpen}
        leadId={id}
        defaultValue={lead.estimated_value}
        onDone={() => {
          setWonOpen(false)
          refreshAll()
        }}
      />
      <LostDialog
        open={lostOpen}
        onOpenChange={setLostOpen}
        leadId={id}
        onDone={() => {
          setLostOpen(false)
          refreshAll()
        }}
      />
      <ReopenDialog
        open={reopenOpen}
        onOpenChange={setReopenOpen}
        leadId={id}
        onDone={() => {
          setReopenOpen(false)
          refreshAll()
        }}
      />
      <FollowupDialog
        open={followupOpen}
        onOpenChange={setFollowupOpen}
        leadId={id}
        onDone={() => {
          setFollowupOpen(false)
          refreshAll()
        }}
      />
    </div>
  )
}

function Metric({ icon: Icon, label, value }: { icon: typeof Target; label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Icon className="size-3.5" /> {label}
      </span>
      <span className="font-medium">{value}</span>
    </div>
  )
}

function InfoRow({ icon: Icon, label, value }: { icon: typeof User; label: string; value: any }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="flex items-center gap-1.5 text-muted-foreground">
        <Icon className="size-3.5" /> {label}
      </span>
      <span className="truncate text-right font-medium">{value || "—"}</span>
    </div>
  )
}

function backlinkFor(refType: string | null, refId: string | null): string | null {
  if (!refType || !refId) return null
  switch (refType) {
    case "meeting":
      return `/modules/sales/meetings/${refId}`
    case "quotation":
      return `/modules/sales/quotations/${refId}`
    case "email":
      return `/modules/sales/emails/${refId}`
    case "call":
      return `/modules/sales/calls/${refId}`
    default:
      return null
  }
}

function TimelineList({ timeline }: { timeline: any[] }) {
  if (timeline.length === 0) {
    return <p className="py-8 text-center text-sm text-muted-foreground">No activity recorded yet.</p>
  }
  return (
    <ol className="flex flex-col">
      {timeline.map((event, i) => {
        const Icon = ACTIVITY_ICON[event.activity_type] || StickyNote
        const backlink = backlinkFor(event.ref_type, event.ref_id)
        return (
          <li key={event.id} className="flex gap-3">
            <div className="flex flex-col items-center">
              <span className="flex size-8 shrink-0 items-center justify-center rounded-full border border-border bg-card text-muted-foreground">
                <Icon className="size-4" />
              </span>
              {i < timeline.length - 1 && <span className="w-px flex-1 bg-border" />}
            </div>
            <div className="flex flex-col gap-0.5 pb-6">
              {backlink ? (
                <Link href={backlink} className="flex items-center gap-1 text-sm font-medium hover:underline">
                  {event.title || event.activity_type}
                  <ArrowUpRight className="size-3.5 text-muted-foreground" />
                </Link>
              ) : (
                <span className="text-sm font-medium">{event.title || event.activity_type}</span>
              )}
              {event.body && <span className="text-sm text-muted-foreground">{event.body}</span>}
              <span className="text-xs text-muted-foreground">
                {formatDateTime(event.occurred_at || event.created_at)}
                {event.actor_name ? ` · ${event.actor_name}` : ""}
              </span>
            </div>
          </li>
        )
      })}
    </ol>
  )
}

function StageHistoryList({ stageHistory }: { stageHistory: any[] }) {
  if (stageHistory.length === 0) {
    return <p className="py-8 text-center text-sm text-muted-foreground">No stage changes recorded.</p>
  }
  return (
    <div className="rounded-md border border-border">
      {stageHistory.map((h) => (
        <div key={h.id} className="flex items-center justify-between gap-3 border-b border-border p-3 last:border-b-0">
          <div className="flex flex-col">
            <span className="text-sm font-medium">
              {h.from_status || "—"} → {h.to_status}
            </span>
            {h.note && <span className="text-xs text-muted-foreground">{h.note}</span>}
          </div>
          <span className="shrink-0 text-xs text-muted-foreground">
            {formatDateTime(h.changed_at)}
            {h.actor_name ? ` · ${h.actor_name}` : ""}
          </span>
        </div>
      ))}
    </div>
  )
}

function FollowupList({
  followups,
  canManage,
  onChanged,
}: {
  followups: any[]
  canManage: boolean
  onChanged: () => void
}) {
  async function update(id: number, action: "complete" | "cancel") {
    const res = await fetch(`/api/sales/followups/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(action === "cancel" ? { action: "cancel" } : { action: "complete" }),
    })
    if (res.ok) {
      toast.success(action === "cancel" ? "Follow-up cancelled" : "Follow-up completed")
      onChanged()
    } else {
      toast.error("Unable to update follow-up")
    }
  }

  if (followups.length === 0) {
    return <p className="py-8 text-center text-sm text-muted-foreground">No follow-ups scheduled.</p>
  }
  return (
    <div className="flex flex-col gap-2">
      {followups.map((f) => {
        const overdue = f.status === "Open" && new Date(f.due_at) < new Date()
        return (
          <div
            key={f.id}
            className="flex items-center justify-between gap-3 rounded-md border border-border p-3"
          >
            <div className="flex flex-col gap-0.5">
              <span className="flex items-center gap-2 text-sm font-medium">
                {f.purpose || f.channel || "Follow-up"}
                {f.channel && <Badge variant="outline">{f.channel}</Badge>}
                {f.status !== "Open" && <Badge variant="secondary">{f.status}</Badge>}
                {overdue && <Badge variant="destructive">Overdue</Badge>}
              </span>
              <span className="text-xs text-muted-foreground">
                Due {formatDateTime(f.due_at)}
                {f.assigned_to_name ? ` · ${f.assigned_to_name}` : ""}
              </span>
            </div>
            {canManage && f.status === "Open" && (
              <div className="flex shrink-0 items-center gap-1.5">
                <Button size="sm" variant="outline" onClick={() => update(f.id, "complete")}>
                  Done
                </Button>
                <Button size="sm" variant="ghost" onClick={() => update(f.id, "cancel")}>
                  Cancel
                </Button>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

function ActivityComposer({ leadId, onLogged }: { leadId: number; onLogged: () => void }) {
  const [type, setType] = useState("note")
  const [body, setBody] = useState("")
  const [saving, setSaving] = useState(false)

  async function submit() {
    if (!body.trim()) return
    setSaving(true)
    const res = await fetch(`/api/sales/leads/${leadId}/activities`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type, body }),
    })
    setSaving(false)
    if (res.ok) {
      setBody("")
      onLogged()
    } else {
      toast.error("Unable to log activity")
    }
  }

  return (
    <div className="flex flex-col gap-2 rounded-md border border-border bg-card p-3">
      <div className="flex items-center gap-2">
        <Select value={type} onValueChange={(v) => setType(v ?? "note")}>
          <SelectTrigger size="sm" className="w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="note">Note</SelectItem>
            <SelectItem value="call">Call</SelectItem>
            <SelectItem value="email">Email</SelectItem>
            <SelectItem value="meeting">Meeting</SelectItem>
            <SelectItem value="whatsapp">WhatsApp</SelectItem>
            <SelectItem value="task">Task</SelectItem>
          </SelectContent>
        </Select>
        <span className="text-xs text-muted-foreground">Log an interaction on this lead</span>
      </div>
      <Textarea
        rows={2}
        placeholder="Add a note or interaction detail..."
        value={body}
        onChange={(e) => setBody(e.target.value)}
      />
      <div className="flex justify-end">
        <Button size="sm" onClick={submit} disabled={saving || !body.trim()}>
          Add to timeline
        </Button>
      </div>
    </div>
  )
}

function WonDialog({
  open,
  onOpenChange,
  leadId,
  defaultValue,
  onDone,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  leadId: number
  defaultValue: any
  onDone: () => void
}) {
  const [value, setValue] = useState("")
  const [notes, setNotes] = useState("")
  const [saving, setSaving] = useState(false)

  async function submit() {
    setSaving(true)
    const res = await fetch(`/api/sales/leads/${leadId}/won`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: value || defaultValue || null, notes }),
    })
    setSaving(false)
    if (res.ok) {
      toast.success("Lead marked as won")
      onDone()
    } else {
      const b = await res.json().catch(() => ({}))
      toast.error(b.error || "Unable to mark as won")
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Mark lead as won</DialogTitle>
          <DialogDescription>Record the deal value and any closing notes.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4 py-2">
          <Field>
            <FieldLabel htmlFor="won_value">Won value</FieldLabel>
            <Input
              id="won_value"
              type="number"
              min="0"
              placeholder={defaultValue ? String(defaultValue) : "0"}
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="won_notes">Notes</FieldLabel>
            <Textarea id="won_notes" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </Field>
        </div>
        <DialogFooter>
          <Button onClick={submit} disabled={saving}>
            Mark as won
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function LostDialog({
  open,
  onOpenChange,
  leadId,
  onDone,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  leadId: number
  onDone: () => void
}) {
  const [reason, setReason] = useState("")
  const [notes, setNotes] = useState("")
  const [saving, setSaving] = useState(false)

  async function submit() {
    if (!reason) {
      toast.error("A reason is required")
      return
    }
    setSaving(true)
    const res = await fetch(`/api/sales/leads/${leadId}/lost`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason, notes }),
    })
    setSaving(false)
    if (res.ok) {
      toast.success("Lead marked as lost")
      onDone()
    } else {
      const b = await res.json().catch(() => ({}))
      toast.error(b.error || "Unable to mark as lost")
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Mark lead as lost</DialogTitle>
          <DialogDescription>Capture why this lead did not convert.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4 py-2">
          <Field>
            <FieldLabel htmlFor="lost_reason">Reason</FieldLabel>
            <Select value={reason} onValueChange={(v) => setReason(v ?? "")}>
              <SelectTrigger id="lost_reason" className="w-full">
                <SelectValue placeholder="Select a reason" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="Price">Price</SelectItem>
                <SelectItem value="Competitor">Competitor</SelectItem>
                <SelectItem value="No budget">No budget</SelectItem>
                <SelectItem value="No response">No response</SelectItem>
                <SelectItem value="Not a fit">Not a fit</SelectItem>
                <SelectItem value="Timing">Timing</SelectItem>
                <SelectItem value="Other">Other</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field>
            <FieldLabel htmlFor="lost_notes">Notes</FieldLabel>
            <Textarea id="lost_notes" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="destructive" onClick={submit} disabled={saving}>
            Mark as lost
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ReopenDialog({
  open,
  onOpenChange,
  leadId,
  onDone,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  leadId: number
  onDone: () => void
}) {
  const [toStage, setToStage] = useState<string>("New")
  const [note, setNote] = useState("")
  const [saving, setSaving] = useState(false)

  async function submit() {
    setSaving(true)
    const res = await fetch(`/api/sales/leads/${leadId}/reopen`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to_stage: toStage, note }),
    })
    setSaving(false)
    if (res.ok) {
      toast.success("Lead reopened")
      onDone()
    } else {
      const b = await res.json().catch(() => ({}))
      toast.error(b.error || "Unable to reopen lead")
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Reopen lead</DialogTitle>
          <DialogDescription>Return this lead to the active pipeline.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4 py-2">
          <Field>
            <FieldLabel htmlFor="reopen_stage">Reopen to stage</FieldLabel>
            <Select value={toStage} onValueChange={(v) => setToStage(v ?? "New")}>
              <SelectTrigger id="reopen_stage" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {STAGE_OPTIONS.map((s) => (
                  <SelectItem key={s} value={s}>
                    {s}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field>
            <FieldLabel htmlFor="reopen_note">Note</FieldLabel>
            <Textarea id="reopen_note" rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
        </div>
        <DialogFooter>
          <Button onClick={submit} disabled={saving}>
            Reopen lead
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function FollowupDialog({
  open,
  onOpenChange,
  leadId,
  onDone,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  leadId: number
  onDone: () => void
}) {
  const [dueAt, setDueAt] = useState("")
  const [channel, setChannel] = useState("Call")
  const [purpose, setPurpose] = useState("")
  const [saving, setSaving] = useState(false)

  async function submit() {
    if (!dueAt) {
      toast.error("A due date/time is required")
      return
    }
    setSaving(true)
    const res = await fetch(`/api/sales/leads/${leadId}/followups`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ due_at: dueAt.replace("T", " ") + ":00", channel, purpose }),
    })
    setSaving(false)
    if (res.ok) {
      toast.success("Follow-up scheduled")
      setDueAt("")
      setPurpose("")
      onDone()
    } else {
      const b = await res.json().catch(() => ({}))
      toast.error(b.error || "Unable to schedule follow-up")
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Schedule follow-up</DialogTitle>
          <DialogDescription>Set a reminder to re-engage this lead.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4 py-2">
          <Field>
            <FieldLabel htmlFor="fu_due">Due date & time</FieldLabel>
            <Input id="fu_due" type="datetime-local" value={dueAt} onChange={(e) => setDueAt(e.target.value)} />
          </Field>
          <Field>
            <FieldLabel htmlFor="fu_channel">Channel</FieldLabel>
            <Select value={channel} onValueChange={(v) => setChannel(v ?? "Call")}>
              <SelectTrigger id="fu_channel" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="Call">Call</SelectItem>
                <SelectItem value="Email">Email</SelectItem>
                <SelectItem value="WhatsApp">WhatsApp</SelectItem>
                <SelectItem value="Meeting">Meeting</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field>
            <FieldLabel htmlFor="fu_purpose">Purpose</FieldLabel>
            <Input
              id="fu_purpose"
              placeholder="e.g. Send revised proposal"
              value={purpose}
              onChange={(e) => setPurpose(e.target.value)}
            />
          </Field>
        </div>
        <DialogFooter>
          <Button onClick={submit} disabled={saving}>
            Schedule
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
