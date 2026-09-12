import type { PoolConnection } from "mysql2/promise"
import { pool, query } from "@/lib/db"
import {
  ensureLeadLifecycleSchema,
  recordAudit,
  notify,
  attachLeadEvent,
  createFollowUp,
  type Actor,
} from "@/lib/sales/lead-lifecycle"
import { ensureCompanyMasterSchema, resolveCompanyId } from "@/lib/sales/company-master"
import { getGoogleAccountForUser } from "@/lib/google-accounts"
import {
  createMeetEventForUser,
  updateMeetEventForUser,
  cancelMeetEventForUser,
  GoogleEventGoneError,
  DEFAULT_TIME_ZONE,
} from "@/lib/google-calendar"

/* -------------------------------------------------------------------------- */
/* Types & constants                                                          */
/* -------------------------------------------------------------------------- */

export const MEETING_STATUSES = ["Scheduled", "Completed", "Cancelled", "No Show"] as const
export type MeetingStatus = (typeof MEETING_STATUSES)[number]

export const MEETING_TYPES = ["Discovery", "Demo", "Negotiation", "Review", "Onboarding", "Other"] as const

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

export const REMINDER_OPTIONS = [
  { label: "No reminder", value: null },
  { label: "10 minutes before", value: 10 },
  { label: "30 minutes before", value: 30 },
  { label: "1 hour before", value: 60 },
  { label: "1 day before", value: 1440 },
] as const

export type GoogleSyncStatus = "Synced" | "Pending" | "Failed" | "Not Connected" | "Cancelled"

export class MeetingNotFoundError extends Error {
  constructor(message = "Meeting not found") {
    super(message)
    this.name = "MeetingNotFoundError"
  }
}

export class MeetingConflictError extends Error {
  constructor(message = "This meeting was updated by someone else. Reload and try again.") {
    super(message)
    this.name = "MeetingConflictError"
  }
}

export class MeetingValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "MeetingValidationError"
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/* -------------------------------------------------------------------------- */
/* Schema self-heal                                                           */
/* -------------------------------------------------------------------------- */

let schemaReady: Promise<void> | null = null

async function addColumn(table: string, column: string, definition: string) {
  const [rows] = await pool.query<any[]>(
    `SELECT COUNT(*) AS c FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
    [table, column],
  )
  if (Number(rows[0]?.c || 0) === 0) {
    await pool.query(`ALTER TABLE \`${table}\` ADD COLUMN ${definition}`)
  }
}

async function addIndex(table: string, indexName: string, columns: string) {
  const [rows] = await pool.query<any[]>(
    `SELECT COUNT(*) AS c FROM information_schema.statistics
     WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?`,
    [table, indexName],
  )
  if (Number(rows[0]?.c || 0) === 0) {
    await pool.query(`ALTER TABLE \`${table}\` ADD INDEX \`${indexName}\` (${columns})`)
  }
}

/**
 * Idempotently extend the legacy `sales_meetings` table with the relationship,
 * lifecycle, sync and concurrency columns the modern module needs. Runs at most
 * once per process. Company master + lead lifecycle schemas are ensured first so
 * the FK-ish integer columns line up with those tables.
 */
