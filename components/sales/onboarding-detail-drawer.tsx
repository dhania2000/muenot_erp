"use client"

import { useState } from "react"
import useSWR from "swr"
import { toast } from "sonner"
import { fetcher } from "@/lib/fetcher"
import { formatDate, formatDateTime, formatCurrency, cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Separator } from "@/components/ui/separator"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Select,
  SelectContent,
  SelectGroup,
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Field, FieldLabel } from "@/components/ui/field"
import { EntityCombobox } from "@/components/sales/entity-combobox"
import {
  ONBOARDING_STAGES,
  STATUS_VARIANT,
  HEALTH_VARIANT,
  PRIORITY_VARIANT,
} from "@/components/sales/onboarding-constants"
import { Plus, Trash2, X, ChevronRight, Loader2Icon } from "lucide-react"

type ActionKind =
  | "hold"
  | "block"
  | "cancel"
  | "complete"
  | "reopen"
  | "go-live"
  | "handover"
  | "kickoff"
  | null

const SUB_STATUS: Record<string, string[]> = {
  checklist: ["Pending", "In Progress", "Done", "N/A"],
  task: ["Open", "In Progress", "Done", "Cancelled"],
  milestone: ["Pending", "In Progress", "Done", "Missed"],
  document: ["Requested", "Received", "Verified", "Rejected", "N/A"],
  risk: ["Open", "Mitigating", "Resolved"],
}

