/**
 * Spec42 (#190-195, #221-222) — Activity, comments & collaboration: PURE model.
 * ---------------------------------------------------------------------------
 * No I/O. The service layer (service.ts) owns DB access; everything here is
 * deterministic so validation, permission-scope SQL, mention parsing, field
 * redaction and inbox merging are unit-tested directly.
 *
 * This layers ON TOP of the existing SPEC 109 activity stream (activity_events)
 * — comments are rows in record_comments that also emit one timeline event;
 * CRM communications are timeline events with a per-tenant dedupe key.
 */

export class CollabError extends Error {
  constructor(
    public status: 400 | 403 | 404 | 409 | 422,
    message: string,
    public fields?: Record<string, string>,
  ) {
    super(message)
    this.name = "CollabError"
  }
}

// ---------------------------------------------------------------------------
// Subject registry — which records can carry collaboration, and how their
// permission, row-scope, field-security entity and deep link resolve.
// ---------------------------------------------------------------------------

export type CollabSubject = {
  /** Permission module key checked via the effective matrix (lib/permission-model.ts catalog). */
  moduleKey: string
  table: string
  labelColumn: string
  /** Columns loaded for the permission check (besides id / label). */
  scopeColumns: string[]
  /**
   * Map a loaded row onto the catalog's `addedBy` / `ownedBy` column names so
   * the shared `canActOnRecord` (RBAC + ABAC) decides access. Needed where the
   * physical table differs from the catalog's (central `tasks` engine).
   */
  permissionRow: (row: Record<string, unknown>) => Record<string, unknown>
  /** field_security_policies (module, entity) pair used for redaction. */
  fieldModule: string
  fieldEntity: string
  /** Whether CRM communications (email/call/whatsapp/meeting/note) may attach. */
  crm: boolean
  link: (id: number) => string
}

const identity = (row: Record<string, unknown>) => row

export const COLLAB_SUBJECTS: Record<string, CollabSubject> = {
  lead: {
    moduleKey: "sales.leads",
    table: "sales_leads",
    labelColumn: "company_name",
    scopeColumns: ["created_by", "assigned_to"],
    permissionRow: identity,
    fieldModule: "sales",
    fieldEntity: "lead",
    crm: true,
    link: (id) => `/modules/sales/leads/${id}`,
  },
  company: {
    moduleKey: "sales.companies",
    table: "sales_companies",
    labelColumn: "company_name",
    scopeColumns: ["created_by", "assigned_to"],
    permissionRow: identity,
    fieldModule: "sales",
    fieldEntity: "company",
    crm: true,
    link: (id) => `/modules/sales/companies/${id}`,
  },
  deal: {
    moduleKey: "sales.deals",
    table: "sales_deals",
    labelColumn: "title",
    scopeColumns: ["created_by", "owner_id"],
    permissionRow: identity,
    fieldModule: "sales",
    fieldEntity: "deal",
    crm: true,
    link: (id) => `/modules/sales/deals?id=${id}`,
  },
  contact: {
    moduleKey: "marketing.contacts",
    table: "marketing_contacts",
    labelColumn: "full_name",
    scopeColumns: ["owner_id"],
    permissionRow: identity,
    fieldModule: "marketing",
    fieldEntity: "contact",
    crm: true,
    link: (id) => `/modules/marketing/contacts?id=${id}`,
  },
  task: {
    moduleKey: "operations.tasks",
    table: "tasks",
    labelColumn: "title",
    scopeColumns: ["reporter_id", "assignee_id", "created_by", "approver_id"],
    permissionRow: (row) => ({
      ...row,
      created_by: row.reporter_id ?? row.created_by,
      assigned_to: row.assignee_id,
    }),
    fieldModule: "operations",
    fieldEntity: "task",
    crm: false,
    link: (id) => `/modules/tasks?id=${id}`,
  },
}

export function getSubject(type: unknown): CollabSubject | null {
  return typeof type === "string" && Object.hasOwn(COLLAB_SUBJECTS, type) ? COLLAB_SUBJECTS[type] : null
}