export async function ensureMeetingSchema(): Promise<void> {
  if (schemaReady) return schemaReady
  schemaReady = (async () => {
    await ensureCompanyMasterSchema()
    await ensureLeadLifecycleSchema()

    // Relationships.
    await addColumn("sales_meetings", "company_id", "`company_id` INT UNSIGNED NULL AFTER `company_name`")
    await addColumn("sales_meetings", "contact_id", "`contact_id` INT UNSIGNED NULL AFTER `contact_person`")
    await addColumn("sales_meetings", "lead_id", "`lead_id` INT UNSIGNED NULL AFTER `contact_id`")
    await addColumn("sales_meetings", "owner_id", "`owner_id` INT UNSIGNED NULL AFTER `lead_id`")
    await addColumn("sales_meetings", "follow_up_id", "`follow_up_id` INT UNSIGNED NULL AFTER `owner_id`")

    // Scheduling / conferencing (may already exist from earlier ad-hoc writes).
    await addColumn("sales_meetings", "duration_minutes", "`duration_minutes` INT UNSIGNED NULL DEFAULT 30")
    await addColumn("sales_meetings", "attendees", "`attendees` TEXT NULL")
    await addColumn("sales_meetings", "location", "`location` VARCHAR(255) NULL")
    await addColumn("sales_meetings", "reminder_minutes", "`reminder_minutes` INT UNSIGNED NULL")

    // Lifecycle.
    await addColumn(
      "sales_meetings",
      "status",
      "`status` ENUM('Scheduled','Completed','Cancelled','No Show') NOT NULL DEFAULT 'Scheduled' AFTER `meeting_type`",
    )
    await addColumn("sales_meetings", "outcome", "`outcome` VARCHAR(40) NULL")
    await addColumn("sales_meetings", "lost_reason", "`lost_reason` VARCHAR(120) NULL")
    await addColumn("sales_meetings", "internal_notes", "`internal_notes` TEXT NULL")
    await addColumn("sales_meetings", "reschedule_count", "`reschedule_count` INT UNSIGNED NOT NULL DEFAULT 0")
    await addColumn("sales_meetings", "completed_at", "`completed_at` DATETIME NULL")
    await addColumn("sales_meetings", "cancelled_at", "`cancelled_at` DATETIME NULL")
    await addColumn("sales_meetings", "rescheduled_at", "`rescheduled_at` DATETIME NULL")
    await addColumn("sales_meetings", "archived_at", "`archived_at` DATETIME NULL")

    // Google sync.
    await addColumn("sales_meetings", "google_event_id", "`google_event_id` VARCHAR(255) NULL")
    await addColumn("sales_meetings", "meet_link", "`meet_link` VARCHAR(500) NULL")
    await addColumn("sales_meetings", "google_html_link", "`google_html_link` VARCHAR(500) NULL")
    await addColumn("sales_meetings", "google_organizer_id", "`google_organizer_id` INT UNSIGNED NULL")
    await addColumn(
      "sales_meetings",
      "google_sync_status",
      "`google_sync_status` ENUM('Synced','Pending','Failed','Not Connected','Cancelled') NULL",
    )
    await addColumn("sales_meetings", "google_sync_error", "`google_sync_error` VARCHAR(500) NULL")

    // Concurrency.
    await addColumn("sales_meetings", "row_version", "`row_version` INT UNSIGNED NOT NULL DEFAULT 1")

    // Backfill owner from legacy added_by, and default status.
    await pool.query(`UPDATE sales_meetings SET owner_id = added_by WHERE owner_id IS NULL AND added_by IS NOT NULL`)
    await pool.query(`UPDATE sales_meetings SET status = 'Scheduled' WHERE status IS NULL`)

    // Link legacy free-text company_name rows to the company master where an exact match exists.
    await pool
      .query(
        `UPDATE sales_meetings m
         JOIN sales_companies c ON c.company_name = m.company_name AND c.archived_at IS NULL
         SET m.company_id = c.id
         WHERE m.company_id IS NULL AND m.company_name IS NOT NULL AND m.company_name <> ''`,
      )
      .catch(() => {})

    await addIndex("sales_meetings", "idx_meetings_date", "`meeting_date`")
    await addIndex("sales_meetings", "idx_meetings_status", "`status`")
    await addIndex("sales_meetings", "idx_meetings_company", "`company_id`")
    await addIndex("sales_meetings", "idx_meetings_lead", "`lead_id`")
    await addIndex("sales_meetings", "idx_meetings_contact", "`contact_id`")
    await addIndex("sales_meetings", "idx_meetings_owner", "`owner_id`")
    await addIndex("sales_meetings", "idx_meetings_type", "`meeting_type`")
    await addIndex("sales_meetings", "idx_meetings_gevent", "`google_event_id`")
  })().catch((err) => {
    // Reset so a transient failure can be retried on the next call.
    schemaReady = null
    throw err
  })
  return schemaReady
}

/* -------------------------------------------------------------------------- */
/* Race-safe meeting code (MM-###) via record_id_sequences                    */
/* -------------------------------------------------------------------------- */

async function nextMeetingCode(conn: PoolConnection): Promise<string> {
  // Seed the sequence from any legacy MAX(meeting_code) the first time so we
  // never collide with pre-existing MM-001 style codes.
  await conn.query(
    `INSERT INTO record_id_sequences (prefix, next_number)
     VALUES ('MM', GREATEST(
       1,
       COALESCE((SELECT MAX(CAST(REGEXP_REPLACE(meeting_code, '[^0-9]', '') AS UNSIGNED)) FROM sales_meetings), 0) + 1
     ))
     ON DUPLICATE KEY UPDATE next_number = next_number + 1`,
  )
  const [cur] = await conn.query<any[]>(`SELECT next_number FROM record_id_sequences WHERE prefix = 'MM' FOR UPDATE`)
  const n = Number(cur[0]?.next_number || 1)
  return `MM-${String(n).padStart(3, "0")}`
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

export type MeetingInput = {
  meeting_date: string
  meeting_time?: string | null
  duration_minutes?: number | null
  company_id?: number | null
  company_name?: string | null
  contact_id?: number | null
  contact_person?: string | null
  lead_id?: number | null
  owner_id?: number | null
  meeting_type?: string
  agenda?: string | null
  location?: string | null
  attendees?: string[] | string | null
  reminder_minutes?: number | null
  internal_notes?: string | null
  create_google_meet?: boolean
}

function parseAttendees(input: MeetingInput["attendees"]): string[] {
  if (!input) return []
  const arr = Array.isArray(input) ? input : String(input).split(/[\s,;]+/)
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of arr) {
    const email = String(raw || "").trim().toLowerCase()
    if (email && EMAIL_RE.test(email) && !seen.has(email)) {
      seen.add(email)
      out.push(email)
    }
  }
  return out
}

