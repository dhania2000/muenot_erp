"use client"

import { useMemo, useState } from "react"
import useSWR from "swr"
import { fetcher } from "@/lib/fetcher"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Ticket, Plus, Search, Eye, Pencil, Trash2, MapPin, Clock, User, ArrowLeft, CalendarDays } from "lucide-react"

type EventItem = {
  id: number
  name: string
  label_color: string
  location: string | null
  description: string | null
  start_at: string
  end_at: string
  repeat_enabled: number
  repeat_cycle: string
  repeat_every: number
  repeat_ends_on: string | null
  host_name: string | null
  attendee_type: "all_employees" | "all_clients" | "specific"
  attendees: string[]
  status: "pending" | "completed"
  created_by_name: string | null
  created_at: string
}

type ApiResponse = { events: EventItem[]; employees: string[]; canManage: boolean }

const LABEL_COLORS = ["#4f46e5", "#0891b2", "#059669", "#d97706", "#dc2626", "#7c3aed", "#db2777", "#475569"]

const emptyForm = {
  id: 0,
  name: "",
  label_color: "#4f46e5",
  location: "",
  description: "",
  start_at: "",
  end_at: "",
  repeat_enabled: false,
  repeat_cycle: "week",
  repeat_every: 1,
  repeat_ends_on: "",
  host_name: "",
  attendee_type: "all_employees" as EventItem["attendee_type"],
  attendees: [] as string[],
  status: "pending" as EventItem["status"],
}

function formatDateTime(value: string) {
  const d = new Date(value.replace(" ", "T"))
  if (Number.isNaN(d.getTime())) return value
  return d.toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })
}

function attendeeLabel(e: Pick<EventItem, "attendee_type" | "attendees">) {
  if (e.attendee_type === "all_clients") return "All Clients"
  if (e.attendee_type === "specific") return `${e.attendees.length} attendee${e.attendees.length === 1 ? "" : "s"}`
  return "All Employees"
}

