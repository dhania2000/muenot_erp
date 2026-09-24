"use client"

import { useState } from "react"
import Link from "next/link"
import useSWR from "swr"
import { fetcher } from "@/lib/fetcher"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { CalendarClock, Plus, Pencil, Trash2, Video, X } from "lucide-react"

type Meeting = {
  id: number
  title: string
  meeting_type: string
  project_id: string | null
  project_name: string | null
  client_name: string | null
  description: string | null
  start_time: string
  end_time: string
  attendees: string | null
  location: string | null
  organizer_name: string | null
  google_event_id: string | null
  meet_link: string | null
  html_link: string | null
  status: string
}

type MeetingsResponse = {
  meetings: Meeting[]
  meetingTypes: string[]
  googleConfigured: boolean
  googleConnected: boolean
}

const STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  Scheduled: "default",
  Completed: "secondary",
  Cancelled: "destructive",
}

function toLocalInput(value: string | null): string {
  if (!value) return ""
  // MySQL DATETIME arrives as "YYYY-MM-DD HH:MM:SS"; datetime-local wants "T".
  const s = String(value).replace(" ", "T")
  return s.slice(0, 16)
}

function formatWhen(value: string): string {
  const d = new Date(String(value).replace(" ", "T"))
  if (Number.isNaN(d.getTime())) return value
  return d.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  })
}

const EMPTY = {
  title: "",
  meeting_type: "Project Meeting",
  project_id: "",
  project_name: "",
  client_name: "",
  description: "",
  start_time: "",
  end_time: "",
  attendees: "",
  location: "",
  create_google_event: false,
}