function toLocalDateTime(date: string, time?: string | null): string {
  const t = (time && /^\d{2}:\d{2}/.test(time) ? time : "09:00").slice(0, 5)
  return `${date}T${t}:00`
}

function addMinutes(date: string, time: string | null | undefined, minutes: number): string {
  const start = new Date(`${toLocalDateTime(date, time)}`)
  const end = new Date(start.getTime() + minutes * 60_000)
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${end.getFullYear()}-${pad(end.getMonth() + 1)}-${pad(end.getDate())}T${pad(end.getHours())}:${pad(
    end.getMinutes(),
  )}:00`
}

/** Resolve the relationship graph (company, contact, lead) into a consistent set. */
async function resolveRelationships(input: MeetingInput, actorId: Actor) {
  let companyId = input.company_id ?? null
  let companyName = input.company_name?.trim() || null
  let contactId = input.contact_id ?? null
  let contactPerson = input.contact_person?.trim() || null
  let leadId = input.lead_id ?? null

  // A linked lead is the strongest signal — inherit its company/contact.
  if (leadId) {
    const [rows] = await pool.query<any[]>(
      `SELECT id, company_id, company_name, contact_person, contact_id FROM sales_leads WHERE id = ? AND archived_at IS NULL`,
      [leadId],
    )
    const lead = rows[0]
    if (!lead) throw new MeetingValidationError("Linked lead no longer exists.")
    companyId = companyId ?? lead.company_id ?? null
    companyName = companyName ?? lead.company_name ?? null
    contactId = contactId ?? lead.contact_id ?? null
    contactPerson = contactPerson ?? lead.contact_person ?? null
  }

  // Link to the company master when the free-text name uniquely matches an
  // existing company. Otherwise keep the name as a snapshot (company_id stays null).
  if (!companyId && companyName) {
    companyId = await resolveCompanyId({ company_name: companyName }).catch(() => null)
  }
  if (companyId && !companyName) {
    const [rows] = await pool.query<any[]>(`SELECT company_name FROM sales_companies WHERE id = ?`, [companyId])
    companyName = rows[0]?.company_name ?? companyName
  }

  // Resolve contact details from the contacts master when an id was given.
  if (contactId) {
    const [rows] = await pool.query<any[]>(`SELECT id, name, company_id FROM sales_contacts WHERE id = ?`, [contactId])
    const c = rows[0]
    if (c) {
      contactPerson = contactPerson ?? c.name ?? null
      companyId = companyId ?? c.company_id ?? null
    } else {
      contactId = null
    }
  }

  return { companyId, companyName, contactId, contactPerson, leadId }
}

/* -------------------------------------------------------------------------- */
/* Google sync (best-effort; never blocks the DB transaction)                 */
/* -------------------------------------------------------------------------- */

type GoogleSyncResult = {
  status: GoogleSyncStatus
  eventId: string | null
  meetLink: string | null
  htmlLink: string | null
  organizerId: number | null
  error: string | null
}

async function syncCreateGoogle(
  ownerId: number,
  meeting: { code: string; input: MeetingInput; companyName: string | null; attendees: string[] },
): Promise<GoogleSyncResult> {
  const empty: GoogleSyncResult = {
    status: "Not Connected",
    eventId: null,
    meetLink: null,
    htmlLink: null,
    organizerId: null,
    error: null,
  }
  const account = await getGoogleAccountForUser(ownerId).catch(() => null)
  if (!account?.refresh_token) return empty
  try {
    const res = await createMeetEventForUser(account.refresh_token, {
      summary: `${meeting.input.meeting_type || "Meeting"}: ${meeting.companyName || meeting.code}`,
      description: meeting.input.agenda || undefined,
      startDateTime: toLocalDateTime(meeting.input.meeting_date, meeting.input.meeting_time),
      endDateTime: addMinutes(
        meeting.input.meeting_date,
        meeting.input.meeting_time,
        meeting.input.duration_minutes || 30,
      ),
      timeZone: DEFAULT_TIME_ZONE,
      attendees: meeting.attendees,
      reminderMinutes: meeting.input.reminder_minutes ?? null,
    })
    return {
      status: "Synced",
      eventId: res.eventId,
      meetLink: res.meetLink,
      htmlLink: res.htmlLink,
      organizerId: ownerId,
      error: null,
    }
  } catch (err: any) {
    return { ...empty, status: "Failed", error: String(err?.message || err).slice(0, 480) }
  }
}

/* -------------------------------------------------------------------------- */
/* Read                                                                       */
/* -------------------------------------------------------------------------- */

const MEETING_SELECT = `
  SELECT m.*, u.name AS owner_name, ab.name AS added_by_name,
         c.company_name AS company_master_name, c.id AS company_master_id,
         ct.name AS contact_master_name, ct.email AS contact_email,
         l.lead_code, l.status AS lead_stage, l.lead_status
  FROM sales_meetings m
  LEFT JOIN users u ON u.id = m.owner_id
  LEFT JOIN users ab ON ab.id = m.added_by
  LEFT JOIN sales_companies c ON c.id = m.company_id
  LEFT JOIN sales_contacts ct ON ct.id = m.contact_id
  LEFT JOIN sales_leads l ON l.id = m.lead_id
`

export type MeetingListFilters = {
  status?: string
  type?: string
  ownerId?: number
  companyId?: number
  leadId?: number
  search?: string
  from?: string
  to?: string
  includeArchived?: boolean
  scope?: "upcoming" | "past" | "today" | "all"
}

export async function listMeetings(filters: MeetingListFilters = {}) {
  await ensureMeetingSchema()
  const where: string[] = []
  const params: any[] = []

  if (!filters.includeArchived) where.push("m.archived_at IS NULL")
  if (filters.status) {
    where.push("m.status = ?")
    params.push(filters.status)
  }
  if (filters.type) {
    where.push("m.meeting_type = ?")
    params.push(filters.type)
  }
  if (filters.ownerId) {
    where.push("m.owner_id = ?")
    params.push(filters.ownerId)
  }
  if (filters.companyId) {
    where.push("m.company_id = ?")
    params.push(filters.companyId)
  }
  if (filters.leadId) {
    where.push("m.lead_id = ?")
    params.push(filters.leadId)
  }
  if (filters.from) {
    where.push("m.meeting_date >= ?")
    params.push(filters.from)
  }
  if (filters.to) {
    where.push("m.meeting_date <= ?")
    params.push(filters.to)
  }
  if (filters.scope === "upcoming") {
    where.push("m.meeting_date >= CURDATE() AND m.status = 'Scheduled'")
  } else if (filters.scope === "past") {
    where.push("m.meeting_date < CURDATE()")
  } else if (filters.scope === "today") {
    where.push("m.meeting_date = CURDATE()")
  }
  if (filters.search) {
    where.push(
      "(m.meeting_code LIKE ? OR m.company_name LIKE ? OR m.contact_person LIKE ? OR m.agenda LIKE ?)",
    )
    const like = `%${filters.search}%`
    params.push(like, like, like, like)
  }

  const clause = where.length ? `WHERE ${where.join(" AND ")}` : ""
  const meetings = await query<any[]>(
    `${MEETING_SELECT} ${clause} ORDER BY m.meeting_date DESC, m.meeting_time DESC, m.id DESC`,
    params,
  )
  return meetings.map(normalizeRow)
}

export async function getMeeting(id: number) {
  await ensureMeetingSchema()
  const rows = await query<any[]>(`${MEETING_SELECT} WHERE m.id = ?`, [id])
  if (!rows[0]) return null
  return normalizeRow(rows[0])
}

/** Meeting + its related records (lead timeline snippet, follow-up, company) for the detail drawer. */
export async function getMeetingDetail(id: number) {
  const meeting = await getMeeting(id)
  if (!meeting) return null

  const [followup, relatedMeetings] = await Promise.all([
    meeting.follow_up_id
      ? query<any[]>(`SELECT * FROM sales_lead_followups WHERE id = ?`, [meeting.follow_up_id]).then((r) => r[0] ?? null)
      : Promise.resolve(null),
    meeting.company_id
      ? query<any[]>(
          `SELECT id, meeting_code, meeting_date, meeting_time, meeting_type, status
           FROM sales_meetings
           WHERE company_id = ? AND id <> ? AND archived_at IS NULL
           ORDER BY meeting_date DESC LIMIT 5`,
          [meeting.company_id, id],
        )
      : Promise.resolve([]),
  ])

  return { meeting, followup, relatedMeetings }
}

function normalizeRow(row: any) {
  let attendees: string[] = []
  if (row.attendees) {
    try {
      const parsed = JSON.parse(row.attendees)
      attendees = Array.isArray(parsed) ? parsed : []
    } catch {
      attendees = String(row.attendees)
        .split(/[\s,;]+/)
        .filter(Boolean)
    }
  }
  return { ...row, attendees }
}

/* -------------------------------------------------------------------------- */
/* Create                                                                     */
/* -------------------------------------------------------------------------- */

export async function createMeeting(input: MeetingInput, actorId: Actor) {
  await ensureMeetingSchema()
  if (!input.meeting_date) throw new MeetingValidationError("Meeting date is required.")

  const ownerId = input.owner_id ?? actorId ?? null
  const attendees = parseAttendees(input.attendees)
  const rel = await resolveRelationships(input, actorId)

  // Google sync happens BEFORE the insert so we persist the event id atomically.
  let sync: GoogleSyncResult = {
    status: "Not Connected",
    eventId: null,
    meetLink: null,
    htmlLink: null,
    organizerId: null,
    error: null,
  }
  if (input.create_google_meet && ownerId) {
    sync = await syncCreateGoogle(ownerId, {
      code: "meeting",
      input,
      companyName: rel.companyName,
      attendees,
    })
  }

  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    const code = await nextMeetingCode(conn)
    const [result] = await conn.query<any>(
      `INSERT INTO sales_meetings
        (meeting_code, meeting_date, meeting_time, duration_minutes,
         company_id, company_name, contact_id, contact_person, lead_id, owner_id,
         meeting_type, status, agenda, location, attendees, reminder_minutes, internal_notes,
         google_event_id, meet_link, google_html_link, google_organizer_id, google_sync_status, google_sync_error,
         added_by, row_version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Scheduled', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      [
        code,
        input.meeting_date,
        input.meeting_time || null,
        input.duration_minutes || 30,
        rel.companyId,
        rel.companyName,
        rel.contactId,
        rel.contactPerson,
        rel.leadId,
        ownerId,
        input.meeting_type || "Discovery",
        input.agenda || null,
        input.location || null,
        JSON.stringify(attendees),
        input.reminder_minutes ?? null,
        input.internal_notes || null,
        sync.eventId,
        sync.meetLink,
        sync.htmlLink,
        sync.organizerId,
        input.create_google_meet ? sync.status : null,
        sync.error,
        actorId ?? null,
      ],
    )
    const id = Number(result.insertId)

    await recordAudit(conn, {
      entityType: "meeting",
      entityId: id,
      action: "create",
      summary: `Meeting ${code} scheduled${rel.companyName ? ` with ${rel.companyName}` : ""}`,
      meta: { meeting_code: code, google_sync: sync.status },
      actorId,
    })

    if (rel.leadId) {
      await notify(conn, {
        userId: ownerId,
        type: "meeting_scheduled",
        title: `Meeting scheduled: ${code}`,
        body: `${rel.companyName || ""} · ${input.meeting_date}${input.meeting_time ? ` ${input.meeting_time}` : ""}`,
        link: `/modules/sales/meetings`,
        entityType: "meeting",
        entityId: id,
      })
    }

    await conn.commit()

    // Timeline entry on the linked lead (outside the txn; best-effort).
    if (rel.leadId) {
      await attachLeadEvent({
        leadId: rel.leadId,
        type: "meeting",
        title: `Meeting scheduled · ${input.meeting_type || "Meeting"}`,
        body: input.agenda || null,
        refType: "meeting",
        refId: code,
        actorId,
      }).catch(() => {})
    }

    return await getMeeting(id)
  } catch (error) {
    await conn.rollback()
    throw error
  } finally {
    conn.release()
  }
}

