/**
 * Separated audit streams (pure model) — Spec47, #38-40, #209-212, #245-249.
 * ---------------------------------------------------------------------------
 * The ERP already writes three append-only trails:
 *   - `audit_log_entries`      (lib/audit-log-store.ts)      general, hashed
 *   - `security_audit_events`  (lib/security-audit-store.ts) security events
 *   - `platform_admin_audit`   (lib/platform-roles.ts)       operator actions
 *
 * This module does NOT add a fourth trail. It defines five read PROJECTIONS
 * over those sources — platform, tenant, billing, support, security — and the
 * rules deciding which viewer may read which projection, how rows are masked
 * for export, how integrity is re-verified, and the conflict / expiry rules
 * for privileged access (access reviews, impersonation). It is DB-free so every
 * rule is unit-testable and shared by the store and the API routes.
 */
import { createHash } from "node:crypto"
import { type AuditLegalHoldFilter, holdMatchesEntry, isBeyondRetention } from "@/lib/audit-retention-policy"

// ---------------------------------------------------------------------------
// Streams & classification
// ---------------------------------------------------------------------------

export const AUDIT_STREAMS = ["platform", "tenant", "billing", "support", "security"] as const
export type AuditStream = (typeof AUDIT_STREAMS)[number]

export function isAuditStream(value: unknown): value is AuditStream {
  return typeof value === "string" && (AUDIT_STREAMS as readonly string[]).includes(value)
}

/** Action-name prefixes (`<entity>.<verb>` taxonomy) that route an audit_log row to a dedicated stream. */
export const STREAM_ACTION_PREFIXES: Readonly<Record<"security" | "billing" | "support", readonly string[]>> = {
  security: [
    "auth.",
    "mfa.",
    "sso.",
    "session.",
    "role.",
    "permission.",
    "access_policy.",
    "access_review.",
    "temporary_access.",
    "break_glass.",
    "impersonation.",
    "api_key.",
    "service_account.",
    "managed_device",
    "geo_policy.",
    "security.",
  ],
  billing: ["billing.", "subscription.", "invoice.", "payment.", "coupon.", "plan.", "usage."],
  support: ["support.", "ticket.", "helpdesk."],
}

/** Operator actions in `platform_admin_audit` that are privileged-access evidence. */
export const PLATFORM_SECURITY_ACTIONS: readonly string[] = [
  "impersonation_start",
  "impersonation_stop",
  "impersonation_denied",
  "assign_platform_role",
  "assign_tenant_role",
]

function hasPrefix(action: string, prefixes: readonly string[]): boolean {
  return prefixes.some((p) => action.startsWith(p))
}

export type AuditSource = "audit_log" | "security_event" | "platform_admin"

/**
 * The single stream a source row belongs to. Every row lands in exactly one
 * stream, so the projections never double-count or leak across boundaries.
 * Precedence: security > billing > support > (platform-wide | tenant).
 */
export function classifyAuditRow(source: AuditSource, action: string, tenantId: number | null): AuditStream {
  if (source === "security_event") return "security"
  if (source === "platform_admin") return PLATFORM_SECURITY_ACTIONS.includes(action) ? "security" : "platform"
  if (hasPrefix(action, STREAM_ACTION_PREFIXES.security)) return "security"
  if (hasPrefix(action, STREAM_ACTION_PREFIXES.billing)) return "billing"
  if (hasPrefix(action, STREAM_ACTION_PREFIXES.support)) return "support"
  return tenantId == null ? "platform" : "tenant"
}

// ---------------------------------------------------------------------------
// Viewers & visibility
// ---------------------------------------------------------------------------

export type StreamViewer =
  | { kind: "tenant_admin"; tenantId: number; isOwner: boolean }
  | { kind: "platform_staff" }
  | { kind: "platform_super_admin" }

/**
 * Which projections a viewer may read.
 *   - Tenant admins read their OWN tenant's tenant/billing/support/security
 *     streams — never the platform stream, never another tenant's rows.
 *   - Platform staff read the platform operator stream plus the cross-tenant
 *     billing/support streams they operate. A platform role grants NOTHING on a
 *     tenant's own business trail (they must impersonate, which is audited).
 *   - Only a platform super admin reads the cross-tenant security stream.
 */
