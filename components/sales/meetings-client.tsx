"use client"

import { useEffect, useMemo, useState } from "react"
import useSWR from "swr"
import { toast } from "sonner"
import { fetcher } from "@/lib/fetcher"
import { formatDate } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { MoreHorizontal, Plus, Search, Video } from "lucide-react"
import { Checkbox } from "@/components/ui/checkbox"
import { MeetingDialog } from "@/components/sales/meeting-dialog"
import { MeetingDetailDrawer } from "@/components/sales/meeting-detail-drawer"
import { ExcelExportButton } from "@/components/excel-export-button"
import { ImportButton } from "@/components/import-button"
import { SelectAllCheckbox, SelectionToolbar, useDeleteManager, useRowSelection } from "@/components/sales/bulk-delete"
import { MEETING_TYPES, MEETING_STATUSES, type MeetingRow, type MeetingStatus } from "@/lib/sales/meeting-types"

// Re-exported for callers that still import the row shape from this module.
export type { MeetingRow } from "@/lib/sales/meeting-types"

type TeamUser = { id: number; name: string }

const QUICK_VIEWS = [
  { value: "all", label: "All" },
  { value: "today", label: "Today" },
  { value: "upcoming", label: "Upcoming" },
  { value: "past", label: "Past" },
  { value: "completed", label: "Completed" },
  { value: "cancelled", label: "Cancelled" },
] as const

const STATUS_STYLE: Record<MeetingStatus, string> = {
  Scheduled: "border-blue-500/30 bg-blue-500/10 text-blue-600 dark:text-blue-400",
  Completed: "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  Cancelled: "border-muted-foreground/30 bg-muted text-muted-foreground",
  "No Show": "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400",
}

const ANY = "__any__"

// Maps a quick view to the server query params it drives.
function viewParams(view: string): Record<string, string> {
  switch (view) {
    case "today":
      return { scope: "today" }
    case "upcoming":
      return { scope: "upcoming" }
    case "past":
      return { scope: "past" }
    case "completed":
      return { status: "Completed" }
    case "cancelled":
      return { status: "Cancelled" }
    default:
      return {}
  }
}

