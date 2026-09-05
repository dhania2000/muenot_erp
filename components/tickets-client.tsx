"use client"

import { useState } from "react"
import useSWR from "swr"
import { fetcher } from "@/lib/fetcher"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { TicketCheck, Plus, Search, Eye, Trash2, ArrowLeft, User, Send, MessageSquare } from "lucide-react"

type TicketItem = {
  id: number
  subject: string
  description: string | null
  type: string
  priority: "low" | "medium" | "high" | "urgent"
  status: "open" | "pending" | "resolved" | "closed"
  requester_name: string | null
  requester_email: string | null
  agent_name: string | null
  created_by: number | null
  created_by_name: string | null
  created_at: string
  updated_at: string
}

type Reply = { id: number; message: string; author_name: string | null; is_staff: number; created_at: string }
type Me = { userId: number; name: string; email: string }
type ApiResponse = { tickets: TicketItem[]; employees: string[]; canManage: boolean; me: Me }

const TYPES = [
  { value: "general", label: "General" },
  { value: "bug", label: "Bug" },
  { value: "feature", label: "Feature Request" },
  { value: "incident", label: "Incident" },
  { value: "billing", label: "Billing" },
  { value: "question", label: "Question" },
]
const PRIORITIES = ["low", "medium", "high", "urgent"] as const
const STATUSES = ["open", "pending", "resolved", "closed"] as const

const PRIORITY_STYLES: Record<string, string> = {
  low: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
  medium: "bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300",
  high: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
  urgent: "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300",
}
const STATUS_STYLES: Record<string, string> = {
  open: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  pending: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
  resolved: "bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300",
  closed: "bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
}

const emptyForm = {
  subject: "",
  type: "general",
  priority: "medium" as TicketItem["priority"],
  description: "",
  requester_name: "",
  requester_email: "",
  agent_name: "",
}

function typeLabel(v: string) {
  return TYPES.find((t) => t.value === v)?.label ?? v
}

function formatDateTime(value: string) {
  const d = new Date(value.replace(" ", "T"))
  if (Number.isNaN(d.getTime())) return value
  return d.toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })
}