/** Internal redirect target that re-checks access at click time. */
export function openLink(subjectType: string, subjectId: number, commentId?: number | null): string {
  const base = `/api/collaboration/open/${encodeURIComponent(subjectType)}/${subjectId}`
  return commentId ? `${base}?comment=${commentId}` : base
}

export function parseSubjectId(value: unknown): number {
  const n = typeof value === "number" ? value : Number(String(value ?? "").trim())
  if (!Number.isSafeInteger(n) || n < 1) throw new CollabError(400, "Invalid record id")
  return n
}

// ---------------------------------------------------------------------------
// Comments, mentions, attachments
// ---------------------------------------------------------------------------

export const COMMENT_BODY_MAX = 5000
export const MAX_ATTACHMENTS = 10
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024
export const MAX_MENTIONS = 20
const IDEMPOTENCY_RE = /^[A-Za-z0-9_:.-]{8,100}$/
/** Structured mention token: `@[Display Name](user:123)`. */
const MENTION_RE = /@\[([^\]\n]{1,100})\]\(user:(\d{1,10})\)/g

export type AttachmentInput = { name: string; url: string; mimeType: string | null; sizeBytes: number | null }
export type CommentInput = {
  body: string
  attachments: AttachmentInput[]
  mentionIds: number[]
  idempotencyKey: string | null
  parentId: number | null
}

export function parseMentions(body: string): number[] {
  const ids = new Set<number>()
  for (const m of body.matchAll(MENTION_RE)) {
    const id = Number(m[2])
    if (Number.isSafeInteger(id) && id > 0) ids.add(id)
  }
  return [...ids]
}

/** Replace each mention token label with the recipient's CURRENT name (or "Deleted user"). */
export function renderMentions(body: string, names: Map<number, string>): string {
  return body.replace(MENTION_RE, (_all, _label, id) => `@${names.get(Number(id)) ?? "Deleted user"}`)
}

function validAttachmentUrl(url: string): boolean {
  if (url.length > 1000 || /[\s\\]/.test(url)) return false
  if (url.startsWith("/") && !url.startsWith("//")) return true
  try {
    return new URL(url).protocol === "https:"
  } catch {
    return false
  }
}

export function validateComment(raw: unknown): CommentInput {
  const input = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>
  const fields: Record<string, string> = {}
  const body = typeof input.body === "string" ? input.body.trim() : ""
  if (!body) fields.body = "Comment cannot be empty"
  else if (body.length > COMMENT_BODY_MAX) fields.body = `Comment must be at most ${COMMENT_BODY_MAX} characters`

  const rawAtt = input.attachments ?? []
  const attachments: AttachmentInput[] = []
  if (!Array.isArray(rawAtt)) fields.attachments = "Attachments must be a list"
  else if (rawAtt.length > MAX_ATTACHMENTS) fields.attachments = `At most ${MAX_ATTACHMENTS} attachments`
  else {
    rawAtt.forEach((a: any, i) => {
      const name = typeof a?.name === "string" ? a.name.trim() : ""
      const url = typeof a?.url === "string" ? a.url.trim() : ""
      const size = a?.sizeBytes == null ? null : Number(a.sizeBytes)
      const mime = typeof a?.mimeType === "string" ? a.mimeType.slice(0, 120) : null
      if (!name || name.length > 200) fields[`attachments.${i}.name`] = "Attachment name is required (max 200)"
      else if (!validAttachmentUrl(url)) fields[`attachments.${i}.url`] = "Attachment must be an internal path or https URL"
      else if (size != null && (!Number.isSafeInteger(size) || size < 0 || size > MAX_ATTACHMENT_BYTES))
        fields[`attachments.${i}.sizeBytes`] = "Attachment exceeds the 25 MB limit"
      else attachments.push({ name, url, mimeType: mime, sizeBytes: size })
    })
  }

  const idem = input.idempotencyKey
  let idempotencyKey: string | null = null
  if (idem != null && idem !== "") {
    if (typeof idem !== "string" || !IDEMPOTENCY_RE.test(idem)) fields.idempotencyKey = "Invalid idempotency key"
    else idempotencyKey = idem
  }

  let parentId: number | null = null
  if (input.parentId != null) {
    const p = Number(input.parentId)
    if (!Number.isSafeInteger(p) || p < 1) fields.parentId = "Invalid parent comment"
    else parentId = p
  }

  const mentionIds = body ? parseMentions(body) : []
  if (mentionIds.length > MAX_MENTIONS) fields.body = `At most ${MAX_MENTIONS} people can be mentioned`

  if (Object.keys(fields).length) throw new CollabError(422, "Invalid comment", fields)
  return { body, attachments, mentionIds, idempotencyKey, parentId }
}

