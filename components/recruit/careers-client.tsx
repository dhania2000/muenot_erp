"use client"

import { useMemo, useState } from "react"
import Link from "next/link"
import useSWR from "swr"
import { fetcher } from "@/lib/fetcher"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { ArrowRight, MapPin, Search } from "lucide-react"
import { JOB_TYPES, WORK_MODES, labelFor, salaryRange } from "@/lib/recruit"

type PublicJob = {
  job_id: string
  public_hash: string
  title: string
  department: string | null
  location: string | null
  job_type: string | null
  work_mode: string | null
  experience: string | null
  salary_from: number | null
  salary_to: number | null
  currency: string
  skills: string | null
}

export function CareersClient() {
  const { data, isLoading } = useSWR<{ jobs: PublicJob[] }>("/api/recruit/public/jobs", fetcher)
  const [search, setSearch] = useState("")
  const jobs = data?.jobs ?? []

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return jobs
    return jobs.filter((j) =>
      [j.title, j.department, j.location, j.skills].filter(Boolean).some((v) => v!.toLowerCase().includes(q)),
    )
  }, [jobs, search])

  const departments = useMemo(() => {
    const set = new Set(jobs.map((j) => j.department).filter(Boolean) as string[])
    return Array.from(set)
  }, [jobs])

  return (
    <div className="mx-auto max-w-5xl px-4 py-10 md:px-6 md:py-16">
      <div className="flex flex-col gap-4 text-center">
        <h1 className="text-3xl font-semibold tracking-tight text-balance md:text-4xl">Join our team</h1>
        <p className="mx-auto max-w-2xl text-pretty text-muted-foreground">
          We&apos;re hiring across {departments.length > 0 ? `${departments.length} teams` : "the company"}. Explore open
          roles below and apply in minutes.
        </p>
      </div>

      <div className="relative mx-auto mt-8 max-w-md">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          placeholder="Search roles, teams or skills…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="pl-9"
        />
      </div>

      <div className="mt-8 flex items-center justify-between">
        <h2 className="text-sm font-medium text-muted-foreground">
          {isLoading ? "Loading openings…" : `${filtered.length} open ${filtered.length === 1 ? "role" : "roles"}`}
        </h2>
      </div>

      <div className="mt-4 flex flex-col gap-3">
        {!isLoading && filtered.length === 0 && (
          <div className="rounded-lg border border-dashed p-12 text-center text-sm text-muted-foreground">
            No open positions right now. Please check back soon.
          </div>
        )}
        {filtered.map((job) => (
          <Link
            key={job.job_id}
            href={`/job-opening/${job.public_hash}`}
            className="group flex flex-col gap-3 rounded-lg border border-border bg-card p-5 transition-colors hover:border-primary/50 sm:flex-row sm:items-center sm:justify-between"
          >
            <div className="min-w-0">
              <h3 className="font-medium">{job.title}</h3>
              <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
                {job.department && <span>{job.department}</span>}
                {job.location && (
                  <span className="inline-flex items-center gap-1">
                    <MapPin className="size-3.5" /> {job.location}
                  </span>
                )}
                <span>{salaryRange(job.salary_from, job.salary_to, job.currency)}</span>
              </div>
              <div className="mt-3 flex flex-wrap gap-1.5">
                {job.job_type && <Badge variant="secondary">{labelFor(JOB_TYPES, job.job_type)}</Badge>}
                {job.work_mode && <Badge variant="secondary">{labelFor(WORK_MODES, job.work_mode)}</Badge>}
                {job.experience && <Badge variant="outline">{job.experience}</Badge>}
              </div>
            </div>
            <span className="inline-flex shrink-0 items-center gap-1 text-sm font-medium text-primary">
              View &amp; apply
              <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
            </span>
          </Link>
        ))}
      </div>
    </div>
  )
}
