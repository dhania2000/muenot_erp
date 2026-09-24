"use client"

import { useRef, useState } from "react"
import Link from "next/link"
import useSWR from "swr"
import { fetcher } from "@/lib/fetcher"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  ArrowLeft,
  CalendarClock,
  CheckCircle2,
  Clock,
  Download,
  History,
  ListTodo,
  Loader2,
  Paperclip,
  Plus,
  Trash2,
  Users,
  Video,
} from "lucide-react"

type Detail = any

const MEETING_STATUSES = ["Scheduled", "In Progress", "Completed", "Cancelled"] as const
const PARTICIPANT_ROLES = ["Organizer", "Presenter", "Attendee", "Optional"]
const RESPONSE_STATUSES = ["Pending", "Accepted", "Declined", "Tentative"]
const ATTENDANCE_STATUSES = ["", "Present", "Absent", "Excused"]
const AGENDA_STATUSES = ["Pending", "Discussed", "Deferred"]
const ACTION_STATUSES = ["Open", "In Progress", "Done", "Cancelled"]
const ACTION_PRIORITIES = ["Low", "Medium", "High", "Urgent"]

const STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  Scheduled: "default",
  "In Progress": "default",
  Completed: "secondary",
  Cancelled: "destructive",
  Open: "outline",
  Done: "secondary",
}

function formatWhen(value: string | null): string {
  if (!value) return "—"
  const d = new Date(String(value).replace(" ", "T"))
  if (Number.isNaN(d.getTime())) return String(value)
  return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
}

function formatDate(value: string | null): string {
  if (!value) return "—"
  const d = new Date(String(value).replace(" ", "T"))
  if (Number.isNaN(d.getTime())) return String(value)
  return d.toLocaleDateString(undefined, { dateStyle: "medium" })
}

