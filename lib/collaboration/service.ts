import "server-only"
import crypto from "node:crypto"
import { query, withTransaction } from "@/lib/db"
import type { SessionPayload } from "@/lib/auth"
import { canActOnRecord } from "@/lib/permission-enforce"
import { getScope } from "@/lib/permission-store"
import { fieldPolicyRulesFor, fieldSecurityActorFromSession } from "@/lib/field-security"
import { effectRedactsValue, resolveFieldEffects } from "@/lib/field-security-model"
import { getTimeline, recordActivity, recordActivitySafe } from "@/lib/activity/db"
import type { ActivityEvent, ActivityViewer } from "@/lib/activity/model"
import { recordAuditLog } from "@/lib/audit-log-store"
import { listInboxForUser } from "@/lib/approval-authority"
import { ensureTaskSchema } from "@/lib/tasks/schema"
import { ensureNotificationEngineSchema } from "@/lib/notification-engine/schema"
import { enqueueNotification } from "@/lib/notification-engine/service"
import { ensureCollaborationSchema } from "./schema"
import {
  APPROVAL_MODULE_PERMISSION,
  CollabError,
  type CollabSubject,
  type FieldVisibility,
  type InboxItem,
  type UserRef,
  crmDedupeKey,
  displayUser,
  getSubject,
  isActiveUser,
  openLink,
  parseSubjectId,
  redactActivityMeta,
  renderMentions,
  sortInbox,
  validateComment,
  validateCrmEvent,
} from "./model"

type Action = "view" | "update"
type LoadedSubject = { type: string; id: number; subject: CollabSubject; row: Record<string, any>; label: string }

// ---------------------------------------------------------------------------
// Record access — tenant predicate first, then the shared RBAC + ABAC gate.
// Absent, cross-tenant and unauthorized records all answer 404 so record ids
// can't be probed.
// ---------------------------------------------------------------------------

async function viewerCanAccess(
  session: Pick<SessionPayload, "userId" | "role"> & Partial<SessionPayload>,
  subject: CollabSubject,
  type: string,
  row: Record<string, any>,
  action: Action,
): Promise<boolean> {
  // Central task engine: the people on a task always see it, matching /api/tasks.
  if (type === "task") {
    const uid = Number(session.userId)
    if ([row.assignee_id, row.reporter_id, row.created_by, row.approver_id].some((v) => Number(v) === uid)) return true
  }
  return canActOnRecord(session as SessionPayload, subject.moduleKey, action, subject.permissionRow(row))
}

export async function loadSubject(
  session: SessionPayload,
  tenantId: number,
  rawType: unknown,
  rawId: unknown,
  action: Action = "view",
): Promise<LoadedSubject> {
  const subject = getSubject(rawType)
  if (!subject) throw new CollabError(404, "Unknown record type")
  const id = parseSubjectId(rawId)
  if (subject.table === "tasks") await ensureTaskSchema()
  const rows = await query<any[]>(`SELECT * FROM \`${subject.table}\` WHERE tenant_id = ? AND id = ? LIMIT 1`, [tenantId, id])
  const row = rows[0]
  if (!row) throw new CollabError(404, "Record not found")
  if (!(await viewerCanAccess(session, subject, String(rawType), row, action))) throw new CollabError(404, "Record not found")
  const label = String(row[subject.labelColumn] ?? "").trim() || `#${id}`
  return { type: String(rawType), id, subject, row, label }
}

async function usersById(tenantId: number, ids: number[]): Promise<Map<number, UserRef & { role?: string }>> {
  const unique = [...new Set(ids.filter((n) => Number.isSafeInteger(n) && n > 0))]
  const out = new Map<number, UserRef & { role?: string }>()
  if (!unique.length) return out
  const rows = await query<any[]>(
    `SELECT id, name, status, role FROM users WHERE tenant_id = ? AND id IN (${unique.map(() => "?").join(",")})`,
    [tenantId, ...unique],
  )
  for (const r of rows) out.set(Number(r.id), { id: Number(r.id), name: r.name ?? null, status: r.status ?? null, role: r.role })
  return out
}

