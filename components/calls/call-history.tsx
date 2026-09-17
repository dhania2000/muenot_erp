"use client"

import { useMemo, useState } from "react"
import useSWR from "swr"
import {
  Phone,
  Video,
  PhoneIncoming,
  PhoneOutgoing,
  PhoneMissed,
  Search,
  History,
  RotateCcw,
} from "lucide-react"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { fetcher } from "@/lib/fetcher"
import { cn } from "@/lib/utils"
import { useCalls } from "./call-provider"

type CallRow = {
  id: number
  direction: "incoming" | "outgoing"
  callType: "audio" | "video"
  status: string
  startedAt: string | null
  durationSeconds: number
  projectName: string | null
  taskName: string | null
  counterpart: { employeeId: number | null; name: string; designation: string | null; photoUrl: string | null }
}

function fmtDuration(s: number) {
  if (!s) return "—"
  const m = Math.floor(s / 60)
  const sec = s % 60
  return m ? `${m}m ${sec}s` : `${sec}s`
}

function fmtWhen(v: string | null) {
  if (!v) return "—"
  const d = new Date(String(v).replace(" ", "T"))
  if (Number.isNaN(d.getTime())) return String(v)
  return d.toLocaleString()
}

function statusTone(status: string): string {
  switch (status) {
    case "ended":
      return "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
    case "missed":
    case "failed":
      return "border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-400"
    case "rejected":
    case "cancelled":
    case "busy":
      return "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400"
    default:
      return ""
  }
}

/**
 * Internal call history with search + filters and a Call Again action
 * (Phase 20/21/22/25/92). Reused by the Employee Profile "Calls" tab and
 * Employee 360. `employeeId` scopes the history to one employee's record;
 * omit it to show the current user's own history.
 */
