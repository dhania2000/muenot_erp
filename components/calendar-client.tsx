"use client"

import { useEffect, useMemo, useState } from "react"
import useSWR from "swr"
import { toast } from "sonner"
import { fetcher } from "@/lib/fetcher"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  RefreshCw,
  Search,
  Video,
} from "lucide-react"

type SourceModule = "sales" | "operations" | "recruitment" | "hr" | "events" | "google"

type CalendarEvent = {
  id: string
  title: string
  start: string
  end: string | null
  allDay: boolean
  location: string | null
  description: string | null
  hangoutLink: string | null
  htmlLink: string | null
  status: string | null
  sourceModule?: SourceModule
  sourceRecordId?: string | number | null
  category?: string | null
  organizer?: string | null
  href?: string | null
  googleSyncStatus?: "Synced" | "Pending" | "Failed" | null
}

type EventsResponse = {
  oauthConfigured: boolean
  connected: boolean
  email: string | null
  events: CalendarEvent[]
  error?: string
}

const IST = "Asia/Kolkata"
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]

/** Per-source theming so aggregated events are instantly distinguishable. */
const SOURCE_META: Record<SourceModule, { label: string; dot: string; chip: string }> = {
  sales: { label: "Sales", dot: "bg-blue-500", chip: "bg-blue-500/10 text-blue-600 dark:text-blue-400" },
  operations: {
    label: "Operations",
    dot: "bg-amber-500",
    chip: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  },
  recruitment: {
    label: "Recruitment",
    dot: "bg-violet-500",
    chip: "bg-violet-500/10 text-violet-600 dark:text-violet-400",
  },
  hr: { label: "HR", dot: "bg-emerald-500", chip: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" },
  events: { label: "Events", dot: "bg-rose-500", chip: "bg-rose-500/10 text-rose-600 dark:text-rose-400" },
  google: { label: "Personal", dot: "bg-muted-foreground", chip: "bg-muted text-muted-foreground" },
}

const ALL_SOURCES = Object.keys(SOURCE_META) as SourceModule[]

function sourceOf(e: CalendarEvent): SourceModule {
  return e.sourceModule ?? "google"
}

/** YYYY-MM-DD key for an event, evaluated in IST so days line up with the grid. */
function dateKey(iso: string) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10)
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: IST,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d)
}

function timeLabel(iso: string) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ""
  return new Intl.DateTimeFormat("en-US", {
    timeZone: IST,
    hour: "numeric",
    minute: "2-digit",
  }).format(d)
}

function localKey(date: Date) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, "0")
  const d = String(date.getDate()).padStart(2, "0")
  return `${y}-${m}-${d}`
}

/** Monday-first offset for a JS weekday (Sun=0 → 6, Mon=1 → 0). */
function mondayOffset(day: number) {
  return (day + 6) % 7
}