/** Internal deep link to a specific comment on a record (validated for the notification engine). */
export function commentDeepLink(subject: CollabSubject, subjectId: number, commentId: number): string {
  const base = subject.link(subjectId)
  const link = `${base}#comment-${commentId}`
  return link.length <= 255 ? link : base.slice(0, 255)
}

// ---------------------------------------------------------------------------
// Users — deleted / deactivated display
// ---------------------------------------------------------------------------

export type UserRef = { id: number; name: string | null; status: string | null; lifecycle_state?: string | null }

export function isActiveUser(u: UserRef | null | undefined): boolean {
  if (!u) return false
  if (u.status && u.status !== "active") return false
  if (u.lifecycle_state && u.lifecycle_state !== "active") return false
  return true
}

export function displayUser(u: UserRef | null | undefined): { id: number | null; name: string; active: boolean } {
  if (!u) return { id: null, name: "Deleted user", active: false }
  const active = isActiveUser(u)
  const name = (u.name ?? "").trim() || `User #${u.id}`
  return { id: u.id, name: active ? name : `${name} (deactivated)`, active }
}

// ---------------------------------------------------------------------------
// CRM communication events
// ---------------------------------------------------------------------------

export const CRM_CHANNELS = ["email", "call", "whatsapp", "meeting", "note"] as const
export type CrmChannel = (typeof CRM_CHANNELS)[number]
export const CRM_DIRECTIONS = ["inbound", "outbound", "internal"] as const

export type CrmEventInput = {
  channel: CrmChannel
  subjectType: string
  subjectId: number
  sourceRef: string
  direction: (typeof CRM_DIRECTIONS)[number]
  title: string
  body: string | null
  occurredAt: string | null
  durationSeconds: number | null
}

export function validateCrmEvent(raw: unknown): CrmEventInput {
  const i = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>
  const fields: Record<string, string> = {}
  const channel = i.channel as CrmChannel
  if (!(CRM_CHANNELS as readonly string[]).includes(String(channel))) fields.channel = "Unsupported channel"
  const subjectType = String(i.subjectType ?? "")
  const subject = getSubject(subjectType)
  if (!subject || !subject.crm) fields.subjectType = "Not a CRM record"
  let subjectId = 0
  try {
    subjectId = parseSubjectId(i.subjectId)
  } catch {
    fields.subjectId = "Invalid record id"
  }
  const sourceRef = typeof i.sourceRef === "string" ? i.sourceRef.trim() : ""
  if (!/^[A-Za-z0-9_:.@\-/]{1,150}$/.test(sourceRef)) fields.sourceRef = "A stable source reference is required"
  const direction = (i.direction ?? (channel === "note" ? "internal" : "outbound")) as CrmEventInput["direction"]
  if (!(CRM_DIRECTIONS as readonly string[]).includes(String(direction))) fields.direction = "Invalid direction"
  const title = typeof i.title === "string" ? i.title.trim() : ""
  if (!title || title.length > 200) fields.title = "Title is required (max 200)"
  const body = typeof i.body === "string" ? i.body.slice(0, 10000) : null
  let occurredAt: string | null = null
  if (i.occurredAt != null) {
    const t = Date.parse(String(i.occurredAt))
    if (!Number.isFinite(t)) fields.occurredAt = "Invalid date"
    else occurredAt = new Date(t).toISOString()
  }
  let durationSeconds: number | null = null
  if (i.durationSeconds != null) {
    const d = Number(i.durationSeconds)
    if (!Number.isSafeInteger(d) || d < 0 || d > 86400) fields.durationSeconds = "Invalid duration"
    else durationSeconds = d
  }
  if (Object.keys(fields).length) throw new CollabError(422, "Invalid communication event", fields)
  return { channel, subjectType, subjectId, sourceRef, direction, title, body, occurredAt, durationSeconds }
}