export function canReadStream(viewer: StreamViewer, stream: AuditStream): boolean {
  switch (viewer.kind) {
    case "tenant_admin":
      return stream !== "platform"
    case "platform_staff":
      return stream === "platform" || stream === "billing" || stream === "support"
    case "platform_super_admin":
      return stream !== "tenant"
  }
}

/** Unmasked export is reserved for the most-privileged role on each side and always needs a reason. */
export function canExportUnmasked(viewer: StreamViewer): boolean {
  return viewer.kind === "platform_super_admin" || (viewer.kind === "tenant_admin" && viewer.isOwner)
}

// ---------------------------------------------------------------------------
// SQL scoping for audit_log_entries (pure so cross-tenant rules are testable)
// ---------------------------------------------------------------------------

function likeEscape(prefix: string): string {
  return `${prefix.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
}

function prefixClause(prefixes: readonly string[]): { sql: string; params: string[] } {
  return {
    sql: `(${prefixes.map(() => "`action` LIKE ?").join(" OR ")})`,
    params: prefixes.map(likeEscape),
  }
}

export class StreamAccessError extends Error {
  status: number
  constructor(message: string, status = 403) {
    super(message)
    this.name = "StreamAccessError"
    this.status = status
  }
}

/**
 * WHERE clause selecting the `audit_log_entries` rows of one stream for one
 * viewer. A tenant viewer is ALWAYS pinned to `tenant_id = ?` (its session
 * tenant) — platform-wide NULL-tenant rows are never included, which closes the
 * old "platform rows visible to every tenant" leak. `filterTenantId` narrows a
 * platform viewer to one tenant and is ignored for tenant viewers.
 */
export function buildAuditLogStreamWhere(
  stream: AuditStream,
  viewer: StreamViewer,
  filterTenantId?: number | null,
): { sql: string; params: unknown[] } {
  if (!canReadStream(viewer, stream)) throw new StreamAccessError("You may not read this audit stream")
  const clauses: string[] = []
  const params: unknown[] = []

  if (viewer.kind === "tenant_admin") {
    clauses.push("`tenant_id` = ?")
    params.push(viewer.tenantId)
  } else if (stream === "platform") {
    clauses.push("`tenant_id` IS NULL")
  } else if (filterTenantId != null) {
    clauses.push("`tenant_id` = ?")
    params.push(filterTenantId)
  }

  if (stream === "security" || stream === "billing" || stream === "support") {
    const own = prefixClause(STREAM_ACTION_PREFIXES[stream])
    clauses.push(own.sql)
    params.push(...own.params)
    // Enforce precedence: a billing row that is also a security action belongs to security only.
    const higher = stream === "billing" ? ["security"] : stream === "support" ? ["security", "billing"] : []
    for (const h of higher) {
      const ex = prefixClause(STREAM_ACTION_PREFIXES[h as "security" | "billing"])
      clauses.push(`NOT ${ex.sql}`)
      params.push(...ex.params)
    }
  } else {
    const all = prefixClause([
      ...STREAM_ACTION_PREFIXES.security,
      ...STREAM_ACTION_PREFIXES.billing,
      ...STREAM_ACTION_PREFIXES.support,
    ])
    clauses.push(`NOT ${all.sql}`)
    params.push(...all.params)
  }

  return { sql: `WHERE ${clauses.join(" AND ")}`, params }
}

// ---------------------------------------------------------------------------
// Normalized record
// ---------------------------------------------------------------------------

export type IntegrityStatus = "verified" | "mismatch" | "unsigned"

export type StreamRecord = {
  source: AuditSource
  sourceId: number
  stream: AuditStream
  tenantId: number | null
  occurredAt: string
  actorUserId: number | null
  actorName: string | null
  actorEmail: string | null
  subject: string | null
  action: string
  outcome: string
  entityType: string | null
  entityId: string | null
  ipAddress: string | null
  userAgent: string | null
  detail: Record<string, unknown> | null
  integrity: IntegrityStatus
}

// ---------------------------------------------------------------------------
// Integrity (tamper evidence)
// ---------------------------------------------------------------------------

/**
 * EXACT hash used by lib/audit-log-store.ts at insert time. Shared from here so
 * verification can never drift from writing. (Top-level sorted-key replacer —
 * kept byte-compatible with every hash already stored.)
 */
export function computeAuditIntegrityHash(fields: Record<string, unknown>): string {
  const canonical = JSON.stringify(fields, Object.keys(fields).sort())
  return createHash("sha256").update(canonical).digest("hex")
}

export type HashableAuditRow = {
  requestId: string | null
  tenantId: number | null
  actorUserId: number | null
  sessionId: string | null
  ipAddress: string | null
  action: string
  entityType: string | null
  entityId: string | null
  result: string
  before: Record<string, unknown> | null
  after: Record<string, unknown> | null
  integrityHash: string | null
}

/** Re-derive a stored row's hash; any out-of-band edit yields `mismatch`. */
export function verifyAuditRowIntegrity(row: HashableAuditRow): IntegrityStatus {
  if (!row.integrityHash) return "unsigned"
  const expected = computeAuditIntegrityHash({
    requestId: row.requestId,
    tenantId: row.tenantId == null ? null : Number(row.tenantId),
    actorUserId: row.actorUserId == null ? null : Number(row.actorUserId),
    sessionId: row.sessionId,
    ipAddress: row.ipAddress,
    action: row.action,
    entityType: row.entityType,
    entityId: row.entityId,
    result: row.result,
    before: row.before,
    after: row.after,
  })
  return expected === row.integrityHash ? "verified" : "mismatch"
}

/** Deterministic JSON with keys sorted at every depth. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`
  const obj = value as Record<string, unknown>
  return `{${Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(",")}}`
}

