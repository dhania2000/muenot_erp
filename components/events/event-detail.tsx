"use client"

import { useMemo, useState } from "react"
import useSWR from "swr"
import { fetcher } from "@/lib/fetcher"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog"
import {
  ArrowLeft, MapPin, Clock, User, Users, QrCode, ScrollText, Search, Plus, RefreshCw, Ban,
  RotateCcw, Trash2, Download, Printer, CheckCircle2, LogOut,
} from "lucide-react"

type Participant = {
  id: number
  employee_pk: number
  employee_ref: string | null
  employee_name: string | null
  designation: string | null
  department: string | null
  employment_status: string | null
  live_status: string | null
  photo_url: string | null
  access_status: string
  token: string | null
  token_active: number
  checked_in_at: string | null
  checked_out_at: string | null
}

type AccessLog = {
  id: number
  employee_name: string | null
  result: string
  reason: string | null
  scanner_name: string | null
  venue: string | null
  scan_time: string
}

type Detail = {
  event: any
  stats: { invited: number; checked_in: number; checked_out: number; denied: number; pending: number }
  canManage: boolean
}

function fmt(v?: string | null) {
  if (!v) return "—"
  const d = new Date(String(v).replace(" ", "T"))
  return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })
}

const STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  checked_in: "default",
  checked_out: "secondary",
  allowed: "outline",
  invited: "outline",
  revoked: "destructive",
  denied: "destructive",
}

const RESULT_VARIANT: Record<string, "default" | "secondary" | "destructive"> = {
  APPROVED: "default",
  ALREADY_CHECKED_IN: "secondary",
  CHECKED_OUT: "secondary",
}

export function EventDetail({ eventId, onBack }: { eventId: number; onBack: () => void }) {
  const { data, mutate } = useSWR<Detail>(`/api/events/${eventId}`, fetcher)
  const [tab, setTab] = useState("overview")

  const event = data?.event
  const canManage = data?.canManage ?? false

  if (!event) {
    return (
      <main className="flex flex-col gap-6 p-6 md:p-8">
        <Button variant="outline" size="sm" className="w-fit" onClick={onBack}>
          <ArrowLeft className="mr-2 size-4" /> Back
        </Button>
        <div className="rounded-lg border border-dashed p-12 text-center text-sm text-muted-foreground">Loading event…</div>
      </main>
    )
  }

  return (
    <main className="flex flex-col gap-6 p-6 md:p-8">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <Button variant="outline" size="sm" onClick={onBack}>
            <ArrowLeft className="mr-2 size-4" /> Back
          </Button>
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
              <span className="size-3 shrink-0 rounded-full" style={{ backgroundColor: event.label_color }} />
              {event.name}
            </h1>
            <p className="text-sm text-muted-foreground">
              {event.event_ref ?? `EVT-${String(event.id).padStart(4, "0")}`} <span className="px-1">•</span>{" "}
              <span className="capitalize">{event.status}</span>
            </p>
          </div>
        </div>
      </header>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        {[
          { label: "Invited", value: data.stats.invited },
          { label: "Checked In", value: data.stats.checked_in },
          { label: "Checked Out", value: data.stats.checked_out },
          { label: "Pending", value: data.stats.pending },
          { label: "Denied/Revoked", value: data.stats.denied },
        ].map((s) => (
          <div key={s.label} className="rounded-lg border bg-card p-4">
            <p className="text-2xl font-semibold">{s.value}</p>
            <p className="text-xs text-muted-foreground">{s.label}</p>
          </div>
        ))}
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="overview"><User className="mr-1.5 size-4" /> Overview</TabsTrigger>
          <TabsTrigger value="participants"><Users className="mr-1.5 size-4" /> Participants</TabsTrigger>
          <TabsTrigger value="qr"><QrCode className="mr-1.5 size-4" /> Event QR</TabsTrigger>
          <TabsTrigger value="logs"><ScrollText className="mr-1.5 size-4" /> Access Logs</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="mt-4">
          <div className="grid gap-3 rounded-lg border bg-card p-6 text-sm">
            <p className="flex items-center gap-2"><Clock className="size-4 text-muted-foreground" /> {fmt(event.start_at)} &ndash; {fmt(event.end_at)}</p>
            {event.location && <p className="flex items-center gap-2"><MapPin className="size-4 text-muted-foreground" /> {event.location}</p>}
            {event.host_name && <p className="flex items-center gap-2"><User className="size-4 text-muted-foreground" /> Host: {event.host_name}</p>}
            {event.contact_person && <p className="text-muted-foreground">Contact: {event.contact_person}</p>}
            {event.capacity ? <p className="text-muted-foreground">Capacity: {event.capacity}</p> : null}
            <p className="text-muted-foreground">
              Access window: opens {event.access_before_minutes} min before start
              {event.access_after_minutes ? `, closes ${event.access_after_minutes} min after end` : ""}
            </p>
            {event.meeting_details && <p className="whitespace-pre-wrap pt-1">{event.meeting_details}</p>}
            {event.instructions && (
              <div className="rounded-md border bg-muted/30 p-3">
                <p className="text-xs font-medium uppercase text-muted-foreground">Instructions</p>
                <p className="whitespace-pre-wrap pt-1">{event.instructions}</p>
              </div>
            )}
            {event.description && <p className="whitespace-pre-wrap pt-1 leading-relaxed">{event.description}</p>}
          </div>
        </TabsContent>

        <TabsContent value="participants" className="mt-4">
          <ParticipantsTab eventId={eventId} canManage={canManage} onChange={() => mutate()} />
        </TabsContent>

        <TabsContent value="qr" className="mt-4">
          <QrPanel token={event.event_token} title={event.name} subtitle="Event QR — shows event landing on scan" />
        </TabsContent>

        <TabsContent value="logs" className="mt-4">
          <LogsTab eventId={eventId} />
        </TabsContent>
      </Tabs>
    </main>
  )
}

