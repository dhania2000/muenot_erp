import "server-only"
import { query } from "@/lib/db"

/**
 * Operations Meeting detail service (SPEC 112 — Meeting Management).
 *
 * Sits ON TOP of the thin scheduling layer in `lib/operations-meetings.ts`.
 * The head row (`operations_meetings`) still owns scheduling + Google Calendar
 * sync; this module owns the rich per-meeting collateral:
 *
 *   • participants   — structured RSVP + attendance
 *   • agenda         — ordered, time-boxed topics with outcomes
 *   • attachments    — files stored via the tenant storage facade
 *   • notes/minutes  — attributed, timestamped entries
 *   • action items   — owned follow-ups with due / follow-up dates
 *   • follow-up      — a follow-up date + chained follow-up meetings
 *   • history        — an immutable activity trail across all of the above
 *
 * Everything here is additive and defensive: reads fall back to empty, and the
 * caller (API layer) is responsible for session/permission checks.
 */

export type Actor = { id: number | null; name: string | null }

export const PARTICIPANT_ROLES = ["Organizer", "Presenter", "Attendee", "Optional"] as const
export const RESPONSE_STATUSES = ["Pending", "Accepted", "Declined", "Tentative"] as const
export const ATTENDANCE_STATUSES = ["Present", "Absent", "Excused"] as const
export const AGENDA_STATUSES = ["Pending", "Discussed", "Deferred"] as const
export const ACTION_ITEM_STATUSES = ["Open", "In Progress", "Done", "Cancelled"] as const
export const ACTION_ITEM_PRIORITIES = ["Low", "Medium", "High", "Urgent"] as const
export const MEETING_STATUSES = ["Scheduled", "In Progress", "Completed", "Cancelled"] as const

function toSqlDate(value: string | null | undefined): string | null {
  if (!value) return null
  const s = String(value).trim()
  return s ? s.slice(0, 10) : null
}

/** Append an entry to the meeting's activity trail. Never throws. */
export async function recordMeetingHistory(
  meetingId: number | string,
  action: string,
  detail: string | null,
  actor: Actor,
): Promise<void> {
  await query(
    `INSERT INTO operations_meeting_history (meeting_id, action, detail, actor_id, actor_name)
     VALUES (?,?,?,?,?)`,
    [meetingId, action, detail ?? null, actor.id ?? null, actor.name ?? null],
  ).catch((error) => {
    console.log("[v0] recordMeetingHistory failed:", (error as Error).message)
  })
}

async function getMeetingHead(id: number | string): Promise<any | null> {
  const rows = (await query(`SELECT * FROM operations_meetings WHERE id = ? LIMIT 1`, [id]).catch(() => [])) as any[]
  return rows[0] ?? null
}

/** Full meeting record: head + all child collections + follow-up chain. */
export async function getMeetingDetail(id: number | string): Promise<any | null> {
  const meeting = await getMeetingHead(id)
  if (!meeting) return null

  const [participants, agenda, attachments, notes, actionItems, history, followUps] = await Promise.all([
    query(`SELECT * FROM operations_meeting_participants WHERE meeting_id = ? ORDER BY is_organizer DESC, id ASC`, [id]).catch(() => []),
    query(`SELECT * FROM operations_meeting_agenda WHERE meeting_id = ? ORDER BY sort_order ASC, id ASC`, [id]).catch(() => []),
    query(`SELECT * FROM operations_meeting_attachments WHERE meeting_id = ? ORDER BY id DESC`, [id]).catch(() => []),
    query(`SELECT * FROM operations_meeting_notes WHERE meeting_id = ? ORDER BY created_at DESC, id DESC`, [id]).catch(() => []),
    query(`SELECT * FROM operations_meeting_action_items WHERE meeting_id = ? ORDER BY (status = 'Done') ASC, COALESCE(due_date, '9999-12-31') ASC, id ASC`, [id]).catch(() => []),
    query(`SELECT * FROM operations_meeting_history WHERE meeting_id = ? ORDER BY created_at DESC, id DESC LIMIT 200`, [id]).catch(() => []),
    query(
      `SELECT id, title, start_time, status FROM operations_meetings WHERE parent_meeting_id = ? ORDER BY start_time ASC`,
      [id],
    ).catch(() => []),
  ])

  let parent: any = null
  if (meeting.parent_meeting_id) {
    const rows = (await query(
      `SELECT id, title, start_time, status FROM operations_meetings WHERE id = ? LIMIT 1`,
      [meeting.parent_meeting_id],
    ).catch(() => [])) as any[]
    parent = rows[0] ?? null
  }

  return { ...meeting, participants, agenda, attachments, notes, actionItems, history, followUps, parent }
}

