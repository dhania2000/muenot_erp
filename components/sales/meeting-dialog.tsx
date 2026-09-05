"use client"

import { useEffect, useMemo, useState } from "react"
import useSWR from "swr"
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
import { Badge } from "@/components/ui/badge"
import { Checkbox } from "@/components/ui/checkbox"
import { Loader2Icon, VideoIcon, XIcon } from "lucide-react"
import { fetcher } from "@/lib/fetcher"
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

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

type Contact = { name: string | null; email: string; company: string | null; source: string }

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
  duration_minutes: "30",
}

export function MeetingDialog({
  open,
  onOpenChange,
  meeting,
  googleConfigured = false,
  googleConnected = false,
  onSaved,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  meeting: MeetingRow | null
  googleConfigured?: boolean
  googleConnected?: boolean
  onSaved: () => void
}) {
  const [form, setForm] = useState<FormState>(EMPTY)
  const [attendees, setAttendees] = useState<string[]>([])
  const [manualEmail, setManualEmail] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  // Meet scheduling only applies when creating a brand-new meeting.
  const canScheduleMeet = !meeting && googleConfigured
  const meetOn = canScheduleMeet && form.create_meet

  // Pull CRM contacts (leads + companies with emails) only when the picker is visible.
  const { data: contactData } = useSWR<{ contacts: Contact[] }>(
    open && meetOn ? "/api/sales/meeting-contacts" : null,
    fetcher,
  )
  const contacts = contactData?.contacts ?? []
  const availableContacts = useMemo(
    () => contacts.filter((c) => !attendees.includes(c.email)),
    [contacts, attendees],
  )

  useEffect(() => {
    if (!open) return
    setError(null)
    setManualEmail("")
    setAttendees([])
    if (meeting) {
      setForm({
        ...EMPTY,
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

  function addAttendee(email: string) {
    const clean = email.trim().toLowerCase()
    if (!clean) return
    if (!EMAIL_RE.test(clean)) {
      setError(`"${email.trim()}" is not a valid email address`)
      return
    }
    setError(null)
    setAttendees((prev) => (prev.includes(clean) ? prev : [...prev, clean]))
  }

  function addManual() {
    if (!manualEmail.trim()) return
    addAttendee(manualEmail)
    setManualEmail("")
  }

  function removeAttendee(email: string) {
    setAttendees((prev) => prev.filter((e) => e !== email))
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!form.company_name || !form.meeting_date) {
      setError("Company name and date are required")
      return
    }
    if (meetOn) {
      if (!form.meeting_time) {
        setError("Meeting time is required to create a Google Meet")
        return
      }
      if (attendees.length === 0) {
        setError("Add at least one attendee to send invitations")
        return
      }
    }
    setLoading(true)
    setError(null)

    try {
      const payload = {
        ...form,
        create_meet: meetOn,
        attendees: attendees.join(", "),
      }
      const res = await fetch(meeting ? `/api/sales/meetings/${meeting.id}` : "/api/sales/meetings", {
        method: meeting ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
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
                <Select value={form.meeting_type} onValueChange={(v) => update("meeting_type", v ?? "Discovery")}>
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

              {!meeting && (
                <div className="rounded-md border border-border p-3">
                  {canScheduleMeet ? (
                    <label className="flex items-start gap-3">
                      <Checkbox
                        checked={form.create_meet}
                        onCheckedChange={(v) => update("create_meet", v === true)}
                        aria-label="Create a Google Meet"
                      />
                      <span className="flex flex-col gap-0.5">
                        <span className="flex items-center gap-1.5 text-sm font-medium">
                          <VideoIcon className="size-4" />
                          Create Google Meet & send invitations
                        </span>
                        <span className="text-xs text-muted-foreground">
                          Adds a Meet link and emails a calendar invite to every attendee from your Google account.
                        </span>
                      </span>
                    </label>
                  ) : (
                    <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <VideoIcon className="size-4" />
                      {googleConfigured
                        ? "Connect your Google account (button on the Meetings page) to schedule a Meet with invitations."
                        : "Google Meet is not configured for this workspace yet."}
                    </p>
                  )}
                </div>
              )}

              {meetOn && (
                <>
                  <Field>
                    <FieldLabel htmlFor="duration_minutes">Duration</FieldLabel>
                    <Select value={form.duration_minutes} onValueChange={(v) => update("duration_minutes", v ?? "30")}>
                      <SelectTrigger id="duration_minutes" className="w-full">
                        <SelectValue placeholder="Select duration" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          {DURATIONS.map((d) => (
                            <SelectItem key={d.value} value={d.value}>
                              {d.label}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  </Field>

                  <Field>
                    <FieldLabel>Attendees</FieldLabel>

                    {availableContacts.length > 0 && (
                      <Select value="" onValueChange={(email) => email && addAttendee(email)}>
                        <SelectTrigger className="w-full">
                          <SelectValue placeholder="Add from CRM contacts" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectGroup>
                            {availableContacts.map((c) => (
                              <SelectItem key={`${c.source}-${c.email}`} value={c.email}>
                                {c.name ? `${c.name} — ${c.email}` : c.email}
                                {c.company ? ` (${c.company})` : ""}
                              </SelectItem>
                            ))}
                          </SelectGroup>
                        </SelectContent>
                      </Select>
                    )}

                    <div className="flex gap-2">
                      <Input
                        type="email"
                        placeholder="Add email manually"
                        value={manualEmail}
                        onChange={(e) => setManualEmail(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault()
                            addManual()
                          }
                        }}
                      />
                      <Button type="button" variant="outline" onClick={addManual}>
                        Add
                      </Button>
                    </div>

                    {attendees.length > 0 && (
                      <div className="flex flex-wrap gap-1.5 pt-1">
                        {attendees.map((email) => (
                          <Badge key={email} variant="secondary" className="gap-1 pr-1">
                            {email}
                            <button
                              type="button"
                              onClick={() => removeAttendee(email)}
                              className="rounded-sm p-0.5 hover:bg-muted-foreground/20"
                              aria-label={`Remove ${email}`}
                            >
                              <XIcon className="size-3" />
                            </button>
                          </Badge>
                        ))}
                      </div>
                    )}
                  </Field>
                </>
              )}

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
              {meeting ? "Save changes" : meetOn ? "Schedule & send invites" : "Schedule meeting"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
