"use client"

import { useState } from "react"
import useSWR from "swr"
import { toast } from "sonner"
import { fetcher } from "@/lib/fetcher"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import { Separator } from "@/components/ui/separator"
import { Progress } from "@/components/ui/progress"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
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
  Play,
  Pause,
  Copy,
  Archive,
  Download,
  Pencil,
  MoreHorizontal,
  UserPlus,
  Loader2,
} from "lucide-react"
import {
  STEP_META,
  TRIGGER_META,
  JOURNEY_STATUS_VARIANT,
  ENROLLMENT_STATUS_VARIANT,
  type Lookups,
  type StepType,
} from "@/components/marketing/journeys-constants"

function fmt(dt: string | null) {
  if (!dt) return "—"
  const d = new Date(dt)
  if (Number.isNaN(d.getTime())) return "—"
  return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
}

export function JourneyDetail({
  journeyId,
  open,
  onOpenChange,
  canManage,
  onEdit,
  onChanged,
}: {
  journeyId: number | null
  open: boolean
  onOpenChange: (o: boolean) => void
  canManage: boolean
  onEdit: (id: number) => void
  onChanged: () => void
}) {
  const key = journeyId != null && open ? `/api/marketing/journeys/${journeyId}` : null
  const { data, mutate } = useSWR(key, fetcher)
  const journey = data?.journey
  const steps: any[] = data?.steps || []
  const [enrollOpen, setEnrollOpen] = useState(false)

  async function status(next: string) {
    if (journeyId == null) return
    const res = await fetch(`/api/marketing/journeys/${journeyId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "status", status: next }),
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) {
      toast.error(body.error || "Could not update status")
      return
    }
    toast.success(`Journey ${next === "Active" ? "activated" : next.toLowerCase()}`)
    mutate()
    onChanged()
  }

  async function duplicate() {
    if (journeyId == null) return
    const res = await fetch(`/api/marketing/journeys/${journeyId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "duplicate" }),
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) {
      toast.error(body.error || "Could not duplicate")
      return
    }
    toast.success("Journey duplicated")
    onChanged()
  }

  async function archive() {
    if (journeyId == null) return
    const res = await fetch(`/api/marketing/journeys/${journeyId}`, { method: "DELETE" })
    if (!res.ok) {
      toast.error("Could not archive")
      return
    }
    toast.success("Journey archived")
    onChanged()
    onOpenChange(false)
  }

  const trig = journey ? TRIGGER_META[journey.trigger_type as keyof typeof TRIGGER_META] : null

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="flex w-full flex-col gap-0 p-0 sm:max-w-3xl">
        <SheetHeader className="border-b px-6 py-4">
          <div className="flex items-start justify-between gap-3">
            <div className="space-y-1">
              <SheetTitle className="flex items-center gap-2">
                {journey?.name || "Journey"}
                {journey && <Badge variant={JOURNEY_STATUS_VARIANT[journey.status] || "outline"}>{journey.status}</Badge>}
              </SheetTitle>
              <SheetDescription>
                {journey ? `${journey.journey_code}${journey.description ? ` · ${journey.description}` : ""}` : "Loading…"}
              </SheetDescription>
            </div>
            {canManage && journey && (
              <div className="flex items-center gap-2">
                {journey.status === "Active" ? (
                  <Button size="sm" variant="outline" onClick={() => status("Paused")}>
                    <Pause className="size-4" />
                    Pause
                  </Button>
                ) : journey.status === "Draft" || journey.status === "Paused" ? (
                  <Button size="sm" onClick={() => status("Active")}>
                    <Play className="size-4" />
                    Activate
                  </Button>
                ) : null}
                <Button size="sm" variant="outline" onClick={() => setEnrollOpen(true)}>
                  <UserPlus className="size-4" />
                  Enroll
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button size="icon" variant="ghost" className="size-8">
                      <MoreHorizontal className="size-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={() => onEdit(journey.id)}>
                      <Pencil className="size-4" />
                      Edit
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={duplicate}>
                      <Copy className="size-4" />
                      Duplicate
                    </DropdownMenuItem>
                    <DropdownMenuItem asChild>
                      <a href={`/api/marketing/journeys/${journey.id}/export`}>
                        <Download className="size-4" />
                        Export enrollments
                      </a>
                    </DropdownMenuItem>
                    <DropdownMenuItem className="text-destructive" onClick={archive}>
                      <Archive className="size-4" />
                      Archive
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            )}
          </div>
        </SheetHeader>

        {!journey ? (
          <div className="flex-1 p-6 text-sm text-muted-foreground">Loading journey…</div>
        ) : (
          <Tabs defaultValue="overview" className="flex flex-1 flex-col overflow-hidden">
            <TabsList className="mx-6 mt-4 w-fit">
              <TabsTrigger value="overview">Overview</TabsTrigger>
              <TabsTrigger value="steps">Steps ({steps.length})</TabsTrigger>
              <TabsTrigger value="enrollments">Enrollments</TabsTrigger>
              <TabsTrigger value="analytics">Analytics</TabsTrigger>
            </TabsList>

            <div className="flex-1 overflow-y-auto px-6 py-4">
              <TabsContent value="overview" className="mt-0 space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <Info label="Trigger" value={trig?.label || journey.trigger_type} />
                  <Info label="Owner" value={journey.owner_name || "Unassigned"} />
                  <Info label="Goal" value={journey.goal_type || "None"} />
                  <Info label="Steps" value={String(steps.length)} />
                  <Info label="Re-entry" value={journey.allow_reentry ? "Allowed" : "Blocked"} />
                  <Info label="Multiple active" value={journey.allow_multiple_active ? "Allowed" : "Blocked"} />
                  <Info label="Created" value={fmt(journey.created_at)} />
                  <Info label="Activated" value={fmt(journey.activated_at)} />
                </div>
              </TabsContent>

              <TabsContent value="steps" className="mt-0">
                {steps.length === 0 ? (
                  <p className="py-8 text-center text-sm text-muted-foreground">This journey has no steps yet.</p>
                ) : (
                  <ol className="space-y-2">
                    {steps.map((s, i) => {
                      const meta = STEP_META[s.type as StepType]
                      const Icon = meta?.icon
                      return (
                        <li key={s.id} className="flex items-center gap-3 rounded-md border p-3">
                          <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-medium text-primary">
                            {i + 1}
                          </span>
                          {Icon && <Icon className="size-4 shrink-0 text-primary" />}
                          <div className="min-w-0 flex-1">
                            <div className="text-sm font-medium">{s.name || meta?.label || s.type}</div>
                            <div className="truncate text-xs text-muted-foreground">
                              {stepSummary(s.type, s.config)}
                            </div>
                          </div>
                          {!s.enabled && <Badge variant="outline">Disabled</Badge>}
                        </li>
                      )
                    })}
                  </ol>
                )}
              </TabsContent>

              <TabsContent value="enrollments" className="mt-0">
                <EnrollmentsTab journeyId={journey.id} canManage={canManage} />
              </TabsContent>

              <TabsContent value="analytics" className="mt-0">
                <AnalyticsTab journeyId={journey.id} />
              </TabsContent>
            </div>
          </Tabs>
        )}
      </SheetContent>

      {journeyId != null && (
        <EnrollDialog
          journeyId={journeyId}
          open={enrollOpen}
          onOpenChange={setEnrollOpen}
          onEnrolled={() => {
            mutate()
            onChanged()
          }}
        />
      )}
    </Sheet>
  )
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-0.5">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-sm font-medium">{value}</p>
    </div>
  )
}

