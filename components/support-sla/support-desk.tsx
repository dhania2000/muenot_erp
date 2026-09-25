"use client"

import { useRef, useState } from "react"
import useSWR from "swr"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"

type SlaState = "met" | "on_track" | "at_risk" | "breached"
type Ticket = {
  id: number
  reference: string
  subject: string
  priority: string
  status: string
  support_level: string
  response_due_at: string
  resolution_due_at: string
  created_at: string
  sla: { response: SlaState; resolution: SlaState; responseRemainingMinutes: number | null; resolutionRemainingMinutes: number | null }
}

const fetcher = async (url: string) => {
  const res = await fetch(url)
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body.error ?? "Request failed")
  return body
}

const SLA_TONE: Record<SlaState, "default" | "secondary" | "destructive" | "outline"> = {
  met: "outline",
  on_track: "secondary",
  at_risk: "default",
  breached: "destructive",
}

function remaining(min: number | null): string {
  if (min == null) return ""
  const abs = Math.abs(min)
  const text = abs >= 1440 ? `${Math.round(abs / 1440)}d` : abs >= 60 ? `${Math.round(abs / 60)}h` : `${abs}m`
  return min < 0 ? `${text} overdue` : `${text} left`
}

function SlaBadge({ label, state, minutes }: { label: string; state: SlaState; minutes: number | null }) {
  return (
    <Badge variant={SLA_TONE[state]} className="font-normal">
      {label}: {state.replace("_", " ")}
      {minutes != null ? ` · ${remaining(minutes)}` : ""}
    </Badge>
  )
}

export function SupportDesk() {
  const { data, error, isLoading, mutate } = useSWR<{ tickets: Ticket[] }>("/api/tenant/support-tickets", fetcher, { refreshInterval: 60_000 })
  const [subject, setSubject] = useState("")
  const [description, setDescription] = useState("")
  const [priority, setPriority] = useState("normal")
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  // One key per logical submission so a double-click or retry cannot open two tickets.
  const idempotencyKey = useRef<string | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setFormError(null)
    setSubmitting(true)
    idempotencyKey.current ??= crypto.randomUUID()
    try {
      const res = await fetch("/api/tenant/support-tickets", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey.current },
        body: JSON.stringify({ subject, description, priority }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error ?? "Unable to open ticket")
      idempotencyKey.current = null
      setSubject("")
      setDescription("")
      setPriority("normal")
      await mutate()
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Unable to open ticket")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[22rem_1fr]">
      <form onSubmit={submit} className="flex flex-col gap-4 rounded-lg border border-border bg-background p-5" aria-labelledby="new-ticket">
        <h2 id="new-ticket" className="font-semibold">Open a ticket</h2>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="subject">Subject</Label>
          <Input id="subject" value={subject} onChange={(e) => { setSubject(e.target.value); idempotencyKey.current = null }} minLength={3} maxLength={200} required />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="priority">Priority</Label>
          <Select value={priority} onValueChange={(v) => { setPriority(v); idempotencyKey.current = null }}>
            <SelectTrigger id="priority"><SelectValue /></SelectTrigger>
            <SelectContent>
              {["low", "normal", "high", "urgent"].map((p) => (
                <SelectItem key={p} value={p} className="capitalize">{p}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="description">Details</Label>
          <Textarea id="description" rows={5} value={description} onChange={(e) => { setDescription(e.target.value); idempotencyKey.current = null }} maxLength={5000} />
        </div>
        {formError && <p role="alert" className="text-sm text-destructive">{formError}</p>}
        <Button type="submit" disabled={submitting}>{submitting ? "Submitting…" : "Submit ticket"}</Button>
        <p className="text-xs text-muted-foreground">Response and resolution targets are set by your plan&apos;s support tier.</p>
      </form>

      <section aria-labelledby="my-tickets" className="flex flex-col gap-3">
        <h2 id="my-tickets" className="font-semibold">Your tickets</h2>
        {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
        {error && <p role="alert" className="text-sm text-destructive">{error.message}</p>}
        {data && data.tickets.length === 0 && <p className="text-sm text-muted-foreground">No tickets yet.</p>}
        <ul className="flex flex-col gap-3">
          {data?.tickets.map((t) => (
            <li key={t.id} className="rounded-lg border border-border bg-background p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="font-medium">{t.subject}</p>
                <Badge variant="outline" className="capitalize">{t.status.replace("_", " ")}</Badge>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                {t.reference} · <span className="capitalize">{t.priority}</span> · {t.support_level} support
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <SlaBadge label="Response" state={t.sla.response} minutes={t.sla.responseRemainingMinutes} />
                <SlaBadge label="Resolution" state={t.sla.resolution} minutes={t.sla.resolutionRemainingMinutes} />
              </div>
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}