/* -------------------------------------------------------------------------- */
/* Update (with optimistic concurrency + Google patch, never re-creates)      */
/* -------------------------------------------------------------------------- */

export async function updateMeeting(
  id: number,
  input: Partial<MeetingInput> & { expectedRowVersion?: number },
  actorId: Actor,
) {
  await ensureMeetingSchema()
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    const [rows] = await conn.query<any[]>(`SELECT * FROM sales_meetings WHERE id = ? FOR UPDATE`, [id])
    const current = rows[0]
    if (!current) throw new MeetingNotFoundError()
    if (
      input.expectedRowVersion != null &&
      Number(input.expectedRowVersion) !== Number(current.row_version)
    ) {
      throw new MeetingConflictError()
    }

    const rel = await resolveRelationships(
      {
        company_id: input.company_id ?? current.company_id,
        company_name: input.company_name ?? current.company_name,
        contact_id: input.contact_id ?? current.contact_id,
        contact_person: input.contact_person ?? current.contact_person,
        lead_id: input.lead_id ?? current.lead_id,
      } as MeetingInput,
      actorId,
    )

    const attendees =
      input.attendees !== undefined ? parseAttendees(input.attendees) : normalizeRow(current).attendees
    const meetingDate = input.meeting_date ?? current.meeting_date
    const meetingTime = input.meeting_time !== undefined ? input.meeting_time : current.meeting_time
    const duration = input.duration_minutes ?? current.duration_minutes ?? 30
    const meetingType = input.meeting_type ?? current.meeting_type
    const agenda = input.agenda !== undefined ? input.agenda : current.agenda
    const reminder = input.reminder_minutes !== undefined ? input.reminder_minutes : current.reminder_minutes

    await conn.query(
      `UPDATE sales_meetings SET
        meeting_date = ?, meeting_time = ?, duration_minutes = ?,
        company_id = ?, company_name = ?, contact_id = ?, contact_person = ?, lead_id = ?,
        owner_id = ?, meeting_type = ?, agenda = ?, location = ?, attendees = ?,
        reminder_minutes = ?, internal_notes = ?, row_version = row_version + 1
       WHERE id = ?`,
      [
        meetingDate,
        meetingTime || null,
        duration,
        rel.companyId,
        rel.companyName,
        rel.contactId,
        rel.contactPerson,
        rel.leadId,
        input.owner_id ?? current.owner_id,
        meetingType,
        agenda ?? null,
        input.location !== undefined ? input.location : current.location,
        JSON.stringify(attendees),
        reminder ?? null,
        input.internal_notes !== undefined ? input.internal_notes : current.internal_notes,
        id,
      ],
    )

    await recordAudit(conn, {
      entityType: "meeting",
      entityId: id,
      action: "update",
      summary: `Meeting ${current.meeting_code} updated`,
      actorId,
    })
    await conn.commit()

    // Patch the existing Google event (never creates a new one).
    if (current.google_event_id && current.google_organizer_id) {
      await patchGoogle(id, current, {
        summary: `${meetingType || "Meeting"}: ${rel.companyName || current.meeting_code}`,
        description: agenda || undefined,
        startDateTime: toLocalDateTime(meetingDate, meetingTime),
        endDateTime: addMinutes(meetingDate, meetingTime, duration),
        attendees,
        reminderMinutes: reminder ?? null,
      })
    }

    if (rel.leadId) {
      await attachLeadEvent({
        leadId: rel.leadId,
        type: "meeting",
        title: `Meeting updated · ${current.meeting_code}`,
        refType: "meeting",
        refId: current.meeting_code,
        actorId,
      }).catch(() => {})
    }

    return await getMeeting(id)
  } catch (error) {
    await conn.rollback()
    throw error
  } finally {
    conn.release()
  }
}

