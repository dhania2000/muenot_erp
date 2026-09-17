"use client"

import { useMemo, useState } from "react"
import useSWR from "swr"
import { toast } from "sonner"
import { fetcher } from "@/lib/fetcher"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Separator } from "@/components/ui/separator"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { formatDate, formatTime, type BadgeVariant } from "@/lib/attendance-ui"
import {
  MonitorPlay,
  ShieldAlert,
  Download,
  Trash2,
  RefreshCw,
  Search,
  Loader2,
  ImageOff,
  Settings2,
  Activity,
  Camera,
  CircleAlert,
  ChevronLeft,
  ChevronRight,
} from "lucide-react"

const ALL = "__all__"
const MONITORING_STATUSES = ["Active", "Stopped", "Completed", "Permission Denied", "Failed", "Stale"]

type SessionRow = {
  id: number
  session_id: string
  employee_id: number
  employee_name: string
  attendance_ref: string | null
  work_date: string | null
  started_at: string | null
  stopped_at: string | null
  duration_seconds: number | null
  status: string
  permission_status: string | null
  capture_count: number
  last_capture_at: string | null
  source_type: string | null
  browser: string | null
  os: string | null
}

type Screenshot = {
  id: number
  screenshot_id: string
  capture_sequence: number
  captured_at: string | null
  source_type: string | null
  file_size: number | null
  file_mime: string | null
  width: number | null
  height: number | null
  upload_status: string | null
  has_data: boolean
}

type SummaryResponse = {
  totals: {
    totalSessions: number
    activeNow: number
    denied: number
    failed: number
    totalCaptures: number
    sessionsToday: number
  }
  settings: {
    enabled: boolean
    retentionDays: number
    captureIntervalSeconds: number
    imageQuality: number
    maxWidth: number
    staleAfterMinutes: number
  }
}

type SessionsResponse = {
  sessions: SessionRow[]
  pagination: { page: number; pageSize: number; total: number; totalPages: number }
  scope: string
}

type SettingsResponse = {
  settings: {
    enabled: boolean
    retention_days: number
    image_quality: number
    capture_interval_seconds: number
    max_width: number
    stale_after_minutes: number
    [key: string]: unknown
  }
  retentionChoices: number[]
}

function statusVariant(status: string | null | undefined): BadgeVariant {
  switch (status) {
    case "Active":
      return "default"
    case "Completed":
    case "Stopped":
      return "secondary"
    case "Permission Denied":
    case "Failed":
      return "destructive"
    case "Stale":
      return "outline"
    default:
      return "secondary"
  }
}