/** Field-security effects for this viewer; fail CLOSED (every governed field hidden) if resolution breaks. */
async function fieldEffectsFor(session: SessionPayload, tenantId: number, subject: CollabSubject) {
  const effects = new Map<string, FieldVisibility>()
  let rules: Awaited<ReturnType<typeof fieldPolicyRulesFor>> = []
  try {
    rules = await fieldPolicyRulesFor(tenantId, subject.fieldModule, subject.fieldEntity)
    if (!rules.length) return effects
    const actor = await fieldSecurityActorFromSession(session)
    if (!actor) throw new Error("no field-security actor")
    for (const [field, r] of resolveFieldEffects(rules, actor)) {
      if (effectRedactsValue(r.effect)) effects.set(field, r.effect === "hidden" ? "hidden" : "masked")
    }
  } catch {
    for (const r of rules) effects.set(r.field, "hidden")
  }
  return effects
}

function viewerFrom(session: SessionPayload): ActivityViewer {
  const s = session as any
  return {
    userId: session.userId,
    role: session.role,
    features: Array.isArray(s.features) ? s.features : undefined,
    isPortal: s.isPortal === true || s.role === "portal",
  }
}

// ---------------------------------------------------------------------------
// Unified record activity: timeline events + comment threads
// ---------------------------------------------------------------------------

export async function getRecordActivity(session: SessionPayload, tenantId: number, type: unknown, id: unknown, cursor?: string | null) {
  const s = await loadSubject(session, tenantId, type, id, "view")
  await ensureCollaborationSchema()

  const [page, effects, comments] = await Promise.all([
    getTimeline({ subjectType: s.type, subjectId: s.id, cursor, limit: 50 }, viewerFrom(session)),
    fieldEffectsFor(session, tenantId, s.subject),
    query<any[]>(
      `SELECT id, parent_id, author_id, body, deleted_at, created_at FROM record_comments
        WHERE tenant_id = ? AND subject_type = ? AND subject_id = ? ORDER BY id ASC LIMIT 500`,
      [tenantId, s.type, s.id],
    ),
  ])

  const commentIds = comments.map((c) => Number(c.id))
  const [attachments, mentions] = commentIds.length
    ? await Promise.all([
        query<any[]>(
          `SELECT comment_id, name, url, mime_type, size_bytes FROM record_comment_attachments
            WHERE tenant_id = ? AND comment_id IN (${commentIds.map(() => "?").join(",")}) ORDER BY id`,
          [tenantId, ...commentIds],
        ),
        query<any[]>(
          `SELECT comment_id, user_id FROM record_comment_mentions
            WHERE tenant_id = ? AND comment_id IN (${commentIds.map(() => "?").join(",")})`,
          [tenantId, ...commentIds],
        ),
      ])
    : [[], []]

  const events = page.events.filter((e) => e.ref_type !== "record_comment")
  const users = await usersById(tenantId, [
    ...comments.map((c) => Number(c.author_id)),
    ...mentions.map((m) => Number(m.user_id)),
    ...events.map((e) => Number(e.actor_id)),
  ])
  const names = new Map([...users].map(([uid, u]) => [uid, displayUser(u).name]))

  return {
    subject: { type: s.type, id: s.id, label: s.label, link: s.subject.link(s.id) },
    comments: comments.map((c) => {
      const deleted = c.deleted_at != null
      return {
        id: Number(c.id),
        parentId: c.parent_id == null ? null : Number(c.parent_id),
        author: displayUser(users.get(Number(c.author_id))),
        body: deleted ? null : renderMentions(String(c.body), names),
        deleted,
        createdAt: c.created_at,
        attachments: deleted
          ? []
          : attachments
              .filter((a) => Number(a.comment_id) === Number(c.id))
              .map((a) => ({ name: a.name, url: a.url, mimeType: a.mime_type, sizeBytes: a.size_bytes == null ? null : Number(a.size_bytes) })),
        mentions: deleted
          ? []
          : mentions.filter((m) => Number(m.comment_id) === Number(c.id)).map((m) => displayUser(users.get(Number(m.user_id)))),
      }
    }),
    events: events.map((e: ActivityEvent) => {
      const { meta } = redactActivityMeta(e.meta, effects)
      return { ...e, meta, actor: e.actor_id == null ? null : displayUser(users.get(e.actor_id)) }
    }),
    nextCursor: page.nextCursor,
  }
}

// ---------------------------------------------------------------------------
// Comments + permission-aware mentions
// ---------------------------------------------------------------------------

