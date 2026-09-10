"use client"

import { useMemo, useState } from "react"
import Link from "next/link"
import { useSearchParams } from "next/navigation"
import useSWR from "swr"
import { toast } from "sonner"
import { fetcher } from "@/lib/fetcher"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { KanbanSquare, Mail, MapPin, Phone, Plus, Trash2 } from "lucide-react"
import { PageHeader, RatingStars } from "@/components/recruit/recruit-shared"
import { RecruitComposeEmailDialog, type ComposeTarget } from "@/components/recruit/recruit-compose-email-dialog"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { APPLICATION_STAGES, formatDate, safeParse, type StageKey } from "@/lib/recruit"
import type { Job } from "@/lib/recruit-db"

type Application = {
  id: number
  application_id: string
  job_id: string | null
  job_title: string | null
  candidate_name: string
  email: string | null
  phone: string | null
  location: string | null
  experience: string | null
  current_company: string | null
  expected_salary: string | null
  resume_url: string | null
  cover_letter: string | null
  source: string | null
  stage: StageKey
  rating: number
  answers: string | null
  applied_at: string
}

export function ApplicationsKanbanClient({ canManage }: { canManage: boolean }) {
  const params = useSearchParams()
  const initialJob = params.get("jobId") || "all"
  const [jobFilter, setJobFilter] = useState(initialJob)
  const { data, isLoading, mutate } = useSWR<{ applications: Application[] }>("/api/recruit/applications", fetcher)
  const { data: jobData } = useSWR<{ jobs: Job[] }>("/api/recruit/jobs", fetcher)
  const [active, setActive] = useState<Application | null>(null)
  const [stageFilter, setStageFilter] = useState<string>("all")
  const [composeOpen, setComposeOpen] = useState(false)
  const [composeTarget, setComposeTarget] = useState<ComposeTarget | null>(null)

  function startEmail(app: Application) {
    setComposeTarget({
      applicationId: app.application_id,
      name: app.candidate_name,
      email: app.email,
      jobTitle: app.job_title,
    })
    setComposeOpen(true)
  }

  const applications = data?.applications ?? []
  const filtered = useMemo(
    () => (jobFilter === "all" ? applications : applications.filter((a) => a.job_id === jobFilter)),
    [applications, jobFilter],
  )

  const tableRows = useMemo(
    () => (stageFilter === "all" ? filtered : filtered.filter((a) => a.stage === stageFilter)),
    [filtered, stageFilter],
  )

  async function moveTo(app: Application, stage: StageKey) {
    if (app.stage === stage) return
    // optimistic
    mutate(
      { applications: applications.map((a) => (a.application_id === app.application_id ? { ...a, stage } : a)) },
      false,
    )
    const res = await fetch(`/api/recruit/applications/${app.application_id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stage }),
    })
    if (res.ok) {
      toast.success(`Moved ${app.candidate_name} to ${APPLICATION_STAGES.find((s) => s.key === stage)?.label}`)
      mutate()
    } else {
      toast.error("Unable to move candidate")
      mutate()
    }
  }

  async function setRating(app: Application, rating: number) {
    mutate({ applications: applications.map((a) => (a.application_id === app.application_id ? { ...a, rating } : a)) }, false)
    await fetch(`/api/recruit/applications/${app.application_id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rating }),
    })
    mutate()
  }

  async function deleteApp(app: Application) {
    if (!confirm(`Delete application from ${app.candidate_name}?`)) return
    const res = await fetch(`/api/recruit/applications/${app.application_id}`, { method: "DELETE" })
    if (res.ok) {
      toast.success("Application deleted")
      setActive(null)
      mutate()
    } else {
      toast.error("Unable to delete application")
    }
  }

  const questions = active ? safeParse<any[]>(active.answers, []) : []

  return (
    <main className="flex flex-col gap-6 p-6 md:p-8">
      <PageHeader
        title="Job Applications"
        description="Track candidates through your hiring pipeline and update their status."
        icon={KanbanSquare}
        action={
          <div className="flex items-center gap-2">
            <Select value={stageFilter} onValueChange={setStageFilter}>
              <SelectTrigger size="sm" className="w-44">
                <SelectValue placeholder="All statuses" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                {APPLICATION_STAGES.map((s) => (
                  <SelectItem key={s.key} value={s.key}>
                    {s.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {canManage && (
              <Button render={<Link href="/modules/recruitment/job-applications/create" />}>
                <Plus data-icon="inline-start" /> Add Application
              </Button>
            )}
          </div>
        }
      />

      <div className="flex items-center gap-2">
        <span className="text-sm text-muted-foreground">Filter by job</span>
        <Select value={jobFilter} onValueChange={setJobFilter}>
          <SelectTrigger size="sm" className="w-64"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All jobs</SelectItem>
            {(jobData?.jobs ?? []).map((j) => (
              <SelectItem key={j.job_id} value={j.job_id}>{j.title}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex flex-col gap-3">
        <h2 className="text-sm font-medium text-muted-foreground">
          {stageFilter === "all"
            ? `All applications (${tableRows.length})`
            : `${APPLICATION_STAGES.find((s) => s.key === stageFilter)?.label} (${tableRows.length})`}
        </h2>
        <div className="overflow-x-auto rounded-md border border-border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Candidate</TableHead>
                <TableHead>Job</TableHead>
                <TableHead>Applied</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading && (
                <TableRow>
                  <TableCell colSpan={5} className="py-8 text-center text-sm text-muted-foreground">
                    Loading applications...
                  </TableCell>
                </TableRow>
              )}
              {!isLoading && tableRows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="py-8 text-center text-sm text-muted-foreground">
                    No applications for this filter.
                  </TableCell>
                </TableRow>
              )}
              {tableRows.map((app) => (
                <TableRow key={app.application_id}>
                  <TableCell>
                    <button type="button" onClick={() => setActive(app)} className="flex flex-col text-left">
                      <span className="font-medium">{app.candidate_name}</span>
                      {app.email && <span className="text-xs text-muted-foreground">{app.email}</span>}
                    </button>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{app.job_title || "—"}</TableCell>
                  <TableCell className="text-muted-foreground">{formatDate(app.applied_at)}</TableCell>
                  <TableCell>
                    {canManage ? (
                      <Select value={app.stage} onValueChange={(v) => moveTo(app, v as StageKey)}>
                        <SelectTrigger size="sm" className="w-40">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {APPLICATION_STAGES.map((s) => (
                            <SelectItem key={s.key} value={s.key}>
                              {s.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : (
                      <span
                        className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${
                          APPLICATION_STAGES.find((s) => s.key === app.stage)?.tone ?? ""
                        }`}
                      >
                        {APPLICATION_STAGES.find((s) => s.key === app.stage)?.label}
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1.5">
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label="Email candidate"
                        disabled={!app.email}
                        onClick={() => startEmail(app)}
                      >
                        <Mail className="size-4" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>

      <Dialog open={!!active} onOpenChange={(o) => !o && setActive(null)}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
          {active && (
            <>
              <DialogHeader>
                <DialogTitle>{active.candidate_name}</DialogTitle>
                <DialogDescription>{active.job_title || "—"} · {active.application_id}</DialogDescription>
              </DialogHeader>
              <div className="flex flex-col gap-4 py-2 text-sm">
                <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-muted-foreground">
                  {active.email && <span className="inline-flex items-center gap-1.5"><Mail className="size-3.5" />{active.email}</span>}
                  {active.phone && <span className="inline-flex items-center gap-1.5"><Phone className="size-3.5" />{active.phone}</span>}
                  {active.location && <span className="inline-flex items-center gap-1.5"><MapPin className="size-3.5" />{active.location}</span>}
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <Detail label="Experience" value={active.experience} />
                  <Detail label="Current company" value={active.current_company} />
                  <Detail label="Expected salary" value={active.expected_salary} />
                  <Detail label="Source" value={active.source} />
                </div>
                {active.resume_url && (
                  <a href={active.resume_url} target="_blank" rel="noreferrer" className="text-primary underline underline-offset-4">View resume</a>
                )}
                {active.cover_letter && (
                  <div>
                    <p className="mb-1 font-medium text-foreground">Cover letter</p>
                    <p className="whitespace-pre-wrap text-muted-foreground">{active.cover_letter}</p>
                  </div>
                )}
                {questions.length > 0 && (
                  <div>
                    <p className="mb-1 font-medium text-foreground">Questionnaire</p>
                    <div className="flex flex-col gap-2">
                      {Object.entries(safeParse<Record<string, any>>(active.answers, {})).map(([k, v]) => (
                        <div key={k} className="rounded-md border border-border p-2">
                          <p className="text-xs text-muted-foreground">Answer #{k}</p>
                          <p>{Array.isArray(v) ? v.join(", ") : String(v)}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Rating</span>
                  <RatingStars value={active.rating} onChange={canManage ? (v) => setRating(active, v) : undefined} readOnly={!canManage} />
                </div>
                {canManage && (
                  <div className="flex flex-col gap-2">
                    <span className="text-muted-foreground">Move to stage</span>
                    <Select value={active.stage} onValueChange={(v) => { moveTo(active, v as StageKey); setActive({ ...active, stage: v as StageKey }) }}>
                      <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {APPLICATION_STAGES.map((s) => <SelectItem key={s.key} value={s.key}>{s.label}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                )}
              </div>
              {canManage && (
                <div className="flex justify-end border-t pt-4">
                  <Button variant="destructive" size="sm" onClick={() => deleteApp(active)}>
                    <Trash2 data-icon="inline-start" /> Delete application
                  </Button>
                </div>
              )}
            </>
          )}
        </DialogContent>
      </Dialog>

      <RecruitComposeEmailDialog open={composeOpen} onOpenChange={setComposeOpen} target={composeTarget} />
    </main>
  )
}

function Detail({ label, value }: { label: string; value: string | null }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p>{value || "—"}</p>
    </div>
  )
}