function formatDuration(seconds: number | null | undefined): string {
  const s = Math.round(Number(seconds || 0))
  if (s <= 0) return "—"
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${s % 60}s`
  return `${s}s`
}

export function ScreenMonitoringClient() {
  const { data: me } = useSWR<{ user: { role: string } | null }>("/api/auth/session", fetcher)
  const isAdmin = me?.user?.role === "admin"

  return (
    <div className="flex flex-col gap-6 p-4 md:p-6">
      <header className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <MonitorPlay className="h-6 w-6 text-primary" aria-hidden="true" />
          <h1 className="text-2xl font-semibold tracking-tight">Screen Activity Monitoring</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          Review captured work sessions, inspect screenshot timelines, and manage capture settings and retention.
        </p>
      </header>

      <Tabs defaultValue="live" className="w-full">
        <TabsList>
          <TabsTrigger value="live" className="gap-1.5">
            <Radio className="h-4 w-4" aria-hidden="true" />
            Live Employees
          </TabsTrigger>
          <TabsTrigger value="sessions" className="gap-1.5">
            <Activity className="h-4 w-4" aria-hidden="true" />
            Sessions
          </TabsTrigger>
          <TabsTrigger value="settings" className="gap-1.5">
            <Settings2 className="h-4 w-4" aria-hidden="true" />
            Settings
          </TabsTrigger>
        </TabsList>

        <TabsContent value="live" className="mt-6">
          <LiveEmployeesPanel />
        </TabsContent>
        <TabsContent value="sessions" className="mt-6">
          <SessionsPanel isAdmin={isAdmin} />
        </TabsContent>
        <TabsContent value="settings" className="mt-6">
          <SettingsPanel />
        </TabsContent>
      </Tabs>
    </div>
  )
}

function SummaryCards() {
  const { data } = useSWR<SummaryResponse>("/api/hr/screen-monitoring/summary", fetcher)
  const t = data?.totals

  const cards = [
    { label: "Total Sessions", value: t?.totalSessions ?? 0, icon: MonitorPlay, tone: "text-foreground" },
    { label: "Active Now", value: t?.activeNow ?? 0, icon: Activity, tone: "text-emerald-600 dark:text-emerald-400" },
    { label: "Sessions Today", value: t?.sessionsToday ?? 0, icon: Camera, tone: "text-foreground" },
    { label: "Total Captures", value: t?.totalCaptures ?? 0, icon: Camera, tone: "text-foreground" },
    { label: "Permission Denied", value: t?.denied ?? 0, icon: ShieldAlert, tone: "text-amber-600 dark:text-amber-400" },
    { label: "Failed", value: t?.failed ?? 0, icon: CircleAlert, tone: "text-destructive" },
  ]

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
      {cards.map((c) => {
        const Icon = c.icon
        return (
          <Card key={c.label}>
            <CardContent className="flex flex-col gap-1 p-4">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-muted-foreground">{c.label}</span>
                <Icon className={`h-4 w-4 ${c.tone}`} aria-hidden="true" />
              </div>
              <span className={`text-2xl font-semibold tabular-nums ${c.tone}`}>{c.value.toLocaleString()}</span>
            </CardContent>
          </Card>
        )
      })}
    </div>
  )
}

function SessionsPanel({ isAdmin }: { isAdmin: boolean }) {
  const [employeeId, setEmployeeId] = useState<string>(ALL)
  const [status, setStatus] = useState<string>(ALL)
  const [from, setFrom] = useState("")
  const [to, setTo] = useState("")
  const [search, setSearch] = useState("")
  const [page, setPage] = useState(1)
  const [openSession, setOpenSession] = useState<SessionRow | null>(null)
  const [exporting, setExporting] = useState(false)

  const { data: employeesData } = useSWR<{ employees: { id: number; employee_name: string; employee_id: string }[] }>(
    "/api/hr/employees?facets=1",
    fetcher,
  )

  const params = useMemo(() => {
    const p = new URLSearchParams()
    if (employeeId !== ALL) p.set("employeeId", employeeId)
    if (status !== ALL) p.set("status", status)
    if (from) p.set("from", from)
    if (to) p.set("to", to)
    if (search.trim()) p.set("q", search.trim())
    p.set("page", String(page))
    p.set("pageSize", "25")
    return p.toString()
  }, [employeeId, status, from, to, search, page])

  const { data, isLoading, mutate } = useSWR<SessionsResponse>(
    `/api/hr/screen-monitoring/sessions?${params}`,
    fetcher,
    { keepPreviousData: true },
  )

  const sessions = data?.sessions ?? []
  const pagination = data?.pagination

  async function handleExport() {
    setExporting(true)
    try {
      const p = new URLSearchParams()
      if (status !== ALL) p.set("status", status)
      if (from) p.set("from", from)
      if (to) p.set("to", to)
      const res = await fetch(`/api/hr/screen-monitoring/export?${p.toString()}`)
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error || "Export failed")
      }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = `screen-monitoring-${new Date().toISOString().slice(0, 10)}.csv`
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
      toast.success("Export downloaded")
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Export failed")
    } finally {
      setExporting(false)
    }
  }

  function resetFilters() {
    setEmployeeId(ALL)
    setStatus(ALL)
    setFrom("")
    setTo("")
    setSearch("")
    setPage(1)
  }

  return (
    <div className="flex flex-col gap-4">
      <SummaryCards />

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Session Log</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="mon-emp" className="text-xs">
                Employee
              </Label>
              <Select
                value={employeeId}
                onValueChange={(v) => {
                  setEmployeeId(v)
                  setPage(1)
                }}
              >
                <SelectTrigger id="mon-emp" className="w-48">
                  <SelectValue placeholder="All employees" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>All employees</SelectItem>
                  {employeesData?.employees?.map((e) => (
                    <SelectItem key={e.id} value={String(e.id)}>
                      {e.employee_name} ({e.employee_id})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="mon-status" className="text-xs">
                Status
              </Label>
              <Select
                value={status}
                onValueChange={(v) => {
                  setStatus(v)
                  setPage(1)
                }}
              >
                <SelectTrigger id="mon-status" className="w-44">
                  <SelectValue placeholder="All statuses" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>All statuses</SelectItem>
                  {MONITORING_STATUSES.map((s) => (
                    <SelectItem key={s} value={s}>
                      {s}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="mon-from" className="text-xs">
                From
              </Label>
              <Input
                id="mon-from"
                type="date"
                value={from}
                onChange={(e) => {
                  setFrom(e.target.value)
                  setPage(1)
                }}
                className="w-40"
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="mon-to" className="text-xs">
                To
              </Label>
              <Input
                id="mon-to"
                type="date"
                value={to}
                onChange={(e) => {
                  setTo(e.target.value)
                  setPage(1)
                }}
                className="w-40"
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="mon-search" className="text-xs">
                Search
              </Label>
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" aria-hidden="true" />
                <Input
                  id="mon-search"
                  placeholder="Employee, session, ref"
                  value={search}
                  onChange={(e) => {
                    setSearch(e.target.value)
                    setPage(1)
                  }}
                  className="w-56 pl-8"
                />
              </div>
            </div>

            <div className="ml-auto flex items-center gap-2">
              <Button variant="ghost" size="sm" onClick={resetFilters}>
                Reset
              </Button>
              <Button variant="outline" size="sm" onClick={() => mutate()} className="gap-1.5">
                <RefreshCw className="h-4 w-4" aria-hidden="true" />
                Refresh
              </Button>
              <Button variant="outline" size="sm" onClick={handleExport} disabled={exporting} className="gap-1.5">
                {exporting ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Download className="h-4 w-4" aria-hidden="true" />}
                Export CSV
              </Button>
            </div>
          </div>

          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Employee</TableHead>
                  <TableHead>Work Date</TableHead>
                  <TableHead>Started</TableHead>
                  <TableHead>Stopped</TableHead>
                  <TableHead>Duration</TableHead>
                  <TableHead className="text-right">Captures</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Environment</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading && sessions.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={8} className="h-24 text-center text-muted-foreground">
                      <Loader2 className="mx-auto h-5 w-5 animate-spin" aria-hidden="true" />
                    </TableCell>
                  </TableRow>
                ) : sessions.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={8} className="h-24 text-center text-muted-foreground">
                      No monitoring sessions match the current filters.
                    </TableCell>
                  </TableRow>
                ) : (
                  sessions.map((s) => (
                    <TableRow
                      key={s.id}
                      className="cursor-pointer"
                      onClick={() => setOpenSession(s)}
                    >
                      <TableCell>
                        <div className="flex flex-col">
                          <span className="font-medium">{s.employee_name}</span>
                          <span className="text-xs text-muted-foreground">{s.session_id}</span>
                        </div>
                      </TableCell>
                      <TableCell className="whitespace-nowrap">{formatDate(s.work_date)}</TableCell>
                      <TableCell className="whitespace-nowrap">{formatTime(s.started_at)}</TableCell>
                      <TableCell className="whitespace-nowrap">{formatTime(s.stopped_at)}</TableCell>
                      <TableCell className="whitespace-nowrap tabular-nums">{formatDuration(s.duration_seconds)}</TableCell>
                      <TableCell className="text-right tabular-nums">{s.capture_count}</TableCell>
                      <TableCell>
                        <Badge variant={statusVariant(s.status)}>{s.status}</Badge>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {[s.browser, s.os].filter(Boolean).join(" · ") || "—"}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>

          {pagination && pagination.total > 0 && (
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground">
                Page {pagination.page} of {pagination.totalPages} · {pagination.total.toLocaleString()} sessions
              </span>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={pagination.page <= 1}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  className="gap-1"
                >
                  <ChevronLeft className="h-4 w-4" aria-hidden="true" />
                  Prev
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={pagination.page >= pagination.totalPages}
                  onClick={() => setPage((p) => p + 1)}
                  className="gap-1"
                >
                  Next
                  <ChevronRight className="h-4 w-4" aria-hidden="true" />
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <SessionDetailDialog
        session={openSession}
        isAdmin={isAdmin}
        onOpenChange={(open) => {
          if (!open) setOpenSession(null)
        }}
        onChanged={() => mutate()}
      />
    </div>
  )
}

function SessionDetailDialog({
  session,
  isAdmin,
  onOpenChange,
  onChanged,
}: {
  session: SessionRow | null
  isAdmin: boolean
  onOpenChange: (open: boolean) => void
  onChanged: () => void
}) {
  const { data, isLoading, mutate } = useSWR<{ session: SessionRow & { user_id: number }; screenshots: Screenshot[] }>(
    session ? `/api/hr/screen-monitoring/sessions/${session.id}` : null,
    fetcher,
  )
  const [preview, setPreview] = useState<Screenshot | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<Screenshot | "all" | null>(null)
  const [busy, setBusy] = useState(false)

  const screenshots = data?.screenshots ?? []
  const withData = screenshots.filter((s) => s.has_data)

  async function performDelete() {
    if (!session || !deleteTarget) return
    setBusy(true)
    try {
      const q = deleteTarget === "all" ? "" : `?screenshotId=${encodeURIComponent(deleteTarget.screenshot_id)}`
      const res = await fetch(`/api/hr/screen-monitoring/sessions/${session.id}${q}`, { method: "DELETE" })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error || "Delete failed")
      }
      toast.success(deleteTarget === "all" ? "All screenshots purged" : "Screenshot purged")
      setDeleteTarget(null)
      setPreview(null)
      await mutate()
      onChanged()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Delete failed")
    } finally {
      setBusy(false)
    }
  }

  async function downloadShot(shot: Screenshot) {
    try {
      const res = await fetch(`/api/hr/screen-monitoring/screenshot/file?id=${encodeURIComponent(shot.screenshot_id)}&download=1`)
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error || "Download failed")
      }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = `${shot.screenshot_id}.jpg`
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Download failed")
    }
  }

  return (
    <>
      <Dialog open={Boolean(session)} onOpenChange={onOpenChange}>
        <DialogContent className="max-h-[90vh] max-w-4xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <MonitorPlay className="h-5 w-5 text-primary" aria-hidden="true" />
              {session?.employee_name}
            </DialogTitle>
            <DialogDescription>
              {session?.session_id} · {formatDate(session?.work_date)}
            </DialogDescription>
          </DialogHeader>

          {session && (
            <div className="flex flex-col gap-4">
              <div className="grid grid-cols-2 gap-x-6 gap-y-2 rounded-md border bg-muted/30 p-4 text-sm sm:grid-cols-4">
                <Meta label="Status" value={<Badge variant={statusVariant(session.status)}>{session.status}</Badge>} />
                <Meta label="Permission" value={session.permission_status || "—"} />
                <Meta label="Started" value={formatTime(session.started_at)} />
                <Meta label="Stopped" value={formatTime(session.stopped_at)} />
                <Meta label="Duration" value={formatDuration(session.duration_seconds)} />
                <Meta label="Captures" value={String(session.capture_count)} />
                <Meta label="Attendance Ref" value={session.attendance_ref || "—"} />
                <Meta label="Source" value={session.source_type || "—"} />
              </div>

              <div className="flex items-center justify-between">
                <h3 className="text-sm font-medium">
                  Screenshot Timeline
                  <span className="ml-1.5 text-muted-foreground">({screenshots.length})</span>
                </h3>
                {isAdmin && withData.length > 0 && (
                  <Button variant="outline" size="sm" onClick={() => setDeleteTarget("all")} className="gap-1.5 text-destructive hover:text-destructive">
                    <Trash2 className="h-4 w-4" aria-hidden="true" />
                    Purge all bytes
                  </Button>
                )}
              </div>
              <Separator />

              {isLoading ? (
                <div className="flex h-40 items-center justify-center">
                  <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" aria-hidden="true" />
                </div>
              ) : screenshots.length === 0 ? (
                <div className="flex h-40 flex-col items-center justify-center gap-2 text-muted-foreground">
                  <ImageOff className="h-6 w-6" aria-hidden="true" />
                  <span className="text-sm">No screenshots captured for this session.</span>
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
                  {screenshots.map((shot) => (
                    <figure key={shot.id} className="group relative overflow-hidden rounded-md border">
                      {shot.has_data ? (
                        <button
                          type="button"
                          onClick={() => setPreview(shot)}
                          className="block w-full focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          aria-label={`View capture ${shot.capture_sequence}`}
                        >
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={`/api/hr/screen-monitoring/screenshot/file?id=${encodeURIComponent(shot.screenshot_id)}`}
                            alt={`Capture ${shot.capture_sequence} at ${formatTime(shot.captured_at)}`}
                            loading="lazy"
                            className="aspect-video w-full bg-muted object-cover transition-transform group-hover:scale-[1.02]"
                          />
                        </button>
                      ) : (
                        <div className="flex aspect-video w-full flex-col items-center justify-center gap-1 bg-muted text-muted-foreground">
                          <ImageOff className="h-5 w-5" aria-hidden="true" />
                          <span className="text-[10px]">Purged</span>
                        </div>
                      )}
                      <figcaption className="flex items-center justify-between gap-1 border-t bg-background px-2 py-1 text-[11px] text-muted-foreground">
                        <span className="tabular-nums">#{shot.capture_sequence}</span>
                        <span className="tabular-nums">{formatTime(shot.captured_at)}</span>
                      </figcaption>
                    </figure>
                  ))}
                </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Fullscreen preview of a single capture */}
      <Dialog open={Boolean(preview)} onOpenChange={(open) => !open && setPreview(null)}>
        <DialogContent className="max-h-[95vh] max-w-5xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              Capture #{preview?.capture_sequence} · {formatTime(preview?.captured_at)}
            </DialogTitle>
            <DialogDescription>
              {preview?.width && preview?.height ? `${preview.width}×${preview.height}` : ""}
              {preview?.file_size ? ` · ${(preview.file_size / 1024).toFixed(0)} KB` : ""}
            </DialogDescription>
          </DialogHeader>
          {preview && (
            <>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={`/api/hr/screen-monitoring/screenshot/file?id=${encodeURIComponent(preview.screenshot_id)}`}
                alt={`Capture ${preview.capture_sequence}`}
                className="w-full rounded-md border bg-muted"
              />
              <DialogFooter className="gap-2 sm:justify-between">
                {isAdmin ? (
                  <Button
                    variant="outline"
                    onClick={() => setDeleteTarget(preview)}
                    className="gap-1.5 text-destructive hover:text-destructive"
                  >
                    <Trash2 className="h-4 w-4" aria-hidden="true" />
                    Purge this capture
                  </Button>
                ) : (
                  <span />
                )}
                <Button onClick={() => downloadShot(preview)} className="gap-1.5">
                  <Download className="h-4 w-4" aria-hidden="true" />
                  Download
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      <AlertDialog open={Boolean(deleteTarget)} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {deleteTarget === "all" ? "Purge all screenshots?" : "Purge this screenshot?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              This permanently deletes the image bytes from storage. Session metadata is retained. This action is
              audited and cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault()
                performDelete()
              }}
              disabled={busy}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {busy ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" aria-hidden="true" /> : null}
              Purge
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

function Meta({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="font-medium">{value}</span>
    </div>
  )
}

function SettingsPanel() {
  const { data, mutate } = useSWR<SettingsResponse>("/api/hr/screen-monitoring/settings", fetcher)
  const [form, setForm] = useState<Record<string, number | boolean> | null>(null)
  const [saving, setSaving] = useState(false)

  const settings = data?.settings
  const retentionChoices = data?.retentionChoices ?? [7, 14, 30, 60, 90]

  // Initialize local form once settings arrive.
  const current = form ?? (settings
    ? {
        enabled: settings.enabled,
        retention_days: settings.retention_days,
        image_quality: settings.image_quality,
        capture_interval_seconds: settings.capture_interval_seconds,
        max_width: settings.max_width,
        stale_after_minutes: settings.stale_after_minutes,
      }
    : null)

  function update(key: string, value: number | boolean) {
    setForm({ ...(current as Record<string, number | boolean>), [key]: value })
  }

  async function save() {
    if (!current) return
    setSaving(true)
    try {
      const res = await fetch("/api/hr/screen-monitoring/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(current),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error || "Could not save settings")
      toast.success("Monitoring settings saved")
      setForm(null)
      await mutate()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save settings")
    } finally {
      setSaving(false)
    }
  }

  if (!current) {
    return (
      <div className="flex h-40 items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" aria-hidden="true" />
      </div>
    )
  }

  return (
    <Card className="max-w-2xl">
      <CardHeader>
        <CardTitle className="text-base">Capture &amp; Retention Settings</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <div className="flex items-center justify-between rounded-md border p-3">
          <div className="flex flex-col">
            <span className="text-sm font-medium">Monitoring enabled</span>
            <span className="text-xs text-muted-foreground">
              When off, no new sessions start when employees clock in.
            </span>
          </div>
          <Select
            value={current.enabled ? "on" : "off"}
            onValueChange={(v) => update("enabled", v === "on")}
          >
            <SelectTrigger className="w-28">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="on">Enabled</SelectItem>
              <SelectItem value="off">Disabled</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="set-interval">Capture interval (seconds)</Label>
            <Input
              id="set-interval"
              type="number"
              min={10}
              max={3600}
              value={Number(current.capture_interval_seconds)}
              onChange={(e) => update("capture_interval_seconds", Number(e.target.value))}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="set-retention">Retention window</Label>
            <Select
              value={String(current.retention_days)}
              onValueChange={(v) => update("retention_days", Number(v))}
            >
              <SelectTrigger id="set-retention">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {retentionChoices.map((d) => (
                  <SelectItem key={d} value={String(d)}>
                    {d} days
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="set-quality">Image quality (0.1 – 1.0)</Label>
            <Input
              id="set-quality"
              type="number"
              min={0.1}
              max={1}
              step={0.1}
              value={Number(current.image_quality)}
              onChange={(e) => update("image_quality", Number(e.target.value))}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="set-width">Max width (px)</Label>
            <Input
              id="set-width"
              type="number"
              min={320}
              max={3840}
              step={10}
              value={Number(current.max_width)}
              onChange={(e) => update("max_width", Number(e.target.value))}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="set-stale">Stale after (minutes)</Label>
            <Input
              id="set-stale"
              type="number"
              min={1}
              max={240}
              value={Number(current.stale_after_minutes)}
              onChange={(e) => update("stale_after_minutes", Number(e.target.value))}
            />
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Button onClick={save} disabled={saving || !form} className="gap-1.5">
            {saving ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Settings2 className="h-4 w-4" aria-hidden="true" />}
            Save settings
          </Button>
          {form && (
            <Button variant="ghost" onClick={() => setForm(null)} disabled={saving}>
              Discard changes
            </Button>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          Saving requires the settings-management grant. Retention purges run automatically via the scheduled job.
        </p>
      </CardContent>
    </Card>
  )
}