function formatBytes(n: number | null): string {
  if (!n) return ""
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

export function OperationsMeetingDetailClient({ meetingId }: { meetingId: string }) {
  const { data, mutate, isLoading } = useSWR<{ meeting: Detail }>(
    `/api/operations/meetings/${meetingId}`,
    fetcher,
  )
  const [busy, setBusy] = useState(false)
  const m = data?.meeting

  async function call(path: string, method: string, body?: any) {
    setBusy(true)
    try {
      const res = await fetch(path, {
        method,
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      })
      const json = await res.json().catch(() => ({}))
      if (json.meeting) mutate({ meeting: json.meeting }, { revalidate: false })
      else mutate()
      return json
    } finally {
      setBusy(false)
    }
  }

  const base = `/api/operations/meetings/${meetingId}`

  if (isLoading) {
    return (
      <main className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Loading meeting…
      </main>
    )
  }

  if (!m) {
    return (
      <main className="space-y-4 p-6">
        <Button variant="ghost" render={<Link href="/modules/operations/meetings" />}>
          <ArrowLeft className="size-4" /> Back to meetings
        </Button>
        <p className="text-sm text-muted-foreground">Meeting not found.</p>
      </main>
    )
  }

  const participants = m.participants ?? []
  const agenda = m.agenda ?? []
  const attachments = m.attachments ?? []
  const notes = m.notes ?? []
  const actionItems = m.actionItems ?? []
  const history = m.history ?? []
  const followUps = m.followUps ?? []

  return (
    <main className="space-y-6 p-6">
      <div className="flex flex-col gap-3">
        <Button
          variant="ghost"
          size="sm"
          className="w-fit -ml-2"
          render={<Link href="/modules/operations/meetings" />}
        >
          <ArrowLeft className="size-4" /> Back to meetings
        </Button>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-semibold tracking-tight">{m.title}</h1>
              <Badge variant={STATUS_VARIANT[m.status] ?? "outline"}>{m.status}</Badge>
            </div>
            <p className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
              <Badge variant="outline">{m.meeting_type}</Badge>
              <span className="inline-flex items-center gap-1">
                <CalendarClock className="size-4" />
                {formatWhen(m.start_time)} – {formatWhen(m.end_time)}
              </span>
              {[m.project_name, m.client_name].filter(Boolean).join(" · ") && (
                <span>{[m.project_name, m.client_name].filter(Boolean).join(" · ")}</span>
              )}
            </p>
            {m.parent_meeting_id && m.parent && (
              <p className="text-sm text-muted-foreground">
                Follow-up to{" "}
                <Link
                  href={`/modules/operations/meetings/${m.parent.id}`}
                  className="text-primary underline-offset-2 hover:underline"
                >
                  {m.parent.title}
                </Link>
              </p>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {m.meet_link && (
              <Button variant="outline" size="sm" render={<a href={m.meet_link} target="_blank" rel="noreferrer" />}>
                <Video className="size-4" /> Join Meet
              </Button>
            )}
            <Label htmlFor="status" className="text-xs text-muted-foreground">
              Status
            </Label>
            <select
              id="status"
              className="h-9 rounded-md border border-input bg-background px-3 text-sm"
              value={m.status}
              disabled={busy}
              onChange={(e) => call(base, "PATCH", { action: "status", status: e.target.value })}
            >
              {MEETING_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      <Tabs defaultValue="agenda" className="w-full">
        <TabsList className="flex-wrap">
          <TabsTrigger value="agenda">Agenda</TabsTrigger>
          <TabsTrigger value="participants">Participants</TabsTrigger>
          <TabsTrigger value="notes">Notes</TabsTrigger>
          <TabsTrigger value="actions">Action Items</TabsTrigger>
          <TabsTrigger value="attachments">Attachments</TabsTrigger>
          <TabsTrigger value="followup">Follow-up</TabsTrigger>
          <TabsTrigger value="history">History</TabsTrigger>
        </TabsList>

        <TabsContent value="agenda" className="mt-4">
          <AgendaTab agenda={agenda} base={base} call={call} busy={busy} />
        </TabsContent>
        <TabsContent value="participants" className="mt-4">
          <ParticipantsTab participants={participants} base={base} call={call} busy={busy} />
        </TabsContent>
        <TabsContent value="notes" className="mt-4">
          <NotesTab notes={notes} minutes={m.minutes} base={base} call={call} busy={busy} />
        </TabsContent>
        <TabsContent value="actions" className="mt-4">
          <ActionItemsTab items={actionItems} base={base} call={call} busy={busy} />
        </TabsContent>
        <TabsContent value="attachments" className="mt-4">
          <AttachmentsTab attachments={attachments} meetingId={meetingId} mutate={mutate} />
        </TabsContent>
        <TabsContent value="followup" className="mt-4">
          <FollowUpTab meeting={m} followUps={followUps} base={base} call={call} busy={busy} />
        </TabsContent>
        <TabsContent value="history" className="mt-4">
          <HistoryTab history={history} />
        </TabsContent>
      </Tabs>
    </main>
  )
}

// ── Agenda ───────────────────────────────────────────────────────────────────

function AgendaTab({ agenda, base, call, busy }: any) {
  const [topic, setTopic] = useState("")
  const [presenter, setPresenter] = useState("")
  const [duration, setDuration] = useState("")

  async function add() {
    if (!topic.trim()) return
    await call(`${base}/agenda`, "POST", {
      topic: topic.trim(),
      presenter: presenter.trim() || null,
      duration_minutes: duration ? Number(duration) : null,
    })
    setTopic("")
    setPresenter("")
    setDuration("")
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <ListTodo className="size-4" /> Agenda ({agenda.length})
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-end gap-2">
          <div className="flex min-w-48 flex-1 flex-col gap-1.5">
            <Label className="text-xs text-muted-foreground">Topic</Label>
            <Input value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="Discussion topic" />
          </div>
          <div className="flex w-40 flex-col gap-1.5">
            <Label className="text-xs text-muted-foreground">Presenter</Label>
            <Input value={presenter} onChange={(e) => setPresenter(e.target.value)} />
          </div>
          <div className="flex w-24 flex-col gap-1.5">
            <Label className="text-xs text-muted-foreground">Min</Label>
            <Input type="number" min={0} value={duration} onChange={(e) => setDuration(e.target.value)} />
          </div>
          <Button onClick={add} disabled={busy || !topic.trim()}>
            <Plus className="size-4" /> Add
          </Button>
        </div>

        {agenda.length === 0 ? (
          <p className="text-sm text-muted-foreground">No agenda items yet.</p>
        ) : (
          <ul className="divide-y rounded-md border">
            {agenda.map((a: any, i: number) => (
              <li key={a.id} className="flex flex-wrap items-center gap-3 p-3">
                <span className="text-sm font-medium text-muted-foreground">{i + 1}.</span>
                <div className="min-w-40 flex-1">
                  <p className="text-sm font-medium">{a.topic}</p>
                  <p className="text-xs text-muted-foreground">
                    {[a.presenter, a.duration_minutes ? `${a.duration_minutes} min` : null]
                      .filter(Boolean)
                      .join(" · ") || "—"}
                  </p>
                </div>
                <select
                  className="h-8 rounded-md border border-input bg-background px-2 text-xs"
                  value={a.status ?? "Pending"}
                  disabled={busy}
                  onChange={(e) => call(`${base}/agenda`, "PUT", { item_id: a.id, status: e.target.value })}
                >
                  {AGENDA_STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
                <Button
                  size="icon"
                  variant="ghost"
                  className="text-destructive hover:text-destructive"
                  disabled={busy}
                  onClick={() => call(`${base}/agenda?item_id=${a.id}`, "DELETE")}
                  aria-label="Remove agenda item"
                >
                  <Trash2 className="size-4" />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}

// ── Participants ─────────────────────────────────────────────────────────────

function ParticipantsTab({ participants, base, call, busy }: any) {
  const [name, setName] = useState("")
  const [email, setEmail] = useState("")
  const [role, setRole] = useState("Attendee")

  async function add() {
    if (!name.trim() && !email.trim()) return
    await call(`${base}/participants`, "POST", {
      name: name.trim() || null,
      email: email.trim() || null,
      role,
    })
    setName("")
    setEmail("")
    setRole("Attendee")
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Users className="size-4" /> Participants ({participants.length})
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-end gap-2">
          <div className="flex w-40 flex-col gap-1.5">
            <Label className="text-xs text-muted-foreground">Name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="flex min-w-48 flex-1 flex-col gap-1.5">
            <Label className="text-xs text-muted-foreground">Email</Label>
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <div className="flex w-36 flex-col gap-1.5">
            <Label className="text-xs text-muted-foreground">Role</Label>
            <select
              className="h-9 rounded-md border border-input bg-background px-3 text-sm"
              value={role}
              onChange={(e) => setRole(e.target.value)}
            >
              {PARTICIPANT_ROLES.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </div>
          <Button onClick={add} disabled={busy || (!name.trim() && !email.trim())}>
            <Plus className="size-4" /> Add
          </Button>
        </div>

        {participants.length === 0 ? (
          <p className="text-sm text-muted-foreground">No participants yet.</p>
        ) : (
          <ul className="divide-y rounded-md border">
            {participants.map((p: any) => (
              <li key={p.id} className="flex flex-wrap items-center gap-3 p-3">
                <div className="min-w-40 flex-1">
                  <p className="flex items-center gap-2 text-sm font-medium">
                    {p.name || p.email || "—"}
                    {p.is_organizer ? <Badge variant="secondary">Organizer</Badge> : null}
                  </p>
                  {p.name && p.email && <p className="text-xs text-muted-foreground">{p.email}</p>}
                </div>
                <select
                  className="h-8 rounded-md border border-input bg-background px-2 text-xs"
                  value={p.role ?? "Attendee"}
                  disabled={busy}
                  onChange={(e) => call(`${base}/participants`, "PUT", { participant_id: p.id, role: e.target.value })}
                  aria-label="Role"
                >
                  {PARTICIPANT_ROLES.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
                <select
                  className="h-8 rounded-md border border-input bg-background px-2 text-xs"
                  value={p.response_status ?? "Pending"}
                  disabled={busy}
                  onChange={(e) =>
                    call(`${base}/participants`, "PUT", { participant_id: p.id, response_status: e.target.value })
                  }
                  aria-label="RSVP"
                >
                  {RESPONSE_STATUSES.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
                <select
                  className="h-8 rounded-md border border-input bg-background px-2 text-xs"
                  value={p.attendance ?? ""}
                  disabled={busy}
                  onChange={(e) =>
                    call(`${base}/participants`, "PUT", { participant_id: p.id, attendance: e.target.value })
                  }
                  aria-label="Attendance"
                >
                  {ATTENDANCE_STATUSES.map((r) => (
                    <option key={r || "none"} value={r}>
                      {r || "Attendance"}
                    </option>
                  ))}
                </select>
                <Button
                  size="icon"
                  variant="ghost"
                  className="text-destructive hover:text-destructive"
                  disabled={busy}
                  onClick={() => call(`${base}/participants?participant_id=${p.id}`, "DELETE")}
                  aria-label="Remove participant"
                >
                  <Trash2 className="size-4" />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}

// ── Notes / minutes ──────────────────────────────────────────────────────────

function NotesTab({ notes, minutes, base, call, busy }: any) {
  const [body, setBody] = useState("")
  const [minutesDraft, setMinutesDraft] = useState<string>(minutes ?? "")
  const [minutesDirty, setMinutesDirty] = useState(false)

  async function addNote() {
    if (!body.trim()) return
    await call(`${base}/notes`, "POST", { body: body.trim() })
    setBody("")
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Minutes</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <Textarea
            rows={5}
            value={minutesDraft}
            placeholder="Formal minutes / summary of the meeting…"
            onChange={(e) => {
              setMinutesDraft(e.target.value)
              setMinutesDirty(true)
            }}
          />
          <div className="flex justify-end">
            <Button
              size="sm"
              disabled={busy || !minutesDirty}
              onClick={async () => {
                await call(base, "PATCH", { action: "minutes", minutes: minutesDraft })
                setMinutesDirty(false)
              }}
            >
              Save minutes
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Notes ({notes.length})</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-col gap-2">
            <Textarea rows={2} value={body} placeholder="Add a note…" onChange={(e) => setBody(e.target.value)} />
            <div className="flex justify-end">
              <Button size="sm" onClick={addNote} disabled={busy || !body.trim()}>
                <Plus className="size-4" /> Add note
              </Button>
            </div>
          </div>
          {notes.length === 0 ? (
            <p className="text-sm text-muted-foreground">No notes yet.</p>
          ) : (
            <ul className="space-y-2">
              {notes.map((n: any) => (
                <li key={n.id} className="rounded-md border p-3">
                  <p className="whitespace-pre-wrap text-sm">{n.body}</p>
                  <div className="mt-2 flex items-center justify-between text-xs text-muted-foreground">
                    <span>
                      {n.author_name || "Someone"} · {formatWhen(n.created_at)}
                    </span>
                    <button
                      className="text-destructive hover:underline"
                      disabled={busy}
                      onClick={() => call(`${base}/notes?note_id=${n.id}`, "DELETE")}
                    >
                      Delete
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

// ── Action items ─────────────────────────────────────────────────────────────

function ActionItemsTab({ items, base, call, busy }: any) {
  const [title, setTitle] = useState("")
  const [assignee, setAssignee] = useState("")
  const [priority, setPriority] = useState("Medium")
  const [dueDate, setDueDate] = useState("")

  async function add() {
    if (!title.trim()) return
    await call(`${base}/action-items`, "POST", {
      title: title.trim(),
      assignee: assignee.trim() || null,
      priority,
      due_date: dueDate || null,
    })
    setTitle("")
    setAssignee("")
    setPriority("Medium")
    setDueDate("")
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <CheckCircle2 className="size-4" /> Action Items ({items.length})
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-end gap-2">
          <div className="flex min-w-48 flex-1 flex-col gap-1.5">
            <Label className="text-xs text-muted-foreground">Task</Label>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What needs to happen" />
          </div>
          <div className="flex w-40 flex-col gap-1.5">
            <Label className="text-xs text-muted-foreground">Assignee</Label>
            <Input value={assignee} onChange={(e) => setAssignee(e.target.value)} />
          </div>
          <div className="flex w-32 flex-col gap-1.5">
            <Label className="text-xs text-muted-foreground">Priority</Label>
            <select
              className="h-9 rounded-md border border-input bg-background px-3 text-sm"
              value={priority}
              onChange={(e) => setPriority(e.target.value)}
            >
              {ACTION_PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </div>
          <div className="flex w-40 flex-col gap-1.5">
            <Label className="text-xs text-muted-foreground">Due</Label>
            <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
          </div>
          <Button onClick={add} disabled={busy || !title.trim()}>
            <Plus className="size-4" /> Add
          </Button>
        </div>

        {items.length === 0 ? (
          <p className="text-sm text-muted-foreground">No action items yet.</p>
        ) : (
          <ul className="divide-y rounded-md border">
            {items.map((it: any) => (
              <li key={it.id} className="flex flex-wrap items-center gap-3 p-3">
                <div className="min-w-40 flex-1">
                  <p className={`text-sm font-medium ${it.status === "Done" ? "line-through text-muted-foreground" : ""}`}>
                    {it.title}
                  </p>
                  <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    {it.assignee && <span>{it.assignee}</span>}
                    <Badge variant="outline">{it.priority}</Badge>
                    {it.due_date && (
                      <span className="inline-flex items-center gap-1">
                        <Clock className="size-3" /> {formatDate(it.due_date)}
                      </span>
                    )}
                  </p>
                </div>
                <select
                  className="h-8 rounded-md border border-input bg-background px-2 text-xs"
                  value={it.status ?? "Open"}
                  disabled={busy}
                  onChange={(e) => call(`${base}/action-items`, "PUT", { item_id: it.id, status: e.target.value })}
                  aria-label="Action item status"
                >
                  {ACTION_STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
                <Button
                  size="icon"
                  variant="ghost"
                  className="text-destructive hover:text-destructive"
                  disabled={busy}
                  onClick={() => call(`${base}/action-items?item_id=${it.id}`, "DELETE")}
                  aria-label="Remove action item"
                >
                  <Trash2 className="size-4" />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}

// ── Attachments ──────────────────────────────────────────────────────────────

function AttachmentsTab({ attachments, meetingId, mutate }: any) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const base = `/api/operations/meetings/${meetingId}`

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setError(null)
    setUploading(true)
    try {
      const fd = new FormData()
      fd.append("file", file)
      const res = await fetch(`${base}/attachments/upload`, { method: "POST", body: fd })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(json.error ?? "Upload failed.")
      } else if (json.meeting) {
        mutate({ meeting: json.meeting }, { revalidate: false })
      } else {
        mutate()
      }
    } finally {
      setUploading(false)
      if (inputRef.current) inputRef.current.value = ""
    }
  }

  async function remove(id: number) {
    const res = await fetch(`${base}/attachments?attachment_id=${id}`, { method: "DELETE" })
    const json = await res.json().catch(() => ({}))
    if (json.meeting) mutate({ meeting: json.meeting }, { revalidate: false })
    else mutate()
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Paperclip className="size-4" /> Attachments ({attachments.length})
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center gap-2">
          <input ref={inputRef} type="file" className="hidden" onChange={onFile} />
          <Button onClick={() => inputRef.current?.click()} disabled={uploading}>
            {uploading ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
            {uploading ? "Uploading…" : "Upload file"}
          </Button>
          {error && <span className="text-sm text-destructive">{error}</span>}
        </div>

        {attachments.length === 0 ? (
          <p className="text-sm text-muted-foreground">No attachments yet.</p>
        ) : (
          <ul className="divide-y rounded-md border">
            {attachments.map((f: any) => (
              <li key={f.id} className="flex items-center gap-3 p-3">
                <Paperclip className="size-4 text-muted-foreground" />
                <div className="min-w-40 flex-1">
                  <a
                    href={f.file_url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-sm font-medium text-primary underline-offset-2 hover:underline"
                  >
                    {f.file_name || "Attachment"}
                  </a>
                  <p className="text-xs text-muted-foreground">
                    {[f.uploaded_by_name, formatBytes(f.size_bytes), formatWhen(f.created_at)]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                </div>
                <Button size="icon" variant="ghost" render={<a href={f.file_url} target="_blank" rel="noreferrer" />} aria-label="Download">
                  <Download className="size-4" />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  className="text-destructive hover:text-destructive"
                  onClick={() => remove(f.id)}
                  aria-label="Remove attachment"
                >
                  <Trash2 className="size-4" />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}

// ── Follow-up ────────────────────────────────────────────────────────────────

function FollowUpTab({ meeting, followUps, base, call, busy }: any) {
  const [date, setDate] = useState<string>(meeting.follow_up_date ? String(meeting.follow_up_date).slice(0, 10) : "")
  const [notes, setNotes] = useState<string>(meeting.follow_up_notes ?? "")

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Follow-up</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-end gap-2">
            <div className="flex w-48 flex-col gap-1.5">
              <Label className="text-xs text-muted-foreground">Follow-up date</Label>
              <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </div>
            <div className="flex min-w-48 flex-1 flex-col gap-1.5">
              <Label className="text-xs text-muted-foreground">Notes</Label>
              <Input value={notes} onChange={(e) => setNotes(e.target.value)} />
            </div>
            <Button
              disabled={busy}
              onClick={() => call(base, "PATCH", { action: "follow_up", follow_up_date: date || null, follow_up_notes: notes || null })}
            >
              Save
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Follow-up meetings ({followUps.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {followUps.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No follow-up meetings linked. Schedule one from the meetings list and set this meeting as its parent.
            </p>
          ) : (
            <ul className="divide-y rounded-md border">
              {followUps.map((f: any) => (
                <li key={f.id} className="flex items-center justify-between gap-3 p-3">
                  <div>
                    <Link
                      href={`/modules/operations/meetings/${f.id}`}
                      className="text-sm font-medium text-primary underline-offset-2 hover:underline"
                    >
                      {f.title}
                    </Link>
                    <p className="text-xs text-muted-foreground">{formatWhen(f.start_time)}</p>
                  </div>
                  <Badge variant={STATUS_VARIANT[f.status] ?? "outline"}>{f.status}</Badge>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

// ── History ──────────────────────────────────────────────────────────────────

function HistoryTab({ history }: any) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <History className="size-4" /> History ({history.length})
        </CardTitle>
      </CardHeader>
      <CardContent>
        {history.length === 0 ? (
          <p className="text-sm text-muted-foreground">No activity recorded yet.</p>
        ) : (
          <ol className="space-y-3">
            {history.map((h: any) => (
              <li key={h.id} className="flex gap-3 text-sm">
                <div className="mt-1.5 size-2 shrink-0 rounded-full bg-muted-foreground/40" />
                <div>
                  <p className="font-medium capitalize">{String(h.action).replace(/_/g, " ")}</p>
                  {h.detail && <p className="text-muted-foreground">{h.detail}</p>}
                  <p className="text-xs text-muted-foreground">
                    {[h.actor_name, formatWhen(h.created_at)].filter(Boolean).join(" · ")}
                  </p>
                </div>
              </li>
            ))}
          </ol>
        )}
      </CardContent>
    </Card>
  )
}