async function patchGoogle(id: number, current: any, input: Parameters<typeof updateMeetEventForUser>[2]) {
  const account = await getGoogleAccountForUser(current.google_organizer_id).catch(() => null)
  if (!account?.refresh_token) return
  try {
    const res = await updateMeetEventForUser(account.refresh_token, current.google_event_id, input)
    await query(
      `UPDATE sales_meetings SET meet_link = ?, google_html_link = ?, google_sync_status = 'Synced', google_sync_error = NULL WHERE id = ?`,
      [res.meetLink, res.htmlLink, id],
    )
  } catch (err: any) {
    const gone = err instanceof GoogleEventGoneError
    await query(
      `UPDATE sales_meetings SET google_sync_status = ?, google_sync_error = ? WHERE id = ?`,
      [gone ? "Cancelled" : "Failed", String(err?.message || err).slice(0, 480), id],
    )
  }
}

/* -------------------------------------------------------------------------- */
/* Lifecycle transitions                                                      */
/* -------------------------------------------------------------------------- */

async function loadForUpdate(conn: PoolConnection, id: number) {
  const [rows] = await conn.query<any[]>(`SELECT * FROM sales_meetings WHERE id = ? FOR UPDATE`, [id])
  const m = rows[0]
  if (!m) throw new MeetingNotFoundError()
  return m
}