export type MentionOutcome = { userId: number; status: "notified" | "no_access" | "inactive" | "self" }

function requestHash(type: string, id: number, input: ReturnType<typeof validateComment>): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify([type, id, input.body, input.parentId, input.attachments]))
    .digest("hex")
}

async function findIdempotent(tenantId: number, authorId: number, key: string, hash: string) {
  const rows = await query<any[]>(
    `SELECT id, request_hash FROM record_comments WHERE tenant_id = ? AND author_id = ? AND idempotency_key = ? LIMIT 1`,
    [tenantId, authorId, key],
  )
  if (!rows[0]) return null
  if (rows[0].request_hash !== hash) throw new CollabError(409, "Idempotency key was already used for a different comment")
  return Number(rows[0].id)
}

export async function addComment(session: SessionPayload, tenantId: number, type: unknown, id: unknown, raw: unknown) {
  const input = validateComment(raw)
  const s = await loadSubject(session, tenantId, type, id, "view")
  await ensureCollaborationSchema()
  const hash = requestHash(s.type, s.id, input)

  if (input.idempotencyKey) {
    const existing = await findIdempotent(tenantId, session.userId, input.idempotencyKey, hash)
    if (existing) return { commentId: existing, duplicate: true, mentions: [] as MentionOutcome[] }
  }

  if (input.parentId) {
    const parent = await query<any[]>(
      `SELECT id FROM record_comments WHERE tenant_id = ? AND id = ? AND subject_type = ? AND subject_id = ? AND deleted_at IS NULL LIMIT 1`,
      [tenantId, input.parentId, s.type, s.id],
    )
    if (!parent[0]) throw new CollabError(422, "Invalid comment", { parentId: "Parent comment not found on this record" })
  }

  // Mentions resolve inside the tenant only; unknown / other-tenant / deleted ids are dropped.
  const users = await usersById(tenantId, input.mentionIds)
  const outcomes: MentionOutcome[] = []
  for (const uid of input.mentionIds) {
    const u = users.get(uid)
    if (!u) continue
    if (uid === session.userId) outcomes.push({ userId: uid, status: "self" })
    else if (!isActiveUser(u)) outcomes.push({ userId: uid, status: "inactive" })
    else {
      const recipient = { userId: uid, role: (u.role === "admin" ? "admin" : "employee") as SessionPayload["role"], name: u.name ?? "", email: "", tenantId }
      const allowed = await viewerCanAccess(recipient, s.subject, s.type, s.row, "view").catch(() => false)
      outcomes.push({ userId: uid, status: allowed ? "notified" : "no_access" })
    }
  }
  const notify = outcomes.filter((o) => o.status === "notified")
  if (notify.length) await ensureNotificationEngineSchema()

  let commentId: number
  try {
    commentId = await withTransaction(async (c) => {
      const [res]: any = await c.query(
        `INSERT INTO record_comments (tenant_id, subject_type, subject_id, parent_id, author_id, body, idempotency_key, request_hash)
         VALUES (?,?,?,?,?,?,?,?)`,
        [tenantId, s.type, s.id, input.parentId, session.userId, input.body, input.idempotencyKey, hash],
      )
      const cid = Number(res.insertId)
      for (const a of input.attachments) {
        await c.query(
          `INSERT INTO record_comment_attachments (tenant_id, comment_id, name, url, mime_type, size_bytes) VALUES (?,?,?,?,?,?)`,
          [tenantId, cid, a.name, a.url, a.mimeType, a.sizeBytes],
        )
      }
      for (const o of outcomes) {
        let notificationId: number | null = null
        if (o.status === "notified") {
          notificationId = await enqueueNotification(c, {
            tenantId,
            userId: o.userId,
            channel: "in_app",
            key: `mention:${cid}:${o.userId}`,
            title: `${session.name || "Someone"} mentioned you on ${s.label}`.slice(0, 255),
            body: input.body.replace(/@\[([^\]\n]{1,100})\]\(user:\d+\)/g, "@$1").slice(0, 4000),
            link: openLink(s.type, s.id, cid),
            context: { actorId: session.userId, actorName: session.name, moduleKey: s.subject.moduleKey },
          })
        }
        await c.query(
          `INSERT INTO record_comment_mentions (tenant_id, comment_id, user_id, status, notification_id) VALUES (?,?,?,?,?)`,
          [tenantId, cid, o.userId, o.status, notificationId],
        )
      }
      return cid
    })
  } catch (err: any) {
    // Concurrent retry with the same key lost the unique-key race: return the winner.
    if (input.idempotencyKey && err?.code === "ER_DUP_ENTRY") {
      const existing = await findIdempotent(tenantId, session.userId, input.idempotencyKey, hash)
      if (existing) return { commentId: existing, duplicate: true, mentions: [] as MentionOutcome[] }
    }
    throw err
  }

  const event = await recordActivitySafe(
    {
      kind: "note",
      subject_type: s.type,
      subject_id: s.id,
      subject_label: s.label,
      action: "commented",
      title: `${session.name || "User"} commented`,
      body: input.body.replace(/@\[([^\]\n]{1,100})\]\(user:\d+\)/g, "@$1").slice(0, 500),
      source_module: s.subject.fieldModule,
      actor_id: session.userId,
      ref_type: "record_comment",
      ref_id: commentId,
      meta: { attachments: input.attachments.length, mentions: notify.length },
    },
    { dedupeKey: `comment:${commentId}` },
  )
  if (event?.id) {
    await query(`UPDATE record_comments SET activity_event_id = ? WHERE tenant_id = ? AND id = ?`, [event.id, tenantId, commentId]).catch(() => {})
  }
  await recordAuditLog({
    action: "collaboration.comment.create",
    entityType: s.type,
    entityId: s.id,
    entityLabel: s.label,
    metadata: { commentId, attachments: input.attachments.length, mentions: outcomes },
  })
  return { commentId, duplicate: false, mentions: outcomes }
}

