"use client"

import * as React from "react"
import useSWR from "swr"
import { toast } from "sonner"
import {
  Search,
  Send,
  Loader2,
  Check,
  CheckCheck,
  Clock,
  AlertCircle,
  MessageSquareOff,
  Link2,
  UserPlus,
  X,
  Inbox as InboxIcon,
  FileText,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Separator } from "@/components/ui/separator"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { fetcher } from "@/lib/fetcher"
import { cn } from "@/lib/utils"

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

type Conversation = {
  id: number
  contactId: number
  phoneNumber: string
  profileName: string | null
  leadId: number | null
  leadCode: string | null
  leadName: string | null
  status: "open" | "closed"
  lastMessageAt: string | null
  lastCustomerMessageAt: string | null
  unreadCount: number
  lastMessagePreview: string | null
}

type ConversationDetail = Conversation & { withinServiceWindow: boolean }

type WaMessage = {
  id: number
  wamid: string | null
  direction: "inbound" | "outbound"
  messageType: string
  body: string | null
  mediaId: string | null
  mediaMimeType: string | null
  mediaFilename: string | null
  status: "received" | "queued" | "sent" | "delivered" | "read" | "failed"
  errorCode: string | null
  errorMessage: string | null
  metaTimestamp: string | null
  sentAt: string | null
  deliveredAt: string | null
  readAt: string | null
  createdAt: string
}

type Template = { name: string; language: string; status: string; category: string | null }

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function initials(name: string | null, phone: string): string {
  if (name) {
    const parts = name.trim().split(/\s+/).slice(0, 2)
    return parts.map((p) => p[0]?.toUpperCase() ?? "").join("") || phone.slice(-2)
  }
  return phone.slice(-2)
}

function displayName(c: { profileName: string | null; phoneNumber: string }): string {
  return c.profileName?.trim() || `+${c.phoneNumber}`
}

function toDate(value: string | null): Date | null {
  if (!value) return null
  const d = new Date(value.includes("T") ? value : value.replace(" ", "T") + "Z")
  return Number.isNaN(d.getTime()) ? null : d
}