export async function rescheduleMeeting(
  id: number,
  input: { meeting_date: string; meeting_time?: string | null; duration_minutes?: number | null; reason?: string | null },
  actorId: Actor,
) {
  await ensureMeetingSchema()
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    const current = await loadForUpdate(conn, id)
    if (current.status !== "Scheduled") {
      throw new MeetingValidationError("Only scheduled meetings can be rescheduled.")
    }
    await conn.query(
      `UPDATE sales_meetings SET meeting_date = ?, meeting_time = ?, duration_minutes = ?,
         reschedule_count = reschedule_count + 1, rescheduled_at = NOW(), row_version = row_version + 1
       WHERE id = ?`,
      [input.meeting_date, input.meeting_time || null, input.duration_minutes ?? current.duration_minutes ?? 30, id],
    )
    await recordAudit(conn, {
      entityType: "meeting",
      entityId: id,
      action: "reschedule",
      summary: `Rescheduled ${current.meeting_code} → ${input.meeting_date}${input.meeting_time ? ` ${input.meeting_time}` : ""}`,
      meta: { reason: input.reason ?? null },
      actorId,
    })
    await conn.commit()

    if (current.google_event_id && current.google_organizer_id) {
      await patchGoogle(id, current, {
        startDateTime: toLocalDateTime(input.meeting_date, input.meeting_time),
        endDateTime: addMinutes(input.meeting_date, input.meeting_time, input.duration_minutes ?? current.duration_minutes ?? 30),
      })
    }
    if (current.lead_id) {
      await attachLeadEvent({
        leadId: current.lead_id,
        type: "meeting",
        title: `Meeting rescheduled · ${current.meeting_code}`,
        body: input.reason || null,
        refType: "meeting",
        refId: current.meeting_code,
        actorId,
      }).catch(() => {})
    }
    return await getMeeting(id)
  } catch (error) {
    await conn.rollback()
    throw error
  } finally {
    conn.release()
  }
}

