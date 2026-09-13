"use client"

import { useState } from "react"
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
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Checkbox } from "@/components/ui/checkbox"
import { Alert, AlertDescription } from "@/components/ui/alert"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Loader2Icon,
  VideoIcon,
  CheckCircle2Icon,
  CalendarClockIcon,
  XCircleIcon,
  UserXIcon,
  RefreshCwIcon,
  PencilIcon,
  ArchiveIcon,
  ExternalLinkIcon,
  BuildingIcon,
  UserIcon,
  TargetIcon,
} from "lucide-react"
import { fetcher } from "@/lib/fetcher"
import { formatDate, formatDateTime } from "@/lib/utils"
import { MEETING_OUTCOMES, MEETING_DURATIONS, type MeetingRow, type MeetingStatus } from "@/lib/sales/meeting-types"

type Detail = { meeting: MeetingRow; followup: any | null; relatedMeetings: MeetingRow[] }
type ActionKind = "complete" | "reschedule" | "cancel" | "no_show" | "sync_google" | null

const STATUS_STYLE: Record<MeetingStatus, string> = {
  Scheduled: "border-blue-500/30 bg-blue-500/10 text-blue-600 dark:text-blue-400",
  Completed: "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  Cancelled: "border-muted-foreground/30 bg-muted text-muted-foreground",
  "No Show": "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400",
}

