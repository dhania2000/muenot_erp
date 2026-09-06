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
import { ArrowLeft, Loader2, Wand2 } from "lucide-react"
import { PageHeader } from "@/components/recruit/recruit-shared"
import { OFFER_STATUSES } from "@/lib/recruit"

type ApplicationOption = { application_id: string; candidate_name: string; job_title: string | null }

function template(name: string, job: string, salary: string, joining: string) {
  return `Dear ${name || "[Candidate]"},

We are delighted to offer you the position of ${job || "[Job Title]"}. We were impressed with your background and believe you will be a great addition to our team.

Compensation: ${salary || "[Salary]"} per annum
Proposed joining date: ${joining || "[Joining Date]"}

This offer is contingent upon the successful completion of any background checks. Please confirm your acceptance by signing and returning this letter before the expiry date.

We look forward to welcoming you aboard.

Warm regards,
The Hiring Team`
}

export function OfferFormClient() {
  const router = useRouter()
  const { data } = useSWR<{ applications: ApplicationOption[] }>("/api/recruit/applications", fetcher)
  const [form, setForm] = useState({
    application_id: "", candidate_name: "", job_title: "", salary: "", currency: "INR",
    joining_date: "", expiry_date: "", status: "draft", content: "",
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

  function generate() {
    update("content", template(form.candidate_name, form.job_title, form.salary, form.joining_date))
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!form.candidate_name.trim()) { setError("Candidate is required"); return }
    setLoading(true)
    setError(null)
    try {
      const res = await fetch("/api/recruit/offers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...form, salary: form.salary ? Number(form.salary) : null }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) { setError(body.error || "Unable to create offer"); setLoading(false); return }
      toast.success("Offer letter created")
      router.push("/modules/recruitment/job-offer-letter")
    } catch {
      setError("Something went wrong. Please try again.")
      setLoading(false)
    }
  }

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-6 md:p-8">
      <div>
        <Button variant="ghost" size="sm" onClick={() => router.push("/modules/recruitment/job-offer-letter")} className="mb-2">
          <ArrowLeft data-icon="inline-start" /> Back to offers
        </Button>
        <PageHeader title="Create Offer Letter" description="Prepare an offer for a selected candidate." />
      </div>

      <form onSubmit={handleSubmit} className="flex flex-col gap-6">
        {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
        <Card>
          <CardHeader><CardTitle>Offer details</CardTitle></CardHeader>
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
              <FieldLabel htmlFor="salary">Salary (per annum)</FieldLabel>
              <Input id="salary" type="number" value={form.salary} onChange={(e) => update("salary", e.target.value)} />
            </Field>
            <Field>
              <FieldLabel htmlFor="currency">Currency</FieldLabel>
              <Input id="currency" value={form.currency} onChange={(e) => update("currency", e.target.value.toUpperCase())} />
            </Field>
            <Field>
              <FieldLabel htmlFor="joining_date">Joining date</FieldLabel>
              <Input id="joining_date" type="date" value={form.joining_date} onChange={(e) => update("joining_date", e.target.value)} />
            </Field>
            <Field>
              <FieldLabel htmlFor="expiry_date">Offer expiry date</FieldLabel>
              <Input id="expiry_date" type="date" value={form.expiry_date} onChange={(e) => update("expiry_date", e.target.value)} />
            </Field>
            <Field>
              <FieldLabel htmlFor="status">Status</FieldLabel>
              <Select value={form.status} onValueChange={(v) => update("status", v)}>
                <SelectTrigger id="status" className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {OFFER_STATUSES.map((s) => <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </Field>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Letter content</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <div>
              <Button type="button" variant="outline" size="sm" onClick={generate}>
                <Wand2 data-icon="inline-start" /> Generate from template
              </Button>
            </div>
            <Textarea rows={14} value={form.content} onChange={(e) => update("content", e.target.value)} placeholder="Write or generate the offer letter body..." />
          </CardContent>
        </Card>
        <div className="flex items-center justify-end gap-2">
          <Button type="button" variant="outline" onClick={() => router.push("/modules/recruitment/job-offer-letter")}>Cancel</Button>
          <Button type="submit" disabled={loading}>
            {loading && <Loader2 className="size-4 animate-spin" data-icon="inline-start" />}
            Create offer
          </Button>
        </div>
      </form>
    </main>
  )
}