export async function cancelMeeting(id: number, input: { reason?: string | null }, actorId: Actor) {
  await ensureMeetingSchema()
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    const current = await loadForUpdate(conn, id)
    await conn.query(
      `UPDATE sales_meetings SET status = 'Cancelled', cancelled_at = NOW(), lost_reason = ?, row_version = row_version + 1 WHERE id = ?`,
      [input.reason ?? null, id],
    )
    await recordAudit(conn, {
      entityType: "meeting",
      entityId: id,
      action: "cancel",
      summary: `Cancelled ${current.meeting_code}${input.reason ? ` — ${input.reason}` : ""}`,
      actorId,
    })
    await conn.commit()

    // Cancel the Google event too (notifies attendees).
    if (current.google_event_id && current.google_organizer_id) {
      const account = await getGoogleAccountForUser(current.google_organizer_id).catch(() => null)
      if (account?.refresh_token) {
        await cancelMeetEventForUser(account.refresh_token, current.google_event_id).catch(() => {})
        await query(`UPDATE sales_meetings SET google_sync_status = 'Cancelled' WHERE id = ?`, [id])
      }
    }
    if (current.lead_id) {
      await attachLeadEvent({
        leadId: current.lead_id,
        type: "meeting",
        title: `Meeting cancelled · ${current.meeting_code}`,
        body: input.reason || null,
        refType: "meeting",
        refId: current.meeting_code,
        actorId,
      }).catch(() => {})
    }
    return await getMeeting(id)
  } catch (error) {
    await conn.rollback()
    throw error
  } finally {
    conn.release()
  }
}

export async function markNoShow(id: number, actorId: Actor) {
  await ensureMeetingSchema()
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    const current = await loadForUpdate(conn, id)
    await conn.query(
      `UPDATE sales_meetings SET status = 'No Show', completed_at = NOW(), row_version = row_version + 1 WHERE id = ?`,
      [id],
    )
    await recordAudit(conn, {
      entityType: "meeting",
      entityId: id,
      action: "no_show",
      summary: `No-show recorded for ${current.meeting_code}`,
      actorId,
    })
    await conn.commit()
    if (current.lead_id) {
      await attachLeadEvent({
        leadId: current.lead_id,
        type: "meeting",
        title: `Meeting no-show · ${current.meeting_code}`,
        refType: "meeting",
        refId: current.meeting_code,
        actorId,
        touchContact: true,
      }).catch(() => {})
    }
    return await getMeeting(id)
  } catch (error) {
    await conn.rollback()
    throw error
  } finally {
    conn.release()
  }
}

export type CompleteMeetingInput = {
  outcome?: string | null
  outcome_notes?: string | null
  next_steps?: string | null
  create_follow_up?: boolean
  follow_up_at?: string | null
  follow_up_channel?: string | null
  follow_up_purpose?: string | null
}