export function MeetingsClient({ canManage }: { canManage: boolean }) {
  const [view, setView] = useState<string>("all")
  const [search, setSearch] = useState("")
  const [debouncedSearch, setDebouncedSearch] = useState("")
  const [statusFilter, setStatusFilter] = useState<string>(ANY)
  const [typeFilter, setTypeFilter] = useState<string>(ANY)
  const [ownerFilter, setOwnerFilter] = useState<string>(ANY)

  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<MeetingRow | null>(null)
  const [detailId, setDetailId] = useState<number | null>(null)
  const [detailOpen, setDetailOpen] = useState(false)

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search.trim()), 300)
    return () => clearTimeout(t)
  }, [search])

  // Build the server query string from quick view + explicit filters.
  const queryKey = useMemo(() => {
    const params = new URLSearchParams(viewParams(view))
    if (statusFilter !== ANY && !params.has("status")) params.set("status", statusFilter)
    if (typeFilter !== ANY) params.set("type", typeFilter)
    if (ownerFilter !== ANY) params.set("owner", ownerFilter)
    if (debouncedSearch) params.set("search", debouncedSearch)
    const qs = params.toString()
    return `/api/sales/meetings${qs ? `?${qs}` : ""}`
  }, [view, statusFilter, typeFilter, ownerFilter, debouncedSearch])

  const { data, isLoading, mutate } = useSWR<{
    meetings: MeetingRow[]
    googleConfigured: boolean
    googleConnected: boolean
  }>(queryKey, fetcher)
  const { data: teamData } = useSWR<{ users: TeamUser[] }>("/api/sales/team", fetcher)

  const { data: google, mutate: mutateGoogle } = useSWR<{
    oauthConfigured: boolean
    connected: boolean
    email: string | null
  }>("/api/sales/google/status", fetcher)

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const status = params.get("google")
    if (!status) return
    if (status === "connected") toast.success("Google account connected")
    else if (status === "notconfigured")
      toast.error("Google is not configured. Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.")
    else if (status === "noretoken") toast.error("Google did not grant access. Please try connecting again.")
    else toast.error("Could not connect your Google account")
    params.delete("google")
    const qs = params.toString()
    window.history.replaceState(null, "", window.location.pathname + (qs ? `?${qs}` : ""))
    mutateGoogle()
  }, [mutateGoogle])

  async function disconnectGoogle() {
    await fetch("/api/sales/google/disconnect", { method: "POST" })
    toast.success("Google account disconnected")
    mutateGoogle()
  }

  const meetings = data?.meetings ?? []
  const team = teamData?.users ?? []

  const { selected, toggle, toggleAll, clear } = useRowSelection()
  const del = useDeleteManager({
    endpoint: (id) => `/api/sales/meetings/${id}`,
    labels: { singular: "meeting", plural: "meetings" },
    mutate,
    onDeleted: clear,
  })

  function openCreate() {
    setEditing(null)
    setDialogOpen(true)
  }

  function openEdit(meeting: MeetingRow) {
    setEditing(meeting)
    setDialogOpen(true)
    setDetailOpen(false)
  }

  function openDetail(id: number) {
    setDetailId(id)
    setDetailOpen(true)
  }

  // Fire a lifecycle action straight from the row menu (no extra input needed).
  async function quickAction(id: number, action: "no_show" | "sync_google") {
    const res = await fetch(`/api/sales/meetings/${id}/action`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) {
      toast.error(body.error || "Action failed")
      return
    }
    toast.success(action === "no_show" ? "Marked as no show" : "Re-synced with Google")
    mutate()
  }

  const filtersActive = statusFilter !== ANY || typeFilter !== ANY || ownerFilter !== ANY || debouncedSearch !== ""

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Tabs value={view} onValueChange={(v) => setView(v as string)}>
          <TabsList>
            {QUICK_VIEWS.map((q) => (
              <TabsTrigger key={q.value} value={q.value}>
                {q.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <div className="flex items-center gap-2">
          {canManage && <ImportButton moduleKey="sales-meetings" onImported={() => mutate()} />}
          <ExcelExportButton
            rows={meetings}
            filename="meetings"
            columns={[
              { header: "Meeting Code", value: (r) => r.meeting_code },
              { header: "Date", value: (r) => r.meeting_date },
              { header: "Time", value: (r) => r.meeting_time },
              { header: "Status", value: (r) => r.status },
              { header: "Company", value: (r) => r.company_name },
              { header: "Contact Person", value: (r) => r.contact_person },
              { header: "Type", value: (r) => r.meeting_type },
              { header: "Owner", value: (r) => r.owner_name },
              { header: "Outcome", value: (r) => r.outcome },
              { header: "Next Steps", value: (r) => r.next_steps },
            ]}
          />
          {canManage && (
            <Button onClick={openCreate}>
              <Plus data-icon="inline-start" />
              Schedule meeting
            </Button>
          )}
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search meetings..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-56 pl-8"
          />
        </div>
        <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v ?? ANY)}>
          <SelectTrigger className="w-36">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value={ANY}>All statuses</SelectItem>
              {MEETING_STATUSES.map((s) => (
                <SelectItem key={s} value={s}>
                  {s}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        <Select value={typeFilter} onValueChange={(v) => setTypeFilter(v ?? ANY)}>
          <SelectTrigger className="w-36">
            <SelectValue placeholder="Type" />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value={ANY}>All types</SelectItem>
              {MEETING_TYPES.map((t) => (
                <SelectItem key={t} value={t}>
                  {t}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        <Select value={ownerFilter} onValueChange={(v) => setOwnerFilter(v ?? ANY)}>
          <SelectTrigger className="w-40">
            <SelectValue placeholder="Owner" />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value={ANY}>All owners</SelectItem>
              {team.map((u) => (
                <SelectItem key={u.id} value={String(u.id)}>
                  {u.name}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        {filtersActive && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setStatusFilter(ANY)
              setTypeFilter(ANY)
              setOwnerFilter(ANY)
              setSearch("")
            }}
          >
            Clear
          </Button>
        )}
      </div>

      {canManage && google?.oauthConfigured && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-card px-4 py-3">
          <div className="flex items-start gap-2 text-sm">
            <Video className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            {google.connected ? (
              <span>
                Google connected as <span className="font-medium">{google.email}</span>. New meetings create a Meet
                link and email invitations from your account.
              </span>
            ) : (
              <span className="text-muted-foreground">
                Connect your Google account to schedule Meet calls and auto-send invitations to attendees.
              </span>
            )}
          </div>
          {google.connected ? (
            <Button variant="outline" size="sm" onClick={disconnectGoogle}>
              Disconnect
            </Button>
          ) : (
            <Button size="sm" onClick={() => (window.location.href = "/api/sales/google/connect")}>
              Connect Google
            </Button>
          )}
        </div>
      )}

      {canManage && (
        <SelectionToolbar
          count={selected.size}
          noun="meeting"
          onClear={clear}
          onDelete={() => del.requestBulk(Array.from(selected))}
        />
      )}

      <div className="rounded-md border border-border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              {canManage && (
                <TableHead className="w-10">
                  <SelectAllCheckbox ids={meetings.map((m) => m.id)} selected={selected} onToggleAll={toggleAll} />
                </TableHead>
              )}
              <TableHead>Date</TableHead>
              <TableHead>Company</TableHead>
              <TableHead>Contact</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Owner</TableHead>
              {canManage && <TableHead className="w-10 text-right">Actions</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading && (
              <TableRow>
                <TableCell colSpan={8} className="py-10 text-center text-sm text-muted-foreground">
                  Loading meetings...
                </TableCell>
              </TableRow>
            )}
            {!isLoading && meetings.length === 0 && (
              <TableRow>
                <TableCell colSpan={8} className="py-10 text-center text-sm text-muted-foreground">
                  No meetings found.
                </TableCell>
              </TableRow>
            )}
            {meetings.map((meeting) => (
              <TableRow
                key={meeting.id}
                data-state={selected.has(meeting.id) ? "selected" : undefined}
                className="cursor-pointer"
                onClick={() => openDetail(meeting.id)}
              >
                {canManage && (
                  <TableCell onClick={(e) => e.stopPropagation()}>
                    <Checkbox
                      aria-label={`Select meeting ${meeting.meeting_code}`}
                      checked={selected.has(meeting.id)}
                      onCheckedChange={() => toggle(meeting.id)}
                    />
                  </TableCell>
                )}
                <TableCell>
                  <div className="flex flex-col">
                    <span className="flex items-center gap-1.5 font-medium">
                      {formatDate(meeting.meeting_date)}
                      {meeting.meet_link && <Video className="size-3.5 text-muted-foreground" />}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {meeting.meeting_time || "—"} · {meeting.meeting_code}
                    </span>
                  </div>
                </TableCell>
                <TableCell>{meeting.company_name || "—"}</TableCell>
                <TableCell className="text-muted-foreground">{meeting.contact_person || "—"}</TableCell>
                <TableCell>
                  <Badge variant="secondary">{meeting.meeting_type}</Badge>
                </TableCell>
                <TableCell>
                  <Badge variant="outline" className={STATUS_STYLE[meeting.status]}>
                    {meeting.status}
                  </Badge>
                </TableCell>
                <TableCell className="text-muted-foreground">{meeting.owner_name || "—"}</TableCell>
                {canManage && (
                  <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                    <DropdownMenu>
                      <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label="Actions" />}>
                        <MoreHorizontal className="size-4" />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => openDetail(meeting.id)}>View details</DropdownMenuItem>
                        <DropdownMenuItem onClick={() => openEdit(meeting)}>Edit meeting</DropdownMenuItem>
                        {meeting.status === "Scheduled" && (
                          <DropdownMenuItem onClick={() => quickAction(meeting.id, "no_show")}>
                            Mark no show
                          </DropdownMenuItem>
                        )}
                        {(meeting.status === "Cancelled" || meeting.google_sync_status === "Failed") && (
                          <DropdownMenuItem onClick={() => quickAction(meeting.id, "sync_google")}>
                            Sync Google
                          </DropdownMenuItem>
                        )}
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          variant="destructive"
                          onClick={() => del.requestSingle(meeting.id, `meeting ${meeting.meeting_code}`)}
                        >
                          Archive meeting
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <MeetingDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        meeting={editing}
        googleConfigured={Boolean(google?.oauthConfigured)}
        googleConnected={Boolean(google?.connected)}
        onSaved={() => {
          setDialogOpen(false)
          toast.success(editing ? "Meeting updated" : "Meeting scheduled")
          mutate()
        }}
      />

      <MeetingDetailDrawer
        meetingId={detailId}
        open={detailOpen}
        onOpenChange={setDetailOpen}
        onEdit={openEdit}
        onChanged={() => mutate()}
      />

      {del.dialog}
    </div>
  )
}
