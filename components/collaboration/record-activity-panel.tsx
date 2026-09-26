"use client"

import { useRef, useState } from "react"
import useSWR from "swr"
import { Mail, MessageSquare, Paperclip, Phone, StickyNote, Trash2, Users, Video } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Textarea } from "@/components/ui/textarea"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"

type UserChip = { id: number | null; name: string; deleted: boolean }
type Comment = {
  id: number
  author: UserChip
  body: string | null
  deleted: boolean
  createdAt: string
  attachments: { name: string; url: string }[]
  mentions: UserChip[]
}
type Event = { id: number; kind: string; title: string; body: string | null; occurred_at: string; actor: UserChip | null }
type Activity = { subject: { label: string }; comments: Comment[]; events: Event[] }

const fetcher = async (url: string) => {
  const res = await fetch(url)
  if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? "Failed to load")
  return res.json()
}

const KIND_ICON: Record<string, typeof Mail> = { email: Mail, call: Phone, whatsapp: MessageSquare, meeting: Video, note: StickyNote }

function when(iso: string) {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
}

export function RecordActivityPanel({ subjectType, subjectId, currentUserId, isAdmin }: {
  subjectType: string
  subjectId: number
  currentUserId?: number
  isAdmin?: boolean
}) {
  const base = `/api/collaboration/${subjectType}/${subjectId}`
  const { data, error, mutate, isLoading } = useSWR<Activity>(base, fetcher)
  const [body, setBody] = useState("")
  const [mentions, setMentions] = useState<{ id: number; name: string }[]>([])
  const [mentionQuery, setMentionQuery] = useState<string | null>(null)
  const [attachment, setAttachment] = useState({ name: "", url: "" })
  const [showAttach, setShowAttach] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const idemKey = useRef<string>(crypto.randomUUID())

  const { data: candidates } = useSWR<{ users: { id: number; name: string }[] }>(
    mentionQuery !== null ? `${base}/mentionable?q=${encodeURIComponent(mentionQuery)}` : null,
    fetcher,
  )

  function onBodyChange(value: string) {
    setBody(value)
    const match = /@([\w .-]{0,40})$/.exec(value)
    setMentionQuery(match ? match[1] : null)
  }

  function pickMention(u: { id: number; name: string }) {
    setBody((b) => b.replace(/@([\w .-]{0,40})$/, `@[${u.name}](user:${u.id}) `))
    setMentions((m) => (m.some((x) => x.id === u.id) ? m : [...m, u]))
    setMentionQuery(null)
  }

  async function submit() {
    if (!body.trim() || busy) return
    setBusy(true)
    setStatus(null)
    const attachments = attachment.name && attachment.url ? [attachment] : []
    const res = await fetch(`${base}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": idemKey.current },
      body: JSON.stringify({ body, attachments }),
    })
    const json = await res.json().catch(() => ({}))
    setBusy(false)
    if (!res.ok) {
      setStatus(json.fields ? Object.values(json.fields).join(" ") : json.error ?? "Could not post comment")
      return
    }
    const skipped = (json.mentions ?? []).filter((m: { status: string }) => m.status === "no_access").length
    setStatus(skipped ? `${skipped} mentioned user(s) can't see this record and were not notified.` : null)
    setBody("")
    setMentions([])
    setAttachment({ name: "", url: "" })
    setShowAttach(false)
    idemKey.current = crypto.randomUUID()
    mutate()
  }

  async function remove(id: number) {
    const res = await fetch(`${base}/comments/${id}`, { method: "DELETE" })
    if (res.ok) mutate()
  }

  const items = [
    ...(data?.comments ?? []).map((c) => ({ at: c.createdAt, type: "comment" as const, c })),
    ...(data?.events ?? []).map((e) => ({ at: e.occurred_at, type: "event" as const, e })),
  ].sort((a, b) => Date.parse(b.at) - Date.parse(a.at))

  return (
    <Card className="mt-6">
      <CardHeader>
        <CardTitle className="text-base">Activity &amp; comments</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="relative flex flex-col gap-2">
          <label htmlFor={`comment-${subjectType}-${subjectId}`} className="sr-only">
            Add a comment
          </label>
          <Textarea
            id={`comment-${subjectType}-${subjectId}`}
            value={body}
            onChange={(e) => onBodyChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing || e.keyCode === 229) return
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit()
            }}
            placeholder="Write a comment. Type @ to mention a teammate."
            rows={3}
            maxLength={5000}
          />
          {mentionQuery !== null && candidates?.users?.length ? (
            <ul role="listbox" aria-label="Mention a teammate" className="absolute top-full z-10 mt-1 w-64 rounded-md border bg-popover p-1 shadow-md">
              {candidates.users.map((u) => (
                <li key={u.id}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={false}
                    onClick={() => pickMention(u)}
                    className="w-full rounded px-2 py-1.5 text-left text-sm hover:bg-accent"
                  >
                    {u.name}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          {showAttach ? (
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input aria-label="Attachment name" placeholder="File name" value={attachment.name} onChange={(e) => setAttachment({ ...attachment, name: e.target.value })} />
              <Input aria-label="Attachment URL" placeholder="https://… or /api/dms/…" value={attachment.url} onChange={(e) => setAttachment({ ...attachment, url: e.target.value })} />
            </div>
          ) : null}
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Button type="button" variant="ghost" size="sm" onClick={() => setShowAttach((s) => !s)}>
                <Paperclip className="size-4" aria-hidden="true" />
                Attach link
              </Button>
              {mentions.length ? (
                <span className="flex items-center gap-1 text-xs text-muted-foreground">
                  <Users className="size-3.5" aria-hidden="true" /> {mentions.length} mentioned
                </span>
              ) : null}
            </div>
            <Button type="button" size="sm" onClick={submit} disabled={busy || !body.trim()}>
              {busy ? "Posting…" : "Comment"}
            </Button>
          </div>
          {status ? <p role="status" className="text-sm text-muted-foreground">{status}</p> : null}
        </div>

        {error ? <p className="text-sm text-destructive">{error.message}</p> : null}
        {isLoading ? <p className="text-sm text-muted-foreground">Loading activity…</p> : null}
        {!isLoading && !error && items.length === 0 ? <p className="text-sm text-muted-foreground">No activity yet.</p> : null}

        <ol className="flex flex-col gap-3">
          {items.map((item) => {
            if (item.type === "comment") {
              const c = item.c
              const canDelete = !c.deleted && (isAdmin || (currentUserId != null && c.author.id === currentUserId))
              return (
                <li key={`c-${c.id}`} id={`comment-${c.id}`} className="rounded-md border p-3">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-sm font-medium">
                      <span className={c.author.deleted ? "italic text-muted-foreground" : ""}>{c.author.name}</span>
                      <span className="ml-2 text-xs font-normal text-muted-foreground">{when(c.createdAt)}</span>
                    </p>
                    {canDelete ? (
                      <Button type="button" variant="ghost" size="icon" onClick={() => remove(c.id)} aria-label="Delete comment">
                        <Trash2 className="size-4" aria-hidden="true" />
                      </Button>
                    ) : null}
                  </div>
                  <p className={`mt-1 whitespace-pre-wrap text-sm ${c.deleted ? "italic text-muted-foreground" : ""}`}>
                    {c.deleted ? "This comment was deleted." : c.body}
                  </p>
                  {c.attachments.length ? (
                    <ul className="mt-2 flex flex-wrap gap-2">
                      {c.attachments.map((a) => (
                        <li key={a.url}>
                          <a href={a.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs text-primary underline-offset-2 hover:underline">
                            <Paperclip className="size-3" aria-hidden="true" /> {a.name}
                          </a>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </li>
              )
            }
            const e = item.e
            const Icon = KIND_ICON[e.kind] ?? StickyNote
            return (
              <li key={`e-${e.id}`} className="flex gap-3 px-1">
                <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                <div className="min-w-0">
                  <p className="text-sm">
                    <Badge variant="secondary" className="mr-2 capitalize">{e.kind}</Badge>
                    {e.title}
                  </p>
                  {e.body ? <p className="mt-0.5 text-sm text-muted-foreground">{e.body}</p> : null}
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {e.actor ? `${e.actor.name} · ` : ""}
                    {when(e.occurred_at)}
                  </p>
                </div>
              </li>
            )
          })}
        </ol>
      </CardContent>
    </Card>
  )
}
