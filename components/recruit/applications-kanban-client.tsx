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
  const [dragId, setDragId] = useState<string | null>(null)

  const applications = data?.applications ?? []
  const filtered = useMemo(
    () => (jobFilter === "all" ? applications : applications.filter((a) => a.job_id === jobFilter)),
    [applications, jobFilter],
  )

  const byStage = useMemo(() => {
    const map: Record<string, Application[]> = {}
    for (const s of APPLICATION_STAGES) map[s.key] = []
    for (const a of filtered) (map[a.stage] ??= []).push(a)
    return map
  }, [filtered])

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
        description="Track candidates through your hiring pipeline. Drag cards between stages to update them."
        icon={KanbanSquare}
        action={
          canManage ? (
            <Button render={<Link href="/modules/recruitment/job-applications/create" />}>
              <Plus data-icon="inline-start" /> Add Application
            </Button>
          ) : undefined
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

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        {APPLICATION_STAGES.map((stage) => (
          <div
            key={stage.key}
            onDragOver={(e) => canManage && e.preventDefault()}
            onDrop={() => {
              if (!canManage || !dragId) return
              const app = applications.find((a) => a.application_id === dragId)
              if (app) moveTo(app, stage.key)
              setDragId(null)
            }}
            className="flex min-h-40 flex-col gap-3 rounded-lg border border-border bg-muted/30 p-3"
          >
            <div className="flex items-center justify-between">
              <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${stage.tone}`}>{stage.label}</span>
              <span className="text-xs text-muted-foreground">{byStage[stage.key]?.length ?? 0}</span>
            </div>
            <div className="flex flex-col gap-2">
              {isLoading && <div className="text-xs text-muted-foreground">Loading...</div>}
              {byStage[stage.key]?.map((app) => (
                <button
                  key={app.application_id}
                  type="button"
                  draggable={canManage}
                  onDragStart={() => setDragId(app.application_id)}
                  onClick={() => setActive(app)}
                  className="flex flex-col gap-1.5 rounded-md border border-border bg-card p-3 text-left shadow-sm transition-colors hover:border-primary/50"
                >
                  <span className="font-medium leading-tight">{app.candidate_name}</span>
                  <span className="text-xs text-muted-foreground">{app.job_title || "—"}</span>
                  <RatingStars value={app.rating} readOnly />
                  <span className="text-xs text-muted-foreground">{formatDate(app.applied_at)}</span>
                </button>
              ))}
            </div>
          </div>
        ))}
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
                <div className="flex flex-wrap gap-x-6 gap-y-2 text-muted-foreground">
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