export function CalendarClient({ name, description }: { name: string; description: string }) {
  const [viewMonth, setViewMonth] = useState(() => {
    const now = new Date()
    return new Date(now.getFullYear(), now.getMonth(), 1)
  })
  const [view, setView] = useState<"month" | "list">("month")
  const [search, setSearch] = useState("")
  const [hiddenSources, setHiddenSources] = useState<Set<SourceModule>>(new Set())
  const [syncing, setSyncing] = useState(false)

  // 6-week grid window (Mon-first) that fully contains the visible month.
  const gridStart = useMemo(() => {
    const first = new Date(viewMonth.getFullYear(), viewMonth.getMonth(), 1)
    const start = new Date(first)
    start.setDate(first.getDate() - mondayOffset(first.getDay()))
    start.setHours(0, 0, 0, 0)
    return start
  }, [viewMonth])

  const gridDays = useMemo(() => {
    return Array.from({ length: 42 }, (_, i) => {
      const d = new Date(gridStart)
      d.setDate(gridStart.getDate() + i)
      return d
    })
  }, [gridStart])

  const timeMin = gridStart.toISOString()
  const timeMax = useMemo(() => {
    const end = new Date(gridStart)
    end.setDate(gridStart.getDate() + 42)
    return end.toISOString()
  }, [gridStart])

  const { data, isLoading, mutate, isValidating } = useSWR<EventsResponse>(
    `/api/calendar/events?timeMin=${encodeURIComponent(timeMin)}&timeMax=${encodeURIComponent(timeMax)}`,
    fetcher,
  )

  // Surface the OAuth redirect result (?google=...) as a toast, then clean the URL.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const status = params.get("google")
    if (!status) return
    if (status === "connected") toast.success("Google Calendar connected")
    else if (status === "notconfigured")
      toast.error("Google is not configured. Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.")
    else if (status === "noretoken") toast.error("Google did not grant access. Please try connecting again.")
    else toast.error("Could not connect your Google account")
    params.delete("google")
    const qs = params.toString()
    window.history.replaceState(null, "", window.location.pathname + (qs ? `?${qs}` : ""))
    mutate()
  }, [mutate])

  async function disconnect() {
    await fetch("/api/sales/google/disconnect", { method: "POST" })
    toast.success("Google Calendar disconnected")
    mutate()
  }

  async function runSync() {
    setSyncing(true)
    try {
      const res = await fetch("/api/calendar/sync", { method: "POST" })
      const json = await res.json()
      if (json?.success) {
        const t = json.totals ?? { synced: 0, failed: 0, retried: 0 }
        if (t.retried === 0) toast.success("Everything is up to date")
        else if (t.failed === 0) toast.success(`Synced ${t.synced} event${t.synced === 1 ? "" : "s"}`)
        else toast.warning(`Synced ${t.synced}, ${t.failed} still failing`)
      } else {
        toast.error("Sync could not complete")
      }
    } catch {
      toast.error("Sync could not complete")
    } finally {
      setSyncing(false)
      mutate()
    }
  }

  function toggleSource(src: SourceModule) {
    setHiddenSources((prev) => {
      const next = new Set(prev)
      if (next.has(src)) next.delete(src)
      else next.add(src)
      return next
    })
  }

  const oauthConfigured = data?.oauthConfigured ?? true
  const connected = Boolean(data?.connected)
  const syncFailed = data?.error === "sync_failed"

  const filteredEvents = useMemo(() => {
    const events = data?.events ?? []
    const q = search.trim().toLowerCase()
    return events.filter((e) => {
      if (hiddenSources.has(sourceOf(e))) return false
      if (!q) return true
      return [e.title, e.location, e.description]
        .filter(Boolean)
        .some((v) => v!.toLowerCase().includes(q))
    })
  }, [data?.events, search, hiddenSources])

  const sourceCounts = useMemo(() => {
    const counts = new Map<SourceModule, number>()
    for (const e of data?.events ?? []) {
      const src = sourceOf(e)
      counts.set(src, (counts.get(src) ?? 0) + 1)
    }
    return counts
  }, [data?.events])

  const eventsByDay = useMemo(() => {
    const map = new Map<string, CalendarEvent[]>()
    for (const e of filteredEvents) {
      const key = dateKey(e.start)
      const list = map.get(key)
      if (list) list.push(e)
      else map.set(key, [e])
    }
    return map
  }, [filteredEvents])

  const todayKey = localKey(new Date())
  const monthIndex = viewMonth.getMonth()

  return (
    <main className="flex flex-col gap-6 p-6 md:p-8">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="flex size-10 items-center justify-center rounded-md bg-primary/10 text-primary">
            <CalendarDays className="size-5" />
          </div>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">{name}</h1>
            <p className="text-sm text-muted-foreground">{description}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => mutate()} disabled={isValidating}>
            <RefreshCw className={`mr-2 size-4 ${isValidating ? "animate-spin" : ""}`} />
            Refresh
          </Button>
          <Button variant="outline" size="sm" onClick={runSync} disabled={syncing}>
            <RefreshCw className={`mr-2 size-4 ${syncing ? "animate-spin" : ""}`} />
            Sync now
          </Button>
        </div>
      </header>

      {oauthConfigured && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-card px-4 py-3">
          <div className="flex items-start gap-2 text-sm">
            <Video className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            {connected ? (
              <span>
                Google Calendar connected as <span className="font-medium">{data?.email}</span>. Your events sync
                live below.
              </span>
            ) : (
              <span className="text-muted-foreground">
                Connect your Google account to sync your personal calendar. Each employee connects their own account.
              </span>
            )}
          </div>
          {connected ? (
            <Button variant="outline" size="sm" onClick={disconnect}>
              Disconnect
            </Button>
          ) : (
            <Button
              size="sm"
              onClick={() =>
                (window.location.href = "/api/sales/google/connect?return=/modules/calendar")
              }
            >
              Connect Google Calendar
            </Button>
          )}
        </div>
      )}

      {!oauthConfigured && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          Google is not configured. Add the GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET environment variables to enable
          calendar sync.
        </div>
      )}

      {syncFailed && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          Could not sync your Google Calendar. Try reconnecting your account.
        </div>
      )}

      <Card>
        <CardContent className="p-4 md:p-6">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="icon"
                aria-label="Previous month"
                onClick={() => setViewMonth(new Date(viewMonth.getFullYear(), monthIndex - 1, 1))}
              >
                <ChevronLeft className="size-4" />
              </Button>
              <Button
                variant="outline"
                size="icon"
                aria-label="Next month"
                onClick={() => setViewMonth(new Date(viewMonth.getFullYear(), monthIndex + 1, 1))}
              >
                <ChevronRight className="size-4" />
              </Button>
              <Button
                variant="outline"
                onClick={() => {
                  const now = new Date()
                  setViewMonth(new Date(now.getFullYear(), now.getMonth(), 1))
                }}
              >
                Today
              </Button>
            </div>
            <strong className="text-base">
              {viewMonth.toLocaleString("en-US", { month: "long", year: "numeric" })}
            </strong>
            <div className="flex w-full flex-wrap items-center gap-1.5 sm:w-auto">
              {ALL_SOURCES.filter((src) => (sourceCounts.get(src) ?? 0) > 0).map((src) => {
                const meta = SOURCE_META[src]
                const hidden = hiddenSources.has(src)
                return (
                  <button
                    key={src}
                    type="button"
                    onClick={() => toggleSource(src)}
                    aria-pressed={!hidden}
                    className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition ${
                      hidden ? "border-border text-muted-foreground opacity-60" : `border-transparent ${meta.chip}`
                    }`}
                  >
                    <span className={`size-2 rounded-full ${meta.dot}`} />
                    {meta.label}
                    <span className="tabular-nums opacity-70">{sourceCounts.get(src)}</span>
                  </button>
                )
              })}
            </div>
            <div className="flex items-center gap-3">
              <div className="relative hidden sm:block">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  placeholder="Search events..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="w-48 pl-8"
                />
              </div>
              <div className="flex">
                <Button
                  variant={view === "month" ? "default" : "outline"}
                  className="rounded-r-none"
                  onClick={() => setView("month")}
                >
                  Month
                </Button>
                <Button
                  variant={view === "list" ? "default" : "outline"}
                  className="rounded-l-none border-l-0"
                  onClick={() => setView("list")}
                >
                  List
                </Button>
              </div>
            </div>
          </div>

          {!connected ? (
            <div className="mt-8 flex flex-col items-center gap-3 py-16 text-center text-sm text-muted-foreground">
              <CalendarDays className="size-9" />
              <p>Connect your Google account to see your calendar events here.</p>
            </div>
          ) : view === "month" ? (
            <div className="mt-6 grid grid-cols-7 gap-px overflow-hidden rounded-md border border-border bg-border text-sm">
              {WEEKDAYS.map((day) => (
                <div key={day} className="bg-muted p-2 text-center font-medium text-muted-foreground">
                  {day}
                </div>
              ))}
              {gridDays.map((day) => {
                const key = localKey(day)
                const dayEvents = eventsByDay.get(key) ?? []
                const inMonth = day.getMonth() === monthIndex
                const isToday = key === todayKey
                return (
                  <div
                    key={key}
                    className={`min-h-24 bg-card p-2 ${inMonth ? "" : "opacity-40"}`}
                  >
                    <span
                      className={`inline-flex size-6 items-center justify-center rounded-full text-xs ${
                        isToday ? "bg-primary font-semibold text-primary-foreground" : "text-muted-foreground"
                      }`}
                    >
                      {day.getDate()}
                    </span>
                    <div className="mt-1 flex flex-col gap-1">
                      {dayEvents.slice(0, 3).map((e) => {
                        const meta = SOURCE_META[sourceOf(e)]
                        const link = e.href ?? e.htmlLink ?? undefined
                        return (
                          <a
                            key={e.id}
                            href={link}
                            target={link?.startsWith("http") ? "_blank" : undefined}
                            rel="noreferrer"
                            className={`flex items-center gap-1 truncate rounded px-1.5 py-0.5 text-xs font-medium hover:opacity-80 ${meta.chip}`}
                            title={`${meta.label}: ${e.title}`}
                          >
                            <span className={`size-1.5 shrink-0 rounded-full ${meta.dot}`} />
                            {!e.allDay && <span className="tabular-nums">{timeLabel(e.start)}</span>}
                            <span className="truncate">{e.title}</span>
                          </a>
                        )
                      })}
                      {dayEvents.length > 3 && (
                        <span className="px-1.5 text-xs text-muted-foreground">+{dayEvents.length - 3} more</span>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          ) : (
            <div className="mt-6 flex flex-col gap-2">
              {isLoading && <p className="py-10 text-center text-sm text-muted-foreground">Loading events...</p>}
              {!isLoading && filteredEvents.length === 0 && (
                <div className="flex flex-col items-center gap-3 py-16 text-center text-sm text-muted-foreground">
                  <CalendarDays className="size-9" />
                  <p>{search ? `No events match "${search}".` : "No events in this range."}</p>
                </div>
              )}
              {[...filteredEvents]
                .sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime())
                .map((e) => (
                  <div
                    key={e.id}
                    className="flex items-center justify-between gap-4 rounded-md border border-border bg-card px-4 py-3"
                  >
                    <div className="flex min-w-0 items-start gap-3">
                      <span
                        className={`mt-1.5 size-2.5 shrink-0 rounded-full ${SOURCE_META[sourceOf(e)].dot}`}
                        aria-hidden
                      />
                      <div className="flex min-w-0 flex-col">
                        <span className="truncate font-medium">{e.title}</span>
                        <span className="text-xs text-muted-foreground">
                          {new Date(e.start).toLocaleDateString("en-GB", { timeZone: IST })}
                          {!e.allDay && ` · ${timeLabel(e.start)}`}
                          {e.location ? ` · ${e.location}` : ""}
                          {e.category ? ` · ${e.category}` : ""}
                        </span>
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <Badge variant="outline" className="hidden sm:inline-flex">
                        {SOURCE_META[sourceOf(e)].label}
                      </Badge>
                      {e.googleSyncStatus === "Failed" && (
                        <Badge variant="destructive">Sync failed</Badge>
                      )}
                      {e.googleSyncStatus === "Pending" && <Badge variant="secondary">Pending</Badge>}
                      {e.allDay && <Badge variant="secondary">All day</Badge>}
                      {e.hangoutLink && (
                        <a
                          href={e.hangoutLink}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                        >
                          <Video className="size-3.5" />
                          Meet
                        </a>
                      )}
                      {e.htmlLink && (
                        <a
                          href={e.htmlLink}
                          target="_blank"
                          rel="noreferrer"
                          aria-label="Open in Google Calendar"
                          className="text-muted-foreground hover:text-foreground"
                        >
                          <ExternalLink className="size-4" />
                        </a>
                      )}
                    </div>
                  </div>
                ))}
            </div>
          )}
        </CardContent>
      </Card>
    </main>
  )
}
