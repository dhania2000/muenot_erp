"use client"

import { useMemo, useState } from "react"
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { MoreHorizontal, Plus, Search } from "lucide-react"
import { MeetingDialog } from "@/components/sales/meeting-dialog"

export type MeetingRow = {
  id: number
  meeting_code: string
  meeting_date: string | null
  meeting_time: string | null
  company_name: string | null
  contact_person: string | null
  meeting_type: string
  agenda: string | null
  outcome_notes: string | null
  next_steps: string | null
  added_by_name: string | null
  created_at: string
}

export function MeetingsClient({ canManage }: { canManage: boolean }) {
  const { data, isLoading, mutate } = useSWR<{ meetings: MeetingRow[] }>("/api/sales/meetings", fetcher)
  const [search, setSearch] = useState("")
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<MeetingRow | null>(null)

  const meetings = data?.meetings ?? []

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return meetings
    return meetings.filter((m) =>
      [m.company_name, m.contact_person, m.meeting_type, m.agenda].filter(Boolean).some((v) => v!.toLowerCase().includes(q)),
    )
  }, [meetings, search])

  async function deleteMeeting(meeting: MeetingRow) {
    if (!confirm(`Delete this meeting with ${meeting.company_name}?`)) return
    const res = await fetch(`/api/sales/meetings/${meeting.id}`, { method: "DELETE" })
    if (res.ok) {
      toast.success("Meeting deleted")
      mutate()
    } else {
      toast.error("Unable to delete meeting")
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search meetings..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-64 pl-8"
          />
        </div>
        {canManage && (
          <Button
            onClick={() => {
              setEditing(null)
              setDialogOpen(true)
            }}
          >
            <Plus data-icon="inline-start" />
            Schedule meeting
          </Button>
        )}
      </div>

      <div className="rounded-md border border-border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Date</TableHead>
              <TableHead>Company</TableHead>
              <TableHead>Contact</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Agenda</TableHead>
              <TableHead>Next steps</TableHead>
              {canManage && <TableHead className="text-right">Actions</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading && (
              <TableRow>
                <TableCell colSpan={7} className="py-10 text-center text-sm text-muted-foreground">
                  Loading meetings...
                </TableCell>
              </TableRow>
            )}
            {!isLoading && filtered.length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="py-10 text-center text-sm text-muted-foreground">
                  No meetings found.
                </TableCell>
              </TableRow>
            )}
            {filtered.map((meeting) => (
              <TableRow key={meeting.id}>
                <TableCell>
                  <div className="flex flex-col">
                    <span className="font-medium">{formatDate(meeting.meeting_date)}</span>
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
                <TableCell className="max-w-48 truncate text-muted-foreground">{meeting.agenda || "—"}</TableCell>
                <TableCell className="max-w-48 truncate text-muted-foreground">{meeting.next_steps || "—"}</TableCell>
                {canManage && (
                  <TableCell className="text-right">
                    <DropdownMenu>
                      <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label="Actions" />}>
                        <MoreHorizontal className="size-4" />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem
                          onClick={() => {
                            setEditing(meeting)
                            setDialogOpen(true)
                          }}
                        >
                          Edit meeting
                        </DropdownMenuItem>
                        <DropdownMenuItem variant="destructive" onClick={() => deleteMeeting(meeting)}>
                          Delete meeting
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
        onSaved={() => {
          setDialogOpen(false)
          toast.success(editing ? "Meeting updated" : "Meeting scheduled")
          mutate()
        }}
      />
    </div>
  )
}
