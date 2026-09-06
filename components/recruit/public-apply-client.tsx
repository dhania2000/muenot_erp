"use client"

import { useState } from "react"
import Link from "next/link"
import useSWR from "swr"
import { toast } from "sonner"
import { fetcher } from "@/lib/fetcher"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import { Field, FieldLabel } from "@/components/ui/field"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { ArrowLeft, CheckCircle2, Loader2, MapPin } from "lucide-react"
import { QuestionFields, type Answers } from "@/components/recruit/question-fields"
import type { JobQuestion } from "@/lib/recruit"
import { JOB_TYPES, WORK_MODES, labelFor, salaryRange } from "@/lib/recruit"

type Job = {
  job_id: string
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
  description: string | null
  requirements: string | null
}

const FIELDS = [
  { key: "candidate_name", label: "Full name", required: true, type: "text" },
  { key: "email", label: "Email", required: true, type: "email" },
  { key: "phone", label: "Phone", required: false, type: "tel" },
  { key: "location", label: "Current location", required: false, type: "text" },
  { key: "experience", label: "Total experience", required: false, type: "text" },
  { key: "current_company", label: "Current company", required: false, type: "text" },
  { key: "expected_salary", label: "Expected salary", required: false, type: "text" },
  { key: "resume_url", label: "Resume link (URL)", required: false, type: "url" },
] as const

export function PublicApplyClient({ hash }: { hash: string }) {
  const { data, isLoading, error } = useSWR<{ job: Job; questions: JobQuestion[] }>(
    `/api/recruit/public/job/${hash}`,
    fetcher,
  )
  const [form, setForm] = useState<Record<string, string>>({})
  const [coverLetter, setCoverLetter] = useState("")
  const [answers, setAnswers] = useState<Answers>({})
  const [submitting, setSubmitting] = useState(false)
  const [done, setDone] = useState(false)

  const job = data?.job
  const questions = data?.questions ?? []

  function setField(key: string, value: string) {
    setForm((prev) => ({ ...prev, [key]: value }))
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
      body: JSON.stringify({ hash, ...form, cover_letter: coverLetter, answers }),
    })
    setSubmitting(false)
    if (res.ok) {
      setDone(true)
      window.scrollTo({ top: 0, behavior: "smooth" })
    } else {
      const body = await res.json().catch(() => ({}))
      toast.error(body.error || "Unable to submit your application")
    }
  }

  if (isLoading) {
    return <div className="mx-auto max-w-3xl px-4 py-20 text-center text-sm text-muted-foreground">Loading job…</div>
  }

  if (error || !job) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-20 text-center">
        <h1 className="text-xl font-semibold">Position not available</h1>
        <p className="mt-2 text-sm text-muted-foreground">This role may have closed or the link is invalid.</p>
        <Button className="mt-6" render={<Link href="/careers" />}>
          <ArrowLeft data-icon="inline-start" /> Back to all openings
        </Button>
      </div>
    )
  }

  if (done) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-20 text-center">
        <span className="mx-auto flex size-14 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
          <CheckCircle2 className="size-7" />
        </span>
        <h1 className="mt-6 text-2xl font-semibold tracking-tight">Application submitted</h1>
        <p className="mx-auto mt-2 max-w-md text-pretty text-muted-foreground">
          Thanks for applying to <strong>{job.title}</strong>. Our team will review your application and reach out if
          there&apos;s a fit.
        </p>
        <Button variant="outline" className="mt-6" render={<Link href="/careers" />}>
          View other openings
        </Button>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-10 md:px-6">
      <Button variant="ghost" size="sm" render={<Link href="/careers" />}>
        <ArrowLeft data-icon="inline-start" /> All openings
      </Button>

      <div className="mt-4">
        <h1 className="text-2xl font-semibold tracking-tight text-balance md:text-3xl">{job.title}</h1>
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
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

      {(job.description || job.requirements || job.skills) && (
        <div className="mt-6 flex flex-col gap-6">
          {job.description && (
            <section>
              <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">About the role</h2>
              <p className="whitespace-pre-wrap text-pretty leading-relaxed">{job.description}</p>
            </section>
          )}
          {job.requirements && (
            <section>
              <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">Requirements</h2>
              <p className="whitespace-pre-wrap text-pretty leading-relaxed">{job.requirements}</p>
            </section>
          )}
          {job.skills && (
            <section>
              <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">Skills</h2>
              <div className="flex flex-wrap gap-1.5">
                {job.skills.split(",").map((s) => s.trim()).filter(Boolean).map((s) => (
                  <Badge key={s} variant="outline">{s}</Badge>
                ))}
              </div>
            </section>
          )}
        </div>
      )}

      <Card className="mt-8">
        <CardHeader>
          <CardTitle>Apply for this role</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="flex flex-col gap-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              {FIELDS.map((f) => (
                <Field key={f.key}>
                  <FieldLabel htmlFor={f.key}>
                    {f.label}
                    {f.required && <span className="text-destructive"> *</span>}
                  </FieldLabel>
                  <Input
                    id={f.key}
                    type={f.type}
                    value={form[f.key] || ""}
                    onChange={(e) => setField(f.key, e.target.value)}
                  />
                </Field>
              ))}
            </div>

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

            <Button type="submit" size="lg" disabled={submitting} className="mt-2 w-full sm:w-auto">
              {submitting && <Loader2 className="size-4 animate-spin" data-icon="inline-start" />}
              Submit application
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
