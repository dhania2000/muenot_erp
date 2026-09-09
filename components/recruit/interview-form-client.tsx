"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
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
import { INTERVIEW_MODES, INTERVIEW_STATUSES } from "@/lib/recruit"

type ApplicationOption = { application_id: string; candidate_name: string; job_title: string | null }

export function InterviewFormClient() {
  const router = useRouter()
  const { data } = useSWR<{ applications: ApplicationOption[] }>("/api/recruit/applications", fetcher)
  const [form, setForm] = useState({
    application_id: "", candidate_name: "", job_title: "", interviewer: "",
    scheduled_at: "", mode: "video", location: "", round: "", status: "scheduled", rating: 0, feedback: "",
  })
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  function update<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm((prev) => ({ ...prev, [key]: value }))
  }

  function pickApplication(id: string) {
    const app = (data?.applications ?? []).find((a) => a.application_id === id)
    setForm((prev) => ({
      ...prev,
      application_id: id === "none" ? "" : id,
      candidate_name: app?.candidate_name || prev.candidate_name,
      job_title: app?.job_title || prev.job_title,
    }))
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!form.candidate_name.trim()) { setError("Candidate is required"); return }
    setLoading(true)
    setError(null)
    try {
      const res = await fetch("/api/recruit/interviews", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...form, rating: Number(form.rating) || 0 }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) { setError(body.error || "Unable to schedule interview"); setLoading(false); return }
      toast.success("Interview scheduled")
      router.push("/modules/recruitment/interview-schedule")
    } catch {
      setError("Something went wrong. Please try again.")
      setLoading(false)
    }
  }

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-6 md:p-8">
      <div>
        <Button variant="ghost" size="sm" onClick={() => router.push("/modules/recruitment/interview-schedule")} className="mb-2">
          <ArrowLeft data-icon="inline-start" /> Back to interviews
        </Button>
        <PageHeader title="Schedule Interview" description="Set up an interview round for a candidate." />
      </div>

      <form onSubmit={handleSubmit} className="flex flex-col gap-6">
        {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
        <Card>
          <CardHeader><CardTitle>Interview details</CardTitle></CardHeader>
          <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field className="sm:col-span-2">
              <FieldLabel htmlFor="application">Link to application</FieldLabel>
              <Select value={form.application_id || "none"} onValueChange={pickApplication}>
                <SelectTrigger id="application" className="w-full"><SelectValue placeholder="Select an application" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Not linked</SelectItem>
                  {(data?.applications ?? []).map((a) => (
                    <SelectItem key={a.application_id} value={a.application_id}>
                      {a.candidate_name}{a.job_title ? ` — ${a.job_title}` : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel htmlFor="candidate_name">Candidate</FieldLabel>
              <Input id="candidate_name" value={form.candidate_name} onChange={(e) => update("candidate_name", e.target.value)} required />
            </Field>
            <Field>
              <FieldLabel htmlFor="job_title">Job title</FieldLabel>
              <Input id="job_title" value={form.job_title} onChange={(e) => update("job_title", e.target.value)} />
            </Field>
            <Field>
              <FieldLabel htmlFor="interviewer">Interviewer</FieldLabel>
              <Input id="interviewer" value={form.interviewer} onChange={(e) => update("interviewer", e.target.value)} />
            </Field>
            <Field>
              <FieldLabel htmlFor="round">Round</FieldLabel>
              <Input id="round" value={form.round} onChange={(e) => update("round", e.target.value)} placeholder="e.g. Technical Round 1" />
            </Field>
            <Field>
              <FieldLabel htmlFor="scheduled_at">Date & time</FieldLabel>
              <Input id="scheduled_at" type="datetime-local" value={form.scheduled_at} onChange={(e) => update("scheduled_at", e.target.value)} />
            </Field>
            <Field>
              <FieldLabel htmlFor="mode">Mode</FieldLabel>
              <Select value={form.mode} onValueChange={(v) => update("mode", v)}>
                <SelectTrigger id="mode" className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {INTERVIEW_MODES.map((m) => <SelectItem key={m.value} value={m.value}>{m.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </Field>
            <Field className="sm:col-span-2">
              <FieldLabel htmlFor="location">Location / meeting link</FieldLabel>
              <Input id="location" value={form.location} onChange={(e) => update("location", e.target.value)} placeholder="Address or video call link" />
            </Field>
            <Field>
              <FieldLabel htmlFor="status">Status</FieldLabel>
              <Select value={form.status} onValueChange={(v) => update("status", v)}>
                <SelectTrigger id="status" className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {INTERVIEW_STATUSES.map((s) => <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel htmlFor="rating">Rating</FieldLabel>
              <div className="flex h-8 items-center"><RatingStars value={form.rating} onChange={(v) => update("rating", v)} /></div>
            </Field>
            <Field className="sm:col-span-2">
              <FieldLabel htmlFor="feedback">Feedback</FieldLabel>
              <Textarea id="feedback" rows={3} value={form.feedback} onChange={(e) => update("feedback", e.target.value)} />
            </Field>
          </CardContent>
        </Card>
        <div className="flex items-center justify-end gap-2">
          <Button type="button" variant="outline" onClick={() => router.push("/modules/recruitment/interview-schedule")}>Cancel</Button>
          <Button type="submit" disabled={loading}>
            {loading && <Loader2 className="size-4 animate-spin" data-icon="inline-start" />}
            Schedule interview
          </Button>
        </div>
      </form>
    </main>
  )
}