// ── Workflow (status + follow-up + minutes) ──────────────────────────────────

export async function setMeetingStatus(id: number | string, status: string, actor: Actor): Promise<any | null> {
  const existing = await getMeetingHead(id)
  if (!existing) return null
  if (!MEETING_STATUSES.includes(status as any)) return getMeetingDetail(id)
  await query(`UPDATE operations_meetings SET status = ? WHERE id = ?`, [status, id])
  await recordMeetingHistory(id, "status_changed", `${existing.status ?? "—"} → ${status}`, actor)
  return getMeetingDetail(id)
}

export async function saveMinutes(id: number | string, minutes: string | null, actor: Actor): Promise<any | null> {
  const existing = await getMeetingHead(id)
  if (!existing) return null
  await query(`UPDATE operations_meetings SET minutes = ? WHERE id = ?`, [minutes ?? null, id])
  await recordMeetingHistory(id, "minutes_updated", "Meeting minutes updated", actor)
  return getMeetingDetail(id)
}

export async function setFollowUp(
  id: number | string,
  input: { follow_up_date?: string | null; follow_up_notes?: string | null },
  actor: Actor,
): Promise<any | null> {
  const existing = await getMeetingHead(id)
  if (!existing) return null
  await query(`UPDATE operations_meetings SET follow_up_date = ?, follow_up_notes = ? WHERE id = ?`, [
    toSqlDate(input.follow_up_date),
    input.follow_up_notes ?? null,
    id,
  ])
  await recordMeetingHistory(
    id,
    "follow_up_set",
    input.follow_up_date ? `Follow-up set for ${toSqlDate(input.follow_up_date)}` : "Follow-up cleared",
    actor,
  )
  return getMeetingDetail(id)
}

// ── Participants ─────────────────────────────────────────────────────────────

export async function addParticipant(
  meetingId: number | string,
  input: { name?: string | null; email?: string | null; role?: string | null; user_id?: number | null },
  actor: Actor,
): Promise<any | null> {
  if (!input.name && !input.email) return getMeetingDetail(meetingId)
  const role = PARTICIPANT_ROLES.includes(input.role as any) ? input.role : "Attendee"
  await query(
    `INSERT INTO operations_meeting_participants (meeting_id, user_id, name, email, role, is_organizer)
     VALUES (?,?,?,?,?,0)`,
    [meetingId, input.user_id ?? null, input.name ?? null, input.email ?? null, role],
  )
  await recordMeetingHistory(meetingId, "participant_added", input.name || input.email || "Participant", actor)
  return getMeetingDetail(meetingId)
}

export async function updateParticipant(
  meetingId: number | string,
  participantId: number | string,
  input: { role?: string | null; response_status?: string | null; attendance?: string | null },
  actor: Actor,
): Promise<any | null> {
  const sets: string[] = []
  const params: any[] = []
  if (input.role !== undefined && PARTICIPANT_ROLES.includes(input.role as any)) {
    sets.push("role = ?")
    params.push(input.role)
  }
  if (input.response_status !== undefined && RESPONSE_STATUSES.includes(input.response_status as any)) {
    sets.push("response_status = ?")
    params.push(input.response_status)
  }
  if (input.attendance !== undefined) {
    sets.push("attendance = ?")
    params.push(ATTENDANCE_STATUSES.includes(input.attendance as any) ? input.attendance : null)
  }
  if (!sets.length) return getMeetingDetail(meetingId)
  params.push(participantId, meetingId)
  await query(`UPDATE operations_meeting_participants SET ${sets.join(", ")} WHERE id = ? AND meeting_id = ?`, params)
  await recordMeetingHistory(meetingId, "participant_updated", null, actor)
  return getMeetingDetail(meetingId)
}

export async function removeParticipant(
  meetingId: number | string,
  participantId: number | string,
  actor: Actor,
): Promise<any | null> {
  await query(`DELETE FROM operations_meeting_participants WHERE id = ? AND meeting_id = ?`, [participantId, meetingId])
  await recordMeetingHistory(meetingId, "participant_removed", null, actor)
  return getMeetingDetail(meetingId)
}

// ── Agenda ───────────────────────────────────────────────────────────────────

