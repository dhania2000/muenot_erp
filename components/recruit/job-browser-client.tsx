"use client"

import { useEffect, useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import useSWR from "swr"
import { toast } from "sonner"
import { fetcher } from "@/lib/fetcher"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Field, FieldLabel } from "@/components/ui/field"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Briefcase, CheckCircle2, GraduationCap, Loader2, MapPin, Share2 } from "lucide-react"
import { QuestionFields, type Answers } from "@/components/recruit/question-fields"
import type { JobQuestion } from "@/lib/recruit"
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

type JobDetail = PublicJob & { description: string | null; requirements: string | null }

const ALL = "all"

const APPLY_FIELDS = [
  { key: "candidate_name", label: "Full name", required: true, type: "text" },
  { key: "email", label: "Email", required: true, type: "email" },
  { key: "phone", label: "Phone", required: false, type: "tel" },
  { key: "location", label: "Current location", required: false, type: "text" },
  { key: "experience", label: "Total experience", required: false, type: "text" },
  { key: "current_company", label: "Current company", required: false, type: "text" },
] as const

export function JobBrowserClient({ initialHash }: { initialHash?: string }) {
  const router = useRouter()
  const { data, isLoading } = useSWR<{ jobs: PublicJob[] }>("/api/recruit/public/jobs", fetcher)
  const jobs = useMemo(() => data?.jobs ?? [], [data])

  const [dept, setDept] = useState(ALL)
  const [jobType, setJobType] = useState(ALL)
  const [workMode, setWorkMode] = useState(ALL)
  const [selected, setSelected] = useState<string | null>(initialHash ?? null)

  const departments = useMemo(
    () => Array.from(new Set(jobs.map((j) => j.department).filter(Boolean) as string[])),
    [jobs],
  )

  const filtered = useMemo(
    () =>
      jobs.filter(
        (j) =>
          (dept === ALL || j.department === dept) &&
          (jobType === ALL || j.job_type === jobType) &&
          (workMode === ALL || j.work_mode === workMode),
      ),
    [jobs, dept, jobType, workMode],
  )

  // Keep a valid selection whenever the filtered list changes.
  useEffect(() => {
    if (filtered.length === 0) return
    if (!selected || !filtered.some((j) => j.public_hash === selected)) {
      setSelected(filtered[0].public_hash)
    }
  }, [filtered, selected])

  function clearFilters() {
    setDept(ALL)
    setJobType(ALL)
    setWorkMode(ALL)
  }

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 md:px-6 md:py-8">
      {/* Filter bar */}
      <div className="rounded-xl border border-border bg-card p-4 md:p-5">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-5">
          <FilterSelect label="Department" value={dept} onChange={setDept} options={departments.map((d) => ({ value: d, label: d }))} />
          <FilterSelect label="Job Type" value={jobType} onChange={setJobType} options={JOB_TYPES} />
          <FilterSelect label="Remote / Work Mode" value={workMode} onChange={setWorkMode} options={WORK_MODES} />
          <div className="flex items-end gap-3 lg:col-span-2">
            <Button variant="outline" onClick={clearFilters} className="text-muted-foreground">
              Clear
            </Button>
            <span className="text-sm text-muted-foreground">
              {isLoading ? "Loading…" : `${filtered.length} open ${filtered.length === 1 ? "role" : "roles"}`}
            </span>
          </div>
        </div>
      </div>

      {/* Two-pane */}
      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,340px)_1fr]">
        {/* Job list */}
        <div className="overflow-hidden rounded-xl border border-border bg-card">
          {isLoading && <div className="p-6 text-sm text-muted-foreground">Loading openings…</div>}
          {!isLoading && filtered.length === 0 && (
            <div className="p-8 text-center text-sm text-muted-foreground">No matching roles right now.</div>
          )}
          <ul className="divide-y divide-border">
            {filtered.map((job) => {
              const active = job.public_hash === selected
              return (
                <li key={job.job_id}>
                  <button
                    type="button"
                    onClick={() => setSelected(job.public_hash)}
                    style={
                      active
                        ? { backgroundColor: "color-mix(in srgb, var(--careers-accent) 10%, transparent)" }
                        : undefined
                    }
                    className={`flex w-full flex-col gap-2 px-5 py-4 text-left transition-colors ${
                      active ? "" : "hover:bg-muted/60"
                    }`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <span className="font-semibold text-foreground">{job.title}</span>
                      <GraduationCap className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                    </div>
                    <div className="flex items-center justify-between gap-2 text-sm text-muted-foreground">
                      <span>{labelFor(JOB_TYPES, job.job_type)}</span>
                      {job.department && <span>{job.department}</span>}
                    </div>
                    <span className="inline-flex items-center gap-1 text-sm text-muted-foreground">
                      <MapPin className="size-3.5" /> {job.location || labelFor(WORK_MODES, job.work_mode)}
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        </div>

        {/* Detail */}
        <div className="rounded-xl border border-border bg-card p-6 md:p-8">
          {selected ? (
            <JobDetailPanel hash={selected} />
          ) : (
            <div className="py-16 text-center text-sm text-muted-foreground">Select a role to see details.</div>
          )}
        </div>
      </div>

      <div className="mt-6">
        <Button variant="ghost" size="sm" onClick={() => router.push("/careers")} className="text-muted-foreground">
          ← Back to company profile
        </Button>
      </div>
    </div>
  )
}

function FilterSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  options: { value: string; label: string }[]
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-sm text-muted-foreground">{label}</span>
      <Select value={value} onValueChange={(v) => onChange(v as string)}>
        <SelectTrigger className="w-full">
          <SelectValue>
            {(v) => (v === ALL ? "All" : options.find((o) => o.value === v)?.label ?? "All")}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>All</SelectItem>
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}

function JobDetailPanel({ hash }: { hash: string }) {
  const { data, isLoading } = useSWR<{ job: JobDetail; questions: JobQuestion[] }>(
    `/api/recruit/public/job/${hash}`,
    fetcher,
  )
  const [applyOpen, setApplyOpen] = useState(false)
  const job = data?.job
  const questions = data?.questions ?? []

  if (isLoading) return <div className="py-16 text-center text-sm text-muted-foreground">Loading role…</div>
  if (!job) return <div className="py-16 text-center text-sm text-muted-foreground">This role is no longer available.</div>

  async function share() {
    const url = `${window.location.origin}/job-opening/${hash}`
    try {
      await navigator.clipboard.writeText(url)
      toast.success("Link copied to clipboard")
    } catch {
      toast.error("Could not copy link")
    }
  }

  return (
    <div>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">{job.title}</h1>
        <div className="flex shrink-0 items-center gap-2">
          <Button variant="outline" onClick={share}>
            <Share2 data-icon="inline-start" /> Share Link
          </Button>
          <Button
            onClick={() => setApplyOpen(true)}
            style={{ backgroundColor: "var(--careers-accent)" }}
            className="text-white hover:opacity-90"
          >
            <Briefcase data-icon="inline-start" /> Apply
          </Button>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 text-sm text-muted-foreground">
        {job.experience && (
          <span className="inline-flex items-center gap-1.5">
            <Briefcase className="size-4" /> {job.experience}
          </span>
        )}
        <span className="inline-flex items-center gap-1.5">
          <MapPin className="size-4" /> {job.location || labelFor(WORK_MODES, job.work_mode)}
        </span>
        <span className="inline-flex items-center gap-2">
          {job.job_type && <span className="rounded-full bg-muted px-2.5 py-0.5">{labelFor(JOB_TYPES, job.job_type)}</span>}
          {job.work_mode && <span className="rounded-full bg-muted px-2.5 py-0.5">{labelFor(WORK_MODES, job.work_mode)}</span>}
        </span>
      </div>

      <p className="mt-3 font-medium text-foreground">{salaryRange(job.salary_from, job.salary_to, job.currency)}</p>

      {job.skills && (
        <section className="mt-6">
          <h2 className="text-base font-semibold text-foreground">Skills Required</h2>
          <div className="mt-2 flex flex-wrap gap-2">
            {job.skills
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean)
              .map((s) => (
                <span key={s} className="rounded-full border border-border px-3 py-1 text-sm text-muted-foreground">
                  {s}
                </span>
              ))}
          </div>
        </section>
      )}

      {job.description && (
        <section className="mt-6">
          <h2 className="text-base font-semibold text-foreground">Description</h2>
          <p className="mt-2 whitespace-pre-wrap leading-relaxed text-muted-foreground">{job.description}</p>
        </section>
      )}

      {job.requirements && (
        <section className="mt-6">
          <h2 className="text-base font-semibold text-foreground">Requirements</h2>
          <p className="mt-2 whitespace-pre-wrap leading-relaxed text-muted-foreground">{job.requirements}</p>
        </section>
      )}

      <ApplyDialog open={applyOpen} onOpenChange={setApplyOpen} hash={hash} jobTitle={job.title} questions={questions} />
    </div>
  )
}

function ApplyDialog({
  open,
  onOpenChange,
  hash,
  jobTitle,
  questions,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  hash: string
  jobTitle: string
  questions: JobQuestion[]
}) {
  const [form, setForm] = useState<Record<string, string>>({})
  const [coverLetter, setCoverLetter] = useState("")
  const [answers, setAnswers] = useState<Answers>({})
  const [submitting, setSubmitting] = useState(false)
  const [done, setDone] = useState(false)
  const [resumeUrl, setResumeUrl] = useState("")
  const [resumeName, setResumeName] = useState("")
  const [uploading, setUploading] = useState(false)

  function setField(key: string, value: string) {
    setForm((prev) => ({ ...prev, [key]: value }))
  }

  async function handleResume(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setUploading(true)
    setResumeUrl("")
    setResumeName("")
    try {
      const fd = new FormData()
      fd.append("file", file)
      const res = await fetch("/api/recruit/public/resume", { method: "POST", body: fd })
      const body = await res.json().catch(() => ({}))
      if (res.ok && body.url) {
        setResumeUrl(body.url)
        setResumeName(body.filename || file.name)
      } else {
        toast.error(body.error || "Unable to upload resume")
        e.target.value = ""
      }
    } catch {
      toast.error("Unable to upload resume")
      e.target.value = ""
    } finally {
      setUploading(false)
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!form.candidate_name?.trim()) return toast.error("Please enter your name")
    if (!form.email?.trim()) return toast.error("Please enter your email")
    for (const q of questions) {
      if (q.required) {
        const v = answers[String(q.id)]
        const empty = v === undefined || v === "" || (Array.isArray(v) && v.length === 0)
        if (empty) return toast.error(`Please answer: ${q.question}`)
      }
    }
    setSubmitting(true)
    const res = await fetch("/api/recruit/public/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hash, ...form, resume_url: resumeUrl, cover_letter: coverLetter, answers }),
    })
    setSubmitting(false)
    if (res.ok) {
      setDone(true)
    } else {
      const body = await res.json().catch(() => ({}))
      toast.error(body.error || "Unable to submit your application")
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        onOpenChange(v)
        if (!v) {
          setTimeout(() => {
            setDone(false)
            setForm({})
            setCoverLetter("")
            setAnswers({})
            setResumeUrl("")
            setResumeName("")
          }, 200)
        }
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        {done ? (
          <div className="py-8 text-center">
            <span className="mx-auto flex size-14 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-600">
              <CheckCircle2 className="size-7" />
            </span>
            <h2 className="mt-6 text-xl font-semibold tracking-tight text-foreground">Application submitted</h2>
            <p className="mx-auto mt-2 max-w-md text-pretty text-muted-foreground">
              Thanks for applying to <strong>{jobTitle}</strong>. Our team will review your application and reach out if
              there&apos;s a fit.
            </p>
            <Button className="mt-6" variant="outline" onClick={() => onOpenChange(false)}>
              Close
            </Button>
          </div>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Apply for {jobTitle}</DialogTitle>
              <DialogDescription>Fill in your details and we&apos;ll be in touch.</DialogDescription>
            </DialogHeader>
            <form onSubmit={submit} className="flex flex-col gap-4">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                {APPLY_FIELDS.map((f) => (
                  <Field key={f.key}>
                    <FieldLabel htmlFor={f.key}>
                      {f.label}
                      {f.required && <span className="text-destructive"> *</span>}
                    </FieldLabel>
                    <Input id={f.key} type={f.type} value={form[f.key] || ""} onChange={(e) => setField(f.key, e.target.value)} />
                  </Field>
                ))}
              </div>

              <Field>
                <FieldLabel htmlFor="resume">Resume (PDF or image)</FieldLabel>
                <Input
                  id="resume"
                  type="file"
                  accept="application/pdf,image/*"
                  onChange={handleResume}
                  disabled={uploading}
                />
                {uploading && (
                  <p className="mt-1 inline-flex items-center gap-1.5 text-sm text-muted-foreground">
                    <Loader2 className="size-3.5 animate-spin" /> Uploading…
                  </p>
                )}
                {!uploading && resumeUrl && (
                  <p className="mt-1 inline-flex items-center gap-1.5 text-sm text-emerald-600 dark:text-emerald-400">
                    <CheckCircle2 className="size-3.5" /> {resumeName || "Resume uploaded"}
                  </p>
                )}
              </Field>

              <Field>
                <FieldLabel htmlFor="cover_letter">Cover letter</FieldLabel>
                <Textarea
                  id="cover_letter"
                  rows={4}
                  value={coverLetter}
                  onChange={(e) => setCoverLetter(e.target.value)}
                  placeholder="Tell us why you're a great fit…"
                />
              </Field>

              {questions.length > 0 && (
                <div className="flex flex-col gap-4 rounded-lg border border-border p-4">
                  <h3 className="text-sm font-medium">A few more questions</h3>
                  <QuestionFields
                    questions={questions}
                    answers={answers}
                    onChange={(id, value) => setAnswers((prev) => ({ ...prev, [id]: value }))}
                  />
                </div>
              )}

              <Button
                type="submit"
                size="lg"
                disabled={submitting}
                style={{ backgroundColor: "var(--careers-accent)" }}
                className="mt-2 w-full text-white hover:opacity-90 sm:w-auto"
              >
                {submitting && <Loader2 className="size-4 animate-spin" data-icon="inline-start" />}
                Submit application
              </Button>
            </form>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