function stepSummary(type: StepType, config: any): string {
  const c = config || {}
  switch (type) {
    case "wait":
      return `Wait ${c.value ?? 0} ${c.unit || "hours"}`
    case "email":
      return c.templateId ? "Send template email" : c.subject ? `Email: ${c.subject}` : "Send email"
    case "whatsapp":
      return c.templateName ? `WhatsApp template: ${c.templateName}` : "WhatsApp text message"
    case "add_tag":
      return `Add tag: ${c.tag || "—"}`
    case "remove_tag":
      return `Remove tag: ${c.tag || "—"}`
    case "add_segment":
      return "Add to segment"
    case "remove_segment":
      return "Remove from segment"
    case "assign_owner":
      return "Assign owner"
    case "notification":
      return c.title || "Notify team"
    case "create_task":
      return c.title || "Create task"
    case "branch":
      return `Branch on ${c.condition?.type || "condition"}`
    case "goal":
      return `Goal: ${c.condition?.type || "checkpoint"}`
    case "end":
      return "End journey"
    default:
      return ""
  }
}

const ENROLLMENT_STATUSES = ["Active", "Waiting", "Completed", "Paused", "Exited", "Failed"]

function EnrollmentsTab({ journeyId, canManage }: { journeyId: number; canManage: boolean }) {
  const [status, setStatus] = useState("all")
  const [search, setSearch] = useState("")
  const [page, setPage] = useState(1)
  const pageSize = 25

  const params = new URLSearchParams()
  params.set("status", status)
  if (search) params.set("search", search)
  params.set("page", String(page))
  params.set("pageSize", String(pageSize))
  const { data, mutate } = useSWR(`/api/marketing/journeys/${journeyId}/enrollments?${params}`, fetcher)
  const items: any[] = data?.items || []
  const total: number = data?.total || 0

  async function act(eid: number, action: string) {
    const reason = action === "exit" ? "Removed from journey manually" : undefined
    const res = await fetch(`/api/marketing/journeys/${journeyId}/enrollments/${eid}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, reason }),
    })
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      toast.error(body.error || "Action failed")
      return
    }
    toast.success("Enrollment updated")
    mutate()
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          placeholder="Search contact…"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value)
            setPage(1)
          }}
          className="h-9 max-w-[220px]"
        />
        <Select
          value={status}
          onValueChange={(v) => {
            setStatus(v)
            setPage(1)
          }}
        >
          <SelectTrigger className="h-9 w-[150px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            {ENROLLMENT_STATUSES.map((s) => (
              <SelectItem key={s} value={s}>
                {s}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className="ml-auto text-xs text-muted-foreground">{total.toLocaleString()} total</span>
      </div>

      <div className="overflow-x-auto rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Contact</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="hidden sm:table-cell">Step</TableHead>
              <TableHead className="hidden md:table-cell">Last action</TableHead>
              {canManage && <TableHead className="w-10" />}
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="py-8 text-center text-muted-foreground">
                  No enrollments yet.
                </TableCell>
              </TableRow>
            )}
            {items.map((e) => (
              <TableRow key={e.id}>
                <TableCell>
                  <div className="font-medium">{e.contact_name || "Unknown"}</div>
                  <div className="text-xs text-muted-foreground">{e.contact_email || e.contact_code}</div>
                </TableCell>
                <TableCell>
                  <Badge variant={ENROLLMENT_STATUS_VARIANT[e.status] || "outline"}>{e.status}</Badge>
                  {e.goal_reached ? <span className="ml-1 text-xs text-primary">· goal</span> : null}
                </TableCell>
                <TableCell className="hidden sm:table-cell tabular-nums">{e.current_step_order}</TableCell>
                <TableCell className="hidden md:table-cell text-xs text-muted-foreground">
                  {fmt(e.last_action_at || e.started_at)}
                </TableCell>
                {canManage && (
                  <TableCell>
                    {["Active", "Waiting", "Paused"].includes(e.status) && (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" className="size-8">
                            <MoreHorizontal className="size-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          {e.status === "Paused" ? (
                            <DropdownMenuItem onClick={() => act(e.id, "resume")}>Resume</DropdownMenuItem>
                          ) : (
                            <DropdownMenuItem onClick={() => act(e.id, "pause")}>Pause</DropdownMenuItem>
                          )}
                          <DropdownMenuItem className="text-destructive" onClick={() => act(e.id, "exit")}>
                            Remove
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
      </div>

      {total > pageSize && (
        <div className="flex items-center justify-end gap-2 text-sm text-muted-foreground">
          <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            Previous
          </Button>
          <span>
            {page} / {Math.ceil(total / pageSize)}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={page >= Math.ceil(total / pageSize)}
            onClick={() => setPage((p) => p + 1)}
          >
            Next
          </Button>
        </div>
      )}
    </div>
  )
}

function AnalyticsTab({ journeyId }: { journeyId: number }) {
  const { data } = useSWR(`/api/marketing/journeys/${journeyId}/analytics`, fetcher)
  const a = data?.analytics
  if (!a) return <p className="py-8 text-center text-sm text-muted-foreground">Loading analytics…</p>

  const totals = a.totals || {}
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <MiniStat label="Total enrolled" value={a.totalEnrolled} />
        <MiniStat label="Completion rate" value={`${a.completionRate}%`} />
        <MiniStat label="Goal rate" value={`${a.goalRate}%`} />
      </div>

      <div className="space-y-2">
        <p className="text-xs font-medium text-muted-foreground">By status</p>
        <div className="space-y-2">
          {ENROLLMENT_STATUSES.filter((s) => totals[s]).map((s) => {
            const pct = a.totalEnrolled ? Math.round((totals[s] / a.totalEnrolled) * 100) : 0
            return (
              <div key={s} className="space-y-1">
                <div className="flex items-center justify-between text-xs">
                  <span>{s}</span>
                  <span className="tabular-nums text-muted-foreground">
                    {totals[s]} · {pct}%
                  </span>
                </div>
                <Progress value={pct} />
              </div>
            )
          })}
          {Object.keys(totals).length === 0 && (
            <p className="text-sm text-muted-foreground">No enrollments yet.</p>
          )}
        </div>
      </div>

      {a.stepBreakdown?.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground">Step execution</p>
          <div className="overflow-x-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Step type</TableHead>
                  <TableHead className="text-right">Run</TableHead>
                  <TableHead className="text-right">Completed</TableHead>
                  <TableHead className="text-right">Failed</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {a.stepBreakdown.map((row: any) => (
                  <TableRow key={row.type}>
                    <TableCell>{STEP_META[row.type as StepType]?.label || row.type}</TableCell>
                    <TableCell className="text-right tabular-nums">{row.count}</TableCell>
                    <TableCell className="text-right tabular-nums">{row.completed}</TableCell>
                    <TableCell className="text-right tabular-nums">{row.failed}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      )}

      <div className="space-y-2">
        <p className="text-xs font-medium text-muted-foreground">Recent activity</p>
        {a.recentEvents?.length ? (
          <ol className="space-y-2">
            {a.recentEvents.slice(0, 20).map((ev: any) => (
              <li key={ev.id} className="flex items-start justify-between gap-3 border-b pb-2 text-sm last:border-0">
                <div>
                  <span className="font-medium">{ev.detail || ev.action}</span>
                  {ev.contact_name && <span className="text-muted-foreground"> · {ev.contact_name}</span>}
                </div>
                <span className="shrink-0 text-xs text-muted-foreground">{fmt(ev.created_at)}</span>
              </li>
            ))}
          </ol>
        ) : (
          <p className="text-sm text-muted-foreground">No activity recorded yet.</p>
        )}
      </div>
    </div>
  )
}

function MiniStat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-md border p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-xl font-semibold tabular-nums">{value}</p>
    </div>
  )
}

function EnrollDialog({
  journeyId,
  open,
  onOpenChange,
  onEnrolled,
}: {
  journeyId: number
  open: boolean
  onOpenChange: (o: boolean) => void
  onEnrolled: () => void
}) {
  const { data: lookups } = useSWR<Lookups>(open ? "/api/marketing/journeys/lookups" : null, fetcher)
  const [mode, setMode] = useState<"contacts" | "segment">("contacts")
  const [contactIds, setContactIds] = useState("")
  const [segmentId, setSegmentId] = useState("")
  const [busy, setBusy] = useState(false)

  async function submit() {
    setBusy(true)
    const payload: any = {}
    if (mode === "contacts") {
      const ids = contactIds
        .split(/[\s,]+/)
        .map((x) => Number(x.trim()))
        .filter(Boolean)
      if (!ids.length) {
        toast.error("Enter at least one contact ID")
        setBusy(false)
        return
      }
      payload.contactIds = ids
    } else {
      if (!segmentId) {
        toast.error("Choose a segment")
        setBusy(false)
        return
      }
      payload.segmentId = Number(segmentId)
    }

    const res = await fetch(`/api/marketing/journeys/${journeyId}/enroll`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
    const body = await res.json().catch(() => ({}))
    setBusy(false)
    if (!res.ok) {
      toast.error(body.error || "Enrollment failed")
      return
    }
    toast.success(
      `Enrolled ${body.enrolled ?? 0}${body.skipped ? `, skipped ${body.skipped}` : ""}`,
    )
    setContactIds("")
    setSegmentId("")
    onEnrolled()
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Enroll contacts</DialogTitle>
          <DialogDescription>Manually add contacts to this journey by ID or by segment.</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="flex gap-2">
            <Button
              type="button"
              variant={mode === "contacts" ? "default" : "outline"}
              size="sm"
              onClick={() => setMode("contacts")}
            >
              By contact ID
            </Button>
            <Button
              type="button"
              variant={mode === "segment" ? "default" : "outline"}
              size="sm"
              onClick={() => setMode("segment")}
            >
              By segment
            </Button>
          </div>

          {mode === "contacts" ? (
            <div className="space-y-1.5">
              <Label htmlFor="cids">Contact IDs</Label>
              <Textarea
                id="cids"
                value={contactIds}
                onChange={(e) => setContactIds(e.target.value)}
                placeholder="Comma or space separated, e.g. 12, 34, 56"
                rows={3}
              />
              <p className="text-xs text-muted-foreground">
                Find contact IDs in the Contacts module. Segment enrollment is the easier bulk option.
              </p>
            </div>
          ) : (
            <div className="space-y-1.5">
              <Label>Segment</Label>
              <Select value={segmentId} onValueChange={setSegmentId}>
                <SelectTrigger>
                  <SelectValue placeholder="Choose a segment" />
                </SelectTrigger>
                <SelectContent>
                  {(lookups?.segments || []).map((s) => (
                    <SelectItem key={s.id} value={String(s.id)}>
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">Everyone currently in the segment (up to 5,000) is enrolled.</p>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={busy}>
            {busy && <Loader2 className="size-4 animate-spin" />}
            Enroll
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
