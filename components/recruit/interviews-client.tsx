"use client"

import { useMemo, useState } from "react"
import Link from "next/link"
import useSWR from "swr"
import { toast } from "sonner"
import { fetcher } from "@/lib/fetcher"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
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
import { CalendarClock, MoreHorizontal, Plus, Search } from "lucide-react"
import { PageHeader, StatusPill, RatingStars } from "@/components/recruit/recruit-shared"
import { INTERVIEW_MODES, INTERVIEW_STATUSES, formatDateTime, labelFor } from "@/lib/recruit"

type Interview = {
  interview_id: string
  candidate_name: string | null
  job_title: string | null
  interviewer: string | null
  scheduled_at: string | null
  mode: string | null
  location: string | null
  round: string | null
  status: string
  rating: number
}

export function InterviewsClient({ canManage }: { canManage: boolean }) {
  const { data, isLoading, mutate } = useSWR<{ interviews: Interview[] }>("/api/recruit/interviews", fetcher)
  const [search, setSearch] = useState("")
  const interviews = data?.interviews ?? []

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return interviews
    return interviews.filter((i) => [i.candidate_name, i.job_title, i.interviewer].filter(Boolean).some((v) => v!.toLowerCase().includes(q)))
  }, [interviews, search])

  async function updateStatus(id: string, iv: Interview, status: string) {
    const res = await fetch(`/api/recruit/interviews/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...iv, status }),
    })
    if (res.ok) { toast.success("Interview updated"); mutate() } else toast.error("Unable to update")
  }

  async function remove(id: string) {
    if (!confirm("Delete this interview?")) return
    const res = await fetch(`/api/recruit/interviews/${id}`, { method: "DELETE" })
    if (res.ok) { toast.success("Interview deleted"); mutate() } else toast.error("Unable to delete")
  }

  return (
    <main className="flex flex-col gap-6 p-6 md:p-8">
      <PageHeader
        title="Interview Schedule"
        description="Plan interview rounds, assign interviewers and record feedback."
        icon={CalendarClock}
        action={canManage ? (
          <Button render={<Link href="/modules/recruitment/interview-schedule/create" />}>
            <Plus data-icon="inline-start" /> Schedule Interview
          </Button>
        ) : undefined}
      />

      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input placeholder="Search interviews..." value={search} onChange={(e) => setSearch(e.target.value)} className="w-64 pl-8" />
      </div>

      <div className="rounded-md border border-border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Candidate</TableHead>
              <TableHead>Job</TableHead>
              <TableHead>Interviewer</TableHead>
              <TableHead>Schedule</TableHead>
              <TableHead>Mode</TableHead>
              <TableHead>Round</TableHead>
              <TableHead>Rating</TableHead>
              <TableHead>Status</TableHead>
              {canManage && <TableHead className="text-right">Actions</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading && (
              <TableRow><TableCell colSpan={canManage ? 9 : 8} className="py-10 text-center text-sm text-muted-foreground">Loading interviews...</TableCell></TableRow>
            )}
            {!isLoading && filtered.length === 0 && (
              <TableRow><TableCell colSpan={canManage ? 9 : 8} className="py-10 text-center text-sm text-muted-foreground">No interviews scheduled.</TableCell></TableRow>
            )}
            {filtered.map((iv) => (
              <TableRow key={iv.interview_id}>
                <TableCell className="font-medium">{iv.candidate_name || "—"}</TableCell>
                <TableCell className="text-muted-foreground">{iv.job_title || "—"}</TableCell>
                <TableCell className="text-muted-foreground">{iv.interviewer || "—"}</TableCell>
                <TableCell className="text-muted-foreground">{formatDateTime(iv.scheduled_at)}</TableCell>
                <TableCell className="text-muted-foreground">{labelFor(INTERVIEW_MODES, iv.mode)}</TableCell>
                <TableCell className="text-muted-foreground">{iv.round || "—"}</TableCell>
                <TableCell><RatingStars value={iv.rating} readOnly /></TableCell>
                <TableCell><StatusPill status={iv.status} kind="interview" /></TableCell>
                {canManage && (
                  <TableCell className="text-right">
                    <DropdownMenu>
                      <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label="Actions" />}>
                        <MoreHorizontal className="size-4" />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        {INTERVIEW_STATUSES.map((s) => (
                          <DropdownMenuItem key={s.value} onClick={() => updateStatus(iv.interview_id, iv, s.value)}>Mark {s.label}</DropdownMenuItem>
                        ))}
                        <DropdownMenuItem variant="destructive" onClick={() => remove(iv.interview_id)}>Delete</DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </main>
  )
}