function relativeTime(value: string | null): string {
  const d = toDate(value)
  if (!d) return ""
  const diff = Date.now() - d.getTime()
  const min = Math.floor(diff / 60000)
  if (min < 1) return "now"
  if (min < 60) return `${min}m`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h`
  const day = Math.floor(hr / 24)
  if (day < 7) return `${day}d`
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" })
}

function clockTime(value: string | null): string {
  const d = toDate(value)
  if (!d) return ""
  return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
}

function windowRemaining(lastCustomerMessageAt: string | null): string | null {
  const d = toDate(lastCustomerMessageAt)
  if (!d) return null
  const remaining = 24 * 60 * 60 * 1000 - (Date.now() - d.getTime())
  if (remaining <= 0) return null
  const hrs = Math.floor(remaining / 3600000)
  const mins = Math.floor((remaining % 3600000) / 60000)
  return hrs > 0 ? `${hrs}h ${mins}m left` : `${mins}m left`
}

/* ------------------------------------------------------------------ */
/* Inbox root                                                          */
/* ------------------------------------------------------------------ */

export function WhatsAppInbox() {
  const [search, setSearch] = React.useState("")
  const [debounced, setDebounced] = React.useState("")
  const [filter, setFilter] = React.useState<"all" | "unread">("all")
  const [selectedId, setSelectedId] = React.useState<number | null>(null)

  React.useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 300)
    return () => clearTimeout(t)
  }, [search])

  const key = `/api/marketing/whatsapp/conversations?filter=${filter}${
    debounced ? `&search=${encodeURIComponent(debounced)}` : ""
  }`
  const { data, isLoading, mutate } = useSWR<{ conversations: Conversation[] }>(key, fetcher, {
    refreshInterval: 10000,
  })

  const conversations = data?.conversations ?? []

  return (
    <div className="grid h-[calc(100vh-16rem)] min-h-[28rem] grid-cols-1 overflow-hidden rounded-xl border bg-card md:grid-cols-[20rem_1fr]">
      {/* Conversation list */}
      <div
        className={cn(
          "flex min-h-0 flex-col border-r",
          selectedId !== null && "hidden md:flex",
        )}
      >
        <div className="flex flex-col gap-3 border-b p-3">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search name, number or lead"
              className="pl-8"
              aria-label="Search conversations"
            />
          </div>
          <Tabs value={filter} onValueChange={(v) => setFilter(v as "all" | "unread")}>
            <TabsList className="w-full">
              <TabsTrigger value="all" className="flex-1">
                All
              </TabsTrigger>
              <TabsTrigger value="unread" className="flex-1">
                Unread
              </TabsTrigger>
            </TabsList>
          </Tabs>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {isLoading ? (
            <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Loading conversations…
            </div>
          ) : conversations.length === 0 ? (
            <EmptyList filter={filter} />
          ) : (
            <ul className="divide-y">
              {conversations.map((c) => (
                <ConversationRow
                  key={c.id}
                  conversation={c}
                  active={c.id === selectedId}
                  onSelect={() => setSelectedId(c.id)}
                />
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* Thread */}
      <div className={cn("min-h-0", selectedId === null && "hidden md:block")}>
        {selectedId === null ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
            <div className="flex size-14 items-center justify-center rounded-2xl bg-muted">
              <InboxIcon className="size-7 text-muted-foreground" />
            </div>
            <div className="space-y-1">
              <p className="text-sm font-medium">Select a conversation</p>
              <p className="text-xs text-muted-foreground text-pretty">
                Inbound WhatsApp messages appear here in real time once your webhook is connected.
              </p>
            </div>
          </div>
        ) : (
          <ConversationThread
            conversationId={selectedId}
            onBack={() => setSelectedId(null)}
            onChanged={() => mutate()}
          />
        )}
      </div>
    </div>
  )
}

function EmptyList({ filter }: { filter: "all" | "unread" }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-16 text-center">
      <MessageSquareOff className="size-8 text-muted-foreground" />
      <p className="text-sm font-medium">
        {filter === "unread" ? "No unread conversations" : "No conversations yet"}
      </p>
      <p className="text-xs text-muted-foreground text-pretty">
        {filter === "unread"
          ? "You're all caught up."
          : "When a customer messages your business number, the conversation shows up here."}
      </p>
    </div>
  )
}

function ConversationRow({
  conversation,
  active,
  onSelect,
}: {
  conversation: Conversation
  active: boolean
  onSelect: () => void
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        className={cn(
          "flex w-full items-start gap-3 px-3 py-3 text-left transition-colors hover:bg-accent/60",
          active && "bg-accent",
        )}
      >
        <Avatar className="size-10 shrink-0">
          <AvatarFallback className="bg-[#25D366]/15 text-xs font-medium text-[#128C4A]">
            {initials(conversation.profileName, conversation.phoneNumber)}
          </AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <span className="truncate text-sm font-medium">{displayName(conversation)}</span>
            <span className="shrink-0 text-[11px] text-muted-foreground">
              {relativeTime(conversation.lastMessageAt)}
            </span>
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="truncate text-xs text-muted-foreground">
              {conversation.lastMessagePreview || "No messages yet"}
            </span>
            {conversation.unreadCount > 0 ? (
              <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-[#25D366] text-[11px] font-semibold text-white">
                {conversation.unreadCount > 9 ? "9+" : conversation.unreadCount}
              </span>
            ) : null}
          </div>
          {conversation.leadCode ? (
            <Badge variant="outline" className="mt-1 h-5 gap-1 px-1.5 text-[10px]">
              <Link2 className="size-2.5" />
              {conversation.leadCode}
            </Badge>
          ) : null}
        </div>
      </button>
    </li>
  )
}

/* ------------------------------------------------------------------ */
/* Thread                                                              */
/* ------------------------------------------------------------------ */

function ConversationThread({
  conversationId,
  onBack,
  onChanged,
}: {
  conversationId: number
  onBack: () => void
  onChanged: () => void
}) {
  const key = `/api/marketing/whatsapp/conversations/${conversationId}/messages`
  const { data, isLoading, mutate } = useSWR<{
    conversation: ConversationDetail
    messages: WaMessage[]
  }>(key, fetcher, { refreshInterval: 8000 })

  const conversation = data?.conversation
  const messages = data?.messages ?? []
  const bottomRef = React.useRef<HTMLDivElement>(null)

  // Mark read whenever the thread opens or new inbound arrives.
  const unread = conversation?.unreadCount ?? 0
  React.useEffect(() => {
    if (unread > 0) {
      fetch("/api/marketing/whatsapp/messages/read", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId }),
      })
        .then(() => onChanged())
        .catch(() => undefined)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId, unread])

  React.useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "auto" })
  }, [messages.length])

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header */}
      <div className="flex items-center gap-3 border-b p-3">
        <Button variant="ghost" size="icon" className="md:hidden" onClick={onBack} aria-label="Back">
          <X className="size-4" />
        </Button>
        <Avatar className="size-9">
          <AvatarFallback className="bg-[#25D366]/15 text-xs font-medium text-[#128C4A]">
            {conversation ? initials(conversation.profileName, conversation.phoneNumber) : "…"}
          </AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">
            {conversation ? displayName(conversation) : "Loading…"}
          </p>
          <p className="truncate text-xs text-muted-foreground">
            {conversation ? `+${conversation.phoneNumber}` : ""}
          </p>
        </div>
        {conversation ? (
          <LinkLeadControl conversation={conversation} onChanged={() => mutate()} />
        ) : null}
      </div>

      {/* Messages */}
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto bg-muted/30 p-4">
        {isLoading ? (
          <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Loading messages…
          </div>
        ) : messages.length === 0 ? (
          <div className="flex items-center justify-center py-16 text-sm text-muted-foreground">
            No messages in this conversation yet.
          </div>
        ) : (
          messages.map((m) => <MessageBubble key={m.id} message={m} />)
        )}
        <div ref={bottomRef} />
      </div>

      {/* Composer */}
      {conversation ? (
        <Composer
          conversation={conversation}
          onSent={() => {
            mutate()
            onChanged()
          }}
        />
      ) : null}
    </div>
  )
}

function MessageBubble({ message }: { message: WaMessage }) {
  const outbound = message.direction === "outbound"
  const failed = message.status === "failed"
  const unsupported = !message.body && !message.mediaId
  const time = clockTime(message.metaTimestamp || message.sentAt || message.createdAt)

  return (
    <div className={cn("flex", outbound ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "max-w-[80%] rounded-2xl px-3 py-2 text-sm shadow-sm",
          outbound
            ? "rounded-br-sm bg-[#DCF8C6] text-[#111B21] dark:bg-[#005C4B] dark:text-white"
            : "rounded-bl-sm bg-card text-card-foreground",
          failed && "border border-destructive/40",
        )}
      >
        {message.mediaId ? (
          <div className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
            <FileText className="size-3.5" />
            {message.mediaFilename || `${message.messageType} attachment`}
          </div>
        ) : null}
        {message.body ? (
          <p className="whitespace-pre-wrap break-words">{message.body}</p>
        ) : unsupported ? (
          <p className="italic text-muted-foreground">
            {`Unsupported message type (${message.messageType})`}
          </p>
        ) : null}
        <div
          className={cn(
            "mt-1 flex items-center justify-end gap-1 text-[10px]",
            outbound ? "text-[#111B21]/60 dark:text-white/70" : "text-muted-foreground",
          )}
        >
          <span>{time}</span>
          {outbound ? <StatusTick status={message.status} /> : null}
        </div>
        {failed && message.errorMessage ? (
          <p className="mt-1 text-[10px] text-destructive">{message.errorMessage}</p>
        ) : null}
      </div>
    </div>
  )
}

function StatusTick({ status }: { status: WaMessage["status"] }) {
  if (status === "failed") return <AlertCircle className="size-3 text-destructive" />
  if (status === "read") return <CheckCheck className="size-3 text-[#53BDEB]" />
  if (status === "delivered") return <CheckCheck className="size-3" />
  if (status === "sent") return <Check className="size-3" />
  return <Clock className="size-3" />
}

/* ------------------------------------------------------------------ */
/* Composer (24h window aware)                                         */
/* ------------------------------------------------------------------ */

function Composer({
  conversation,
  onSent,
}: {
  conversation: ConversationDetail
  onSent: () => void
}) {
  const [text, setText] = React.useState("")
  const [sending, setSending] = React.useState(false)
  const withinWindow = conversation.withinServiceWindow
  const remaining = windowRemaining(conversation.lastCustomerMessageAt)

  async function sendText() {
    const message = text.trim()
    if (!message) return
    setSending(true)
    try {
      const res = await fetch("/api/marketing/whatsapp/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId: conversation.id, mode: "text", message }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(json.error || "Failed to send message")
      setText("")
      onSent()
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setSending(false)
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      if (e.nativeEvent.isComposing || e.keyCode === 229) return
      e.preventDefault()
      void sendText()
    }
  }

  if (!withinWindow) {
    return (
      <div className="flex flex-col gap-2 border-t p-3">
        <div className="flex items-start gap-2 rounded-lg bg-muted p-3 text-xs text-muted-foreground">
          <Clock className="mt-0.5 size-4 shrink-0" />
          <p className="text-pretty">
            The 24-hour reply window has closed. WhatsApp only allows an approved template message to
            re-open the conversation.
          </p>
        </div>
        <div className="flex justify-end">
          <SendTemplateDialog conversationId={conversation.id} onSent={onSent} />
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-1.5 border-t p-3">
      <div className="flex items-end gap-2">
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          rows={1}
          placeholder="Type a message"
          className="max-h-32 min-h-10 resize-none"
          aria-label="Message"
        />
        <Button onClick={sendText} disabled={sending || !text.trim()} size="icon" className="size-10 shrink-0">
          {sending ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
        </Button>
      </div>
      <div className="flex items-center justify-between">
        <span className="text-[11px] text-muted-foreground">
          {remaining ? `Reply window: ${remaining}` : "Within reply window"}
        </span>
        <SendTemplateDialog conversationId={conversation.id} onSent={onSent} triggerVariant="link" />
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Template sender                                                     */
/* ------------------------------------------------------------------ */

function SendTemplateDialog({
  conversationId,
  onSent,
  triggerVariant = "outline",
}: {
  conversationId: number
  onSent: () => void
  triggerVariant?: "outline" | "link"
}) {
  const [open, setOpen] = React.useState(false)
  const [sending, setSending] = React.useState(false)
  const [selected, setSelected] = React.useState<Template | null>(null)
  const { data, isLoading } = useSWR<{ templates: Template[] }>(
    open ? "/api/marketing/whatsapp/templates" : null,
    fetcher,
  )
  const templates = (data?.templates ?? []).filter((t) => t.status.toUpperCase() === "APPROVED")

  async function send() {
    if (!selected) {
      toast.error("Choose a template to send.")
      return
    }
    setSending(true)
    try {
      const res = await fetch("/api/marketing/whatsapp/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conversationId,
          mode: "template",
          templateName: selected.name,
          languageCode: selected.language,
        }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(json.error || "Failed to send template")
      toast.success("Template message sent")
      setSelected(null)
      setOpen(false)
      onSent()
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setSending(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          triggerVariant === "link" ? (
            <button type="button" className="text-[11px] font-medium text-[#128C4A] hover:underline">
              Send template
            </button>
          ) : (
            <Button variant="outline" size="sm">
              <FileText className="size-4" />
              Send template
            </Button>
          )
        }
      />
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Send a template message</DialogTitle>
          <DialogDescription>
            Approved templates can be sent at any time, including outside the 24-hour window.
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[50vh] overflow-y-auto py-1">
          {isLoading ? (
            <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Loading templates…
            </div>
          ) : templates.length === 0 ? (
            <p className="px-1 py-6 text-center text-sm text-muted-foreground text-pretty">
              No approved templates found on this account. Create and get templates approved in the Meta
              WhatsApp Manager.
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {templates.map((t) => (
                <li key={`${t.name}:${t.language}`}>
                  <button
                    type="button"
                    onClick={() => setSelected(t)}
                    className={cn(
                      "flex w-full items-center justify-between gap-3 rounded-lg border p-3 text-left transition-colors hover:bg-accent/60",
                      selected?.name === t.name && selected?.language === t.language && "border-[#25D366] bg-[#25D366]/5",
                    )}
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{t.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {t.language}
                        {t.category ? ` · ${t.category}` : ""}
                      </p>
                    </div>
                    {selected?.name === t.name && selected?.language === t.language ? (
                      <Check className="size-4 shrink-0 text-[#128C4A]" />
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <DialogFooter>
          <DialogClose render={<Button variant="outline">Cancel</Button>} />
          <Button onClick={send} disabled={sending || !selected}>
            {sending ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
            Send
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/* ------------------------------------------------------------------ */
/* CRM lead linking                                                    */
/* ------------------------------------------------------------------ */

type LeadCandidate = {
  id: number
  lead_code: string
  contact_person: string | null
  company_name: string | null
  contact_number: string | null
  status: string
}

function LinkLeadControl({
  conversation,
  onChanged,
}: {
  conversation: ConversationDetail
  onChanged: () => void
}) {
  const [open, setOpen] = React.useState(false)
  const [q, setQ] = React.useState("")
  const [busy, setBusy] = React.useState(false)
  const { data, isLoading } = useSWR<{ candidates: LeadCandidate[] }>(
    open ? `/api/marketing/whatsapp/conversations/${conversation.id}/link-lead?q=${encodeURIComponent(q)}` : null,
    fetcher,
  )
  const candidates = data?.candidates ?? []

  async function post(body: unknown) {
    setBusy(true)
    try {
      const res = await fetch(`/api/marketing/whatsapp/conversations/${conversation.id}/link-lead`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(json.error || "Failed to update lead link")
      return json
    } finally {
      setBusy(false)
    }
  }

  async function link(leadId: number) {
    try {
      await post({ leadId })
      toast.success("Conversation linked to lead")
      setOpen(false)
      onChanged()
    } catch (err) {
      toast.error((err as Error).message)
    }
  }

  async function unlink() {
    try {
      await post({ leadId: null })
      toast.success("Lead unlinked")
      onChanged()
    } catch (err) {
      toast.error((err as Error).message)
    }
  }

  async function createLead() {
    try {
      await post({
        create: {
          contactPerson: conversation.profileName || `WhatsApp ${conversation.phoneNumber}`,
          companyName: conversation.profileName || `WhatsApp ${conversation.phoneNumber}`,
        },
      })
      toast.success("Lead created and linked")
      setOpen(false)
      onChanged()
    } catch (err) {
      toast.error((err as Error).message)
    }
  }

  if (conversation.leadId) {
    return (
      <div className="flex items-center gap-1.5">
        <Badge variant="outline" className="gap-1">
          <Link2 className="size-3" />
          {conversation.leadCode || `Lead #${conversation.leadId}`}
        </Badge>
        <Button variant="ghost" size="icon" className="size-7" onClick={unlink} disabled={busy} aria-label="Unlink lead">
          {busy ? <Loader2 className="size-3.5 animate-spin" /> : <X className="size-3.5" />}
        </Button>
      </div>
    )
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button variant="outline" size="sm">
            <UserPlus className="size-4" />
            Link lead
          </Button>
        }
      />
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Link to a CRM lead</DialogTitle>
          <DialogDescription>
            Connect this WhatsApp contact to an existing sales lead, or create a new one.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3 py-1">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search by name, company or code"
              className="pl-8"
              aria-label="Search leads"
            />
          </div>
          <div className="max-h-[40vh] overflow-y-auto">
            {isLoading ? (
              <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" /> Searching…
              </div>
            ) : candidates.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">No matching leads.</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {candidates.map((lead) => (
                  <li key={lead.id}>
                    <button
                      type="button"
                      onClick={() => link(lead.id)}
                      disabled={busy}
                      className="flex w-full items-center justify-between gap-3 rounded-lg border p-3 text-left transition-colors hover:bg-accent/60 disabled:opacity-60"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">
                          {lead.contact_person || lead.company_name || lead.lead_code}
                        </p>
                        <p className="truncate text-xs text-muted-foreground">
                          {lead.lead_code}
                          {lead.company_name ? ` · ${lead.company_name}` : ""}
                        </p>
                      </div>
                      <Badge variant="secondary" className="shrink-0 text-[10px]">
                        {lead.status}
                      </Badge>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <Separator />
          <Button variant="outline" onClick={createLead} disabled={busy} className="w-full">
            {busy ? <Loader2 className="size-4 animate-spin" /> : <UserPlus className="size-4" />}
            Create a new lead from this contact
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