export function crmDedupeKey(e: Pick<CrmEventInput, "channel" | "sourceRef">): string {
  return `crm:${e.channel}:${e.sourceRef}`.slice(0, 191)
}

// ---------------------------------------------------------------------------
// Hidden / masked fields in timeline metadata
// ---------------------------------------------------------------------------

export type FieldVisibility = "hidden" | "masked"
const MASK = "••••"

/**
 * Remove or mask protected field values carried in activity metadata. Handles
 * the two shapes module hooks emit: `{ field, from, to }` (status_change) and
 * `{ changes: { [field]: { from, to } | value } }`.
 */
export function redactActivityMeta(
  meta: Record<string, unknown> | null,
  effects: Map<string, FieldVisibility>,
): { meta: Record<string, unknown> | null; redacted: string[] } {
  if (!meta || effects.size === 0) return { meta, redacted: [] }
  const out: Record<string, unknown> = { ...meta }
  const redacted: string[] = []
  const field = typeof out.field === "string" ? out.field : null
  if (field && effects.has(field)) {
    redacted.push(field)
    if (effects.get(field) === "hidden") {
      delete out.field
      delete out.from
      delete out.to
    } else {
      if ("from" in out) out.from = MASK
      if ("to" in out) out.to = MASK
    }
  }
  if (out.changes && typeof out.changes === "object" && !Array.isArray(out.changes)) {
    const changes: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(out.changes as Record<string, unknown>)) {
      const eff = effects.get(k)
      if (!eff) changes[k] = v
      else {
        redacted.push(k)
        if (eff === "masked") changes[k] = v && typeof v === "object" ? { from: MASK, to: MASK } : MASK
      }
    }
    out.changes = changes
  }
  if (redacted.length) out.redacted_fields = [...new Set(redacted)]
  return { meta: out, redacted }
}

// ---------------------------------------------------------------------------
// Unified task + approval inbox
// ---------------------------------------------------------------------------

export type InboxItem = {
  kind: "task" | "approval"
  id: number
  title: string
  moduleKey: string
  status: string
  priority: string | null
  dueAt: string | null
  createdAt: string
  link: string
}

/** Map an approval request's module to the permission module that must be viewable. */
export const APPROVAL_MODULE_PERMISSION: Record<string, string> = {
  purchase_order: "finance.purchase_orders",
  purchase_request: "finance.purchase_orders",
  expense: "finance.expenses",
  leave: "hr.leaves",
  sales_invoice: "finance.sales_invoices",
  quotation: "sales.quotations",
  deal: "sales.deals",
  payment: "finance.payments",
}

/** Overdue first, then soonest due, then oldest created. Stable & deterministic. */
export function sortInbox(items: InboxItem[], now: Date = new Date()): InboxItem[] {
  const t = now.getTime()
  return [...items].sort((a, b) => {
    const ad = a.dueAt ? Date.parse(a.dueAt) : Number.POSITIVE_INFINITY
    const bd = b.dueAt ? Date.parse(b.dueAt) : Number.POSITIVE_INFINITY
    const ao = ad < t ? 0 : 1
    const bo = bd < t ? 0 : 1
    if (ao !== bo) return ao - bo
    if (ad !== bd) return ad - bd
    const ac = Date.parse(a.createdAt) || 0
    const bc = Date.parse(b.createdAt) || 0
    if (ac !== bc) return ac - bc
    return a.kind === b.kind ? a.id - b.id : a.kind < b.kind ? -1 : 1
  })
}
