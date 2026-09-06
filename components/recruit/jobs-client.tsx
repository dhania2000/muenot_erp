"use client"

import { useMemo, useState } from "react"
import Link from "next/link"
import useSWR from "swr"
import { toast } from "sonner"
import { fetcher } from "@/lib/fetcher"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
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
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Briefcase, ExternalLink, MoreHorizontal, Plus, Search, Users } from "lucide-react"
import { PageHeader, StatusPill } from "@/components/recruit/recruit-shared"
import type { Job } from "@/lib/recruit-db"
import { JOB_STATUSES, JOB_TYPES, WORK_MODES, labelFor, salaryRange } from "@/lib/recruit"

export function JobsClient({ canManage }: { canManage: boolean }) {
  const { data, isLoading, mutate } = useSWR<{ jobs: Job[] }>("/api/recruit/jobs", fetcher)
  const [search, setSearch] = useState("")
  const [status, setStatus] = useState("all")

  const jobs = data?.jobs ?? []

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return jobs.filter((j) => {
      if (status !== "all" && j.status !== status) return false
      if (!q) return true
      return [j.title, j.department, j.location, j.recruiter].filter(Boolean).some((v) => v!.toLowerCase().includes(q))
    })
  }, [jobs, search, status])

  async function copyPublicLink(job: Job) {
    const url = `${window.location.origin}/job-opening/${job.public_hash}`
    try {
      await navigator.clipboard.writeText(url)
      toast.success("Public job link copied")
    } catch {
      toast.message(url)
    }
  }

  async function deleteJob(job: Job) {
    if (!confirm(`Delete "${job.title}"? This also removes its custom questions.`)) return
    const res = await fetch(`/api/recruit/jobs/${job.job_id}`, { method: "DELETE" })
    if (res.ok) {
      toast.success("Job deleted")
      mutate()
    } else {
      toast.error("Unable to delete job")
    }
  }

  return (
    <main className="flex flex-col gap-6 p-6 md:p-8">
      <PageHeader
        title="Jobs"
        description="Post openings, manage custom application questions and share them on your careers site."
        icon={Briefcase}
        action={
          canManage ? (
            <Button render={<Link href="/modules/recruitment/jobs/create" />}>
              <Plus data-icon="inline-start" />
              Add Job
            </Button>
          ) : undefined
        }
      />

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input placeholder="Search jobs..." value={search} onChange={(e) => setSearch(e.target.value)} className="w-64 pl-8" />
        </div>
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger size="sm" className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            {JOB_STATUSES.map((s) => (
              <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="rounded-md border border-border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Job</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Location</TableHead>
              <TableHead>Salary</TableHead>
              <TableHead>Applications</TableHead>
              <TableHead>Status</TableHead>
              {canManage && <TableHead className="text-right">Actions</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading && (
              <TableRow>
                <TableCell colSpan={canManage ? 7 : 6} className="py-10 text-center text-sm text-muted-foreground">Loading jobs...</TableCell>
              </TableRow>
            )}
            {!isLoading && filtered.length === 0 && (
              <TableRow>
                <TableCell colSpan={canManage ? 7 : 6} className="py-10 text-center text-sm text-muted-foreground">No jobs found.</TableCell>
              </TableRow>
            )}
            {filtered.map((job) => (
              <TableRow key={job.job_id}>
                <TableCell>
                  <div className="flex flex-col">
                    <span className="font-medium">{job.title}</span>
                    <span className="text-xs text-muted-foreground">
                      {job.job_id}{job.department ? ` · ${job.department}` : ""}
                    </span>
                  </div>
                </TableCell>
                <TableCell className="text-muted-foreground">
                  <div className="flex flex-col">
                    <span>{labelFor(JOB_TYPES, job.job_type)}</span>
                    <span className="text-xs">{labelFor(WORK_MODES, job.work_mode)}</span>
                  </div>
                </TableCell>
                <TableCell className="text-muted-foreground">{job.location || "—"}</TableCell>
                <TableCell className="text-muted-foreground">{salaryRange(job.salary_from, job.salary_to, job.currency)}</TableCell>
                <TableCell>
                  <Link href={`/modules/recruitment/job-applications?jobId=${job.job_id}`} className="inline-flex items-center gap-1.5 text-sm hover:text-primary">
                    <Users className="size-3.5" />
                    {job.applications_count ?? 0}
                  </Link>
                </TableCell>
                <TableCell><StatusPill status={job.status} kind="job" /></TableCell>
                {canManage && (
                  <TableCell className="text-right">
                    <DropdownMenu>
                      <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label="Actions" />}>
                        <MoreHorizontal className="size-4" />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem render={<Link href={`/modules/recruitment/jobs/${job.job_id}/edit`} />}>Edit job</DropdownMenuItem>
                        <DropdownMenuItem render={<Link href={`/job-opening/${job.public_hash}`} target="_blank" />}>
                          <ExternalLink className="size-4" /> View public page
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => copyPublicLink(job)}>Copy public link</DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem variant="destructive" onClick={() => deleteJob(job)}>Delete job</DropdownMenuItem>
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
