"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import useSWR from "swr"
import { toast } from "sonner"
import { fetcher } from "@/lib/fetcher"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Checkbox } from "@/components/ui/checkbox"
import { Field, FieldLabel } from "@/components/ui/field"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Alert, AlertDescription } from "@/components/ui/alert"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { ArrowLeft, GripVertical, Loader2, Plus, Trash2 } from "lucide-react"
import { PageHeader } from "@/components/recruit/recruit-shared"
import {
  JOB_STATUSES, JOB_TYPES, WORK_MODES, QUESTION_TYPES, QUESTION_TYPES_WITH_OPTIONS,
  type JobQuestion,
} from "@/lib/recruit"
import type { Job } from "@/lib/recruit-db"

type FormState = {
  title: string
  department: string
  location: string
  job_type: string
  work_mode: string
  status: string
  positions: string
  experience: string
  salary_from: string
  salary_to: string
  currency: string
  start_date: string
  end_date: string
  recruiter: string
  skills: string
  description: string
  requirements: string
  show_on_careers: boolean
}

const EMPTY: FormState = {
  title: "", department: "", location: "", job_type: "full_time", work_mode: "on_site",
  status: "open", positions: "1", experience: "", salary_from: "", salary_to: "", currency: "INR",
  start_date: "", end_date: "", recruiter: "", skills: "", description: "", requirements: "",
  show_on_careers: true,
}