/**
 * Hash chain over an export's records (h_i = sha256(h_{i-1} + record_i)).
 * Reordering, dropping or editing any record after export changes the digest.
 */
export function computeExportDigest(records: readonly unknown[]): string {
  let h = ""
  for (const r of records) h = createHash("sha256").update(h).update(stableStringify(r)).digest("hex")
  return h || createHash("sha256").update("empty").digest("hex")
}

// ---------------------------------------------------------------------------
// Field masking
// ---------------------------------------------------------------------------

/** Keys whose values are secrets and are ALWAYS redacted, even in an unmasked export. */
const SECRET_KEY = /(pass(word|code)?|secret|token|api[_-]?key|authorization|cookie|otp|cvv|card[_-]?number|private[_-]?key|signature)/i
/** Keys holding personal data, masked unless an unmasked export is authorized. */
const PII_KEY = /(email|phone|mobile|ip(_?address)?|user[_-]?agent|ssn|aadhaar|pan|address)/i
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export const REDACTED = "[REDACTED]"

export function maskEmail(value: string | null | undefined): string | null {
  if (!value) return value ?? null
  const at = value.indexOf("@")
  if (at <= 0) return "***"
  return `${value[0]}***${value.slice(at)}`
}

export function maskIp(value: string | null | undefined): string | null {
  if (!value) return value ?? null
  if (value.includes(".") && !value.includes(":")) {
    const parts = value.split(".")
    return parts.length === 4 ? `${parts[0]}.${parts[1]}.x.x` : "x.x.x.x"
  }
  const groups = value.split(":").filter(Boolean)
  return `${groups.slice(0, 2).join(":")}::*`
}

export function maskUserAgent(value: string | null | undefined): string | null {
  if (!value) return value ?? null
  return `${value.split(/[\s/]/)[0] || "client"}/*`
}

export function maskName(value: string | null | undefined): string | null {
  if (!value) return value ?? null
  return value
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => `${w[0]}.`)
    .join(" ")
}

function maskScalar(key: string, v: unknown, masked: boolean): unknown {
  if (SECRET_KEY.test(key)) return REDACTED
  if (!masked) return v
  if (typeof v === "string") {
    if (EMAIL_RE.test(v)) return maskEmail(v)
    if (PII_KEY.test(key)) return /ip/i.test(key) ? maskIp(v) : "***"
  }
  return v
}