export async function addAgendaItem(
  meetingId: number | string,
  input: { topic?: string | null; presenter?: string | null; duration_minutes?: number | null; notes?: string | null },
  actor: Actor,
): Promise<any | null> {
  if (!input.topic) return getMeetingDetail(meetingId)
  const rows = (await query(
    `SELECT COALESCE(MAX(sort_order), 0) + 1 AS next_order FROM operations_meeting_agenda WHERE meeting_id = ?`,
    [meetingId],
  ).catch(() => [{ next_order: 1 }])) as any[]
  const nextOrder = rows[0]?.next_order ?? 1
  await query(
    `INSERT INTO operations_meeting_agenda (meeting_id, sort_order, topic, presenter, duration_minutes, notes)
     VALUES (?,?,?,?,?,?)`,
    [meetingId, nextOrder, input.topic, input.presenter ?? null, input.duration_minutes ?? null, input.notes ?? null],
  )
  await recordMeetingHistory(meetingId, "agenda_added", input.topic, actor)
  return getMeetingDetail(meetingId)
}

export async function updateAgendaItem(
  meetingId: number | string,
  itemId: number | string,
  input: {
    topic?: string | null
    presenter?: string | null
    duration_minutes?: number | null
    status?: string | null
    notes?: string | null
    sort_order?: number | null
  },
  actor: Actor,
): Promise<any | null> {
  const allowed: Record<string, (v: any) => any> = {
    topic: (v) => v ?? null,
    presenter: (v) => v ?? null,
    duration_minutes: (v) => (v === "" || v == null ? null : Number(v)),
    status: (v) => (AGENDA_STATUSES.includes(v) ? v : "Pending"),
    notes: (v) => v ?? null,
    sort_order: (v) => (v == null ? 0 : Number(v)),
  }
  const sets: string[] = []
  const params: any[] = []
  for (const [key, coerce] of Object.entries(allowed)) {
    if ((input as any)[key] !== undefined) {
      sets.push(`${key} = ?`)
      params.push(coerce((input as any)[key]))
    }
  }
  if (!sets.length) return getMeetingDetail(meetingId)
  params.push(itemId, meetingId)
  await query(`UPDATE operations_meeting_agenda SET ${sets.join(", ")} WHERE id = ? AND meeting_id = ?`, params)
  await recordMeetingHistory(meetingId, "agenda_updated", input.topic ?? null, actor)
  return getMeetingDetail(meetingId)
}

export async function removeAgendaItem(
  meetingId: number | string,
  itemId: number | string,
  actor: Actor,
): Promise<any | null> {
  await query(`DELETE FROM operations_meeting_agenda WHERE id = ? AND meeting_id = ?`, [itemId, meetingId])
  await recordMeetingHistory(meetingId, "agenda_removed", null, actor)
  return getMeetingDetail(meetingId)
}

// ── Attachments ──────────────────────────────────────────────────────────────

export async function addAttachment(
  meetingId: number | string,
  input: { file_url: string; file_name?: string | null; content_type?: string | null; size_bytes?: number | null },
  actor: Actor,
): Promise<any | null> {
  if (!input.file_url) return getMeetingDetail(meetingId)
  await query(
    `INSERT INTO operations_meeting_attachments
       (meeting_id, file_url, file_name, content_type, size_bytes, uploaded_by, uploaded_by_name)
     VALUES (?,?,?,?,?,?,?)`,
    [
      meetingId,
      input.file_url,
      input.file_name ?? null,
      input.content_type ?? null,
      input.size_bytes ?? null,
      actor.id ?? null,
      actor.name ?? null,
    ],
  )
  await recordMeetingHistory(meetingId, "attachment_added", input.file_name ?? null, actor)
  return getMeetingDetail(meetingId)
}

export async function removeAttachment(
  meetingId: number | string,
  attachmentId: number | string,
  actor: Actor,
): Promise<any | null> {
  await query(`DELETE FROM operations_meeting_attachments WHERE id = ? AND meeting_id = ?`, [attachmentId, meetingId])
  await recordMeetingHistory(meetingId, "attachment_removed", null, actor)
  return getMeetingDetail(meetingId)
}

// ── Notes / minutes ──────────────────────────────────────────────────────────

export async function addNote(
  meetingId: number | string,
  body: string,
  actor: Actor,
): Promise<any | null> {
  if (!body || !body.trim()) return getMeetingDetail(meetingId)
  await query(
    `INSERT INTO operations_meeting_notes (meeting_id, body, author_id, author_name) VALUES (?,?,?,?)`,
    [meetingId, body.trim(), actor.id ?? null, actor.name ?? null],
  )
  await recordMeetingHistory(meetingId, "note_added", null, actor)
  return getMeetingDetail(meetingId)
}

