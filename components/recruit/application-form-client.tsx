"use client"

import { useEffect, useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import useSWR from "swr"
import { toast } from "sonner"
import { fetcher } from "@/lib/fetcher"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
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
import { ArrowLeft, Loader2 } from "lucide-react"
import { PageHeader, RatingStars } from "@/components/recruit/recruit-shared"
import { QuestionFields, type Answers } from "@/components/recruit/question-fields"
import { APPLICATION_STAGES, type JobQuestion } from "@/lib/recruit"
import type { Job } from "@/lib/recruit-db"

export function ApplicationFormClient() {
  const router = useRouter()
  const params = useSearchParams()
  const { data: jobData } = useSWR<{ jobs: Job[] }>("/api/recruit/jobs", fetcher)

  const [jobId, setJobId] = useState(params.get("jobId") || "")
  const { data: jobDetail } = useSWR<{ job: Job; questions: JobQuestion[] }>(
    jobId ? `/api/recruit/jobs/${jobId}` : null,
    fetcher,
  )

  const [form, setForm] = useState({
    candidate_name: "", email: "", phone: "", location: "", experience: "",
    current_company: "", expected_salary: "", resume_url: "", cover_letter: "",
    source: "Direct", stage: "applied", rating: 0,
  })
  const [answers, setAnswers] = useState<Answers>({})
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => setAnswers({}), [jobId])

  function update<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm((prev) => ({ ...prev, [key]: value }))
  }

  const questions = jobDetail?.questions ?? []

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!form.candidate_name.trim()) {
      setError("Candidate name is required")
      return
    }
    for (const q of questions) {
      if (q.required) {
        const v = answers[String(q.id)]
        if (v === undefined || v === "" || (Array.isArray(v) && v.length === 0)) {
          setError(`Please answer: ${q.question}`)
          return
        }
      }
    }
    setLoading(true)
    setError(null)
    try {
      const res = await fetch("/api/recruit/applications", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...form,
          rating: Number(form.rating) || 0,
          job_id: jobId || null,
          job_title: jobDetail?.job?.title || null,
          answers,
        }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(body.error || "Unable to create application")
        setLoading(false)
        return
      }
      toast.success("Application added")
      router.push("/modules/recruitment/job-applications")
    } catch {
      setError("Something went wrong. Please try again.")
      setLoading(false)
    }
  }

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-6 md:p-8">
      <div>
        <Button variant="ghost" size="sm" onClick={() => router.push("/modules/recruitment/job-applications")} className="mb-2">
          <ArrowLeft data-icon="inline-start" /> Back to applications
        </Button>
        <PageHeader title="Add Application" description="Manually add a candidate to the hiring pipeline." />
      </div>

      <form onSubmit={handleSubmit} className="flex flex-col gap-6">
        {error && (
          <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>
        )}

        <Card>
          <CardHeader><CardTitle>Candidate details</CardTitle></CardHeader>
          <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="job">Job</FieldLabel>
              <Select value={jobId || "none"} onValueChange={(v) => setJobId(v === "none" ? "" : v)}>
                <SelectTrigger id="job" className="w-full"><SelectValue placeholder="Select a job" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No specific job</SelectItem>
                  {(jobData?.jobs ?? []).map((j) => <SelectItem key={j.job_id} value={j.job_id}>{j.title}</SelectItem>)}
                </SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel htmlFor="candidate_name">Candidate name</FieldLabel>
              <Input id="candidate_name" value={form.candidate_name} onChange={(e) => update("candidate_name", e.target.value)} required />
            </Field>
            <Field>
              <FieldLabel htmlFor="email">Email</FieldLabel>
              <Input id="email" type="email" value={form.email} onChange={(e) => update("email", e.target.value)} />
            </Field>
            <Field>
              <FieldLabel htmlFor="phone">Phone</FieldLabel>
              <Input id="phone" value={form.phone} onChange={(e) => update("phone", e.target.value)} />
            </Field>
            <Field>
              <FieldLabel htmlFor="location">Location</FieldLabel>
              <Input id="location" value={form.location} onChange={(e) => update("location", e.target.value)} />
            </Field>
            <Field>
              <FieldLabel htmlFor="experience">Experience</FieldLabel>
              <Input id="experience" value={form.experience} onChange={(e) => update("experience", e.target.value)} placeholder="e.g. 4 years" />
            </Field>
            <Field>
              <FieldLabel htmlFor="current_company">Current company</FieldLabel>
              <Input id="current_company" value={form.current_company} onChange={(e) => update("current_company", e.target.value)} />
            </Field>
            <Field>
              <FieldLabel htmlFor="expected_salary">Expected salary</FieldLabel>
              <Input id="expected_salary" value={form.expected_salary} onChange={(e) => update("expected_salary", e.target.value)} />
            </Field>
            <Field>
              <FieldLabel htmlFor="source">Source</FieldLabel>
              <Input id="source" value={form.source} onChange={(e) => update("source", e.target.value)} placeholder="e.g. LinkedIn, Referral" />
            </Field>
            <Field>
              <FieldLabel htmlFor="resume_url">Resume URL</FieldLabel>
              <Input id="resume_url" type="url" value={form.resume_url} onChange={(e) => update("resume_url", e.target.value)} />
            </Field>
            <Field>
              <FieldLabel htmlFor="stage">Stage</FieldLabel>
              <Select value={form.stage} onValueChange={(v) => update("stage", v)}>
                <SelectTrigger id="stage" className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {APPLICATION_STAGES.map((s) => <SelectItem key={s.key} value={s.key}>{s.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel htmlFor="rating">Rating</FieldLabel>
              <div className="flex h-8 items-center">
                <RatingStars value={form.rating} onChange={(v) => update("rating", v)} />
              </div>
            </Field>
            <Field className="sm:col-span-2">
              <FieldLabel htmlFor="cover_letter">Cover letter / notes</FieldLabel>
              <Textarea id="cover_letter" rows={4} value={form.cover_letter} onChange={(e) => update("cover_letter", e.target.value)} />
            </Field>
          </CardContent>
        </Card>

        {questions.length > 0 && (
          <Card>
            <CardHeader><CardTitle>Screening questions</CardTitle></CardHeader>
            <CardContent>
              <QuestionFields
                questions={questions}
                answers={answers}
                onChange={(id, value) => setAnswers((prev) => ({ ...prev, [id]: value }))}
              />
            </CardContent>
          </Card>
        )}

        <div className="flex items-center justify-end gap-2">
          <Button type="button" variant="outline" onClick={() => router.push("/modules/recruitment/job-applications")}>Cancel</Button>
          <Button type="submit" disabled={loading}>
            {loading && <Loader2 className="size-4 animate-spin" data-icon="inline-start" />}
            Add application
          </Button>
        </div>
      </form>
    </main>
  )
}
