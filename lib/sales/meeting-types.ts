// Shared client/server constants + row shapes for the Sales → Meetings module.
// Keeping these in one place avoids the dialog and list importing types from
// each other (which created a circular dependency previously).

export const MEETING_STATUSES = ["Scheduled", "Completed", "Cancelled", "No Show"] as const
export type MeetingStatus = (typeof MEETING_STATUSES)[number]

export const MEETING_TYPES = [
  "Discovery",
  "Demo",
  "Negotiation",
  "Review",
  "Kickoff",
  "Onboarding",
  "Other",
] as const

export const MEETING_OUTCOMES = [
  "Positive",
  "Neutral",
  "Negative",
  "Advanced",
  "Won",
  "Lost",
  "Follow-up needed",
  "No decision",
] as const

export const MEETING_DURATIONS = [
  { value: "15", label: "15 minutes" },
  { value: "30", label: "30 minutes" },
  { value: "45", label: "45 minutes" },
  { value: "60", label: "1 hour" },
  { value: "90", label: "1.5 hours" },
  { value: "120", label: "2 hours" },
] as const

export const MEETING_REMINDERS = [
  { value: "", label: "No reminder" },
  { value: "10", label: "10 minutes before" },
  { value: "30", label: "30 minutes before" },
  { value: "60", label: "1 hour before" },
  { value: "1440", label: "1 day before" },
] as const

export type GoogleSyncStatus = "Synced" | "Pending" | "Failed" | "Not Connected" | "Cancelled"

export type MeetingRow = {
  id: number
  meeting_code: string
  meeting_date: string | null
  meeting_time: string | null
  duration_minutes: number | null
  company_id: number | null
  company_name: string | null
  contact_id: number | null
  contact_person: string | null
  contact_email: string | null
  lead_id: number | null
  lead_code: string | null
  lead_stage: string | null
  lead_status: string | null
  owner_id: number | null
  owner_name: string | null
  follow_up_id: number | null
  meeting_type: string
  status: MeetingStatus
  agenda: string | null
  location: string | null
  attendees: string[]
  reminder_minutes: number | null
  internal_notes: string | null
  outcome: string | null
  outcome_notes: string | null
  next_steps: string | null
  lost_reason: string | null
  reschedule_count: number | null
  completed_at: string | null
  cancelled_at: string | null
  rescheduled_at: string | null
  archived_at: string | null
  google_event_id: string | null
  meet_link: string | null
  google_html_link: string | null
  google_sync_status: GoogleSyncStatus | null
  google_sync_error: string | null
  added_by_name: string | null
  row_version: number
  created_at: string
  updated_at: string | null
}
