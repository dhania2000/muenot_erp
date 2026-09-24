"use client"

import { useEffect, useState } from "react"
import useSWR from "swr"
import type { PortalTicket, PortalTicketMessage } from "@/lib/portal/store"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent } from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { cn } from "@/lib/utils"
import { ArrowLeft, LifeBuoy, Loader2, Plus, Send } from "lucide-react"

const STATUS_VARIANT: Record<PortalTicket["status"], "default" | "secondary" | "outline"> = {
  open: "default",
  pending: "secondary",
  resolved: "outline",
  closed: "outline",
}

function formatTime(value: string) {
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return ""
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
}

export function TicketsView({ initialTickets }: { initialTickets: PortalTicket[] }) {
  const [tickets, setTickets] = useState(initialTickets)
  const [openId, setOpenId] = useState<number | null>(null)

  if (openId != null) {
    return (
      <TicketThread
        ticketId={openId}
        onBack={() => setOpenId(null)}
        onStatusChange={(status) =>
          setTickets((prev) => prev.map((t) => (t.id === openId ? { ...t, status } : t)))
        }
      />
    )
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Support tickets</h1>
          <p className="text-sm text-muted-foreground">Raise and track requests with our team.</p>
        </div>
        <NewTicketDialog onCreated={(t) => setTickets((prev) => [t, ...prev])} />
      </div>

      {tickets.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-12 text-center">
            <LifeBuoy className="h-8 w-8 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">No tickets yet.</p>
          </CardContent>
        </Card>
      ) : (
        <div className="flex flex-col gap-3">
          {tickets.map((t) => (
            <button key={t.id} type="button" onClick={() => setOpenId(t.id)} className="text-left">
              <Card className="transition-colors hover:border-primary/50">
                <CardContent className="flex items-center justify-between gap-4 py-4">
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-xs text-muted-foreground">{t.ticket_number}</span>
                      <span className="font-medium">{t.subject}</span>
                    </div>
                    <p className="text-xs text-muted-foreground">Updated {formatTime(t.updated_at)}</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Badge variant="outline" className="capitalize">
                      {t.priority}
                    </Badge>
                    <Badge variant={STATUS_VARIANT[t.status]} className="capitalize">
                      {t.status}
                    </Badge>
                  </div>
                </CardContent>
              </Card>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function NewTicketDialog({ onCreated }: { onCreated: (t: PortalTicket) => void }) {
  const [open, setOpen] = useState(false)
  const [subject, setSubject] = useState("")
  const [priority, setPriority] = useState("normal")
  const [body, setBody] = useState("")
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    setError(null)
    try {
      const res = await fetch("/api/portal/tickets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subject, priority, body }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error ?? "Could not create ticket")
        return
      }
      onCreated(data.ticket)
      setOpen(false)
      setSubject("")
      setBody("")
      setPriority("normal")
    } catch {
      setError("Could not create ticket")
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button className="gap-2">
          <Plus className="h-4 w-4" />
          New ticket
        </Button>
      </DialogTrigger>
      <DialogContent>
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>New support ticket</DialogTitle>
            <DialogDescription>Describe your request and we&apos;ll get back to you.</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4 py-4">
            {error && <p className="text-sm text-destructive">{error}</p>}
            <div className="flex flex-col gap-2">
              <Label htmlFor="subject">Subject</Label>
              <Input id="subject" required value={subject} onChange={(e) => setSubject(e.target.value)} />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="priority">Priority</Label>
              <Select value={priority} onValueChange={setPriority}>
                <SelectTrigger id="priority">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="low">Low</SelectItem>
                  <SelectItem value="normal">Normal</SelectItem>
                  <SelectItem value="high">High</SelectItem>
                  <SelectItem value="urgent">Urgent</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="body">Details</Label>
              <Textarea id="body" required rows={4} value={body} onChange={(e) => setBody(e.target.value)} />
            </div>
          </div>
          <DialogFooter>
            <Button type="submit" disabled={saving || !subject.trim() || !body.trim()}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : "Create ticket"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function TicketThread({
  ticketId,
  onBack,
  onStatusChange,
}: {
  ticketId: number
  onBack: () => void
  onStatusChange: (status: PortalTicket["status"]) => void
}) {
  const { data, isLoading } = useSWR<{ ticket: PortalTicket; messages: PortalTicketMessage[] }>(
    `/api/portal/tickets/${ticketId}`,
    (url: string) => fetch(url).then((r) => r.json()),
  )
  const [ticket, setTicket] = useState<PortalTicket | null>(null)
  const [messages, setMessages] = useState<PortalTicketMessage[]>([])
  const [reply, setReply] = useState("")
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const loading = isLoading

  useEffect(() => {
    if (data?.ticket) {
      setTicket(data.ticket)
      setMessages(data.messages ?? [])
    }
  }, [data])

  async function sendReply() {
    const text = reply.trim()
    if (!text || sending) return
    setSending(true)
    setError(null)
    try {
      const res = await fetch(`/api/portal/tickets/${ticketId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: text }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error ?? "Could not send reply")
        return
      }
      setMessages((prev) => [...prev, data.message])
      setReply("")
      if (ticket && (ticket.status === "resolved" || ticket.status === "closed")) {
        setTicket({ ...ticket, status: "open" })
        onStatusChange("open")
      }
    } catch {
      setError("Could not send reply")
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <Button variant="ghost" size="sm" className="w-fit gap-2 px-2" onClick={onBack}>
        <ArrowLeft className="h-4 w-4" />
        Back to tickets
      </Button>

      {loading ? (
        <div className="flex items-center gap-2 py-10 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </div>
      ) : ticket ? (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-xs text-muted-foreground">{ticket.ticket_number}</span>
            <h1 className="text-xl font-semibold">{ticket.subject}</h1>
            <Badge variant={STATUS_VARIANT[ticket.status]} className="capitalize">
              {ticket.status}
            </Badge>
          </div>

          <div className="flex flex-col gap-3 rounded-lg border border-border bg-background p-4">
            {messages.map((m) => {
              const mine = m.author_type === "client"
              return (
                <div key={m.id} className={cn("flex flex-col", mine ? "items-end" : "items-start")}>
                  <div
                    className={cn(
                      "max-w-[80%] rounded-lg px-3 py-2 text-sm",
                      mine ? "bg-primary text-primary-foreground" : "bg-muted text-foreground",
                    )}
                  >
                    <p className="whitespace-pre-wrap break-words">{m.body}</p>
                  </div>
                  <span className="mt-1 px-1 text-xs text-muted-foreground">
                    {mine ? "You" : m.author_name} · {formatTime(m.created_at)}
                  </span>
                </div>
              )
            })}
          </div>

          {ticket.status !== "closed" && (
            <div className="flex flex-col gap-2">
              {error && <p className="text-sm text-destructive">{error}</p>}
              <div className="flex items-end gap-2">
                <Textarea
                  value={reply}
                  onChange={(e) => setReply(e.target.value)}
                  placeholder="Write a reply…"
                  rows={2}
                  className="resize-none"
                  aria-label="Reply"
                />
                <Button onClick={sendReply} disabled={sending || !reply.trim()} size="icon" aria-label="Send reply">
                  {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                </Button>
              </div>
            </div>
          )}
        </>
      ) : (
        <p className="py-10 text-sm text-destructive">{error ?? "Ticket not found"}</p>
      )}
    </div>
  )
}