export function OnboardingDetailDrawer({
  onboardingId,
  open,
  onOpenChange,
  canManage,
  onChanged,
}: {
  onboardingId: number | null
  open: boolean
  onOpenChange: (open: boolean) => void
  canManage: boolean
  onChanged: () => void
}) {
  const key = open && onboardingId ? `/api/sales/onboarding/${onboardingId}` : null
  const { data, isLoading, mutate } = useSWR<{ onboarding: any }>(key, fetcher)
  const { data: lookups } = useSWR<any>(open ? "/api/sales/onboarding/lookups" : null, fetcher)
  const ob = data?.onboarding
  const [busy, setBusy] = useState(false)
  const [action, setAction] = useState<ActionKind>(null)

  function refresh() {
    mutate()
    onChanged()
  }

  async function runAction(body: Record<string, any>, successMsg: string) {
    if (!onboardingId) return
    setBusy(true)
    try {
      const res = await fetch(`/api/sales/onboarding/${onboardingId}/actions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, expectedRowVersion: ob?.row_version }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) {
        if (json?.details?.requiresOverride) {
          if (confirm(`${json.error}\n\nForce this action anyway?`)) {
            return runAction({ ...body, override: true }, successMsg)
          }
        } else {
          toast.error(json.error || "Action failed")
        }
        return
      }
      toast.success(successMsg)
      setAction(null)
      refresh()
    } finally {
      setBusy(false)
    }
  }

  async function changeStage(stage: string) {
    await runAction({ action: "stage", stage }, `Stage set to ${stage}`)
  }

  async function addItem(kind: string, body: Record<string, any>) {
    if (!onboardingId) return
    const res = await fetch(`/api/sales/onboarding/${onboardingId}/items`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind, ...body }),
    })
    const json = await res.json().catch(() => ({}))
    if (!res.ok) return toast.error(json.error || "Failed to add")
    toast.success("Added")
    refresh()
  }

  async function updateItem(kind: string, itemId: number, body: Record<string, any>) {
    if (!onboardingId) return
    const res = await fetch(`/api/sales/onboarding/${onboardingId}/items/${itemId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind, ...body }),
    })
    if (!res.ok) {
      const json = await res.json().catch(() => ({}))
      return toast.error(json.error || "Failed to update")
    }
    refresh()
  }

  async function deleteItem(kind: string, itemId: number) {
    if (!onboardingId) return
    const res = await fetch(`/api/sales/onboarding/${onboardingId}/items/${itemId}?kind=${kind}`, { method: "DELETE" })
    if (!res.ok) {
      const json = await res.json().catch(() => ({}))
      return toast.error(json.error || "Failed to remove")
    }
    refresh()
  }

  if (!open) return null

  const terminal = ob?.status === "Completed" || ob?.status === "Cancelled"

  return (
    <>
      <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label="Onboarding detail">
        <div className="absolute inset-0 bg-black/40" onClick={() => onOpenChange(false)} />
        <div className="relative flex h-full w-full max-w-2xl flex-col border-l border-border bg-background shadow-xl">
          {/* Header */}
          <div className="flex items-start justify-between gap-3 border-b border-border p-4">
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-2">
                <h2 className="text-lg font-semibold">{ob?.company_name || "Onboarding"}</h2>
                {ob && <span className="text-sm text-muted-foreground">{ob.onboarding_code}</span>}
              </div>
              {ob && (
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline">{ob.current_stage}</Badge>
                  <Badge variant={STATUS_VARIANT[ob.status] || "outline"}>{ob.status}</Badge>
                  <Badge variant={HEALTH_VARIANT[ob.health] || "outline"}>{ob.health}</Badge>
                  {ob.priority && <Badge variant={PRIORITY_VARIANT[ob.priority] || "outline"}>{ob.priority}</Badge>}
                </div>
              )}
            </div>
            <Button variant="ghost" size="icon-sm" aria-label="Close" onClick={() => onOpenChange(false)}>
              <X className="size-4" />
            </Button>
          </div>

          {isLoading && (
            <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
              <Loader2Icon className="mr-2 size-4 animate-spin" /> Loading…
            </div>
          )}

          {ob && (
            <>
              {/* Progress */}
              <div className="border-b border-border px-4 py-3">
                <div className="mb-1 flex items-center justify-between text-xs text-muted-foreground">
                  <span>Progress</span>
                  <span>{ob.progress_pct ?? 0}%</span>
                </div>
                <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-primary transition-all"
                    style={{ width: `${Math.min(100, Math.max(0, ob.progress_pct ?? 0))}%` }}
                  />
                </div>
                {ob.health_reasons?.length > 0 && (
                  <ul className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    {ob.health_reasons.map((r: string, i: number) => (
                      <li key={i} className="flex items-center gap-1">
                        <span className={cn("size-1.5 rounded-full", ob.health === "Blocked" ? "bg-destructive" : ob.health === "At Risk" ? "bg-amber-500" : "bg-emerald-500")} />
                        {r}
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {/* Action bar */}
              {canManage && (
                <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
                  <Select value={ob.current_stage} onValueChange={(v) => v && changeStage(v)}>
                    <SelectTrigger size="sm" className="w-40" disabled={busy || terminal}>
                      <SelectValue placeholder="Stage" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {ONBOARDING_STAGES.map((s) => (
                          <SelectItem key={s} value={s}>
                            {s}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>

                  <DropdownMenu>
                    <DropdownMenuTrigger render={<Button variant="outline" size="sm" disabled={busy} />}>
                      Status
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start">
                      {!terminal && (
                        <>
                          <DropdownMenuItem onClick={() => runAction({ action: "status", status: "In Progress" }, "Resumed")}>
                            Mark In Progress
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => setAction("hold")}>Put On Hold…</DropdownMenuItem>
                          <DropdownMenuItem onClick={() => setAction("block")}>Mark Blocked…</DropdownMenuItem>
                          <DropdownMenuItem onClick={() => setAction("complete")}>Complete…</DropdownMenuItem>
                          <DropdownMenuItem variant="destructive" onClick={() => setAction("cancel")}>
                            Cancel…
                          </DropdownMenuItem>
                        </>
                      )}
                      {terminal && (
                        <DropdownMenuItem onClick={() => setAction("reopen")}>Reopen</DropdownMenuItem>
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>

                  {!terminal && (
                    <>
                      <Button variant="outline" size="sm" disabled={busy} onClick={() => setAction("kickoff")}>
                        {ob.kickoff_meeting_id ? "Kickoff scheduled" : "Schedule kickoff"}
                      </Button>
                      <Button variant="outline" size="sm" disabled={busy} onClick={() => setAction("go-live")}>
                        Go-live
                      </Button>
                      <Button variant="outline" size="sm" disabled={busy} onClick={() => setAction("handover")}>
                        Handover
                      </Button>
                    </>
                  )}
                  {ob.archived_at ? (
                    <Button variant="outline" size="sm" disabled={busy} onClick={() => runAction({ action: "restore" }, "Restored")}>
                      Restore
                    </Button>
                  ) : (
                    <Button variant="outline" size="sm" disabled={busy} onClick={() => runAction({ action: "archive" }, "Archived")}>
                      Archive
                    </Button>
                  )}
                </div>
              )}

              {/* Tabs */}
              <div className="flex-1 overflow-y-auto p-4">
                <Tabs defaultValue="overview">
                  <TabsList className="mb-4 flex flex-wrap">
                    <TabsTrigger value="overview">Overview</TabsTrigger>
                    <TabsTrigger value="checklist">Checklist</TabsTrigger>
                    <TabsTrigger value="task">Tasks</TabsTrigger>
                    <TabsTrigger value="document">Documents</TabsTrigger>
                    <TabsTrigger value="milestone">Milestones</TabsTrigger>
                    <TabsTrigger value="risk">Risks</TabsTrigger>
                    <TabsTrigger value="timeline">Timeline</TabsTrigger>
                  </TabsList>

                  <TabsContent value="overview">
                    <Overview ob={ob} />
                  </TabsContent>

                  {(["checklist", "task", "document", "milestone", "risk"] as const).map((kind) => (
                    <TabsContent key={kind} value={kind}>
                      <SubItemPanel
                        kind={kind}
                        items={ob.items?.[kind === "task" ? "tasks" : kind === "risk" ? "risks" : kind === "document" ? "documents" : kind === "milestone" ? "milestones" : "checklist"] || []}
                        canManage={canManage && !terminal}
                        onAdd={(body) => addItem(kind, body)}
                        onUpdate={(itemId, body) => updateItem(kind, itemId, body)}
                        onDelete={(itemId) => deleteItem(kind, itemId)}
                      />
                    </TabsContent>
                  ))}

                  <TabsContent value="timeline">
                    <Timeline activities={ob.activities || []} history={ob.history || []} />
                  </TabsContent>
                </Tabs>
              </div>
            </>
          )}
        </div>
      </div>

      <ActionDialog
        action={action}
        onClose={() => setAction(null)}
        busy={busy}
        ownerOptions={(lookups?.users || []).map((u: any) => ({ value: String(u.id), label: u.name }))}
        onSubmit={(body, msg) => runAction(body, msg)}
        hasKickoff={!!ob?.kickoff_meeting_id}
      />
    </>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 py-1.5 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right font-medium">{children || "—"}</span>
    </div>
  )
}

function Overview({ ob }: { ob: any }) {
  const rel = ob.relations || {}
  return (
    <div className="flex flex-col gap-4">
      <section className="rounded-lg border border-border p-3">
        <h3 className="mb-1 text-sm font-semibold">Relationships</h3>
        <Row label="Contract">{rel.contract ? `${rel.contract.contract_code}${rel.contract.value ? ` · ${formatCurrency(Number(rel.contract.value))}` : ""}` : ob.contract_code}</Row>
        <Row label="Quotation">{rel.quotation ? rel.quotation.quote_code : null}</Row>
        <Row label="Lead">{rel.lead ? `${rel.lead.lead_code}` : null}</Row>
        <Row label="Kickoff meeting">{rel.kickoff ? `${rel.kickoff.meeting_code} · ${formatDate(rel.kickoff.meeting_date)}` : null}</Row>
        <Row label="Contact">{ob.contact_person}</Row>
        <Row label="Owner">{ob.owner_name}</Row>
        <Row label="Created by">{ob.added_by_name}</Row>
      </section>

      <section className="rounded-lg border border-border p-3">
        <h3 className="mb-1 text-sm font-semibold">Timeline & dates</h3>
        <Row label="Onboarding date">{formatDate(ob.onboarding_date)}</Row>
        <Row label="Planned start">{formatDate(ob.start_date)}</Row>
        <Row label="Target completion">{formatDate(ob.target_completion_date)}</Row>
        <Row label="Go-live">{formatDate(ob.go_live_date)}</Row>
        <Row label="Actual completion">{ob.completed_at ? formatDateTime(ob.completed_at) : null}</Row>
      </section>

      {ob.status === "On Hold" && (
        <section className="rounded-lg border border-border p-3">
          <h3 className="mb-1 text-sm font-semibold">On hold</h3>
          <Row label="Reason">{ob.hold_reason}</Row>
          <Row label="Since">{formatDateTime(ob.hold_since)}</Row>
          <Row label="Expected resume">{formatDate(ob.expected_resume_date)}</Row>
        </section>
      )}
      {ob.status === "Blocked" && (
        <section className="rounded-lg border border-border p-3">
          <h3 className="mb-1 text-sm font-semibold">Blocked</h3>
          <Row label="Reason">{ob.blocked_reason}</Row>
          <Row label="Since">{formatDateTime(ob.blocked_since)}</Row>
        </section>
      )}
      {ob.status === "Cancelled" && (
        <section className="rounded-lg border border-border p-3">
          <h3 className="mb-1 text-sm font-semibold">Cancelled</h3>
          <Row label="Reason">{ob.cancel_reason}</Row>
          <Row label="At">{formatDateTime(ob.cancelled_at)}</Row>
        </section>
      )}

      {(ob.requirements_summary || ob.scope_notes || ob.internal_notes) && (
        <section className="rounded-lg border border-border p-3">
          <h3 className="mb-2 text-sm font-semibold">Notes</h3>
          {ob.requirements_summary && (
            <div className="mb-2">
              <p className="text-xs text-muted-foreground">Requirements</p>
              <p className="whitespace-pre-wrap text-sm">{ob.requirements_summary}</p>
            </div>
          )}
          {ob.scope_notes && (
            <div className="mb-2">
              <p className="text-xs text-muted-foreground">Scope</p>
              <p className="whitespace-pre-wrap text-sm">{ob.scope_notes}</p>
            </div>
          )}
          {ob.internal_notes && (
            <div>
              <p className="text-xs text-muted-foreground">Internal</p>
              <p className="whitespace-pre-wrap text-sm">{ob.internal_notes}</p>
            </div>
          )}
        </section>
      )}
    </div>
  )
}

function SubItemPanel({
  kind,
  items,
  canManage,
  onAdd,
  onUpdate,
  onDelete,
}: {
  kind: "checklist" | "task" | "document" | "milestone" | "risk"
  items: any[]
  canManage: boolean
  onAdd: (body: Record<string, any>) => void
  onUpdate: (itemId: number, body: Record<string, any>) => void
  onDelete: (itemId: number) => void
}) {
  const [title, setTitle] = useState("")
  const [required, setRequired] = useState(false)
  const nameKey = kind === "milestone" ? "name" : kind === "document" ? "name" : "title"
  const statusKey = kind === "document" ? "doc_status" : "status"
  const statuses = SUB_STATUS[kind]

  function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!title.trim()) return
    const body: Record<string, any> = { [nameKey]: title.trim() }
    if (kind === "checklist" || kind === "document") body.is_required = required ? 1 : 0
    onAdd(body)
    setTitle("")
    setRequired(false)
  }

  return (
    <div className="flex flex-col gap-3">
      {canManage && (
        <form onSubmit={submit} className="flex items-center gap-2">
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={`Add ${kind}…`}
            className="h-8"
          />
          {(kind === "checklist" || kind === "document") && (
            <label className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
              <input type="checkbox" checked={required} onChange={(e) => setRequired(e.target.checked)} />
              Required
            </label>
          )}
          <Button type="submit" size="sm" disabled={!title.trim()}>
            <Plus className="size-4" />
          </Button>
        </form>
      )}

      {items.length === 0 && <p className="py-6 text-center text-sm text-muted-foreground">No {kind} items yet.</p>}

      <ul className="flex flex-col divide-y divide-border">
        {items.map((it) => (
          <li key={it.id} className="flex items-center justify-between gap-2 py-2">
            <div className="flex min-w-0 flex-col">
              <span className="flex items-center gap-2 text-sm">
                <span className="truncate">{it[nameKey]}</span>
                {(it.is_required === 1 || it.is_required === true) && (
                  <Badge variant="outline" className="shrink-0 text-[10px]">
                    Required
                  </Badge>
                )}
              </span>
              {it.due_date && <span className="text-xs text-muted-foreground">Due {formatDate(it.due_date)}</span>}
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              <Select
                value={it[statusKey]}
                onValueChange={(v) => v && onUpdate(it.id, { [statusKey]: v })}
              >
                <SelectTrigger size="sm" className="w-32" disabled={!canManage}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {statuses.map((s) => (
                      <SelectItem key={s} value={s}>
                        {s}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
              {canManage && (
                <Button variant="ghost" size="icon-sm" aria-label="Remove" onClick={() => onDelete(it.id)}>
                  <Trash2 className="size-4" />
                </Button>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}

function Timeline({ activities, history }: { activities: any[]; history: any[] }) {
  const merged = [
    ...activities.map((a) => ({
      at: a.occurred_at,
      title: a.title || a.activity_type,
      body: a.body,
      actor: a.actor_name,
    })),
    ...history.map((h) => ({
      at: h.changed_at,
      title: `${h.field}: ${h.from_value ?? "—"} → ${h.to_value ?? "—"}`,
      body: h.note,
      actor: h.actor_name,
    })),
  ].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())

  if (merged.length === 0) return <p className="py-6 text-center text-sm text-muted-foreground">No activity yet.</p>

  return (
    <ul className="flex flex-col gap-3">
      {merged.map((e, i) => (
        <li key={i} className="flex gap-3">
          <div className="mt-1 flex flex-col items-center">
            <ChevronRight className="size-3.5 text-muted-foreground" />
          </div>
          <div className="flex flex-col">
            <span className="text-sm font-medium">{e.title}</span>
            {e.body && <span className="text-sm text-muted-foreground">{e.body}</span>}
            <span className="text-xs text-muted-foreground">
              {formatDateTime(e.at)}
              {e.actor ? ` · ${e.actor}` : ""}
            </span>
          </div>
        </li>
      ))}
    </ul>
  )
}

function ActionDialog({
  action,
  onClose,
  onSubmit,
  busy,
  ownerOptions,
  hasKickoff,
}: {
  action: ActionKind
  onClose: () => void
  onSubmit: (body: Record<string, any>, msg: string) => void
  busy: boolean
  ownerOptions: { value: string; label: string }[]
  hasKickoff: boolean
}) {
  const [reason, setReason] = useState("")
  const [date, setDate] = useState("")
  const [time, setTime] = useState("")
  const [notes, setNotes] = useState("")
  const [ownerId, setOwnerId] = useState<string | null>(null)
  const [reassign, setReassign] = useState(true)

  const open = action !== null
  function reset() {
    setReason("")
    setDate("")
    setTime("")
    setNotes("")
    setOwnerId(null)
    setReassign(true)
  }

  const config: Record<string, { title: string; desc: string }> = {
    hold: { title: "Put on hold", desc: "Capture why this implementation is paused." },
    block: { title: "Mark blocked", desc: "Describe the blocker holding delivery." },
    cancel: { title: "Cancel onboarding", desc: "This keeps history — a reason is required." },
    complete: { title: "Complete onboarding", desc: "Required checklist and documents must be satisfied." },
    reopen: { title: "Reopen onboarding", desc: "Move this back into progress." },
    "go-live": { title: "Record go-live", desc: "Log the go-live date and notes." },
    handover: { title: "Handover", desc: "Hand this implementation to a colleague." },
    kickoff: { title: "Schedule kickoff meeting", desc: "Creates a linked Sales meeting." },
  }
  const cfg = action ? config[action] : null

  function submit() {
    if (!action) return
    switch (action) {
      case "hold":
        if (!reason.trim()) return
        onSubmit({ action: "status", status: "On Hold", reason: reason.trim(), expected_resume_date: date || null }, "Put on hold")
        break
      case "block":
        if (!reason.trim()) return
        onSubmit({ action: "status", status: "Blocked", reason: reason.trim() }, "Marked blocked")
        break
      case "cancel":
        if (!reason.trim()) return
        onSubmit({ action: "status", status: "Cancelled", reason: reason.trim() }, "Cancelled")
        break
      case "complete":
        onSubmit({ action: "complete", reason: reason.trim() || undefined }, "Completed")
        break
      case "reopen":
        onSubmit({ action: "reopen", reason: reason.trim() || undefined }, "Reopened")
        break
      case "go-live":
        onSubmit({ action: "go-live", go_live_date: date || undefined, notes: notes.trim() || undefined }, "Go-live recorded")
        break
      case "handover":
        if (!ownerId) return
        onSubmit({ action: "handover", handover_to_id: Number(ownerId), notes: notes.trim() || undefined, reassign }, "Handover recorded")
        break
      case "kickoff":
        if (!date) return
        onSubmit(
          { action: "schedule-kickoff", meeting_date: date, meeting_time: time || null, agenda: notes.trim() || null },
          "Kickoff scheduled",
        )
        break
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) {
          reset()
          onClose()
        }
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{cfg?.title}</DialogTitle>
          <DialogDescription>{cfg?.desc}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3 py-2">
          {(action === "hold" || action === "block" || action === "cancel") && (
            <Field>
              <FieldLabel>Reason</FieldLabel>
              <Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
            </Field>
          )}
          {action === "hold" && (
            <Field>
              <FieldLabel>Expected resume date</FieldLabel>
              <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </Field>
          )}
          {(action === "complete" || action === "reopen") && (
            <Field>
              <FieldLabel>Note (optional)</FieldLabel>
              <Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
            </Field>
          )}
          {action === "go-live" && (
            <>
              <Field>
                <FieldLabel>Go-live date</FieldLabel>
                <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
              </Field>
              <Field>
                <FieldLabel>Notes</FieldLabel>
                <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
              </Field>
            </>
          )}
          {action === "handover" && (
            <>
              <Field>
                <FieldLabel>Handover to</FieldLabel>
                <EntityCombobox options={ownerOptions} value={ownerId} onChange={setOwnerId} placeholder="Select colleague" />
              </Field>
              <label className="flex items-center gap-2 text-sm text-muted-foreground">
                <input type="checkbox" checked={reassign} onChange={(e) => setReassign(e.target.checked)} />
                Also reassign ownership
              </label>
              <Field>
                <FieldLabel>Notes</FieldLabel>
                <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
              </Field>
            </>
          )}
          {action === "kickoff" && (
            <>
              {hasKickoff && (
                <p className="text-sm text-destructive">A kickoff meeting is already linked to this onboarding.</p>
              )}
              <div className="grid grid-cols-2 gap-3">
                <Field>
                  <FieldLabel>Date</FieldLabel>
                  <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
                </Field>
                <Field>
                  <FieldLabel>Time</FieldLabel>
                  <Input type="time" value={time} onChange={(e) => setTime(e.target.value)} />
                </Field>
              </div>
              <Field>
                <FieldLabel>Agenda</FieldLabel>
                <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
              </Field>
            </>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={busy}>
            {busy && <Loader2Icon className="animate-spin" data-icon="inline-start" />}
            Confirm
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
