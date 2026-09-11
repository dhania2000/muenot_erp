"use client"

import { useState } from "react"
import useSWR from "swr"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import { Checkbox } from "@/components/ui/checkbox"
import { Separator } from "@/components/ui/separator"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { fetcher } from "@/lib/fetcher"
import { toast } from "sonner"
import { priorityBadge, slaBadge, statusBadge } from "./support-badges"

const STATUSES = ["Open", "In Progress", "Waiting", "Resolved", "Closed"]

function fmt(value?: string | null) {
  if (!value) return "—"
  return String(value).replace("T", " ").slice(0, 16)
}

export function SupportTicketDetail({
  ticketId,
  open,
  onOpenChange,
  onChanged,
}: {
  ticketId: number | null
  open: boolean
  onOpenChange: (v: boolean) => void
  onChanged: () => void
}) {
  const key = open && ticketId ? `/api/hr/support/${ticketId}` : null
  const { data, mutate, isLoading } = useSWR<any>(key, fetcher)
  const [reply, setReply] = useState("")
  const [internal, setInternal] = useState(false)
  const [resolution, setResolution] = useState("")
  const [busy, setBusy] = useState(false)

  const { data: agentData } = useSWR<any>(open && data?.canManage ? "/api/hr/support/agents" : null, fetcher)

  const ticket = data?.ticket
  const canManage = data?.canManage
  const messages = data?.messages || []
  const events = data?.events || []
  const attachments = data?.attachments || []

  const refresh = () => { mutate(); onChanged() }

  const patch = async (payload: any, successMsg?: string) => {
    if (!ticket) return
    setBusy(true)
    try {
      const res = await fetch(`/api/hr/support/${ticket.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error || "Update failed")
      if (successMsg) toast.success(successMsg)
      refresh()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const sendReply = async () => {
    if (!reply.trim() || !ticket) return
    setBusy(true)
    try {
      const res = await fetch(`/api/hr/support/${ticket.id}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: reply.trim(), is_internal: internal }),
      })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error || "Could not send")
      setReply(""); setInternal(false)
      refresh()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const rate = async (rating: number) => patch({ action: "csat", rating }, "Thanks for your feedback")

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] gap-0 overflow-hidden p-0 sm:max-w-4xl">
        {isLoading || !ticket ? (
          <div className="p-8 text-sm text-muted-foreground">Loading ticket…</div>
        ) : (
          <div className="flex max-h-[92vh] flex-col">
            <DialogHeader className="space-y-2 border-b p-5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-xs text-muted-foreground">{ticket.ticket_id}</span>
                {statusBadge(ticket.status)}
                {priorityBadge(ticket.priority)}
                {slaBadge(ticket.sla_state)}
                {ticket.is_sensitive ? <Badge variant="outline">Confidential</Badge> : null}
                {ticket.reopened_count > 0 ? <Badge variant="outline">Reopened ×{ticket.reopened_count}</Badge> : null}
              </div>
              <DialogTitle className="text-balance text-lg">{ticket.subject}</DialogTitle>
              <p className="text-xs text-muted-foreground">
                {ticket.employee_name || "Unknown"} · {ticket.department || "No department"} · {ticket.support_category}
                {ticket.subcategory ? ` · ${ticket.subcategory}` : ""}
              </p>
            </DialogHeader>

            <div className="grid flex-1 grid-cols-1 gap-0 overflow-hidden md:grid-cols-[1fr_280px]">
              {/* Conversation / activity */}
              <div className="flex min-h-0 flex-col overflow-hidden border-r">
                <Tabs defaultValue="conversation" className="flex min-h-0 flex-1 flex-col">
                  <TabsList className="mx-4 mt-3 w-fit">
                    <TabsTrigger value="conversation">Conversation</TabsTrigger>
                    <TabsTrigger value="timeline">Timeline</TabsTrigger>
                    <TabsTrigger value="files">Files ({attachments.length})</TabsTrigger>
                  </TabsList>

                  <TabsContent value="conversation" className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
                    <div className="space-y-3">
                      {messages.map((m: any) => (
                        <div
                          key={m.id}
                          className={`rounded-lg border p-3 text-sm ${m.is_internal ? "border-dashed bg-muted/60" : "bg-card"}`}
                        >
                          <div className="mb-1 flex items-center justify-between gap-2">
                            <span className="font-medium">{m.author_name || "System"}</span>
                            <span className="text-xs text-muted-foreground">{fmt(m.created_at)}</span>
                          </div>
                          {m.is_internal ? <Badge variant="outline" className="mb-1">Internal note</Badge> : null}
                          <p className="whitespace-pre-wrap leading-relaxed text-foreground">{m.body}</p>
                          {m.attachment_path ? (
                            <a href={m.attachment_path} target="_blank" rel="noreferrer" className="mt-2 inline-block text-xs text-primary underline">
                              {m.attachment_name || "Attachment"}
                            </a>
                          ) : null}
                        </div>
                      ))}
                      {messages.length === 0 ? <p className="text-sm text-muted-foreground">No messages yet.</p> : null}
                    </div>
                  </TabsContent>

                  <TabsContent value="timeline" className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
                    <ol className="space-y-3">
                      {events.map((ev: any) => (
                        <li key={ev.id} className="flex gap-3 text-sm">
                          <div className="mt-1 h-2 w-2 shrink-0 rounded-full bg-primary" />
                          <div>
                            <p className="text-foreground">{ev.detail || ev.event_type}</p>
                            <p className="text-xs text-muted-foreground">{ev.actor_name || "System"} · {fmt(ev.created_at)}</p>
                          </div>
                        </li>
                      ))}
                      {events.length === 0 ? <p className="text-sm text-muted-foreground">No activity yet.</p> : null}
                    </ol>
                  </TabsContent>

                  <TabsContent value="files" className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
                    <div className="space-y-2">
                      {attachments.map((a: any) => (
                        <a key={a.id} href={a.file_url} target="_blank" rel="noreferrer" className="flex items-center justify-between rounded-md border p-2 text-sm hover:bg-muted">
                          <span className="truncate">{a.file_name || "Attachment"}</span>
                          <span className="text-xs text-muted-foreground">{fmt(a.created_at)}</span>
                        </a>
                      ))}
                      {attachments.length === 0 ? <p className="text-sm text-muted-foreground">No files attached.</p> : null}
                    </div>
                  </TabsContent>
                </Tabs>

                {/* Reply box */}
                {ticket.status !== "Closed" || canManage ? (
                  <div className="border-t p-4">
                    <Textarea
                      value={reply}
                      onChange={(e) => setReply(e.target.value)}
                      placeholder={canManage ? "Reply to the employee…" : "Add a reply…"}
                      rows={2}
                    />
                    <div className="mt-2 flex items-center justify-between">
                      {canManage ? (
                        <label className="flex items-center gap-2 text-xs text-muted-foreground">
                          <Checkbox checked={internal} onCheckedChange={(v) => setInternal(Boolean(v))} />
                          Internal note (hidden from employee)
                        </label>
                      ) : <span />}
                      <Button size="sm" disabled={busy || !reply.trim()} onClick={sendReply}>Send</Button>
                    </div>
                  </div>
                ) : null}
              </div>

              {/* Side panel */}
              <div className="min-h-0 space-y-4 overflow-y-auto p-4">
                {canManage ? (
                  <div className="space-y-3">
                    <div className="grid gap-1.5">
                      <Label className="text-xs">Status</Label>
                      <Select
                        value={ticket.status}
                        onValueChange={(v) => {
                          if (v === "Resolved") return // handled via resolve box below
                          patch({ action: "status", status: v }, `Moved to ${v}`)
                        }}
                      >
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {STATUSES.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    </div>

                    <div className="grid gap-1.5">
                      <Label className="text-xs">Assignee</Label>
                      <Select
                        value={ticket.assigned_to ? String(ticket.assigned_to) : "unassigned"}
                        onValueChange={(v) => patch({ action: "assign", assigned_to: v === "unassigned" ? null : Number(v) }, "Assignment updated")}
                      >
                        <SelectTrigger><SelectValue placeholder="Unassigned" /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="unassigned">Unassigned</SelectItem>
                          {(agentData?.agents || []).map((a: any) => (
                            <SelectItem key={a.id} value={String(a.id)}>{a.name}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>

                    <div className="grid gap-1.5">
                      <Label className="text-xs">Priority</Label>
                      <Select value={ticket.priority} onValueChange={(v) => patch({ action: "reprioritise", priority: v }, "Priority updated")}>
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {["Low", "Medium", "High", "Urgent"].map((p) => <SelectItem key={p} value={p}>{p}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    </div>

                    {ticket.status !== "Resolved" && ticket.status !== "Closed" ? (
                      <div className="grid gap-1.5">
                        <Label className="text-xs">Resolve ticket</Label>
                        <Textarea value={resolution} onChange={(e) => setResolution(e.target.value)} placeholder="Resolution summary" rows={3} />
                        <Button size="sm" disabled={busy || !resolution.trim()} onClick={() => patch({ action: "status", status: "Resolved", resolution: resolution.trim() }, "Ticket resolved")}>
                          Mark resolved
                        </Button>
                      </div>
                    ) : null}

                    <Separator />
                  </div>
                ) : null}

                <div className="space-y-2 text-xs">
                  <Detail label="Created" value={fmt(ticket.created_at)} />
                  <Detail label="Created by" value={ticket.created_by_name} />
                  <Detail label="Manager" value={ticket.manager_name} />
                  <Detail label="Assignee" value={ticket.assigned_to_name || "Unassigned"} />
                  <Detail label="First response due" value={fmt(ticket.first_response_due)} />
                  <Detail label="First response" value={fmt(ticket.first_response_at)} />
                  <Detail label="Resolution due" value={fmt(ticket.sla_due_date)} />
                  <Detail label="Resolved" value={fmt(ticket.resolved_at)} />
                  {ticket.resolution ? <Detail label="Resolution" value={ticket.resolution} /> : null}
                </div>

                {/* Employee actions on resolved tickets */}
                {!canManage && (ticket.status === "Resolved" || ticket.status === "Closed") ? (
                  <div className="space-y-3 rounded-lg border p-3">
                    <div>
                      <Label className="text-xs">Rate this resolution</Label>
                      <div className="mt-1 flex gap-1">
                        {[1, 2, 3, 4, 5].map((n) => (
                          <button
                            key={n}
                            type="button"
                            onClick={() => rate(n)}
                            className={`h-7 w-7 rounded-md border text-sm ${ticket.csat_rating >= n ? "bg-primary text-primary-foreground" : "hover:bg-muted"}`}
                            aria-label={`Rate ${n} of 5`}
                          >
                            {n}
                          </button>
                        ))}
                      </div>
                    </div>
                    {ticket.status === "Resolved" ? (
                      <Button size="sm" variant="outline" disabled={busy} onClick={() => patch({ action: "status", status: "Open" }, "Ticket reopened")}>
                        Reopen ticket
                      </Button>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

function Detail({ label, value }: { label: string; value?: string | null }) {
  return (
    <div className="flex justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right font-medium text-foreground">{value || "—"}</span>
    </div>
  )
}