export function JobFormClient({ jobId }: { jobId?: string }) {
  const router = useRouter()
  const isEdit = Boolean(jobId)
  const { data: existing } = useSWR<{ job: Job; questions: JobQuestion[] }>(
    jobId ? `/api/recruit/jobs/${jobId}` : null,
    fetcher,
  )
  const { data: skillData } = useSWR<{ skills: { name: string }[] }>("/api/recruit/skills", fetcher)

  const [form, setForm] = useState<FormState>(EMPTY)
  const [questions, setQuestions] = useState<JobQuestion[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!existing?.job) return
    const j = existing.job
    setForm({
      title: j.title || "", department: j.department || "", location: j.location || "",
      job_type: j.job_type || "full_time", work_mode: j.work_mode || "on_site", status: j.status || "open",
      positions: String(j.positions ?? 1), experience: j.experience || "",
      salary_from: j.salary_from != null ? String(j.salary_from) : "",
      salary_to: j.salary_to != null ? String(j.salary_to) : "", currency: j.currency || "INR",
      start_date: j.start_date || "", end_date: j.end_date || "", recruiter: j.recruiter || "",
      skills: j.skills || "", description: j.description || "", requirements: j.requirements || "",
      show_on_careers: !!j.show_on_careers,
    })
    setQuestions(existing.questions || [])
  }, [existing])

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }))
  }

  function addQuestion() {
    setQuestions((prev) => [...prev, { question: "", type: "text", options: [], required: false }])
  }
  function updateQuestion(index: number, patch: Partial<JobQuestion>) {
    setQuestions((prev) => prev.map((q, i) => (i === index ? { ...q, ...patch } : q)))
  }
  function removeQuestion(index: number) {
    setQuestions((prev) => prev.filter((_, i) => i !== index))
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!form.title.trim()) {
      setError("Job title is required")
      return
    }
    for (const q of questions) {
      if (q.question.trim() && QUESTION_TYPES_WITH_OPTIONS.has(q.type) && q.options.filter(Boolean).length === 0) {
        setError(`Add at least one option for the "${q.question}" question`)
        return
      }
    }
    setLoading(true)
    setError(null)

    const payload = {
      ...form,
      positions: Number(form.positions) || 1,
      salary_from: form.salary_from ? Number(form.salary_from) : null,
      salary_to: form.salary_to ? Number(form.salary_to) : null,
      questions: questions
        .filter((q) => q.question.trim())
        .map((q) => ({ ...q, options: q.options.filter(Boolean) })),
    }

    try {
      const res = await fetch(isEdit ? `/api/recruit/jobs/${jobId}` : "/api/recruit/jobs", {
        method: isEdit ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(body.error || "Unable to save job")
        setLoading(false)
        return
      }
      toast.success(isEdit ? "Job updated" : "Job created")
      router.push("/modules/recruitment/jobs")
    } catch {
      setError("Something went wrong. Please try again.")
      setLoading(false)
    }
  }

  return (
    <main className="mx-auto flex w-full max-w-4xl flex-col gap-6 p-6 md:p-8">
      <div>
        <Button variant="ghost" size="sm" onClick={() => router.push("/modules/recruitment/jobs")} className="mb-2">
          <ArrowLeft data-icon="inline-start" /> Back to jobs
        </Button>
        <PageHeader title={isEdit ? "Edit Job" : "Create Job"} description="Define the role and the questions candidates answer when they apply." />
      </div>

      <form onSubmit={handleSubmit} className="flex flex-col gap-6">
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <Card>
          <CardHeader><CardTitle>Job details</CardTitle></CardHeader>
          <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field className="sm:col-span-2">
              <FieldLabel htmlFor="title">Job title</FieldLabel>
              <Input id="title" value={form.title} onChange={(e) => update("title", e.target.value)} required placeholder="e.g. Senior Frontend Engineer" />
            </Field>
            <Field>
              <FieldLabel htmlFor="department">Department</FieldLabel>
              <Input id="department" value={form.department} onChange={(e) => update("department", e.target.value)} />
            </Field>
            <Field>
              <FieldLabel htmlFor="recruiter">Recruiter</FieldLabel>
              <Input id="recruiter" value={form.recruiter} onChange={(e) => update("recruiter", e.target.value)} />
            </Field>
            <Field>
              <FieldLabel htmlFor="location">Location</FieldLabel>
              <Input id="location" value={form.location} onChange={(e) => update("location", e.target.value)} placeholder="e.g. Bengaluru" />
            </Field>
            <Field>
              <FieldLabel htmlFor="positions">Number of positions</FieldLabel>
              <Input id="positions" type="number" min="1" value={form.positions} onChange={(e) => update("positions", e.target.value)} />
            </Field>
            <Field>
              <FieldLabel htmlFor="job_type">Job type</FieldLabel>
              <Select value={form.job_type} onValueChange={(v) => update("job_type", v)}>
                <SelectTrigger id="job_type" className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {JOB_TYPES.map((t) => <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel htmlFor="work_mode">Work mode</FieldLabel>
              <Select value={form.work_mode} onValueChange={(v) => update("work_mode", v)}>
                <SelectTrigger id="work_mode" className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {WORK_MODES.map((t) => <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel htmlFor="experience">Experience</FieldLabel>
              <Input id="experience" value={form.experience} onChange={(e) => update("experience", e.target.value)} placeholder="e.g. 3-5 years" />
            </Field>
            <Field>
              <FieldLabel htmlFor="status">Status</FieldLabel>
              <Select value={form.status} onValueChange={(v) => update("status", v)}>
                <SelectTrigger id="status" className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {JOB_STATUSES.map((t) => <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel htmlFor="salary_from">Salary from</FieldLabel>
              <Input id="salary_from" type="number" value={form.salary_from} onChange={(e) => update("salary_from", e.target.value)} />
            </Field>
            <Field>
              <FieldLabel htmlFor="salary_to">Salary to</FieldLabel>
              <Input id="salary_to" type="number" value={form.salary_to} onChange={(e) => update("salary_to", e.target.value)} />
            </Field>
            <Field>
              <FieldLabel htmlFor="currency">Currency</FieldLabel>
              <Input id="currency" value={form.currency} onChange={(e) => update("currency", e.target.value.toUpperCase())} />
            </Field>
            <Field>
              <FieldLabel htmlFor="start_date">Start date</FieldLabel>
              <Input id="start_date" type="date" value={form.start_date} onChange={(e) => update("start_date", e.target.value)} />
            </Field>
            <Field>
              <FieldLabel htmlFor="end_date">Closing date</FieldLabel>
              <Input id="end_date" type="date" value={form.end_date} onChange={(e) => update("end_date", e.target.value)} />
            </Field>
            <Field className="sm:col-span-2">
              <FieldLabel htmlFor="skills">Skills</FieldLabel>
              <Input id="skills" value={form.skills} onChange={(e) => update("skills", e.target.value)} placeholder="Comma separated, e.g. React, TypeScript, Node.js" list="skill-suggestions" />
              <datalist id="skill-suggestions">
                {(skillData?.skills ?? []).map((s) => <option key={s.name} value={s.name} />)}
              </datalist>
            </Field>
            <Field className="sm:col-span-2">
              <FieldLabel htmlFor="description">Job description</FieldLabel>
              <Textarea id="description" rows={5} value={form.description} onChange={(e) => update("description", e.target.value)} />
            </Field>
            <Field className="sm:col-span-2">
              <FieldLabel htmlFor="requirements">Requirements</FieldLabel>
              <Textarea id="requirements" rows={4} value={form.requirements} onChange={(e) => update("requirements", e.target.value)} />
            </Field>
            <label className="flex items-center gap-2 text-sm sm:col-span-2">
              <Checkbox checked={form.show_on_careers} onCheckedChange={(v) => update("show_on_careers", v === true)} />
              Show this job on the public careers site
            </label>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Custom application questions</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <p className="-mt-2 text-sm text-muted-foreground">
              Add questions applicants must answer on the public apply form. Leave empty to only collect the standard fields.
            </p>
            {questions.length === 0 && (
              <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">No custom questions yet.</div>
            )}
            {questions.map((q, i) => (
              <div key={i} className="rounded-md border border-border p-4">
                <div className="flex items-start gap-3">
                  <GripVertical className="mt-2 size-4 shrink-0 text-muted-foreground" />
                  <div className="flex-1 grid grid-cols-1 gap-3 sm:grid-cols-[1fr_180px]">
                    <Field>
                      <FieldLabel htmlFor={`q-${i}`}>Question {i + 1}</FieldLabel>
                      <Input id={`q-${i}`} value={q.question} onChange={(e) => updateQuestion(i, { question: e.target.value })} placeholder="e.g. What is your notice period?" />
                    </Field>
                    <Field>
                      <FieldLabel htmlFor={`qt-${i}`}>Answer type</FieldLabel>
                      <Select value={q.type} onValueChange={(v) => updateQuestion(i, { type: v })}>
                        <SelectTrigger id={`qt-${i}`} className="w-full"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {QUESTION_TYPES.map((t) => <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    </Field>
                    {QUESTION_TYPES_WITH_OPTIONS.has(q.type) && (
                      <Field className="sm:col-span-2">
                        <FieldLabel htmlFor={`qo-${i}`}>Options</FieldLabel>
                        <Input id={`qo-${i}`} value={q.options.join(", ")} onChange={(e) => updateQuestion(i, { options: e.target.value.split(",").map((s) => s.trim()) })} placeholder="Comma separated options" />
                      </Field>
                    )}
                  </div>
                  <div className="flex flex-col items-end gap-2">
                    <Button type="button" variant="ghost" size="icon-sm" aria-label="Remove question" onClick={() => removeQuestion(i)}>
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                </div>
                <label className="mt-3 flex items-center gap-2 pl-7 text-sm">
                  <Checkbox checked={q.required} onCheckedChange={(v) => updateQuestion(i, { required: v === true })} />
                  Required
                </label>
              </div>
            ))}
            <div>
              <Button type="button" variant="outline" size="sm" onClick={addQuestion}>
                <Plus data-icon="inline-start" /> Add question
              </Button>
            </div>
          </CardContent>
        </Card>

        <div className="flex items-center justify-end gap-2">
          <Button type="button" variant="outline" onClick={() => router.push("/modules/recruitment/jobs")}>Cancel</Button>
          <Button type="submit" disabled={loading}>
            {loading && <Loader2 className="size-4 animate-spin" data-icon="inline-start" />}
            {isEdit ? "Save changes" : "Create job"}
          </Button>
        </div>
      </form>
    </main>
  )
}