export async function completeMeeting(id: number, input: CompleteMeetingInput, actorId: Actor) {
  await ensureMeetingSchema()
  const conn = await pool.getConnection()
  let leadId: number | null = null
  let companyId: number | null = null
  let meetingCode = ""
  try {
    await conn.beginTransaction()
    const current = await loadForUpdate(conn, id)
    leadId = current.lead_id ?? null
    companyId = current.company_id ?? null
    meetingCode = current.meeting_code

    await conn.query(
      `UPDATE sales_meetings SET status = 'Completed', completed_at = NOW(), outcome = ?,
         outcome_notes = ?, next_steps = ?, row_version = row_version + 1 WHERE id = ?`,
      [input.outcome ?? null, input.outcome_notes ?? null, input.next_steps ?? null, id],
    )

    // Touch last-contact on the linked company + lead so 360 views stay accurate.
    if (companyId) {
      await conn.query(`UPDATE sales_companies SET last_contact_date = NOW() WHERE id = ?`, [companyId]).catch(() => {})
    }
    if (leadId) {
      await conn.query(`UPDATE sales_leads SET last_contact_date = NOW() WHERE id = ?`, [leadId]).catch(() => {})
    }

    await recordAudit(conn, {
      entityType: "meeting",
      entityId: id,
      action: "complete",
      summary: `Completed ${current.meeting_code}${input.outcome ? ` — ${input.outcome}` : ""}`,
      meta: { outcome: input.outcome ?? null },
      actorId,
    })
    await conn.commit()

    if (leadId) {
      await attachLeadEvent({
        leadId,
        type: "meeting",
        title: `Meeting completed · ${current.meeting_code}`,
        body: [input.outcome, input.outcome_notes].filter(Boolean).join(" — ") || null,
        refType: "meeting",
        refId: current.meeting_code,
        actorId,
        touchContact: true,
      }).catch(() => {})
    }

    // Optionally spin up a follow-up on the linked lead, reusing the lead engine.
    if (input.create_follow_up && leadId && input.follow_up_at) {
      const fu = await createFollowUp(
        {
          leadId,
          dueAt: input.follow_up_at,
          channel: input.follow_up_channel ?? "Meeting",
          purpose: input.follow_up_purpose ?? `Follow up on ${current.meeting_code}`,
        },
        actorId,
      ).catch(() => null)
      if (fu?.id) {
        await query(`UPDATE sales_meetings SET follow_up_id = ? WHERE id = ?`, [fu.id, id])
      }
    }

    return await getMeeting(id)
  } catch (error) {
    await conn.rollback()
    throw error
  } finally {
    conn.release()
  }
}

/** Soft-archive (never hard delete). Cancels the Google event if still active. */
export async function archiveMeeting(id: number, actorId: Actor) {
  await ensureMeetingSchema()
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    const current = await loadForUpdate(conn, id)
    await conn.query(
      `UPDATE sales_meetings SET archived_at = NOW(), row_version = row_version + 1 WHERE id = ?`,
      [id],
    )
    await recordAudit(conn, {
      entityType: "meeting",
      entityId: id,
      action: "archive",
      summary: `Archived ${current.meeting_code}`,
      actorId,
    })
    await conn.commit()

    if (current.status === "Scheduled" && current.google_event_id && current.google_organizer_id) {
      const account = await getGoogleAccountForUser(current.google_organizer_id).catch(() => null)
      if (account?.refresh_token) {
        await cancelMeetEventForUser(account.refresh_token, current.google_event_id).catch(() => {})
      }
    }
    return { success: true }
  } catch (error) {
    await conn.rollback()
    throw error
  } finally {
    conn.release()
  }
}

/** Retry Google Meet creation for a meeting whose sync previously failed / was not connected. */
export async function recreateGoogleEvent(id: number, actorId: Actor) {
  await ensureMeetingSchema()
  const current = await getMeeting(id)
  if (!current) throw new MeetingNotFoundError()
  if (current.status !== "Scheduled") {
    throw new MeetingValidationError("Only scheduled meetings can be synced to Google Calendar.")
  }
  const ownerId = current.owner_id ?? actorId ?? null
  if (!ownerId) throw new MeetingValidationError("No owner to sync the calendar event as.")

  const sync = await syncCreateGoogle(ownerId, {
    code: current.meeting_code,
    input: {
      meeting_date: current.meeting_date,
      meeting_time: current.meeting_time,
      duration_minutes: current.duration_minutes,
      meeting_type: current.meeting_type,
      agenda: current.agenda,
      reminder_minutes: current.reminder_minutes,
    },
    companyName: current.company_name,
    attendees: current.attendees,
  })
  await query(
    `UPDATE sales_meetings SET google_event_id = ?, meet_link = ?, google_html_link = ?,
       google_organizer_id = ?, google_sync_status = ?, google_sync_error = ? WHERE id = ?`,
    [sync.eventId, sync.meetLink, sync.htmlLink, sync.organizerId, sync.status, sync.error, id],
  )
  await recordAudit(null as any, {
    entityType: "meeting",
    entityId: id,
    action: "google_sync",
    summary: `Google sync ${sync.status}`,
    actorId,
  }).catch(() => {})
  return await getMeeting(id)
}