function QrPanel({ token, title, subtitle }: { token: string | null; title: string; subtitle: string }) {
  if (!token) return <p className="text-sm text-muted-foreground">No QR token available.</p>
  const src = `/api/events/qr?token=${encodeURIComponent(token)}`

  const download = async () => {
    const res = await fetch(src)
    const blob = await res.blob()
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = `${title.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-qr.png`
    a.click()
    URL.revokeObjectURL(url)
  }
  const print = () => {
    const w = window.open("", "_blank")
    if (!w) return
    w.document.write(
      `<html><head><title>${title}</title></head><body style="font-family:sans-serif;text-align:center;padding:40px">
       <h2>${title}</h2><p>${subtitle}</p><img src="${src}" style="width:320px;height:320px" /></body></html>`,
    )
    w.document.close()
    w.focus()
    setTimeout(() => w.print(), 300)
  }

  return (
    <div className="flex flex-col items-center gap-4 rounded-lg border bg-card p-8 text-center">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src || "/placeholder.svg"} alt={`QR code for ${title}`} className="size-64 rounded-md border bg-white p-2" />
      <p className="text-sm text-muted-foreground">{subtitle}</p>
      <div className="flex gap-2">
        <Button variant="outline" size="sm" onClick={download}><Download className="mr-1.5 size-4" /> Download</Button>
        <Button variant="outline" size="sm" onClick={print}><Printer className="mr-1.5 size-4" /> Print</Button>
      </div>
    </div>
  )
}