export function CallHistory({ employeeId }: { employeeId?: number }) {
  const { permissions, startCall, activeCallId } = useCalls()
  const [q, setQ] = useState("")
  const [type, setType] = useState("all")
  const [direction, setDirection] = useState("all")
  const [status, setStatus] = useState("all")
  const [from, setFrom] = useState("")
  const [to, setTo] = useState("")

  const query = useMemo(() => {
    const p = new URLSearchParams()
    if (employeeId) p.set("employeeId", String(employeeId))
    if (q.trim()) p.set("q", q.trim())
    if (type !== "all") p.set("type", type)
    if (direction !== "all") p.set("direction", direction)
    if (status !== "all") p.set("status", status)
    if (from) p.set("from", from)
    if (to) p.set("to", to)
    return p.toString()
  }, [employeeId, q, type, direction, status, from, to])

  const { data, isLoading } = useSWR<{ calls: CallRow[] }>(`/api/calls/history?${query}`, fetcher)
  const calls = data?.calls || []
  const canCall = permissions.audio || permissions.video

  function callAgain(row: CallRow, callType: "audio" | "video") {
    if (!row.counterpart.employeeId) return
    startCall(callType, {
      employeeId: row.counterpart.employeeId,
      name: row.counterpart.name,
      origin: "history",
    })
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Filters */}
      <div className="flex flex-wrap items-end gap-2">
        <div className="relative min-w-[200px] flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search employee / code"
            className="pl-8"
            aria-label="Search call history"
          />
        </div>
        <Select value={type} onValueChange={setType}>
          <SelectTrigger size="sm" className="w-[120px]">
            <SelectValue placeholder="Type" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All types</SelectItem>
            <SelectItem value="audio">Audio</SelectItem>
            <SelectItem value="video">Video</SelectItem>
          </SelectContent>
        </Select>
        <Select value={direction} onValueChange={setDirection}>
          <SelectTrigger size="sm" className="w-[130px]">
            <SelectValue placeholder="Direction" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All calls</SelectItem>
            <SelectItem value="incoming">Incoming</SelectItem>
            <SelectItem value="outgoing">Outgoing</SelectItem>
          </SelectContent>
        </Select>
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger size="sm" className="w-[130px]">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All status</SelectItem>
            <SelectItem value="ended">Completed</SelectItem>
            <SelectItem value="missed">Missed</SelectItem>
            <SelectItem value="rejected">Rejected</SelectItem>
            <SelectItem value="failed">Failed</SelectItem>
            <SelectItem value="cancelled">Cancelled</SelectItem>
            <SelectItem value="busy">Busy</SelectItem>
          </SelectContent>
        </Select>
        <Input
          type="date"
          value={from}
          onChange={(e) => setFrom(e.target.value)}
          className="w-[150px]"
          aria-label="From date"
        />
        <Input
          type="date"
          value={to}
          onChange={(e) => setTo(e.target.value)}
          className="w-[150px]"
          aria-label="To date"
        />
      </div>

      {/* List */}
      {isLoading ? (
        <div className="py-12 text-center text-sm text-muted-foreground">Loading call history…</div>
      ) : calls.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-2 py-12 text-center text-muted-foreground">
          <History className="size-6 opacity-50" />
          <p className="text-sm">No calls found.</p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full min-w-[720px] text-sm">
            <thead>
              <tr className="border-b bg-muted/40 text-left text-muted-foreground">
                <th className="px-4 py-2.5 font-medium">Employee</th>
                <th className="px-4 py-2.5 font-medium">Type</th>
                <th className="px-4 py-2.5 font-medium">Direction</th>
                <th className="px-4 py-2.5 font-medium">Date &amp; time</th>
                <th className="px-4 py-2.5 font-medium">Duration</th>
                <th className="px-4 py-2.5 font-medium">Status</th>
                {canCall && <th className="px-4 py-2.5 text-right font-medium">Action</th>}
              </tr>
            </thead>
            <tbody>
              {calls.map((c) => {
                const missed = c.status === "missed"
                return (
                  <tr key={c.id} className="border-b last:border-0">
                    <td className="px-4 py-2.5">
                      <div className="font-medium">{c.counterpart.name}</div>
                      {c.counterpart.designation && (
                        <div className="text-xs text-muted-foreground">{c.counterpart.designation}</div>
                      )}
                      {(c.projectName || c.taskName) && (
                        <div className="text-xs text-muted-foreground">
                          {[c.projectName && `Project: ${c.projectName}`, c.taskName && `Task: ${c.taskName}`]
                            .filter(Boolean)
                            .join(" · ")}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-2.5">
                      <span className="inline-flex items-center gap-1.5">
                        {c.callType === "video" ? <Video className="size-4" /> : <Phone className="size-4" />}
                        <span className="capitalize">{c.callType}</span>
                      </span>
                    </td>
                    <td className="px-4 py-2.5">
                      <span className={cn("inline-flex items-center gap-1.5", missed && "text-red-500")}>
                        {missed ? (
                          <PhoneMissed className="size-4" />
                        ) : c.direction === "incoming" ? (
                          <PhoneIncoming className="size-4" />
                        ) : (
                          <PhoneOutgoing className="size-4" />
                        )}
                        <span className="capitalize">{c.direction}</span>
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-muted-foreground">{fmtWhen(c.startedAt)}</td>
                    <td className="px-4 py-2.5">{fmtDuration(c.durationSeconds)}</td>
                    <td className="px-4 py-2.5">
                      <Badge variant="outline" className={cn("capitalize", statusTone(c.status))}>
                        {c.status}
                      </Badge>
                    </td>
                    {canCall && (
                      <td className="px-4 py-2.5">
                        <div className="flex items-center justify-end gap-1.5">
                          {permissions.audio && (
                            <Button
                              size="icon"
                              variant="ghost"
                              className="size-8"
                              disabled={!c.counterpart.employeeId || activeCallId != null}
                              onClick={() => callAgain(c, "audio")}
                              aria-label="Call again (audio)"
                              title="Call again"
                            >
                              <RotateCcw className="size-3.5" />
                            </Button>
                          )}
                          {permissions.video && (
                            <Button
                              size="icon"
                              variant="ghost"
                              className="size-8"
                              disabled={!c.counterpart.employeeId || activeCallId != null}
                              onClick={() => callAgain(c, "video")}
                              aria-label="Call again (video)"
                              title="Video call again"
                            >
                              <Video className="size-3.5" />
                            </Button>
                          )}
                        </div>
                      </td>
                    )}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
