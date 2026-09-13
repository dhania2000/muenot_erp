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
import {
  MEETING_TYPES,
  MEETING_DURATIONS,
  MEETING_REMINDERS,
  type MeetingRow,
} from "@/lib/sales/meeting-types"

const NONE = "__none__"
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

type CompanyOption = { id: number; company_name: string; company_email?: string | null }
type LeadOption = {
  id: number
  lead_code: string | null
  company_name: string | null
  contact_person: string | null
  company_id: number | null
}
type ContactOption = { id: number; name: string; email: string | null; is_primary?: number }
type TeamUser = { id: number; name: string }
type CrmContact = { name: string | null; email: string; company: string | null; source: string }

type FormState = {
  meeting_date: string
  meeting_time: string
  duration_minutes: string
  company_id: string
  company_name: string
  contact_id: string
  contact_person: string
  lead_id: string
  owner_id: string
  meeting_type: string
  agenda: string
  location: string
  reminder_minutes: string
  internal_notes: string
  create_google_meet: boolean
}

const EMPTY: FormState = {
  meeting_date: "",
  meeting_time: "",
  duration_minutes: "30",
  company_id: "",
  company_name: "",
  contact_id: "",
  contact_person: "",
  lead_id: "",
  owner_id: "",
  meeting_type: "Discovery",
  agenda: "",
  location: "",
  reminder_minutes: "",
  internal_notes: "",
  create_google_meet: false,
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

  const isEdit = Boolean(meeting)
  const canScheduleMeet = !isEdit && googleConfigured
  const meetOn = canScheduleMeet && form.create_google_meet

  // Selector data — fetched only while the dialog is open.
  const { data: companyData } = useSWR<{ companies: CompanyOption[] }>(
    open ? "/api/sales/companies" : null,
    fetcher,
  )
  const { data: leadData } = useSWR<{ leads: LeadOption[] }>(open ? "/api/sales/leads" : null, fetcher)
  const { data: teamData } = useSWR<{ users: TeamUser[] }>(open ? "/api/sales/team" : null, fetcher)
  const { data: contactData } = useSWR<{ contacts: ContactOption[] }>(
    open && form.company_id ? `/api/sales/companies/${form.company_id}/contacts` : null,
    fetcher,
  )
  const { data: crmData } = useSWR<{ contacts: CrmContact[] }>(
    open && meetOn ? "/api/sales/meeting-contacts" : null,
    fetcher,
  )

  const companies = companyData?.companies ?? []
  const leads = leadData?.leads ?? []
  const team = teamData?.users ?? []
  const companyContacts = contactData?.contacts ?? []
  const crmContacts = crmData?.contacts ?? []
  const availableCrm = useMemo(
    () => crmContacts.filter((c) => !attendees.includes(c.email)),
    [crmContacts, attendees],
  )

  useEffect(() => {
    if (!open) return
    setError(null)
    setManualEmail("")
    if (meeting) {
      setForm({
        ...EMPTY,
        meeting_date: toDateInputValue(meeting.meeting_date),
        meeting_time: meeting.meeting_time || "",
        duration_minutes: meeting.duration_minutes ? String(meeting.duration_minutes) : "30",
        company_id: meeting.company_id ? String(meeting.company_id) : "",
        company_name: meeting.company_name || "",
        contact_id: meeting.contact_id ? String(meeting.contact_id) : "",
        contact_person: meeting.contact_person || "",
        lead_id: meeting.lead_id ? String(meeting.lead_id) : "",
        owner_id: meeting.owner_id ? String(meeting.owner_id) : "",
        meeting_type: meeting.meeting_type || "Discovery",
        agenda: meeting.agenda || "",
        location: meeting.location || "",
        reminder_minutes: meeting.reminder_minutes != null ? String(meeting.reminder_minutes) : "",
        internal_notes: meeting.internal_notes || "",
      })
      setAttendees(meeting.attendees ?? [])
    } else {
      setForm(EMPTY)
      setAttendees([])
    }
  }, [open, meeting])

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }))
  }

  function selectCompany(value: string | null) {
    if (!value || value === NONE) {
      setForm((prev) => ({ ...prev, company_id: "", company_name: "", contact_id: "", contact_person: "" }))
      return
    }
    const company = companies.find((c) => String(c.id) === value)
    setForm((prev) => ({
      ...prev,
      company_id: value,
      company_name: company?.company_name ?? prev.company_name,
      // Reset contact when the company changes so we never keep a mismatched id.
      contact_id: "",
      contact_person: "",
    }))
  }

  function selectContact(value: string | null) {
    if (!value || value === NONE) {
      setForm((prev) => ({ ...prev, contact_id: "", contact_person: "" }))
      return
    }
    const contact = companyContacts.find((c) => String(c.id) === value)
    setForm((prev) => ({ ...prev, contact_id: value, contact_person: contact?.name ?? prev.contact_person }))
  }

  function selectLead(value: string | null) {
    if (!value || value === NONE) {
      update("lead_id", "")
      return
    }
    const lead = leads.find((l) => String(l.id) === value)
    setForm((prev) => ({
      ...prev,
      lead_id: value,
      // Inherit the lead's company/contact when nothing is set yet.
      company_id: prev.company_id || (lead?.company_id ? String(lead.company_id) : prev.company_id),
      company_name: prev.company_name || lead?.company_name || prev.company_name,
      contact_person: prev.contact_person || lead?.contact_person || prev.contact_person,
    }))
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
    if (!form.meeting_date) {
      setError("Meeting date is required")
      return
    }
    if (!form.company_id && !form.company_name && !form.lead_id) {
      setError("Select a company or lead for the meeting")
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
      const payload: Record<string, unknown> = {
        meeting_date: form.meeting_date,
        meeting_time: form.meeting_time || null,
        duration_minutes: form.duration_minutes,
        company_id: form.company_id ? Number(form.company_id) : null,
        company_name: form.company_name || null,
        contact_id: form.contact_id ? Number(form.contact_id) : null,
        contact_person: form.contact_person || null,
        lead_id: form.lead_id ? Number(form.lead_id) : null,
        owner_id: form.owner_id ? Number(form.owner_id) : null,
        meeting_type: form.meeting_type,
        agenda: form.agenda || null,
        location: form.location || null,
        reminder_minutes: form.reminder_minutes ? Number(form.reminder_minutes) : null,
        internal_notes: form.internal_notes || null,
        attendees: attendees.join(", "),
      }
      if (isEdit) {
        payload.row_version = meeting!.row_version
      } else {
        payload.create_google_meet = meetOn
      }

      const res = await fetch(isEdit ? `/api/sales/meetings/${meeting!.id}` : "/api/sales/meetings", {
        method: isEdit ? "PATCH" : "POST",
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
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>{isEdit ? "Edit meeting" : "Schedule meeting"}</DialogTitle>
            <DialogDescription>
              {isEdit ? "Update this meeting's details." : "Log a scheduled meeting and link it to your CRM records."}
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
                  <FieldLabel htmlFor="meeting_type">Type</FieldLabel>
                  <Select value={form.meeting_type} onValueChange={(v) => update("meeting_type", v ?? "Discovery")}>
                    <SelectTrigger id="meeting_type" className="w-full">
                      <SelectValue placeholder="Select type" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {MEETING_TYPES.map((t) => (
                          <SelectItem key={t} value={t}>
                            {t}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </Field>
                <Field>
                  <FieldLabel htmlFor="duration_minutes">Duration</FieldLabel>
                  <Select value={form.duration_minutes} onValueChange={(v) => update("duration_minutes", v ?? "30")}>
                    <SelectTrigger id="duration_minutes" className="w-full">
                      <SelectValue placeholder="Duration" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {MEETING_DURATIONS.map((d) => (
                          <SelectItem key={d.value} value={d.value}>
                            {d.label}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </Field>
              </div>

              <Field>
                <FieldLabel htmlFor="company_id">Company</FieldLabel>
                <Select value={form.company_id || NONE} onValueChange={selectCompany}>
                  <SelectTrigger id="company_id" className="w-full">
                    <SelectValue placeholder="Select company" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value={NONE}>No company</SelectItem>
                      {companies.map((c) => (
                        <SelectItem key={c.id} value={String(c.id)}>
                          {c.company_name}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>

              <div className="grid grid-cols-2 gap-4">
                <Field>
                  <FieldLabel htmlFor="contact_id">Contact</FieldLabel>
                  {form.company_id && companyContacts.length > 0 ? (
                    <Select value={form.contact_id || NONE} onValueChange={selectContact}>
                      <SelectTrigger id="contact_id" className="w-full">
                        <SelectValue placeholder="Select contact" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          <SelectItem value={NONE}>No contact</SelectItem>
                          {companyContacts.map((c) => (
                            <SelectItem key={c.id} value={String(c.id)}>
                              {c.name}
                              {c.email ? ` — ${c.email}` : ""}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  ) : (
                    <Input
                      id="contact_id"
                      placeholder="Contact person"
                      value={form.contact_person}
                      onChange={(e) => update("contact_person", e.target.value)}
                    />
                  )}
                </Field>
                <Field>
                  <FieldLabel htmlFor="lead_id">Lead</FieldLabel>
                  <Select value={form.lead_id || NONE} onValueChange={selectLead}>
                    <SelectTrigger id="lead_id" className="w-full">
                      <SelectValue placeholder="Link a lead" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        <SelectItem value={NONE}>No lead</SelectItem>
                        {leads.map((l) => (
                          <SelectItem key={l.id} value={String(l.id)}>
                            {l.lead_code ? `${l.lead_code} · ` : ""}
                            {l.company_name || l.contact_person || `Lead #${l.id}`}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </Field>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <Field>
                  <FieldLabel htmlFor="owner_id">Owner</FieldLabel>
                  <Select value={form.owner_id || NONE} onValueChange={(v) => update("owner_id", !v || v === NONE ? "" : v)}>
                    <SelectTrigger id="owner_id" className="w-full">
                      <SelectValue placeholder="Assign owner" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        <SelectItem value={NONE}>Me (default)</SelectItem>
                        {team.map((u) => (
                          <SelectItem key={u.id} value={String(u.id)}>
                            {u.name}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </Field>
                <Field>
                  <FieldLabel htmlFor="reminder_minutes">Reminder</FieldLabel>
                  <Select
                    value={form.reminder_minutes || ""}
                    onValueChange={(v) => update("reminder_minutes", v ?? "")}
                  >
                    <SelectTrigger id="reminder_minutes" className="w-full">
                      <SelectValue placeholder="No reminder" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {MEETING_REMINDERS.map((r) => (
                          <SelectItem key={r.value || "none"} value={r.value}>
                            {r.label}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </Field>
              </div>

              <Field>
                <FieldLabel htmlFor="location">Location</FieldLabel>
                <Input
                  id="location"
                  placeholder="Office, address, or video link"
                  value={form.location}
                  onChange={(e) => update("location", e.target.value)}
                />
              </Field>

              <Field>
                <FieldLabel htmlFor="agenda">Agenda</FieldLabel>
                <Textarea
                  id="agenda"
                  rows={2}
                  value={form.agenda}
                  onChange={(e) => update("agenda", e.target.value)}
                />
              </Field>

              <Field>
                <FieldLabel htmlFor="internal_notes">Internal notes</FieldLabel>
                <Textarea
                  id="internal_notes"
                  rows={2}
                  value={form.internal_notes}
                  onChange={(e) => update("internal_notes", e.target.value)}
                />
              </Field>

              {!isEdit && (
                <div className="rounded-md border border-border p-3">
                  {canScheduleMeet ? (
                    <label className="flex items-start gap-3">
                      <Checkbox
                        checked={form.create_google_meet}
                        onCheckedChange={(v) => update("create_google_meet", v === true)}
                        aria-label="Create a Google Meet"
                      />
                      <span className="flex flex-col gap-0.5">
                        <span className="flex items-center gap-1.5 text-sm font-medium">
                          <VideoIcon className="size-4" />
                          Create Google Meet & send invitations
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {googleConnected
                            ? "Adds a Meet link and emails a calendar invite to every attendee."
                            : "Connect the organizer's Google account first to enable invitations."}
                        </span>
                      </span>
                    </label>
                  ) : (
                    <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <VideoIcon className="size-4" />
                      {googleConfigured
                        ? "Connect your Google account (button on the Meetings page) to schedule a Meet."
                        : "Google Meet is not configured for this workspace yet."}
                    </p>
                  )}
                </div>
              )}

              {meetOn && (
                <Field>
                  <FieldLabel>Attendees</FieldLabel>
                  {availableCrm.length > 0 && (
                    <Select value="" onValueChange={(email) => { if (email) addAttendee(email) }}>
                      <SelectTrigger className="w-full">
                        <SelectValue placeholder="Add from CRM contacts" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          {availableCrm.map((c) => (
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
              )}
            </FieldGroup>
          </div>

          <DialogFooter>
            <Button type="submit" disabled={loading}>
              {loading && <Loader2Icon className="animate-spin" data-icon="inline-start" />}
              {isEdit ? "Save changes" : meetOn ? "Schedule & send invites" : "Schedule meeting"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