export function OperationsMeetingsClient() {
  const { data, mutate, isLoading } = useSWR<MeetingsResponse>("/api/operations/meetings", fetcher)
  const [open, setOpen] = useState(false)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [form, setForm] = useState<any>({ ...EMPTY })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [typeFilter, setTypeFilter] = useState("")
  const [statusFilter, setStatusFilter] = useState("")

  const meetings = data?.meetings ?? []
  const meetingTypes = data?.meetingTypes ?? []
  const googleConfigured = data?.googleConfigured ?? false
  const googleConnected = data?.googleConnected ?? false

  const filtered = meetings.filter(
    (m) => (!typeFilter || m.meeting_type === typeFilter) && (!statusFilter || m.status === statusFilter),
  )

  function openCreate() {
    setEditingId(null)
    setForm({ ...EMPTY })
    setError(null)
    setOpen(true)
  }

  function openEdit(m: Meeting) {
    setEditingId(m.id)
    setForm({
      title: m.title ?? "",
      meeting_type: m.meeting_type ?? "Project Meeting",
      project_id: m.project_id ?? "",
      project_name: m.project_name ?? "",
      client_name: m.client_name ?? "",
      description: m.description ?? "",
      start_time: toLocalInput(m.start_time),
      end_time: toLocalInput(m.end_time),
      attendees: m.attendees ?? "",
      location: m.location ?? "",
      create_google_event: false,
    })
    setError(null)
    setOpen(true)
  }

  async function save() {
    setError(null)
    if (!form.title || !form.start_time || !form.end_time) {
      setError("Title, start time and end time are required.")
      return
    }
    setSaving(true)
    try {
      const isEdit = editingId != null
      const res = await fetch("/api/operations/meetings", {
        method: isEdit ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(isEdit ? { id: editingId, ...form } : form),
      })
      const json = await res.json()
      if (!res.ok) {
        setError(json.error ?? "Could not save the meeting.")
        return
      }
      setNotice(json.warning ?? null)
      setOpen(false)
      setForm({ ...EMPTY })
      setEditingId(null)
      mutate()
    } finally {
      setSaving(false)
    }
  }

  async function cancelMeeting(m: Meeting) {
    if (!window.confirm(`Cancel "${m.title}"? Attendees will be notified if it is on the calendar.`)) return
    const res = await fetch(`/api/operations/meetings?id=${m.id}&action=cancel`, { method: "DELETE" })
    const json = await res.json().catch(() => ({}))
    setNotice(json.warning ?? null)
    mutate()
  }

  async function remove(m: Meeting) {
    if (!window.confirm(`Delete "${m.title}"? This removes it and any linked calendar event.`)) return
    await fetch(`/api/operations/meetings?id=${m.id}`, { method: "DELETE" })
    mutate()
  }

  return (
    <main className="space-y-6 p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-sm text-muted-foreground">Delivery cockpit</p>
          <h1 className="flex items-center gap-2 text-3xl font-semibold tracking-tight">
            <CalendarClock className="size-7 text-muted-foreground" />
            Meetings
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Project, client, review, SLA and task meetings — synced to your Google Calendar.
          </p>
        </div>
        <Button onClick={openCreate}>
          <Plus className="size-4" />
          Schedule Meeting
        </Button>
      </div>

      {!googleConfigured && (
        <div className="rounded-lg border border-dashed bg-muted/40 p-3 text-sm text-muted-foreground">
          Google Calendar is not configured. Meetings are still saved here, but no calendar events will be created.
        </div>
      )}
      {googleConfigured && !googleConnected && (
        <div className="rounded-lg border border-dashed bg-muted/40 p-3 text-sm text-muted-foreground">
          Connect your Google account (via Sales / Calendar) to create Google Calendar events and Meet links from here.
        </div>
      )}
      {notice && (
        <div className="flex items-start justify-between gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          <span>{notice}</span>
          <button aria-label="Dismiss" onClick={() => setNotice(null)}>
            <X className="size-4" />
          </button>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <select
          className="h-9 rounded-md border border-input bg-background px-3 text-sm"
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value)}
          aria-label="Filter by meeting type"
        >
          <option value="">All types</option>
          {meetingTypes.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <select
          className="h-9 rounded-md border border-input bg-background px-3 text-sm"
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          aria-label="Filter by status"
        >
          <option value="">All statuses</option>
          <option value="Scheduled">Scheduled</option>
          <option value="Completed">Completed</option>
          <option value="Cancelled">Cancelled</option>
        </select>
      </div>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading meetings…</p>
      ) : filtered.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 p-10 text-center text-muted-foreground">
            <CalendarClock className="size-8" />
            <p>No meetings yet. Click &quot;Schedule Meeting&quot; to create one.</p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {filtered.map((m) => (
            <Card key={m.id} className={m.status === "Cancelled" ? "opacity-70" : undefined}>
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between gap-2">
                  <CardTitle className="text-base leading-tight">{m.title}</CardTitle>
                  <Badge variant={STATUS_VARIANT[m.status] ?? "outline"}>{m.status}</Badge>
                </div>
                <div className="flex flex-wrap items-center gap-2 pt-1">
                  <Badge variant="outline">{m.meeting_type}</Badge>
                  {m.google_event_id && (
                    <Badge variant="secondary" className="gap-1">
                      <Video className="size-3" /> Calendar
                    </Badge>
                  )}
                </div>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                <p className="font-medium">{formatWhen(m.start_time)}</p>
                {(m.project_name || m.client_name) && (
                  <p className="text-muted-foreground">
                    {[m.project_name, m.client_name].filter(Boolean).join(" · ")}
                  </p>
                )}
                {m.description && <p className="line-clamp-2 text-muted-foreground">{m.description}</p>}
                {m.meet_link && (
                  <a
                    href={m.meet_link}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-primary underline-offset-2 hover:underline"
                  >
                    <Video className="size-4" /> Join Google Meet
                  </a>
                )}
                <div className="flex items-center gap-1 pt-2">
                  <Button size="sm" variant="secondary" render={<Link href={`/modules/operations/meetings/${m.id}`} />}>
                    Open
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => openEdit(m)} aria-label="Edit meeting">
                    <Pencil className="size-4" /> Edit
                  </Button>
                  {m.status !== "Cancelled" && (
                    <Button size="sm" variant="ghost" onClick={() => cancelMeeting(m)} aria-label="Cancel meeting">
                      <X className="size-4" /> Cancel
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-destructive hover:text-destructive"
                    onClick={() => remove(m)}
                    aria-label="Delete meeting"
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{editingId ? "Edit Meeting" : "Schedule Meeting"}</DialogTitle>
          </DialogHeader>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <div className="grid gap-4 py-2 md:grid-cols-2">
            <div className="flex flex-col gap-1.5 md:col-span-2">
              <Label htmlFor="title" className="text-xs text-muted-foreground">
                Title
              </Label>
              <Input id="title" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="meeting_type" className="text-xs text-muted-foreground">
                Meeting Type
              </Label>
              <select
                id="meeting_type"
                className="h-9 rounded-md border border-input bg-background px-3 text-sm"
                value={form.meeting_type}
                onChange={(e) => setForm({ ...form, meeting_type: e.target.value })}
              >
                {(meetingTypes.length ? meetingTypes : ["Project Meeting"]).map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="location" className="text-xs text-muted-foreground">
                Location
              </Label>
              <Input
                id="location"
                value={form.location}
                onChange={(e) => setForm({ ...form, location: e.target.value })}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="start_time" className="text-xs text-muted-foreground">
                Start
              </Label>
              <Input
                id="start_time"
                type="datetime-local"
                value={form.start_time}
                onChange={(e) => setForm({ ...form, start_time: e.target.value })}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="end_time" className="text-xs text-muted-foreground">
                End
              </Label>
              <Input
                id="end_time"
                type="datetime-local"
                value={form.end_time}
                onChange={(e) => setForm({ ...form, end_time: e.target.value })}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="project_id" className="text-xs text-muted-foreground">
                Project ID
              </Label>
              <Input
                id="project_id"
                value={form.project_id}
                onChange={(e) => setForm({ ...form, project_id: e.target.value })}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="project_name" className="text-xs text-muted-foreground">
                Project Name
              </Label>
              <Input
                id="project_name"
                value={form.project_name}
                onChange={(e) => setForm({ ...form, project_name: e.target.value })}
              />
            </div>
            <div className="flex flex-col gap-1.5 md:col-span-2">
              <Label htmlFor="client_name" className="text-xs text-muted-foreground">
                Client Name
              </Label>
              <Input
                id="client_name"
                value={form.client_name}
                onChange={(e) => setForm({ ...form, client_name: e.target.value })}
              />
            </div>
            <div className="flex flex-col gap-1.5 md:col-span-2">
              <Label htmlFor="attendees" className="text-xs text-muted-foreground">
                Attendees (comma-separated emails)
              </Label>
              <Input
                id="attendees"
                placeholder="alice@example.com, bob@example.com"
                value={form.attendees}
                onChange={(e) => setForm({ ...form, attendees: e.target.value })}
              />
            </div>
            <div className="flex flex-col gap-1.5 md:col-span-2">
              <Label htmlFor="description" className="text-xs text-muted-foreground">
                Description / Agenda
              </Label>
              <Textarea
                id="description"
                rows={3}
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
              />
            </div>
            {editingId == null && (
              <label className="flex items-center gap-2 text-sm md:col-span-2">
                <input
                  type="checkbox"
                  checked={form.create_google_event}
                  disabled={!googleConfigured || !googleConnected}
                  onChange={(e) => setForm({ ...form, create_google_event: e.target.checked })}
                />
                Create Google Calendar event &amp; Meet link
                {(!googleConfigured || !googleConnected) && (
                  <span className="text-xs text-muted-foreground">(connect Google first)</span>
                )}
              </label>
            )}
          </div>
          <DialogFooter>
            <DialogClose render={<Button variant="outline">Cancel</Button>} />
            <Button onClick={save} disabled={saving}>
              {saving ? "Saving…" : editingId ? "Update meeting" : "Schedule meeting"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </main>
  )
}