export async function deleteComment(session: SessionPayload, tenantId: number, type: unknown, id: unknown, rawCommentId: unknown) {
  const s = await loadSubject(session, tenantId, type, id, "view")
  await ensureCollaborationSchema()
  const commentId = parseSubjectId(rawCommentId)
  const rows = await query<any[]>(
    `SELECT id, author_id, deleted_at FROM record_comments WHERE tenant_id = ? AND id = ? AND subject_type = ? AND subject_id = ? LIMIT 1`,
    [tenantId, commentId, s.type, s.id],
  )
  const row = rows[0]
  if (!row) throw new CollabError(404, "Comment not found")
  if (Number(row.author_id) !== session.userId && session.role !== "admin") throw new CollabError(403, "Only the author or an admin can delete this comment")
  if (row.deleted_at != null) return { deleted: true, alreadyDeleted: true }
  await query(`UPDATE record_comments SET deleted_at = NOW(), deleted_by = ? WHERE tenant_id = ? AND id = ? AND deleted_at IS NULL`, [
    session.userId,
    tenantId,
    commentId,
  ])
  await recordAuditLog({ action: "collaboration.comment.delete", entityType: s.type, entityId: s.id, metadata: { commentId } })
  return { deleted: true, alreadyDeleted: false }
}

// ---------------------------------------------------------------------------
// CRM communications → timeline (email / call / whatsapp / meeting / note)
// ---------------------------------------------------------------------------

/**
 * Single connector for communication modules and integrations. Requires edit
 * access to the CRM record; the per-tenant dedupe key makes webhook/provider
 * retries and module re-saves idempotent.
 */
export async function recordCrmCommunication(session: SessionPayload, tenantId: number, raw: unknown) {
  const e = validateCrmEvent(raw)
  const s = await loadSubject(session, tenantId, e.subjectType, e.subjectId, "update")
  const result = await recordActivity(
    {
      kind: e.channel,
      subject_type: s.type,
      subject_id: s.id,
      subject_label: s.label,
      action: e.channel === "note" ? "noted" : e.direction,
      title: e.title,
      body: e.body,
      source_module: "crm",
      actor_id: session.userId,
      occurred_at: e.occurredAt,
      meta: { direction: e.direction, sourceRef: e.sourceRef, durationSeconds: e.durationSeconds },
    },
    { dedupeKey: crmDedupeKey(e) },
  )
  if (!result.duplicate) {
    await recordAuditLog({
      action: "collaboration.crm_event.record",
      entityType: s.type,
      entityId: s.id,
      metadata: { channel: e.channel, sourceRef: e.sourceRef, eventId: result.id },
    })
  }
  return { eventId: result.id, duplicate: Boolean(result.duplicate) }
}

