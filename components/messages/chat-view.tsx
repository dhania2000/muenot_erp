"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  AlertCircle,
  ArrowLeft,
  Building2,
  Check,
  CheckCheck,
  FileText,
  Megaphone,
  MoreVertical,
  Paperclip,
  Pencil,
  Pin,
  Reply,
  Send,
  Trash2,
  Users,
  VolumeX,
  X,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { toast } from "sonner"
import {
  api,
  formatBytes,
  formatTime,
  initials,
  type ConversationDetail,
  type Message,
} from "./types"

export function ChatView({
  conversationId,
  onBack,
  onChanged,
  onManage,
}: {
  conversationId: number
  onBack: () => void
  onChanged: () => void
  onManage: (detail: ConversationDetail) => void
}) {
  const [detail, setDetail] = useState<ConversationDetail | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(true)
  const [body, setBody] = useState("")
  const [importance, setImportance] = useState<"normal" | "important" | "urgent">("normal")
  const [announce, setAnnounce] = useState(false)
  const [replyTo, setReplyTo] = useState<Message | null>(null)
  const [editing, setEditing] = useState<Message | null>(null)
  const [pendingFiles, setPendingFiles] = useState<{ id: number; file_name: string; file_size: number }[]>([])
  const [sending, setSending] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)

  const load = useCallback(async () => {
    const data = await api<ConversationDetail>(`/api/messages/${conversationId}`)
    setDetail(data)
    setMessages(data.messages)
    setHasMore(data.hasMore)
    setLoading(false)
    onChanged()
  }, [conversationId, onChanged])

  useEffect(() => {
    setLoading(true)
    setReplyTo(null)
    setEditing(null)
    setPendingFiles([])
    load()
    const t = setInterval(load, 8000)
    return () => clearInterval(t)
  }, [conversationId, load])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "auto" })
  }, [messages.length, conversationId])

  async function loadOlder() {
    if (!messages.length) return
    const oldest = messages[0].id
    const data = await api<ConversationDetail>(`/api/messages/${conversationId}?before=${oldest}`)
    setMessages((prev) => [...data.messages, ...prev])
    setHasMore(data.hasMore)
  }

  async function uploadFiles(files: FileList) {
    for (const file of Array.from(files)) {
      const form = new FormData()
      form.append("conversationId", String(conversationId))
      form.append("file", file)
      try {
        const res = await api<{ id: number; file_name: string; file_size: number }>("/api/messages/attachments", {
          method: "POST",
          body: form,
        })
        setPendingFiles((prev) => [...prev, res])
      } catch (e: any) {
        toast.error(e.message)
      }
    }
  }

  async function send() {
    const text = body.trim()
    if (!text && !pendingFiles.length) return
    setSending(true)
    try {
      if (editing) {
        await api(`/api/messages/item/${editing.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ body: text }),
        })
        setEditing(null)
      } else {
        await api(`/api/messages/${conversationId}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            body: text,
            importance,
            reply_to_id: replyTo?.id || null,
            attachmentIds: pendingFiles.map((f) => f.id),
            message_type: announce ? "announcement" : "text",
          }),
        })
      }
      setBody("")
      setImportance("normal")
      setAnnounce(false)
      setReplyTo(null)
      setPendingFiles([])
      await load()
    } catch (e: any) {
      toast.error(e.message)
    } finally {
      setSending(false)
    }
  }

  async function deleteMessage(m: Message) {
    try {
      await api(`/api/messages/item/${m.id}`, { method: "DELETE" })
      await load()
    } catch (e: any) {
      toast.error(e.message)
    }
  }

  async function reportMessage(m: Message) {
    try {
      await api(`/api/messages/item/${m.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "Inappropriate content" }),
      })
      toast.success("Reported to management for review")
    } catch (e: any) {
      toast.error(e.message)
    }
  }

  async function conversationAction(action: string, value?: any) {
    try {
      await api(`/api/messages/${conversationId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, value }),
      })
      if (action === "leave") onBack()
      await load()
    } catch (e: any) {
      toast.error(e.message)
    }
  }

  if (loading || !detail)
    return <div className="flex h-full items-center justify-center text-sm text-muted-foreground">Loading conversation…</div>

  const conv = detail.conversation
  const isGroupLike = conv.type !== "direct"
  const canManage = detail.myRole === "admin"
  const canAnnounce = detail.myRole === "admin"
  const otherReadMap = new Map(detail.participants.map((p) => [p.user_id, p.last_read_at]))

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <header className="flex items-center gap-3 border-b px-4 py-3">
        <Button variant="ghost" size="icon" className="lg:hidden" onClick={onBack} aria-label="Back to conversations">
          <ArrowLeft className="size-5" />
        </Button>
        <Avatar className="size-9">
          <AvatarFallback className={cn(isGroupLike && "bg-primary/15 text-primary")}>
            {conv.type === "department" ? (
              <Building2 className="size-4" />
            ) : conv.type === "management" ? (
              <Megaphone className="size-4" />
            ) : conv.type === "group" ? (
              <Users className="size-4" />
            ) : (
              initials(conv.title)
            )}
          </AvatarFallback>
        </Avatar>
        <button
          type="button"
          className="min-w-0 flex-1 text-left"
          onClick={() => isGroupLike && onManage(detail)}
        >
          <div className="flex items-center gap-2">
            <h2 className="truncate text-sm font-semibold">{conv.title}</h2>
            {detail.isMuted && <VolumeX className="size-3.5 text-muted-foreground" />}
            {detail.isPinned && <Pin className="size-3.5 text-muted-foreground" />}
          </div>
          <p className="truncate text-xs text-muted-foreground">
            {isGroupLike ? `${detail.participants.filter((p) => p.active).length} members` : detail.participants.find((p) => !p.active === false)?.designation || ""}
          </p>
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" aria-label="Conversation options">
              <MoreVertical className="size-5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => conversationAction("pin", !detail.isPinned)}>
              {detail.isPinned ? "Unpin" : "Pin"} conversation
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => conversationAction("mute", !detail.isMuted)}>
              {detail.isMuted ? "Unmute" : "Mute"} notifications
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => conversationAction("markUnread")}>Mark as unread</DropdownMenuItem>
            <DropdownMenuItem onClick={() => conversationAction("archive", true)}>Archive</DropdownMenuItem>
            {isGroupLike && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => onManage(detail)}>
                  {canManage ? "Manage group" : "View members"}
                </DropdownMenuItem>
                <DropdownMenuItem className="text-destructive" onClick={() => conversationAction("leave")}>
                  Leave conversation
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </header>

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 space-y-1 overflow-y-auto bg-muted/30 px-4 py-4">
        {hasMore && (
          <div className="flex justify-center pb-2">
            <Button variant="outline" size="sm" onClick={loadOlder}>Load earlier messages</Button>
          </div>
        )}
        {messages.map((m, i) => {
          const prev = messages[i - 1]
          const grouped = prev && prev.sender_id === m.sender_id && !m.reply && m.message_type === "text"
          if (m.message_type === "system")
            return (
              <div key={m.id} className="py-2 text-center text-xs text-muted-foreground">{m.body}</div>
            )
          return (
            <MessageBubble
              key={m.id}
              message={m}
              grouped={!!grouped}
              showSender={isGroupLike}
              onReply={() => setReplyTo(m)}
              onEdit={() => { setEditing(m); setBody(m.body || "") }}
              onDelete={() => deleteMessage(m)}
              onReport={() => reportMessage(m)}
              canModerate={canManage}
            />
          )
        })}
        <div ref={bottomRef} />
      </div>

      {/* Composer */}
      <div className="border-t bg-background px-3 py-2">
        {replyTo && (
          <div className="mb-2 flex items-center gap-2 rounded-md border-l-2 border-primary bg-muted px-3 py-1.5 text-xs">
            <Reply className="size-3.5" />
            <span className="min-w-0 flex-1 truncate">
              Replying to <b>{replyTo.sender_name}</b>: {replyTo.body}
            </span>
            <button onClick={() => setReplyTo(null)} aria-label="Cancel reply"><X className="size-3.5" /></button>
          </div>
        )}
        {editing && (
          <div className="mb-2 flex items-center gap-2 rounded-md border-l-2 border-amber-500 bg-muted px-3 py-1.5 text-xs">
            <Pencil className="size-3.5" />
            <span className="min-w-0 flex-1 truncate">Editing message</span>
            <button onClick={() => { setEditing(null); setBody("") }} aria-label="Cancel edit"><X className="size-3.5" /></button>
          </div>
        )}
        {pendingFiles.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-2">
            {pendingFiles.map((f) => (
              <Badge key={f.id} variant="secondary" className="gap-1">
                <FileText className="size-3" />
                {f.file_name}
                <button
                  onClick={() => setPendingFiles((prev) => prev.filter((x) => x.id !== f.id))}
                  aria-label={`Remove ${f.file_name}`}
                >
                  <X className="size-3" />
                </button>
              </Badge>
            ))}
          </div>
        )}
        <div className="flex items-end gap-2">
          <input
            ref={fileRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => e.target.files && uploadFiles(e.target.files)}
          />
          {!editing && (
            <Button variant="ghost" size="icon" onClick={() => fileRef.current?.click()} aria-label="Attach file">
              <Paperclip className="size-5" />
            </Button>
          )}
          <Textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder={announce ? "Write an announcement…" : "Write a message…"}
            rows={1}
            className="max-h-32 min-h-10 flex-1 resize-none"
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229) {
                e.preventDefault()
                send()
              }
            }}
          />
          <Button size="icon" onClick={send} disabled={sending} aria-label="Send message">
            <Send className="size-4" />
          </Button>
        </div>
        {!editing && (
          <div className="mt-1.5 flex items-center gap-3 px-1">
            <select
              value={importance}
              onChange={(e) => setImportance(e.target.value as any)}
              className="rounded border bg-background px-1.5 py-0.5 text-xs text-muted-foreground"
              aria-label="Message importance"
            >
              <option value="normal">Normal</option>
              <option value="important">Important</option>
              <option value="urgent">Urgent</option>
            </select>
            {canAnnounce && (
              <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <input type="checkbox" checked={announce} onChange={(e) => setAnnounce(e.target.checked)} />
                <Megaphone className="size-3.5" /> Announcement
              </label>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function MessageBubble({
  message: m,
  grouped,
  showSender,
  onReply,
  onEdit,
  onDelete,
  onReport,
  canModerate,
}: {
  message: Message
  grouped: boolean
  showSender: boolean
  onReply: () => void
  onEdit: () => void
  onDelete: () => void
  onReport: () => void
  canModerate: boolean
}) {
  const isAnnouncement = m.message_type === "announcement"
  if (isAnnouncement)
    return (
      <div className="my-2 rounded-lg border border-amber-300 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-950/40">
        <div className="mb-1 flex items-center gap-2 text-xs font-semibold text-amber-700 dark:text-amber-400">
          <Megaphone className="size-3.5" /> Announcement · {m.sender_name}
        </div>
        <p className="whitespace-pre-wrap text-sm">{m.deleted ? <em className="text-muted-foreground">Message deleted</em> : m.body}</p>
        <span className="mt-1 block text-[10px] text-muted-foreground">{formatTime(m.created_at)}</span>
      </div>
    )

  return (
    <div className={cn("group flex", m.mine ? "justify-end" : "justify-start", grouped ? "mt-0.5" : "mt-3")}>
      <div className={cn("flex max-w-[85%] items-end gap-2", m.mine && "flex-row-reverse")}>
        <div
          className={cn(
            "relative rounded-2xl px-3 py-2 text-sm",
            m.mine ? "rounded-br-sm bg-primary text-primary-foreground" : "rounded-bl-sm bg-background border",
            m.importance === "urgent" && "ring-2 ring-destructive",
            m.importance === "important" && "ring-1 ring-amber-400",
          )}
        >
          {showSender && !m.mine && !grouped && (
            <div className="mb-0.5 text-xs font-semibold text-primary">{m.sender_name}</div>
          )}
          {m.reply && (
            <div className={cn("mb-1 rounded border-l-2 px-2 py-0.5 text-xs", m.mine ? "border-primary-foreground/50 bg-primary-foreground/10" : "border-primary/50 bg-muted")}>
              <span className="font-medium">{m.reply.sender_name}</span>
              <p className="truncate opacity-80">{m.reply.body || "Message deleted"}</p>
            </div>
          )}
          {m.importance !== "normal" && !m.deleted && (
            <Badge variant={m.importance === "urgent" ? "destructive" : "secondary"} className="mb-1 gap-1 text-[10px]">
              <AlertCircle className="size-3" /> {m.importance}
            </Badge>
          )}
          {m.deleted ? (
            <em className="text-muted-foreground">Message deleted</em>
          ) : (
            <p className="whitespace-pre-wrap break-words">{m.body}</p>
          )}
          {m.attachments.map((a) => (
            <a
              key={a.id}
              href={a.url}
              target="_blank"
              rel="noopener noreferrer"
              className={cn(
                "mt-1.5 flex items-center gap-2 rounded-md px-2 py-1.5 text-xs",
                m.mine ? "bg-primary-foreground/15" : "bg-muted",
              )}
            >
              <FileText className="size-4 shrink-0" />
              <span className="min-w-0 flex-1 truncate">{a.file_name}</span>
              <span className="shrink-0 opacity-70">{formatBytes(a.file_size)}</span>
            </a>
          ))}
          <div className={cn("mt-0.5 flex items-center justify-end gap-1 text-[10px]", m.mine ? "text-primary-foreground/70" : "text-muted-foreground")}>
            {m.edited_at && <span>edited</span>}
            <span>{formatTime(m.created_at)}</span>
            {m.mine && <CheckCheck className="size-3" />}
          </div>
        </div>

        {!m.deleted && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                className="mb-1 opacity-0 transition-opacity group-hover:opacity-100"
                aria-label="Message actions"
              >
                <MoreVertical className="size-4 text-muted-foreground" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align={m.mine ? "end" : "start"}>
              <DropdownMenuItem onClick={onReply}><Reply className="mr-2 size-4" /> Reply</DropdownMenuItem>
              {m.mine && (
                <DropdownMenuItem onClick={onEdit}><Pencil className="mr-2 size-4" /> Edit</DropdownMenuItem>
              )}
              {(m.mine || canModerate) && (
                <DropdownMenuItem className="text-destructive" onClick={onDelete}>
                  <Trash2 className="mr-2 size-4" /> Delete
                </DropdownMenuItem>
              )}
              {!m.mine && (
                <DropdownMenuItem onClick={onReport}><AlertCircle className="mr-2 size-4" /> Report</DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
    </div>
  )
}