export function TicketsClient() {
  const [q, setQ] = useState("")
  const [statusFilter, setStatusFilter] = useState("all")
  const [priorityFilter, setPriorityFilter] = useState("all")

  const params = new URLSearchParams()
  if (q) params.set("q", q)
  if (statusFilter !== "all") params.set("status", statusFilter)
  if (priorityFilter !== "all") params.set("priority", priorityFilter)
  const { data, mutate } = useSWR<ApiResponse>(`/api/tickets?${params.toString()}`, fetcher)

  const tickets = data?.tickets ?? []
  const employees = data?.employees ?? []
  const canManage = data?.canManage ?? false

  const [view, setView] = useState<"list" | "form">("list")
  const [form, setForm] = useState(emptyForm)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")
  const [viewing, setViewing] = useState<TicketItem | null>(null)

  const openCreate = () => { setForm(emptyForm); setError(""); setView("form") }

  const save = async (ev: React.FormEvent) => {
    ev.preventDefault()
    setError("")
    if (!form.subject.trim()) { setError("Subject is required."); return }
    setSaving(true)
    const res = await fetch("/api/tickets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(form),
    })
    setSaving(false)
    if (res.ok) { setView("list"); setForm(emptyForm); mutate() }
    else setError((await res.json().catch(() => ({}))).error || "Could not create the ticket.")
  }

  const remove = async (id: number) => {
    await fetch(`/api/tickets?id=${id}`, { method: "DELETE" })
    setViewing(null)
    mutate()
  }

  if (view === "form") {
    return (
      <main className="flex flex-col gap-6 p-6 md:p-8">
        <header className="flex items-center gap-3">
          <Button variant="outline" size="sm" onClick={() => setView("list")}>
            <ArrowLeft className="mr-2 size-4" /> Back
          </Button>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Create Ticket</h1>
            <p className="text-sm text-muted-foreground">Tickets <span className="px-1">•</span> Create</p>
          </div>
        </header>

        <form onSubmit={save} className="grid gap-6 rounded-lg border bg-card p-6">
          {error && <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}

          <label className="grid gap-1.5 text-sm font-medium">
            Subject
            <Input required value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} placeholder="Briefly describe the issue" />
          </label>

          <div className="grid gap-4 md:grid-cols-2">
            <label className="grid gap-1.5 text-sm font-medium">
              Ticket Type
              <Select value={form.type} onValueChange={(v) => setForm({ ...form, type: v || "general" })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {TYPES.map((t) => <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </label>
            <label className="grid gap-1.5 text-sm font-medium">
              Priority
              <Select value={form.priority} onValueChange={(v) => setForm({ ...form, priority: (v as TicketItem["priority"]) || "medium" })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {PRIORITIES.map((p) => <SelectItem key={p} value={p} className="capitalize">{p}</SelectItem>)}
                </SelectContent>
              </Select>
            </label>
          </div>

          {canManage && (
            <div className="grid gap-4 rounded-md border p-4 md:grid-cols-3">
              <label className="grid gap-1.5 text-sm font-medium">
                Requester Name
                <Input value={form.requester_name} onChange={(e) => setForm({ ...form, requester_name: e.target.value })} placeholder="Defaults to you" />
              </label>
              <label className="grid gap-1.5 text-sm font-medium">
                Requester Email
                <Input type="email" value={form.requester_email} onChange={(e) => setForm({ ...form, requester_email: e.target.value })} placeholder="Optional" />
              </label>
              <label className="grid gap-1.5 text-sm font-medium">
                Assign Agent
                <Select value={form.agent_name || "none"} onValueChange={(v) => setForm({ ...form, agent_name: !v || v === "none" ? "" : v })}>
                  <SelectTrigger><SelectValue placeholder="Unassigned" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Unassigned</SelectItem>
                    {employees.map((n) => <SelectItem key={n} value={n}>{n}</SelectItem>)}
                  </SelectContent>
                </Select>
              </label>
            </div>
          )}

          <label className="grid gap-1.5 text-sm font-medium">
            Description
            <Textarea rows={6} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="Provide as much detail as possible" />
          </label>

          <div className="flex items-center gap-2">
            <Button type="submit" disabled={saving}>{saving ? "Submitting…" : "Submit Ticket"}</Button>
            <Button type="button" variant="ghost" onClick={() => setView("list")}>Cancel</Button>
          </div>
        </form>
      </main>
    )
  }

  return (
    <main className="flex flex-col gap-6 p-6 md:p-8">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Tickets</h1>
          <p className="text-sm text-muted-foreground">
            Home <span className="px-1">•</span> Tickets
            {!canManage && <span className="ml-2 text-xs">(showing your tickets)</span>}
          </p>
        </div>
        <Button onClick={openCreate}>
          <Plus className="mr-2 size-4" /> Add Ticket
        </Button>
      </header>

      <div className="flex flex-wrap items-end gap-3 rounded-lg border bg-card p-4">
        <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
          Status
          <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v || "all")}>
            <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              {STATUSES.map((s) => <SelectItem key={s} value={s} className="capitalize">{s}</SelectItem>)}
            </SelectContent>
          </Select>
        </label>
        <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
          Priority
          <Select value={priorityFilter} onValueChange={(v) => setPriorityFilter(v || "all")}>
            <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              {PRIORITIES.map((p) => <SelectItem key={p} value={p} className="capitalize">{p}</SelectItem>)}
            </SelectContent>
          </Select>
        </label>
        <div className="relative ml-auto min-w-[220px] flex-1">
          <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input className="pl-9" placeholder="Start typing to search" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      </div>

      <div className="overflow-hidden rounded-lg border bg-card">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <h2 className="text-sm font-medium">Tickets</h2>
          <span className="text-xs text-muted-foreground">{tickets.length} record{tickets.length === 1 ? "" : "s"}</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-muted-foreground">
                <th className="px-4 py-2.5 font-medium">Ticket #</th>
                <th className="px-4 py-2.5 font-medium">Subject</th>
                {canManage && <th className="px-4 py-2.5 font-medium">Requester</th>}
                <th className="px-4 py-2.5 font-medium">Type</th>
                <th className="px-4 py-2.5 font-medium">Priority</th>
                {canManage && <th className="px-4 py-2.5 font-medium">Agent</th>}
                <th className="px-4 py-2.5 font-medium">Status</th>
                <th className="px-4 py-2.5 text-right font-medium">Action</th>
              </tr>
            </thead>
            <tbody>
              {tickets.length === 0 ? (
                <tr>
                  <td colSpan={canManage ? 8 : 6}>
                    <div className="flex flex-col items-center gap-3 py-16 text-center text-sm text-muted-foreground">
                      <TicketCheck className="size-9" />
                      <p>No record found.</p>
                    </div>
                  </td>
                </tr>
              ) : (
                tickets.map((t) => (
                  <tr key={t.id} className="border-b last:border-b-0 hover:bg-muted/40">
                    <td className="px-4 py-3 font-mono text-xs text-muted-foreground">#{t.id}</td>
                    <td className="px-4 py-3">
                      <button className="text-left font-medium hover:underline" onClick={() => setViewing(t)}>
                        {t.subject}
                      </button>
                    </td>
                    {canManage && <td className="px-4 py-3 text-muted-foreground">{t.requester_name || "—"}</td>}
                    <td className="px-4 py-3 text-muted-foreground">{typeLabel(t.type)}</td>
                    <td className="px-4 py-3">
                      <Badge variant="secondary" className={`font-normal capitalize ${PRIORITY_STYLES[t.priority] ?? ""}`}>{t.priority}</Badge>
                    </td>
                    {canManage && <td className="px-4 py-3 text-muted-foreground">{t.agent_name || "Unassigned"}</td>}
                    <td className="px-4 py-3">
                      <Badge variant="secondary" className={`font-normal capitalize ${STATUS_STYLES[t.status] ?? ""}`}>{t.status}</Badge>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-1.5">
                        <Button variant="outline" size="sm" onClick={() => setViewing(t)}><Eye className="size-3.5" /></Button>
                        {canManage && (
                          <Button variant="outline" size="sm" onClick={() => remove(t.id)}><Trash2 className="size-3.5" /></Button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      <TicketDetailDialog
        ticket={viewing}
        canManage={canManage}
        employees={employees}
        onClose={() => setViewing(null)}
        onChanged={mutate}
        onDelete={remove}
      />
    </main>
  )
}

function TicketDetailDialog({
  ticket, canManage, employees, onClose, onChanged, onDelete,
}: {
  ticket: TicketItem | null
  canManage: boolean
  employees: string[]
  onClose: () => void
  onChanged: () => void
  onDelete: (id: number) => void
}) {
  const { data, mutate } = useSWR<{ replies: Reply[] }>(
    ticket ? `/api/tickets/replies?ticketId=${ticket.id}` : null,
    fetcher,
  )
  const [message, setMessage] = useState("")
  const [sending, setSending] = useState(false)

  const replies = data?.replies ?? []

  const update = async (patch: Record<string, unknown>) => {
    await fetch("/api/tickets", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: ticket!.id, ...patch }),
    })
    onChanged()
  }

  const sendReply = async (ev: React.FormEvent) => {
    ev.preventDefault()
    if (!message.trim()) return
    setSending(true)
    const res = await fetch("/api/tickets/replies", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ticket_id: ticket!.id, message }),
    })
    setSending(false)
    if (res.ok) { setMessage(""); mutate() }
  }

  return (
    <Dialog open={!!ticket} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        {ticket && (
          <>
            <DialogHeader>
              <DialogTitle className="flex flex-wrap items-center gap-2 text-pretty">
                <span className="font-mono text-sm text-muted-foreground">#{ticket.id}</span>
                {ticket.subject}
              </DialogTitle>
              <DialogDescription className="flex flex-wrap items-center gap-2">
                <Badge variant="secondary" className={`font-normal capitalize ${STATUS_STYLES[ticket.status] ?? ""}`}>{ticket.status}</Badge>
                <Badge variant="secondary" className={`font-normal capitalize ${PRIORITY_STYLES[ticket.priority] ?? ""}`}>{ticket.priority}</Badge>
                <span className="text-xs">{typeLabel(ticket.type)}</span>
              </DialogDescription>
            </DialogHeader>

            <div className="grid gap-2 rounded-md border bg-muted/30 p-3 text-sm sm:grid-cols-2">
              <p className="flex items-center gap-2"><User className="size-4 text-muted-foreground" /> {ticket.requester_name || "—"}</p>
              <p className="text-muted-foreground">Agent: {ticket.agent_name || "Unassigned"}</p>
              <p className="text-muted-foreground">Raised by {ticket.created_by_name || "—"}</p>
              <p className="text-muted-foreground">{formatDateTime(ticket.created_at)}</p>
            </div>

            {ticket.description && (
              <p className="whitespace-pre-wrap rounded-md border p-3 text-sm leading-relaxed text-foreground/90">{ticket.description}</p>
            )}

            {canManage && (
              <div className="grid gap-3 rounded-md border p-4 sm:grid-cols-3">
                <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
                  Status
                  <Select value={ticket.status} onValueChange={(v) => update({ status: v })}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {STATUSES.map((s) => <SelectItem key={s} value={s} className="capitalize">{s}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </label>
                <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
                  Priority
                  <Select value={ticket.priority} onValueChange={(v) => update({ priority: v })}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {PRIORITIES.map((p) => <SelectItem key={p} value={p} className="capitalize">{p}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </label>
                <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
                  Agent
                  <Select value={ticket.agent_name || "none"} onValueChange={(v) => update({ agent_name: v === "none" ? null : v })}>
                    <SelectTrigger><SelectValue placeholder="Unassigned" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">Unassigned</SelectItem>
                      {employees.map((n) => <SelectItem key={n} value={n}>{n}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </label>
              </div>
            )}

            <div className="grid gap-3">
              <h3 className="flex items-center gap-2 text-sm font-medium"><MessageSquare className="size-4" /> Conversation</h3>
              {replies.length === 0 ? (
                <p className="text-sm text-muted-foreground">No replies yet.</p>
              ) : (
                <div className="grid gap-2.5">
                  {replies.map((r) => (
                    <div key={r.id} className={`rounded-md border p-3 text-sm ${r.is_staff ? "bg-primary/5" : "bg-card"}`}>
                      <div className="mb-1 flex items-center justify-between gap-2">
                        <span className="font-medium">{r.author_name || "User"}{r.is_staff ? " · Staff" : ""}</span>
                        <span className="text-xs text-muted-foreground">{formatDateTime(r.created_at)}</span>
                      </div>
                      <p className="whitespace-pre-wrap leading-relaxed text-foreground/90">{r.message}</p>
                    </div>
                  ))}
                </div>
              )}

              <form onSubmit={sendReply} className="grid gap-2">
                <Textarea rows={3} value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Write a reply…" />
                <div className="flex items-center justify-between gap-2">
                  {canManage ? (
                    <Button type="button" variant="destructive" size="sm" onClick={() => onDelete(ticket.id)}>
                      <Trash2 className="mr-2 size-3.5" /> Delete
                    </Button>
                  ) : <span />}
                  <Button type="submit" size="sm" disabled={sending || !message.trim()}>
                    <Send className="mr-2 size-3.5" /> {sending ? "Sending…" : "Send Reply"}
                  </Button>
                </div>
              </form>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