// ---------------------------------------------------------------------------
// Unified task + approval inbox
// ---------------------------------------------------------------------------

export async function getInbox(session: SessionPayload, tenantId: number) {
  await ensureTaskSchema()
  const taskRows = await query<any[]>(
    `SELECT id, title, status, priority, due_date, created_at, assignee_id, approver_id, approval_status
       FROM tasks
      WHERE tenant_id = ?
        AND ((assignee_id = ? AND status NOT IN ('Done','Cancelled'))
          OR (approver_id = ? AND approval_status = 'pending'))
      ORDER BY id DESC LIMIT 200`,
    [tenantId, session.userId, session.userId],
  )
  const items: InboxItem[] = taskRows.map((t) => {
    const approval = Number(t.approver_id) === session.userId && t.approval_status === "pending"
    return {
      kind: approval ? "approval" : "task",
      id: Number(t.id),
      title: String(t.title ?? `Task #${t.id}`),
      moduleKey: "tasks",
      status: approval ? "pending_approval" : String(t.status),
      priority: t.priority ?? null,
      dueAt: t.due_date ? new Date(t.due_date).toISOString() : null,
      createdAt: new Date(t.created_at).toISOString(),
      link: `/modules/tasks?task=${t.id}`,
    }
  })

  let hiddenApprovals = 0
  const approvals = await listInboxForUser(session.userId, { isAdmin: session.role === "admin" })
  const scopeCache = new Map<string, boolean>()
  for (const a of approvals) {
    const permKey = APPROVAL_MODULE_PERMISSION[a.moduleKey]
    if (permKey) {
      if (!scopeCache.has(permKey)) {
        const scope = await getScope(session.userId, session.role, permKey, "view").catch(() => "none" as const)
        scopeCache.set(permKey, scope !== "none")
      }
      if (!scopeCache.get(permKey)) {
        hiddenApprovals++
        continue
      }
    }
    const due = (a as any).dueAt ?? (a as any).slaDueAt ?? null
    items.push({
      kind: "approval",
      id: a.id,
      title: a.title || `${a.moduleKey} approval #${a.id}`,
      moduleKey: a.moduleKey,
      status: a.status,
      priority: null,
      dueAt: due ? new Date(due).toISOString() : null,
      createdAt: new Date(a.createdAt).toISOString(),
      link: `/modules/operations/approvals?request=${a.id}`,
    })
  }
  const sorted = sortInbox(items)
  return {
    items: sorted,
    counts: {
      tasks: sorted.filter((i) => i.kind === "task").length,
      approvals: sorted.filter((i) => i.kind === "approval").length,
      hiddenApprovals,
    },
  }
}

/** Active users in the caller's tenant for the @mention picker (record access is re-checked at post time). */
export async function mentionCandidates(session: SessionPayload, tenantId: number, type: unknown, id: unknown, q: string | null) {
  await loadSubject(session, tenantId, type, id, "view")
  const term = (q ?? "").trim().slice(0, 60).replace(/[\\%_]/g, (c) => `\\${c}`)
  const rows = await query<any[]>(
    `SELECT id, name FROM users WHERE tenant_id = ? AND status = 'active' AND id <> ? ${term ? "AND name LIKE ?" : ""} ORDER BY name LIMIT 8`,
    term ? [tenantId, session.userId, `%${term}%`] : [tenantId, session.userId],
  )
  return { users: rows.map((r) => ({ id: Number(r.id), name: String(r.name ?? `User #${r.id}`) })) }
}

/** Re-check access when a notification deep link is opened (permissions may have changed). */
export async function resolveDeepLink(session: SessionPayload, tenantId: number, type: unknown, id: unknown, commentId?: string | null) {
  try {
    const s = await loadSubject(session, tenantId, type, id, "view")
    const cid = commentId && /^\d{1,18}$/.test(commentId) ? Number(commentId) : null
    const base = s.subject.link(s.id)
    return { allowed: true as const, url: cid ? `${base}#comment-${cid}` : base }
  } catch (err) {
    if (err instanceof CollabError) return { allowed: false as const, url: "/notifications?denied=1" }
    throw err
  }
}
