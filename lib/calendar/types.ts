/**
 * The unified Calendar Event model (spec Phase 3/4).
 *
 * Every event surfaced in the central "My Calendar" — whether it originates
 * from an ERP source table (sales meeting, operations meeting, recruitment
 * interview, …) or from the user's Google Calendar — is projected into this
 * single shape. It is intentionally a SUPERSET of the legacy Google-only event
 * shape the client already renders, so nothing breaks: the original fields
 * (id/title/start/end/allDay/location/description/hangoutLink/htmlLink/status)
 * keep their meaning, and the new fields add source/category/sync context.
 */

export type CalendarSourceModule =
  | "google"
  | "sales"
  | "operations"
  | "recruitment"
  | "hr"
  | "events"
  | "personal"

export type GoogleSyncStatus =
  | "Synced"
  | "Pending"
  | "Failed"
  | "Not Connected"
  | "Cancelled"
  | "Disconnected"

export type UnifiedCalendarEvent = {
  /** Stable, source-qualified id, e.g. "sales:123" or "google:abc". */
  id: string
  title: string
  /** ISO instant for timed events, or "YYYY-MM-DD" for all-day events. */
  start: string
  end: string | null
  allDay: boolean
  location: string | null
  description: string | null
  /** Video/meeting join link (kept as hangoutLink for client compatibility). */
  hangoutLink: string | null
  /** External (Google) event web link, when available. */
  htmlLink: string | null
  status: string | null

  // --- Central-calendar additions ---
  sourceModule: CalendarSourceModule
  /** The primary key / business id of the originating ERP record. */
  sourceRecordId: string | null
  /** Human category used for colour/legend, e.g. "Sales", "Interview". */
  category: string
  /** Organizer display name, when known. */
  organizer: string | null
  /** The Google Calendar event id this record is linked to, if any. */
  externalEventId: string | null
  /** Per-event Google sync state for the status badge. */
  googleSyncStatus: GoogleSyncStatus | null
  /** Deep link back to the originating ERP record (Phase 44). */
  href: string | null
}

/** Category metadata drives the colour legend in the UI. */
export const CATEGORY_META: Record<
  string,
  { label: string; module: CalendarSourceModule }
> = {
  Sales: { label: "Sales", module: "sales" },
  Operations: { label: "Operations", module: "operations" },
  Interview: { label: "Interview", module: "recruitment" },
  HR: { label: "HR", module: "hr" },
  Events: { label: "Events", module: "events" },
  Personal: { label: "Personal", module: "personal" },
}