function ParticipantsTab({ eventId, canManage, onChange }: { eventId: number; canManage: boolean; onChange: () => void }) {
  const [q, setQ] = useState("")
  const [status, setStatus] = useState("all")
  const params = new URLSearchParams()
  if (q) params.set("q", q)
  if (status !== "all") params.set("status", status)
  const { data, mutate } = useSWR<{ participants: Participant[] }>(
    `/api/events/${eventId}/participants?${params.toString()}`,
    fetcher,
  )
  const participants = data?.participants ?? []

  const [addOpen, setAddOpen] = useState(false)
  const [qrFor, setQrFor] = useState<Participant | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = () => { mutate(); onChange() }

  const act = async (participant_id: number, action: string, reason?: string) => {
    setBusy(true)
    await fetch(`/api/events/${eventId}/participants`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ participant_id, action, reason }),
    })
    setBusy(false)
    refresh()
  }
  const remove = async (participant_id: number) => {
    setBusy(true)
    await fetch(`/api/events/${eventId}/participants?participant_id=${participant_id}`, { method: "DELETE" })
    setBusy(false)
    refresh()
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-[200px] flex-1">
          <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input className="pl-9" placeholder="Search participants" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="w-44"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="invited">Invited</SelectItem>
            <SelectItem value="checked_in">Checked In</SelectItem>
            <SelectItem value="checked_out">Checked Out</SelectItem>
            <SelectItem value="revoked">Revoked</SelectItem>
          </SelectContent>
        </Select>
        {canManage && (
          <Button onClick={() => setAddOpen(true)}><Plus className="mr-1.5 size-4" /> Add Participants</Button>
        )}
      </div>

      <div className="overflow-hidden rounded-lg border bg-card">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-muted-foreground">
                <th className="px-4 py-2.5 font-medium">Employee</th>
                <th className="px-4 py-2.5 font-medium">Department</th>
                <th className="px-4 py-2.5 font-medium">Live Status</th>
                <th className="px-4 py-2.5 font-medium">Access</th>
                <th className="px-4 py-2.5 font-medium">Checked In</th>
                <th className="px-4 py-2.5 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {participants.length === 0 ? (
                <tr><td colSpan={6} className="py-12 text-center text-sm text-muted-foreground">No participants yet.</td></tr>
              ) : (
                participants.map((p) => (
                  <tr key={p.id} className="border-b last:border-b-0 hover:bg-muted/40">
                    <td className="px-4 py-3">
                      <div className="font-medium">{p.employee_name}</div>
                      <div className="text-xs text-muted-foreground">{[p.employee_ref, p.designation].filter(Boolean).join(" · ")}</div>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">{p.department || "—"}</td>
                    <td className="px-4 py-3">
                      <Badge variant={String(p.live_status).toLowerCase() === "active" ? "secondary" : "destructive"} className="font-normal">
                        {p.live_status || "—"}
                      </Badge>
                    </td>
                    <td className="px-4 py-3">
                      <Badge variant={STATUS_VARIANT[p.access_status] ?? "outline"} className="font-normal capitalize">
                        {p.access_status.replace("_", " ")}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">{fmt(p.checked_in_at)}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-1.5">
                        <Button variant="outline" size="sm" onClick={() => setQrFor(p)} title="Show QR"><QrCode className="size-3.5" /></Button>
                        {canManage && (
                          <>
                            <Button variant="outline" size="sm" disabled={busy} onClick={() => act(p.id, "regenerate")} title="Regenerate QR"><RefreshCw className="size-3.5" /></Button>
                            {p.token_active ? (
                              <Button variant="outline" size="sm" disabled={busy} onClick={() => act(p.id, "revoke")} title="Revoke access"><Ban className="size-3.5" /></Button>
                            ) : (
                              <Button variant="outline" size="sm" disabled={busy} onClick={() => act(p.id, "restore")} title="Restore access"><RotateCcw className="size-3.5" /></Button>
                            )}
                            <Button variant="outline" size="sm" disabled={busy} onClick={() => remove(p.id)} title="Remove"><Trash2 className="size-3.5" /></Button>
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

      {canManage && (
        <AddParticipantsDialog eventId={eventId} open={addOpen} onOpenChange={setAddOpen} onAdded={refresh} existing={participants} />
      )}

      <Dialog open={!!qrFor} onOpenChange={(o) => !o && setQrFor(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{qrFor?.employee_name}</DialogTitle>
            <DialogDescription>Personal access QR for this event</DialogDescription>
          </DialogHeader>
          {qrFor?.token ? (
            <QrPanel token={qrFor.token} title={qrFor.employee_name ?? "Participant"} subtitle="Scan at the gate to check in" />
          ) : (
            <p className="text-sm text-muted-foreground">No token for this participant.</p>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}

function AddParticipantsDialog({
  eventId, open, onOpenChange, onAdded, existing,
}: {
  eventId: number
  open: boolean
  onOpenChange: (o: boolean) => void
  onAdded: () => void
  existing: Participant[]
}) {
  const { data } = useSWR<{ employees: { id: number; employee_name: string; department: string | null; designation: string | null }[] }>(
    open ? "/api/events/employees" : null,
    fetcher,
  )
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [q, setQ] = useState("")
  const [saving, setSaving] = useState(false)

  const existingPks = useMemo(() => new Set(existing.map((p) => p.employee_pk)), [existing])
  const employees = (data?.employees ?? []).filter(
    (e) => !q || (e.employee_name || "").toLowerCase().includes(q.toLowerCase()) || (e.department || "").toLowerCase().includes(q.toLowerCase()),
  )

  const toggle = (id: number) =>
    setSelected((s) => {
      const n = new Set(s)
      n.has(id) ? n.delete(id) : n.add(id)
      return n
    })

  const submit = async (allActive = false) => {
    setSaving(true)
    await fetch(`/api/events/${eventId}/participants`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(allActive ? { all_active: true } : { employee_pks: Array.from(selected) }),
    })
    setSaving(false)
    setSelected(new Set())
    onOpenChange(false)
    onAdded()
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add Participants</DialogTitle>
          <DialogDescription>Select employees to invite, or add all active employees at once.</DialogDescription>
        </DialogHeader>
        <div className="relative">
          <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input className="pl-9" placeholder="Search employees" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className="grid max-h-72 gap-1 overflow-y-auto rounded-md border p-2">
          {employees.length === 0 ? (
            <p className="p-4 text-center text-sm text-muted-foreground">No employees found.</p>
          ) : (
            employees.map((e) => {
              const already = existingPks.has(e.id)
              return (
                <label key={e.id} className={`flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm ${already ? "opacity-50" : "hover:bg-muted"}`}>
                  <input type="checkbox" disabled={already} checked={already || selected.has(e.id)} onChange={() => toggle(e.id)} />
                  <span className="flex-1">
                    {e.employee_name}
                    <span className="ml-2 text-xs text-muted-foreground">{[e.designation, e.department].filter(Boolean).join(" · ")}</span>
                  </span>
                  {already && <span className="text-xs text-muted-foreground">Added</span>}
                </label>
              )
            })
          )}
        </div>
        <DialogFooter className="flex-col gap-2 sm:flex-row sm:justify-between">
          <Button variant="outline" disabled={saving} onClick={() => submit(true)}>Add all active employees</Button>
          <Button disabled={saving || selected.size === 0} onClick={() => submit(false)}>
            {saving ? "Adding…" : `Add ${selected.size || ""} selected`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function LogsTab({ eventId }: { eventId: number }) {
  const [result, setResult] = useState("all")
  const [q, setQ] = useState("")
  const params = new URLSearchParams()
  if (result !== "all") params.set("result", result)
  if (q) params.set("q", q)
  const { data } = useSWR<{ logs: AccessLog[] }>(`/api/events/${eventId}/access-logs?${params.toString()}`, fetcher, {
    refreshInterval: 15_000,
  })
  const logs = data?.logs ?? []

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-[200px] flex-1">
          <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input className="pl-9" placeholder="Search logs" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <Select value={result} onValueChange={setResult}>
          <SelectTrigger className="w-52"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All results</SelectItem>
            <SelectItem value="APPROVED">Approved</SelectItem>
            <SelectItem value="ALREADY_CHECKED_IN">Already Checked In</SelectItem>
            <SelectItem value="CHECKED_OUT">Checked Out</SelectItem>
            <SelectItem value="INACTIVE_EMPLOYEE">Inactive Employee</SelectItem>
            <SelectItem value="NOT_AUTHORIZED">Not Authorized</SelectItem>
            <SelectItem value="QR_REVOKED">Revoked</SelectItem>
            <SelectItem value="EVENT_CLOSED">Event Closed</SelectItem>
            <SelectItem value="EVENT_NOT_OPEN">Not Open</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="overflow-hidden rounded-lg border bg-card">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-muted-foreground">
                <th className="px-4 py-2.5 font-medium">Time</th>
                <th className="px-4 py-2.5 font-medium">Employee</th>
                <th className="px-4 py-2.5 font-medium">Result</th>
                <th className="px-4 py-2.5 font-medium">Reason</th>
                <th className="px-4 py-2.5 font-medium">Scanner</th>
              </tr>
            </thead>
            <tbody>
              {logs.length === 0 ? (
                <tr><td colSpan={5} className="py-12 text-center text-sm text-muted-foreground">No scans logged yet.</td></tr>
              ) : (
                logs.map((l) => (
                  <tr key={l.id} className="border-b last:border-b-0 hover:bg-muted/40">
                    <td className="px-4 py-3 text-muted-foreground">{fmt(l.scan_time)}</td>
                    <td className="px-4 py-3">{l.employee_name || "—"}</td>
                    <td className="px-4 py-3">
                      <Badge variant={RESULT_VARIANT[l.result] ?? "destructive"} className="font-normal">
                        {l.result.replace(/_/g, " ")}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">{l.reason || "—"}</td>
                    <td className="px-4 py-3 text-muted-foreground">{[l.scanner_name, l.venue].filter(Boolean).join(" · ") || "—"}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