/** Recursively mask a JSON detail blob. Secrets are always redacted. */
export function maskDetail(value: unknown, masked: boolean, depth = 0, key = ""): unknown {
  if (depth > 8) return REDACTED
  if (Array.isArray(value)) return value.map((v) => maskDetail(v, masked, depth + 1, key))
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = v && typeof v === "object" && !SECRET_KEY.test(k) ? maskDetail(v, masked, depth + 1, k) : maskScalar(k, v, masked)
    }
    return out
  }
  return maskScalar(key, value, masked)
}

export function maskStreamRecord(record: StreamRecord, masked: boolean): StreamRecord {
  const detail = record.detail ? (maskDetail(record.detail, masked) as Record<string, unknown>) : null
  if (!masked) return { ...record, detail }
  return {
    ...record,
    actorName: maskName(record.actorName),
    actorEmail: maskEmail(record.actorEmail),
    subject: record.subject && EMAIL_RE.test(record.subject) ? maskEmail(record.subject) : record.subject ? "***" : null,
    ipAddress: maskIp(record.ipAddress),
    userAgent: maskUserAgent(record.userAgent),
    detail,
  }
}

// ---------------------------------------------------------------------------
// Retention & legal hold for exports
// ---------------------------------------------------------------------------

export type RetentionAnnotated = StreamRecord & { legalHold: boolean }

/**
 * Apply the effective audit retention policy to an export. Records past the
 * retention window are excluded (they are due for archive/purge and must not be
 * re-distributed) UNLESS an active legal hold covers them — a hold always wins.
 */
export function applyExportRetention(
  records: readonly StreamRecord[],
  opts: { retentionDays: number; holds: readonly AuditLegalHoldFilter[]; now?: Date },
): { kept: RetentionAnnotated[]; excludedByRetention: number; heldCount: number } {
  const now = opts.now ?? new Date()
  const kept: RetentionAnnotated[] = []
  let excludedByRetention = 0
  let heldCount = 0
  for (const r of records) {
    const legalHold = opts.holds.some((h) =>
      holdMatchesEntry(h, { action: r.action, entityType: r.entityType, actorUserId: r.actorUserId, createdAt: r.occurredAt }),
    )
    if (legalHold) heldCount++
    if (!legalHold && isBeyondRetention(r.occurredAt, opts.retentionDays, now)) {
      excludedByRetention++
      continue
    }
    kept.push({ ...r, legalHold })
  }
  return { kept, excludedByRetention, heldCount }
}

// ---------------------------------------------------------------------------
// Export request validation & idempotency
// ---------------------------------------------------------------------------

export const EXPORT_LIMITS = { MAX_ROWS: 5000, DEFAULT_ROWS: 1000, MIN_REASON: 10, MAX_REASON: 500 } as const

export function isValidIdempotencyKey(key: unknown): key is string {
  return typeof key === "string" && /^[A-Za-z0-9_\-:.]{8,128}$/.test(key)
}

export type ExportRequest = {
  stream: AuditStream
  masked: boolean
  reason: string
  from: string | null
  to: string | null
  limit: number
  tenantId: number | null
}

function isoOrNull(v: unknown): string | null {
  if (v == null || v === "") return null
  const d = new Date(String(v))
  if (Number.isNaN(d.getTime())) throw new StreamAccessError("Invalid date filter", 400)
  return d.toISOString()
}

