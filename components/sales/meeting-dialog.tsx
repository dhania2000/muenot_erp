"use client"

import { useEffect, useState } from "react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Checkbox } from "@/components/ui/checkbox"
import { Loader2Icon, VideoIcon } from "lucide-react"
import { toDateInputValue } from "@/lib/utils"
import type { MeetingRow } from "@/components/sales/meetings-client"

const TYPES = ["Discovery", "Demo", "Negotiation", "Review", "Other"]
const DURATIONS = [
  { value: "15", label: "15 minutes" },
  { value: "30", label: "30 minutes" },
  { value: "45", label: "45 minutes" },
  { value: "60", label: "1 hour" },
  { value: "90", label: "1.5 hours" },
]

type FormState = {
  meeting_date: string
  meeting_time: string
  company_name: string
  contact_person: string
  meeting_type: string
  agenda: string
  outcome_notes: string
  next_steps: string
  create_meet: boolean
  attendees: string
  duration_minutes: string
}

const EMPTY: FormState = {
  meeting_date: "",
  meeting_time: "",
  company_name: "",
  contact_person: "",
  meeting_type: "Discovery",
  agenda: "",
  outcome_notes: "",
  next_steps: "",
  create_meet: false,
  attendees: "",
  duration_minutes: "30",
}

export function MeetingDialog({
  open,
  onOpenChange,
  meeting,
  googleConfigured = false,
  onSaved,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  meeting: MeetingRow | null
  googleConfigured?: boolean
  onSaved: () => void
}) {
  const [form, setForm] = useState<FormState>(EMPTY)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!open) return
    setError(null)
    if (meeting) {
      setForm({
        meeting_date: toDateInputValue(meeting.meeting_date),
        meeting_time: meeting.meeting_time || "",
        company_name: meeting.company_name || "",
        contact_person: meeting.contact_person || "",
        meeting_type: meeting.meeting_type || "Discovery",
        agenda: meeting.agenda || "",
        outcome_notes: meeting.outcome_notes || "",
        next_steps: meeting.next_steps || "",
      })
    } else {
      setForm(EMPTY)
    }
  }, [open, meeting])

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }))
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!form.company_name || !form.meeting_date) {
      setError("Company name and date are required")
      return
    }
    setLoading(true)
    setError(null)

    try {
      const res = await fetch(meeting ? `/api/sales/meetings/${meeting.id}` : "/api/sales/meetings", {
        method: meeting ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(body.error || "Unable to save meeting")
        setLoading(false)
        return
      }
      setLoading(false)
      onSaved()
    } catch {
      setError("Something went wrong. Please try again.")
      setLoading(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>{meeting ? "Edit meeting" : "Schedule meeting"}</DialogTitle>
            <DialogDescription>
              {meeting ? "Update this meeting's details." : "Log a scheduled or completed meeting."}
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-4 py-4">
            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}

            <FieldGroup>
              <div className="grid grid-cols-2 gap-4">
                <Field>
                  <FieldLabel htmlFor="meeting_date">Date</FieldLabel>
                  <Input
                    id="meeting_date"
                    type="date"
                    value={form.meeting_date}
                    onChange={(e) => update("meeting_date", e.target.value)}
                    required
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="meeting_time">Time</FieldLabel>
                  <Input
                    id="meeting_time"
                    type="time"
                    value={form.meeting_time}
                    onChange={(e) => update("meeting_time", e.target.value)}
                  />
                </Field>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <Field>
                  <FieldLabel htmlFor="company_name">Company</FieldLabel>
                  <Input
                    id="company_name"
                    value={form.company_name}
                    onChange={(e) => update("company_name", e.target.value)}
                    required
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="contact_person">Contact person</FieldLabel>
                  <Input
                    id="contact_person"
                    value={form.contact_person}
                    onChange={(e) => update("contact_person", e.target.value)}
                  />
                </Field>
              </div>

              <Field>
                <FieldLabel htmlFor="meeting_type">Meeting type</FieldLabel>
                <Select value={form.meeting_type} onValueChange={(v) => update("meeting_type", v)}>
                  <SelectTrigger id="meeting_type" className="w-full">
                    <SelectValue placeholder="Select type" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {TYPES.map((t) => (
                        <SelectItem key={t} value={t}>
                          {t}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>

              <Field>
                <FieldLabel htmlFor="agenda">Agenda</FieldLabel>
                <Input id="agenda" value={form.agenda} onChange={(e) => update("agenda", e.target.value)} />
              </Field>

              <Field>
                <FieldLabel htmlFor="outcome_notes">Outcome notes</FieldLabel>
                <Textarea
                  id="outcome_notes"
                  rows={3}
                  value={form.outcome_notes}
                  onChange={(e) => update("outcome_notes", e.target.value)}
                />
              </Field>

              <Field>
                <FieldLabel htmlFor="next_steps">Next steps</FieldLabel>
                <Input
                  id="next_steps"
                  value={form.next_steps}
                  onChange={(e) => update("next_steps", e.target.value)}
                />
              </Field>
            </FieldGroup>
          </div>

          <DialogFooter>
            <Button type="submit" disabled={loading}>
              {loading && <Loader2Icon className="animate-spin" data-icon="inline-start" />}
              {meeting ? "Save changes" : "Schedule meeting"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