export async function updateNote(
  meetingId: number | string,
  noteId: number | string,
  body: string,
  actor: Actor,
): Promise<any | null> {
  await query(`UPDATE operations_meeting_notes SET body = ? WHERE id = ? AND meeting_id = ?`, [
    (body ?? "").trim(),
    noteId,
    meetingId,
  ])
  await recordMeetingHistory(meetingId, "note_updated", null, actor)
  return getMeetingDetail(meetingId)
}

export async function removeNote(
  meetingId: number | string,
  noteId: number | string,
  actor: Actor,
): Promise<any | null> {
  await query(`DELETE FROM operations_meeting_notes WHERE id = ? AND meeting_id = ?`, [noteId, meetingId])
  await recordMeetingHistory(meetingId, "note_removed", null, actor)
  return getMeetingDetail(meetingId)
}

// ── Action items ─────────────────────────────────────────────────────────────

export async function addActionItem(
  meetingId: number | string,
  input: {
    title: string
    description?: string | null
    assignee?: string | null
    assignee_email?: string | null
    priority?: string | null
    due_date?: string | null
    follow_up_date?: string | null
  },
  actor: Actor,
): Promise<any | null> {
  if (!input.title || !input.title.trim()) return getMeetingDetail(meetingId)
  const priority = ACTION_ITEM_PRIORITIES.includes(input.priority as any) ? input.priority : "Medium"
  await query(
    `INSERT INTO operations_meeting_action_items
       (meeting_id, title, description, assignee, assignee_email, priority, status, due_date, follow_up_date, created_by, created_by_name)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [
      meetingId,
      input.title.trim(),
      input.description ?? null,
      input.assignee ?? null,
      input.assignee_email ?? null,
      priority,
      "Open",
      toSqlDate(input.due_date),
      toSqlDate(input.follow_up_date),
      actor.id ?? null,
      actor.name ?? null,
    ],
  )
  await recordMeetingHistory(meetingId, "action_item_added", input.title.trim(), actor)
  return getMeetingDetail(meetingId)
}

export async function updateActionItem(
  meetingId: number | string,
  itemId: number | string,
  input: {
    title?: string | null
    description?: string | null
    assignee?: string | null
    assignee_email?: string | null
    priority?: string | null
    status?: string | null
    due_date?: string | null
    follow_up_date?: string | null
  },
  actor: Actor,
): Promise<any | null> {
  const sets: string[] = []
  const params: any[] = []
  if (input.title !== undefined) {
    sets.push("title = ?")
    params.push((input.title ?? "").trim())
  }
  if (input.description !== undefined) {
    sets.push("description = ?")
    params.push(input.description ?? null)
  }
  if (input.assignee !== undefined) {
    sets.push("assignee = ?")
    params.push(input.assignee ?? null)
  }
  if (input.assignee_email !== undefined) {
    sets.push("assignee_email = ?")
    params.push(input.assignee_email ?? null)
  }
  if (input.priority !== undefined && ACTION_ITEM_PRIORITIES.includes(input.priority as any)) {
    sets.push("priority = ?")
    params.push(input.priority)
  }
  if (input.due_date !== undefined) {
    sets.push("due_date = ?")
    params.push(toSqlDate(input.due_date))
  }
  if (input.follow_up_date !== undefined) {
    sets.push("follow_up_date = ?")
    params.push(toSqlDate(input.follow_up_date))
  }
  if (input.status !== undefined && ACTION_ITEM_STATUSES.includes(input.status as any)) {
    sets.push("status = ?")
    params.push(input.status)
    sets.push("completed_at = ?")
    params.push(input.status === "Done" ? new Date().toISOString().slice(0, 19).replace("T", " ") : null)
  }
  if (!sets.length) return getMeetingDetail(meetingId)
  params.push(itemId, meetingId)
  await query(`UPDATE operations_meeting_action_items SET ${sets.join(", ")} WHERE id = ? AND meeting_id = ?`, params)
  await recordMeetingHistory(meetingId, "action_item_updated", input.title ?? null, actor)
  return getMeetingDetail(meetingId)
}

export async function removeActionItem(
  meetingId: number | string,
  itemId: number | string,
  actor: Actor,
): Promise<any | null> {
  await query(`DELETE FROM operations_meeting_action_items WHERE id = ? AND meeting_id = ?`, [itemId, meetingId])
  await recordMeetingHistory(meetingId, "action_item_removed", null, actor)
  return getMeetingDetail(meetingId)
}