/** Validate an export body. Throws StreamAccessError(400/403) on bad input. */
export function parseExportRequest(body: unknown, viewer: StreamViewer): ExportRequest {
  const b = (body ?? {}) as Record<string, unknown>
  if (!isAuditStream(b.stream)) throw new StreamAccessError("A valid stream is required", 400)
  if (!canReadStream(viewer, b.stream)) throw new StreamAccessError("You may not export this audit stream")
  const masked = b.masked !== false
  const reason = typeof b.reason === "string" ? b.reason.trim() : ""
  if (reason.length < EXPORT_LIMITS.MIN_REASON || reason.length > EXPORT_LIMITS.MAX_REASON) {
    throw new StreamAccessError(`A justification of ${EXPORT_LIMITS.MIN_REASON}-${EXPORT_LIMITS.MAX_REASON} characters is required`, 400)
  }
  if (!masked && !canExportUnmasked(viewer)) {
    throw new StreamAccessError("Unmasked export requires tenant owner or platform super admin")
  }
  const from = isoOrNull(b.from)
  const to = isoOrNull(b.to)
  if (from && to && from > to) throw new StreamAccessError("`from` must be before `to`", 400)
  const rawLimit = Number(b.limit ?? EXPORT_LIMITS.DEFAULT_ROWS)
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.trunc(rawLimit), 1), EXPORT_LIMITS.MAX_ROWS) : EXPORT_LIMITS.DEFAULT_ROWS
  // Only platform viewers may narrow to a tenant; tenant viewers are pinned to their session tenant.
  const tenantId =
    viewer.kind === "tenant_admin"
      ? viewer.tenantId
      : b.tenantId != null && Number.isInteger(Number(b.tenantId)) && Number(b.tenantId) > 0
        ? Number(b.tenantId)
        : null
  return { stream: b.stream, masked, reason, from, to, limit, tenantId }
}

export function exportFingerprint(req: ExportRequest): string {
  return createHash("sha256").update(stableStringify(req)).digest("hex")
}

// ---------------------------------------------------------------------------
// Append-only protection
// ---------------------------------------------------------------------------

/** Tables that are evidence: no tenant-facing edit/delete path may target them. */
export const APPEND_ONLY_TABLES: readonly string[] = [
  "audit_log_entries",
  "audit_log_archive_batches",
  "security_audit_events",
  "platform_admin_audit",
  "security_audit_exports",
]

export function isAppendOnlyTable(table: string): boolean {
  return APPEND_ONLY_TABLES.includes(table.replace(/`/g, "").trim().toLowerCase())
}

/** Guard for generic mutators (bulk actions, recycle bin, CRUD configs). */
export function assertMutableTable(table: string): void {
  if (isAppendOnlyTable(table)) throw new StreamAccessError(`${table} is append-only and cannot be edited or deleted`, 405)
}

// ---------------------------------------------------------------------------
// Privileged access: reviewer conflicts
// ---------------------------------------------------------------------------

export type ReviewerConflict =
  | "reviewer_is_subject"
  | "reviewer_not_in_tenant"
  | "not_assigned_reviewer"
  | "self_review"
  | "campaign_closed"

export const REVIEWER_CONFLICT_MESSAGES: Record<ReviewerConflict, string> = {
  reviewer_is_subject: "The reviewer cannot also be a subject of the same access review",
  reviewer_not_in_tenant: "The reviewer must be an active user of this organization",
  not_assigned_reviewer: "Only the assigned reviewer can decide items in this access review",
  self_review: "A reviewer cannot certify their own access",
  campaign_closed: "This access review is no longer open for decisions",
}

/** Segregation-of-duties check at campaign creation. */
export function checkCampaignReviewer(input: {
  reviewerId: number
  reviewerActiveInTenant: boolean
  subjectIds: ReadonlyArray<number | null | undefined>
}): ReviewerConflict | null {
  if (!input.reviewerActiveInTenant) return "reviewer_not_in_tenant"
  if (input.subjectIds.some((id) => id != null && Number(id) === input.reviewerId)) return "reviewer_is_subject"
  return null
}

/** Segregation-of-duties check at decision time. */
export function checkDecisionConflict(input: {
  actorUserId: number
  reviewerId: number
  subjectId: number | null
  campaignStatus: string
}): ReviewerConflict | null {
  if (input.campaignStatus !== "open" && input.campaignStatus !== "overdue") return "campaign_closed"
  if (input.subjectId != null && input.subjectId === input.actorUserId) return "self_review"
  if (input.actorUserId !== input.reviewerId) return "not_assigned_reviewer"
  return null
}

// ---------------------------------------------------------------------------
// Privileged access: impersonation window
// ---------------------------------------------------------------------------

export {
  IMPERSONATION_LIMITS,
  resolveImpersonationMinutes,
  computeImpersonationExpiry,
  isImpersonationWindowOpen,
  validateImpersonationReason,
} from "@/lib/impersonation-window"