export function MeetingDetailDrawer({
  meetingId,
  open,
  onOpenChange,
  onEdit,
  onChanged,
}: {
  meetingId: number | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onEdit: (meeting: MeetingRow) => void
  onChanged: () => void
}) {
  const { data, mutate, isLoading } = useSWR<Detail>(
    open && meetingId ? `/api/sales/meetings/${meetingId}` : null,
    fetcher,
  )
  const [action, setAction] = useState<ActionKind>(null)
  const meeting = data?.meeting

  function afterChange() {
    setAction(null)
    mutate()
    onChanged()
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-2xl">
        {isLoading || !meeting ? (
          <div className="flex items-center justify-center py-16">
            <Loader2Icon className="size-6 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <>
            <DialogHeader>
              <div className="flex flex-wrap items-center gap-2">
                <DialogTitle className="font-mono text-base">{meeting.meeting_code}</DialogTitle>
                <Badge variant="outline" className={STATUS_STYLE[meeting.status]}>
                  {meeting.status}
                </Badge>
                <Badge variant="secondary">{meeting.meeting_type}</Badge>
                {meeting.reschedule_count ? (
                  <Badge variant="outline" className="text-muted-foreground">
                    Rescheduled {meeting.reschedule_count}×
                  </Badge>
                ) : null}
              </div>
              <DialogDescription>
                {formatDate(meeting.meeting_date)}
                {meeting.meeting_time ? ` at ${meeting.meeting_time}` : ""}
                {meeting.duration_minutes ? ` · ${meeting.duration_minutes} min` : ""}
              </DialogDescription>
            </DialogHeader>

            {action ? (
              <ActionForm kind={action} meeting={meeting} onCancel={() => setAction(null)} onDone={afterChange} />
            ) : (
              <div className="flex flex-col gap-5 py-2">
                {meeting.google_sync_status === "Failed" && meeting.google_sync_error && (
                  <Alert variant="destructive">
                    <AlertDescription>Google sync failed: {meeting.google_sync_error}</AlertDescription>
                  </Alert>
                )}

                {/* CRM links */}
                <section className="grid gap-3 sm:grid-cols-3">
                  <InfoTile icon={<BuildingIcon className="size-4" />} label="Company" value={meeting.company_name} />
                  <InfoTile
                    icon={<UserIcon className="size-4" />}
                    label="Contact"
                    value={meeting.contact_person}
                    sub={meeting.contact_email}
                  />
                  <InfoTile
                    icon={<TargetIcon className="size-4" />}
                    label="Lead"
                    value={meeting.lead_code}
                    sub={meeting.lead_status || meeting.lead_stage}
                  />
                </section>

                <section className="grid gap-3 sm:grid-cols-2">
                  <InfoTile label="Owner" value={meeting.owner_name} />
                  <InfoTile label="Location" value={meeting.location} />
                </section>

                {(meeting.meet_link || meeting.google_html_link) && (
                  <section className="flex flex-wrap gap-2">
                    {meeting.meet_link && (
                      <a href={meeting.meet_link} target="_blank" rel="noreferrer">
                        <Button variant="outline" size="sm">
                          <VideoIcon data-icon="inline-start" /> Join Meet
                        </Button>
                      </a>
                    )}
                    {meeting.google_html_link && (
                      <a href={meeting.google_html_link} target="_blank" rel="noreferrer">
                        <Button variant="outline" size="sm">
                          <ExternalLinkIcon data-icon="inline-start" /> Google Calendar
                        </Button>
                      </a>
                    )}
                  </section>
                )}

                {meeting.attendees.length > 0 && (
                  <Section title="Attendees">
                    <div className="flex flex-wrap gap-1.5">
                      {meeting.attendees.map((a) => (
                        <Badge key={a} variant="secondary">
                          {a}
                        </Badge>
                      ))}
                    </div>
                  </Section>
                )}

                {meeting.agenda && (
                  <Section title="Agenda">
                    <p className="whitespace-pre-wrap text-sm text-foreground">{meeting.agenda}</p>
                  </Section>
                )}

                {meeting.internal_notes && (
                  <Section title="Internal notes">
                    <p className="whitespace-pre-wrap text-sm text-muted-foreground">{meeting.internal_notes}</p>
                  </Section>
                )}

                {meeting.status === "Completed" && (
                  <Section title="Outcome">
                    <div className="flex flex-col gap-1.5 text-sm">
                      {meeting.outcome && (
                        <div className="flex gap-2">
                          <span className="text-muted-foreground">Result:</span>
                          <Badge variant="outline">{meeting.outcome}</Badge>
                        </div>
                      )}
                      {meeting.outcome_notes && <p className="whitespace-pre-wrap">{meeting.outcome_notes}</p>}
                      {meeting.next_steps && (
                        <p>
                          <span className="text-muted-foreground">Next steps: </span>
                          {meeting.next_steps}
                        </p>
                      )}
                    </div>
                  </Section>
                )}

                {meeting.status === "Cancelled" && meeting.lost_reason && (
                  <Section title="Cancellation reason">
                    <p className="text-sm text-muted-foreground">{meeting.lost_reason}</p>
                  </Section>
                )}

                {data?.followup && (
                  <Section title="Follow-up">
                    <div className="rounded-md border border-border p-3 text-sm">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-medium">{data.followup.purpose || data.followup.channel || "Follow-up"}</span>
                        <Badge variant="outline">{data.followup.status || "Pending"}</Badge>
                      </div>
                      <p className="mt-1 text-muted-foreground">Due {formatDateTime(data.followup.due_at)}</p>
                    </div>
                  </Section>
                )}

                {data?.relatedMeetings && data.relatedMeetings.length > 0 && (
                  <Section title={`Other meetings with ${meeting.company_name || "this company"}`}>
                    <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
                      {data.relatedMeetings.map((m) => (
                        <li key={m.id} className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
                          <span className="flex items-center gap-2">
                            <span className="font-mono text-xs text-muted-foreground">{m.meeting_code}</span>
                            {formatDate(m.meeting_date)}
                          </span>
                          <Badge variant="outline" className={STATUS_STYLE[m.status]}>
                            {m.status}
                          </Badge>
                        </li>
                      ))}
                    </ul>
                  </Section>
                )}
              </div>
            )}

            {!action && (
              <>
                <Separator />
                <DialogFooter className="flex-wrap gap-2 sm:justify-start">
                  {meeting.status === "Scheduled" && (
                    <>
                      <Button size="sm" onClick={() => setAction("complete")}>
                        <CheckCircle2Icon data-icon="inline-start" /> Complete
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => setAction("reschedule")}>
                        <CalendarClockIcon data-icon="inline-start" /> Reschedule
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => setAction("no_show")}>
                        <UserXIcon data-icon="inline-start" /> No show
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => setAction("cancel")}>
                        <XCircleIcon data-icon="inline-start" /> Cancel
                      </Button>
                    </>
                  )}
                  {(meeting.status === "Cancelled" || meeting.google_sync_status === "Failed") && (
                    <Button size="sm" variant="outline" onClick={() => setAction("sync_google")}>
                      <RefreshCwIcon data-icon="inline-start" /> Sync Google
                    </Button>
                  )}
                  <Button size="sm" variant="outline" onClick={() => onEdit(meeting)}>
                    <PencilIcon data-icon="inline-start" /> Edit
                  </Button>
                  <ArchiveButton meetingId={meeting.id} onDone={() => { onOpenChange(false); onChanged() }} />
                </DialogFooter>
              </>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</h3>
      {children}
    </section>
  )
}

function InfoTile({
  icon,
  label,
  value,
  sub,
}: {
  icon?: React.ReactNode
  label: string
  value: string | null | undefined
  sub?: string | null
}) {
  return (
    <div className="rounded-md border border-border p-3">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        {icon}
        {label}
      </div>
      <p className="mt-1 truncate text-sm font-medium">{value || "—"}</p>
      {sub && <p className="truncate text-xs text-muted-foreground">{sub}</p>}
    </div>
  )
}

function ArchiveButton({ meetingId, onDone }: { meetingId: number; onDone: () => void }) {
  const [loading, setLoading] = useState(false)
  const [confirm, setConfirm] = useState(false)

  async function archive() {
    setLoading(true)
    const res = await fetch(`/api/sales/meetings/${meetingId}`, { method: "DELETE" })
    setLoading(false)
    if (res.ok) onDone()
  }

  if (!confirm) {
    return (
      <Button size="sm" variant="ghost" className="text-destructive" onClick={() => setConfirm(true)}>
        <ArchiveIcon data-icon="inline-start" /> Archive
      </Button>
    )
  }
  return (
    <Button size="sm" variant="destructive" disabled={loading} onClick={archive}>
      {loading && <Loader2Icon className="animate-spin" data-icon="inline-start" />}
      Confirm archive
    </Button>
  )
}

/* -------------------------------------------------------------------------- */
/* Lifecycle action forms                                                     */
/* -------------------------------------------------------------------------- */

function ActionForm({
  kind,
  meeting,
  onCancel,
  onDone,
}: {
  kind: Exclude<ActionKind, null>
  meeting: MeetingRow
  onCancel: () => void
  onDone: () => void
}) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // complete
  const [outcome, setOutcome] = useState<string>("")
  const [outcomeNotes, setOutcomeNotes] = useState("")
  const [nextSteps, setNextSteps] = useState("")
  const [createFollowUp, setCreateFollowUp] = useState(false)
  const [followUpAt, setFollowUpAt] = useState("")
  const [followUpChannel, setFollowUpChannel] = useState("Call")
  const [followUpPurpose, setFollowUpPurpose] = useState("")

  // reschedule
  const [date, setDate] = useState(meeting.meeting_date ? meeting.meeting_date.slice(0, 10) : "")
  const [time, setTime] = useState(meeting.meeting_time || "")
  const [duration, setDuration] = useState(meeting.duration_minutes ? String(meeting.duration_minutes) : "30")

  // cancel
  const [reason, setReason] = useState("")

  const TITLES: Record<typeof kind, string> = {
    complete: "Complete meeting",
    reschedule: "Reschedule meeting",
    cancel: "Cancel meeting",
    no_show: "Mark as no show",
    sync_google: "Re-sync with Google",
  }

  async function submit() {
    setLoading(true)
    setError(null)
    const body: Record<string, unknown> = { action: kind }
    if (kind === "complete") {
      body.outcome = outcome || null
      body.outcome_notes = outcomeNotes || null
      body.next_steps = nextSteps || null
      body.create_follow_up = createFollowUp
      body.follow_up_at = createFollowUp ? followUpAt || null : null
      body.follow_up_channel = createFollowUp ? followUpChannel : null
      body.follow_up_purpose = createFollowUp ? followUpPurpose || null : null
    } else if (kind === "reschedule") {
      if (!date) {
        setError("Pick a new date")
        setLoading(false)
        return
      }
      body.meeting_date = date
      body.meeting_time = time || null
      body.duration_minutes = duration
      body.reason = reason || null
    } else if (kind === "cancel") {
      body.reason = reason || null
    }

    const res = await fetch(`/api/sales/meetings/${meeting.id}/action`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
    const json = await res.json().catch(() => ({}))
    setLoading(false)
    if (!res.ok) {
      setError(json.error || "Action failed")
      return
    }
    onDone()
  }

  return (
    <div className="flex flex-col gap-4 py-2">
      <h3 className="text-sm font-semibold">{TITLES[kind]}</h3>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {kind === "complete" && (
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="outcome">Outcome</FieldLabel>
            <Select value={outcome} onValueChange={(v) => setOutcome(v ?? "")}>
              <SelectTrigger id="outcome" className="w-full">
                <SelectValue placeholder="Select outcome" />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {MEETING_OUTCOMES.map((o) => (
                    <SelectItem key={o} value={o}>
                      {o}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
          <Field>
            <FieldLabel htmlFor="outcome_notes">Notes</FieldLabel>
            <Textarea id="outcome_notes" rows={3} value={outcomeNotes} onChange={(e) => setOutcomeNotes(e.target.value)} />
          </Field>
          <Field>
            <FieldLabel htmlFor="next_steps">Next steps</FieldLabel>
            <Input id="next_steps" value={nextSteps} onChange={(e) => setNextSteps(e.target.value)} />
          </Field>
          <div className="rounded-md border border-border p-3">
            <label className="flex items-center gap-2 text-sm font-medium">
              <Checkbox
                checked={createFollowUp}
                onCheckedChange={(v) => setCreateFollowUp(v === true)}
                aria-label="Create a follow-up"
              />
              Create a follow-up task
            </label>
            {createFollowUp && (
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <Field>
                  <FieldLabel htmlFor="follow_up_at">Due</FieldLabel>
                  <Input
                    id="follow_up_at"
                    type="datetime-local"
                    value={followUpAt}
                    onChange={(e) => setFollowUpAt(e.target.value)}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="follow_up_channel">Channel</FieldLabel>
                  <Select value={followUpChannel} onValueChange={(v) => setFollowUpChannel(v ?? "Call")}>
                    <SelectTrigger id="follow_up_channel" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {["Call", "Email", "Meeting", "WhatsApp", "Other"].map((c) => (
                          <SelectItem key={c} value={c}>
                            {c}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </Field>
                <Field className="sm:col-span-2">
                  <FieldLabel htmlFor="follow_up_purpose">Purpose</FieldLabel>
                  <Input
                    id="follow_up_purpose"
                    value={followUpPurpose}
                    onChange={(e) => setFollowUpPurpose(e.target.value)}
                  />
                </Field>
              </div>
            )}
          </div>
        </FieldGroup>
      )}

      {kind === "reschedule" && (
        <FieldGroup>
          <div className="grid grid-cols-3 gap-3">
            <Field>
              <FieldLabel htmlFor="rs_date">Date</FieldLabel>
              <Input id="rs_date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </Field>
            <Field>
              <FieldLabel htmlFor="rs_time">Time</FieldLabel>
              <Input id="rs_time" type="time" value={time} onChange={(e) => setTime(e.target.value)} />
            </Field>
            <Field>
              <FieldLabel htmlFor="rs_duration">Duration</FieldLabel>
              <Select value={duration} onValueChange={(v) => setDuration(v ?? "30")}>
                <SelectTrigger id="rs_duration" className="w-full">
                  <SelectValue />
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
            <FieldLabel htmlFor="rs_reason">Reason (optional)</FieldLabel>
            <Input id="rs_reason" value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
        </FieldGroup>
      )}

      {kind === "cancel" && (
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="cancel_reason">Reason (optional)</FieldLabel>
            <Textarea id="cancel_reason" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
        </FieldGroup>
      )}

      {kind === "no_show" && (
        <p className="text-sm text-muted-foreground">
          Mark this meeting as a no show. It stays on record and its Google event, if any, will be updated.
        </p>
      )}

      {kind === "sync_google" && (
        <p className="text-sm text-muted-foreground">
          Recreate the Google Calendar event and Meet link for this meeting using the organizer&apos;s connected
          account.
        </p>
      )}

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel} disabled={loading}>
          Back
        </Button>
        <Button type="button" onClick={submit} disabled={loading}>
          {loading && <Loader2Icon className="animate-spin" data-icon="inline-start" />}
          Confirm
        </Button>
      </DialogFooter>
    </div>
  )
}