export function EventsClient() {
  const [q, setQ] = useState("")
  const [from, setFrom] = useState("")
  const [toDate, setToDate] = useState("")
  const [statusFilter, setStatusFilter] = useState<string>("all")

  const params = new URLSearchParams()
  if (q) params.set("q", q)
  if (from) params.set("from", from)
  if (toDate) params.set("to_date", toDate)
  if (statusFilter !== "all") params.set("status", statusFilter)
  const { data, mutate } = useSWR<ApiResponse>(`/api/events?${params.toString()}`, fetcher)

  const events = data?.events ?? []
  const employees = data?.employees ?? []
  const canManage = data?.canManage ?? false

  const [view, setView] = useState<"list" | "form">("list")
  const [form, setForm] = useState(emptyForm)
  const [viewing, setViewing] = useState<EventItem | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")

  const isEditing = form.id > 0

  const openCreate = () => { setForm(emptyForm); setError(""); setView("form") }
  const openEdit = (e: EventItem) => {
    setForm({
      id: e.id, name: e.name, label_color: e.label_color || "#4f46e5", location: e.location ?? "",
      description: e.description ?? "", start_at: (e.start_at || "").replace(" ", "T").slice(0, 16),
      end_at: (e.end_at || "").replace(" ", "T").slice(0, 16), repeat_enabled: !!e.repeat_enabled,
      repeat_cycle: e.repeat_cycle || "week", repeat_every: e.repeat_every || 1,
      repeat_ends_on: e.repeat_ends_on ?? "", host_name: e.host_name ?? "",
      attendee_type: e.attendee_type, attendees: e.attendees ?? [], status: e.status,
    })
    setError("")
    setView("form")
  }

  const save = async (ev: React.FormEvent) => {
    ev.preventDefault()
    setError("")
    if (form.end_at && form.start_at && form.end_at < form.start_at) {
      setError("End date/time must be after the start date/time.")
      return
    }
    setSaving(true)
    const res = await fetch("/api/events", {
      method: isEditing ? "PATCH" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...form, id: form.id || undefined }),
    })
    setSaving(false)
    if (res.ok) { setView("list"); setForm(emptyForm); mutate() }
    else setError((await res.json().catch(() => ({}))).error || "Could not save the event.")
  }

  const remove = async (id: number) => {
    await fetch(`/api/events?id=${id}`, { method: "DELETE" })
    setViewing(null)
    mutate()
  }

  const toggleAttendee = (name: string) => {
    setForm((f) => ({
      ...f,
      attendees: f.attendees.includes(name) ? f.attendees.filter((a) => a !== name) : [...f.attendees, name],
    }))
  }

  const total = useMemo(() => events.length, [events])

  if (view === "form") {
    return (
      <main className="flex flex-col gap-6 p-6 md:p-8">
        <header className="flex items-center gap-3">
          <Button variant="outline" size="sm" onClick={() => setView("list")}>
            <ArrowLeft className="mr-2 size-4" /> Back
          </Button>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">{isEditing ? "Edit Event" : "Create Event"}</h1>
            <p className="text-sm text-muted-foreground">Events <span className="px-1">•</span> {isEditing ? "Edit" : "Create"}</p>
          </div>
        </header>

        <form onSubmit={save} className="grid gap-6 rounded-lg border bg-card p-6">
          {error && <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}

          <div className="grid gap-4 md:grid-cols-2">
            <label className="grid gap-1.5 text-sm font-medium">
              Event Name
              <Input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Enter event name" />
            </label>
            <div className="grid gap-1.5 text-sm font-medium">
              Label Color
              <div className="flex flex-wrap items-center gap-2 pt-1">
                {LABEL_COLORS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setForm({ ...form, label_color: c })}
                    className={`size-7 rounded-full ring-offset-2 ring-offset-background transition ${form.label_color === c ? "ring-2 ring-foreground" : ""}`}
                    style={{ backgroundColor: c }}
                    aria-label={`Select color ${c}`}
                  />
                ))}
              </div>
            </div>
          </div>

          <label className="grid gap-1.5 text-sm font-medium">
            Where
            <Input value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} placeholder="Event location" />
          </label>

          <div className="grid gap-4 md:grid-cols-2">
            <label className="grid gap-1.5 text-sm font-medium">
              Starts On
              <Input type="datetime-local" required value={form.start_at} onChange={(e) => setForm({ ...form, start_at: e.target.value })} />
            </label>
            <label className="grid gap-1.5 text-sm font-medium">
              Ends On
              <Input type="datetime-local" required value={form.end_at} onChange={(e) => setForm({ ...form, end_at: e.target.value })} />
            </label>
          </div>

          <div className="grid gap-3 rounded-md border p-4">
            <label className="flex items-center gap-2 text-sm font-medium">
              <input type="checkbox" checked={form.repeat_enabled} onChange={(e) => setForm({ ...form, repeat_enabled: e.target.checked })} />
              Repeat this event
            </label>
            {form.repeat_enabled && (
              <div className="grid gap-4 md:grid-cols-3">
                <label className="grid gap-1.5 text-sm font-medium">
                  Every
                  <Input type="number" min={1} value={form.repeat_every} onChange={(e) => setForm({ ...form, repeat_every: Number(e.target.value) })} />
                </label>
                <label className="grid gap-1.5 text-sm font-medium">
                  Cycle
                  <Select value={form.repeat_cycle} onValueChange={(v) => setForm({ ...form, repeat_cycle: v || "week" })}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="day">Day(s)</SelectItem>
                      <SelectItem value="week">Week(s)</SelectItem>
                      <SelectItem value="month">Month(s)</SelectItem>
                      <SelectItem value="year">Year(s)</SelectItem>
                    </SelectContent>
                  </Select>
                </label>
                <label className="grid gap-1.5 text-sm font-medium">
                  Ends On
                  <Input type="date" value={form.repeat_ends_on} onChange={(e) => setForm({ ...form, repeat_ends_on: e.target.value })} />
                </label>
              </div>
            )}
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <label className="grid gap-1.5 text-sm font-medium">
              Host
              <Select value={form.host_name || "none"} onValueChange={(v) => setForm({ ...form, host_name: !v || v === "none" ? "" : v })}>
                <SelectTrigger><SelectValue placeholder="Select host" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No host</SelectItem>
                  {employees.map((n) => <SelectItem key={n} value={n}>{n}</SelectItem>)}
                </SelectContent>
              </Select>
            </label>
            <label className="grid gap-1.5 text-sm font-medium">
              Status
              <Select value={form.status} onValueChange={(v) => setForm({ ...form, status: (v as EventItem["status"]) || "pending" })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="pending">Pending</SelectItem>
                  <SelectItem value="completed">Completed</SelectItem>
                </SelectContent>
              </Select>
            </label>
          </div>

          <div className="grid gap-2">
            <span className="text-sm font-medium">Select Attendees</span>
            <div className="flex flex-wrap gap-6 text-sm">
              {(["all_employees", "all_clients", "specific"] as const).map((t) => (
                <label key={t} className="flex items-center gap-2">
                  <input type="radio" name="attendee_type" checked={form.attendee_type === t} onChange={() => setForm({ ...form, attendee_type: t })} />
                  {t === "all_employees" ? "All Employees" : t === "all_clients" ? "All Clients" : "Specific Employees"}
                </label>
              ))}
            </div>
            {form.attendee_type === "specific" && (
              <div className="mt-1 grid max-h-52 gap-1.5 overflow-y-auto rounded-md border p-3 sm:grid-cols-2">
                {employees.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No employees found.</p>
                ) : (
                  employees.map((n) => (
                    <label key={n} className="flex items-center gap-2 text-sm">
                      <input type="checkbox" checked={form.attendees.includes(n)} onChange={() => toggleAttendee(n)} />
                      {n}
                    </label>
                  ))
                )}
              </div>
            )}
          </div>

          <label className="grid gap-1.5 text-sm font-medium">
            Description
            <Textarea rows={5} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="Event description" />
          </label>

          <div className="flex items-center gap-2">
            <Button type="submit" disabled={saving}>{saving ? "Saving…" : isEditing ? "Update Event" : "Create Event"}</Button>
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
          <h1 className="text-2xl font-semibold tracking-tight">Events</h1>
          <p className="text-sm text-muted-foreground">Home <span className="px-1">•</span> Events</p>
        </div>
        {canManage && (
          <Button onClick={openCreate}>
            <Plus className="mr-2 size-4" /> Add Event
          </Button>
        )}
      </header>

      <div className="flex flex-wrap items-end gap-3 rounded-lg border bg-card p-4">
        <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
          Start Date
          <Input type="date" className="w-44" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
          End Date
          <Input type="date" className="w-44" value={toDate} onChange={(e) => setToDate(e.target.value)} />
        </label>
        <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
          Status
          <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v || "all")}>
            <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              <SelectItem value="pending">Pending</SelectItem>
              <SelectItem value="completed">Completed</SelectItem>
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
          <h2 className="text-sm font-medium">Events</h2>
          <span className="text-xs text-muted-foreground">{total} record{total === 1 ? "" : "s"}</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-muted-foreground">
                <th className="px-4 py-2.5 font-medium">#</th>
                <th className="px-4 py-2.5 font-medium">Event Name</th>
                <th className="px-4 py-2.5 font-medium">Starts On</th>
                <th className="px-4 py-2.5 font-medium">Ends On</th>
                <th className="px-4 py-2.5 font-medium">Host</th>
                <th className="px-4 py-2.5 font-medium">Status</th>
                <th className="px-4 py-2.5 text-right font-medium">Action</th>
              </tr>
            </thead>
            <tbody>
              {events.length === 0 ? (
                <tr>
                  <td colSpan={7}>
                    <div className="flex flex-col items-center gap-3 py-16 text-center text-sm text-muted-foreground">
                      <Ticket className="size-9" />
                      <p>No record found.</p>
                    </div>
                  </td>
                </tr>
              ) : (
                events.map((e, i) => (
                  <tr key={e.id} className="border-b last:border-b-0 hover:bg-muted/40">
                    <td className="px-4 py-3 text-muted-foreground">{i + 1}</td>
                    <td className="px-4 py-3">
                      <button className="flex items-center gap-2 text-left font-medium hover:underline" onClick={() => setViewing(e)}>
                        <span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: e.label_color }} />
                        {e.name}
                      </button>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">{formatDateTime(e.start_at)}</td>
                    <td className="px-4 py-3 text-muted-foreground">{formatDateTime(e.end_at)}</td>
                    <td className="px-4 py-3 text-muted-foreground">{e.host_name || "—"}</td>
                    <td className="px-4 py-3">
                      <Badge variant={e.status === "completed" ? "secondary" : "default"} className="font-normal capitalize">
                        {e.status}
                      </Badge>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-1.5">
                        <Button variant="outline" size="sm" onClick={() => setViewing(e)}><Eye className="size-3.5" /></Button>
                        {canManage && (
                          <>
                            <Button variant="outline" size="sm" onClick={() => openEdit(e)}><Pencil className="size-3.5" /></Button>
                            <Button variant="outline" size="sm" onClick={() => remove(e.id)}><Trash2 className="size-3.5" /></Button>
                          </>
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

      <Dialog open={!!viewing} onOpenChange={(o) => !o && setViewing(null)}>
        <DialogContent className="sm:max-w-lg">
          {viewing && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2 text-pretty">
                  <span className="size-3 shrink-0 rounded-full" style={{ backgroundColor: viewing.label_color }} />
                  {viewing.name}
                </DialogTitle>
                <DialogDescription className="capitalize">{viewing.status}</DialogDescription>
              </DialogHeader>
              <div className="grid gap-2.5 text-sm">
                <p className="flex items-center gap-2"><Clock className="size-4 text-muted-foreground" /> {formatDateTime(viewing.start_at)} &ndash; {formatDateTime(viewing.end_at)}</p>
                {viewing.location && <p className="flex items-center gap-2"><MapPin className="size-4 text-muted-foreground" /> {viewing.location}</p>}
                {viewing.host_name && <p className="flex items-center gap-2"><User className="size-4 text-muted-foreground" /> Host: {viewing.host_name}</p>}
                <p className="flex items-center gap-2"><CalendarDays className="size-4 text-muted-foreground" /> {attendeeLabel(viewing)}</p>
                {viewing.repeat_enabled ? (
                  <p className="text-muted-foreground">Repeats every {viewing.repeat_every} {viewing.repeat_cycle}(s){viewing.repeat_ends_on ? ` until ${viewing.repeat_ends_on}` : ""}</p>
                ) : null}
                {viewing.attendee_type === "specific" && viewing.attendees.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 pt-1">
                    {viewing.attendees.map((a) => <Badge key={a} variant="secondary" className="font-normal">{a}</Badge>)}
                  </div>
                )}
                {viewing.description && <p className="whitespace-pre-wrap pt-1 leading-relaxed text-foreground/90">{viewing.description}</p>}
              </div>
              {canManage && (
                <div className="flex items-center justify-end gap-2 pt-2">
                  <Button variant="outline" onClick={() => { const e = viewing; setViewing(null); openEdit(e) }}>
                    <Pencil className="mr-2 size-3.5" /> Edit
                  </Button>
                  <Button variant="destructive" onClick={() => remove(viewing.id)}>
                    <Trash2 className="mr-2 size-3.5" /> Delete
                  </Button>
                </div>
              )}
            </>
          )}
        </DialogContent>
      </Dialog>
    </main>
  )
}
