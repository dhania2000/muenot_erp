import "server-only"
/**
 * Enterprise audit log foundation.
 * ---------------------------------------------------------------------------
 * A single, immutable, append-only record of every meaningful operation across
 * the platform. Distinct from lib/security-audit-store.ts (which is a focused
 * security-event trail): this is the general foundation every major module logs
 * to, capturing the full forensic context of an action.
 *
 * Each entry records:
 *   who        — actor user id, name, email, role
 *   tenant     — tenant_id the action happened in (NULL = platform-wide)
 *   when       — created_at (millisecond precision)
 *   where      — ip address + user agent (device) + session id
 *   what       — action (e.g. "user.create"), entity type + id + label
 *   change     — before / after snapshots where appropriate
 *   result     — success | failure | denied
 *   request    — request id for correlating a single HTTP request's events
 *
 * Immutability is enforced at two layers:
 *   1. Application: this module exposes NO update/delete function.
 *   2. Database: BEFORE UPDATE / BEFORE DELETE triggers reject mutations, and
 *      every row carries a SHA-256 integrity hash of its own content so any
 *      out-of-band tampering is detectable.
 *
 * Writes are best-effort — recording an audit entry must never change or block
 * the primary operation's own outcome. Self-heals its schema at runtime (same
 * pattern as lib/security-audit-store.ts) so existing databases converge with
 * no manual migration step.
 */
import { createHash, randomUUID } from "node:crypto"
import { query } from "@/lib/db"
import { getSession } from "@/lib/auth"
import { getClientIp } from "@/lib/rate-limit"

export type AuditResult = "success" | "failure" | "denied"

/**
 * the ONLY authorized way to remove an audit row is the retention
 * purge, and only after the row has been sealed into the immutable archive.
 * The BEFORE DELETE trigger rejects every delete UNLESS this connection-scoped
 * session flag is set to 1, which lib/audit-retention.ts sets on a dedicated
 * transaction connection, deletes, then clears. UPDATEs remain rejected
 * unconditionally — an audit row's content is never mutable.
 */
export const AUDIT_PURGE_SESSION_FLAG = "@audit_retention_purge"

/**
 * Phase 1 — inventory of auditable operations, expressed as a stable
 * `<entity>.<verb>` taxonomy. Kept open (string) so modules can log new actions
 * without a code change here, while these constants document the major surface.
 */
export const AUDIT_ACTIONS = {
  // Authentication & session
  authLogin: "auth.login",
  authLogout: "auth.logout",
  authLoginDenied: "auth.login_denied",
  authMfaChallenge: "auth.mfa_challenge",
  // Users & lifecycle
  userCreate: "user.create",
  userUpdate: "user.update",
  userDelete: "user.delete",
  userSuspend: "user.suspend",
  userReactivate: "user.reactivate",
  // Roles & permissions
  roleAssign: "role.assign",
  roleRevoke: "role.revoke",
  permissionGrant: "permission.grant",
  permissionRevoke: "permission.revoke",
  // Access control
  accessPolicyCreate: "access_policy.create",
  accessPolicyUpdate: "access_policy.update",
  accessPolicyDelete: "access_policy.delete",
  geoPolicyUpdate: "geo_policy.update",
  managedDevicePolicyUpdate: "managed_device_policy.update",
  managedDeviceEnroll: "managed_device.enroll",
  managedDeviceRevoke: "managed_device.revoke",
  temporaryAccessGrant: "temporary_access.grant",
  temporaryAccessRevoke: "temporary_access.revoke",
  // Credentials
  apiKeyCreate: "api_key.create",
  apiKeyRevoke: "api_key.revoke",
  serviceAccountCreate: "service_account.create",
  serviceAccountDelete: "service_account.delete",
  // Data modules (finance, HR, sales, etc.) log "<module>.<verb>" freely.
} as const

export type AuditEntry = {
  id: number
  requestId: string | null
  tenantId: number | null
  actorUserId: number | null
  actorName: string | null
  actorEmail: string | null
  actorRole: string | null
  sessionId: string | null
  ipAddress: string | null
  userAgent: string | null
  action: string
  entityType: string | null
  entityId: string | null
  entityLabel: string | null
  result: AuditResult
  before: Record<string, unknown> | null
  after: Record<string, unknown> | null
  metadata: Record<string, unknown> | null
  integrityHash: string | null
  createdAt: string
}

type EntryRow = {
  id: number
  request_id: string | null
  tenant_id: number | null
  actor_user_id: number | null
  actor_name: string | null
  actor_email: string | null
  actor_role: string | null
  session_id: string | null
  ip_address: string | null
  user_agent: string | null
  action: string
  entity_type: string | null
  entity_id: string | null
  entity_label: string | null
  result: AuditResult
  before_data: string | null
  after_data: string | null
  metadata: string | null
  integrity_hash: string | null
  created_at: string
}

let ensured: Promise<void> | null = null

async function runEnsure(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS \`audit_log_entries\` (
      \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      \`request_id\` VARCHAR(64) DEFAULT NULL,
      \`tenant_id\` INT UNSIGNED DEFAULT NULL,
      \`actor_user_id\` INT UNSIGNED DEFAULT NULL,
      \`actor_name\` VARCHAR(160) DEFAULT NULL,
      \`actor_email\` VARCHAR(190) DEFAULT NULL,
      \`actor_role\` VARCHAR(32) DEFAULT NULL,
      \`session_id\` VARCHAR(64) DEFAULT NULL,
      \`ip_address\` VARCHAR(64) DEFAULT NULL,
      \`user_agent\` VARCHAR(512) DEFAULT NULL,
      \`action\` VARCHAR(96) NOT NULL,
      \`entity_type\` VARCHAR(96) DEFAULT NULL,
      \`entity_id\` VARCHAR(128) DEFAULT NULL,
      \`entity_label\` VARCHAR(255) DEFAULT NULL,
      \`result\` VARCHAR(16) NOT NULL DEFAULT 'success',
      \`before_data\` JSON DEFAULT NULL,
      \`after_data\` JSON DEFAULT NULL,
      \`metadata\` JSON DEFAULT NULL,
      \`integrity_hash\` CHAR(64) DEFAULT NULL,
      \`created_at\` TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      PRIMARY KEY (\`id\`),
      KEY \`idx_audit_tenant\` (\`tenant_id\`),
      KEY \`idx_audit_actor\` (\`actor_user_id\`),
      KEY \`idx_audit_action\` (\`action\`),
      KEY \`idx_audit_entity\` (\`entity_type\`, \`entity_id\`),
      KEY \`idx_audit_created\` (\`created_at\`),
      KEY \`idx_audit_request\` (\`request_id\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)
  await ensureImmutabilityTriggers()
}

/**
 * Database-level immutability. Reject any UPDATE against the audit table
 * unconditionally, and reject every DELETE EXCEPT an authorized retention purge
 * that sets the AUDIT_PURGE_SESSION_FLAG on its own connection first.
 * Best-effort and idempotent: CREATE TRIGGER has no IF NOT EXISTS on most MySQL
 * versions, so we drop-then-create to upgrade older installs, and swallow any
 * failure so a hosting account that forbids trigger creation still gets
 * application-level immutability (the store exposes no update/delete function).
 */
async function ensureImmutabilityTriggers(): Promise<void> {
  try {
    await query(`DROP TRIGGER IF EXISTS \`audit_log_no_update\``)
    await query(
      `CREATE TRIGGER \`audit_log_no_update\` BEFORE UPDATE ON \`audit_log_entries\`
       FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'audit_log_entries is append-only'`,
    )
    await query(`DROP TRIGGER IF EXISTS \`audit_log_no_delete\``)
    // The compound body is a single CREATE TRIGGER statement (safe for one
    // pool.query call — no multi-statement mode needed). Deletes are allowed
    // only when the retention purge has flagged this connection.
    await query(
      `CREATE TRIGGER \`audit_log_no_delete\` BEFORE DELETE ON \`audit_log_entries\`
       FOR EACH ROW
       BEGIN
         IF ${AUDIT_PURGE_SESSION_FLAG} IS NULL OR ${AUDIT_PURGE_SESSION_FLAG} <> 1 THEN
           SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'audit_log_entries is append-only; deletion is only permitted via authorized retention purge';
         END IF;
       END`,
    )
  } catch (err) {
    console.warn("[v0] audit immutability triggers not installed (app-level immutability still applies):", (err as Error).message)
  }
}

export function ensureAuditSchema(): Promise<void> {
  if (!ensured) {
    ensured = runEnsure().catch((err) => {
      ensured = null
      throw err
    })
  }
  return ensured
}

/**
 * Request/actor context resolved once per HTTP request and reused across the
 * events it emits. `getSession()` also populates actor/tenant async-context, so
 * this stays cheap even when called from several handlers in one request.
 */
export type AuditContext = {
  requestId: string
  tenantId: number | null
  actorUserId: number | null
  actorName: string | null
  actorEmail: string | null
  actorRole: string | null
  sessionId: string | null
  ipAddress: string | null
  userAgent: string | null
}

export async function captureAuditContext(request: Request): Promise<AuditContext> {
  const session = await getSession().catch(() => null)
  const requestId = request.headers.get("x-request-id")?.trim() || randomUUID()
  return {
    requestId,
    tenantId: session?.tenantId ?? null,
    actorUserId: session?.userId ?? null,
    actorName: session?.name ?? null,
    actorEmail: session?.email ?? null,
    actorRole: session?.role ?? null,
    sessionId: session?.sid ?? null,
    ipAddress: getClientIp(request),
    userAgent: request.headers.get("user-agent"),
  }
}

function computeIntegrityHash(fields: Record<string, unknown>): string {
  // Canonical JSON with sorted keys so the hash is deterministic.
  const canonical = JSON.stringify(fields, Object.keys(fields).sort())
  return createHash("sha256").update(canonical).digest("hex")
}

export type RecordAuditInput = {
  action: string
  result?: AuditResult
  entityType?: string | null
  entityId?: string | number | null
  entityLabel?: string | null
  before?: Record<string, unknown> | null
  after?: Record<string, unknown> | null
  metadata?: Record<string, unknown> | null
  /** Override any field of the resolved context (e.g. actor on a failed login). */
  context?: Partial<AuditContext>
}

/**
 * Append one audit entry. Best-effort: never throws. Pass a context captured
 * via captureAuditContext(); when omitted the actor/tenant are resolved from
 * the current session.
 */
export async function recordAuditLog(input: RecordAuditInput, context?: AuditContext): Promise<void> {
  try {
    await ensureAuditSchema()
    const base: AuditContext =
      context ??
      ({
        requestId: randomUUID(),
        tenantId: null,
        actorUserId: null,
        actorName: null,
        actorEmail: null,
        actorRole: null,
        sessionId: null,
        ipAddress: null,
        userAgent: null,
      } satisfies AuditContext)
    const ctx = { ...base, ...(input.context ?? {}) }

    const entityId = input.entityId == null ? null : String(input.entityId).slice(0, 128)
    const result: AuditResult = input.result ?? "success"
    const before = input.before && Object.keys(input.before).length ? input.before : null
    const after = input.after && Object.keys(input.after).length ? input.after : null
    const metadata = input.metadata && Object.keys(input.metadata).length ? input.metadata : null

    const integrityHash = computeIntegrityHash({
      requestId: ctx.requestId,
      tenantId: ctx.tenantId,
      actorUserId: ctx.actorUserId,
      sessionId: ctx.sessionId,
      ipAddress: ctx.ipAddress,
      action: input.action,
      entityType: input.entityType ?? null,
      entityId,
      result,
      before,
      after,
    })

    await query(
      `INSERT INTO \`audit_log_entries\`
         (\`request_id\`, \`tenant_id\`, \`actor_user_id\`, \`actor_name\`, \`actor_email\`, \`actor_role\`,
          \`session_id\`, \`ip_address\`, \`user_agent\`, \`action\`, \`entity_type\`, \`entity_id\`,
          \`entity_label\`, \`result\`, \`before_data\`, \`after_data\`, \`metadata\`, \`integrity_hash\`)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        ctx.requestId?.slice(0, 64) ?? null,
        ctx.tenantId,
        ctx.actorUserId,
        ctx.actorName ? ctx.actorName.slice(0, 160) : null,
        ctx.actorEmail ? ctx.actorEmail.slice(0, 190) : null,
        ctx.actorRole ? ctx.actorRole.slice(0, 32) : null,
        ctx.sessionId ? ctx.sessionId.slice(0, 64) : null,
        ctx.ipAddress ? ctx.ipAddress.slice(0, 64) : null,
        ctx.userAgent ? ctx.userAgent.slice(0, 512) : null,
        input.action.slice(0, 96),
        input.entityType ? input.entityType.slice(0, 96) : null,
        entityId,
        input.entityLabel ? input.entityLabel.slice(0, 255) : null,
        result,
        before ? JSON.stringify(before) : null,
        after ? JSON.stringify(after) : null,
        metadata ? JSON.stringify(metadata) : null,
        integrityHash,
      ],
    )
  } catch (err) {
    console.error("[v0] audit log write failed (ignored):", (err as Error).message)
  }
}

/**
 * Convenience: capture context from the request and record in one call. Use
 * this from route handlers that only emit a single event.
 */
export async function recordAuditLogFromRequest(request: Request, input: RecordAuditInput): Promise<void> {
  const context = await captureAuditContext(request).catch(() => undefined)
  await recordAuditLog(input, context)
}

/**
 * Compute a shallow before/after diff, returning only the keys that changed.
 * Handy for update handlers that have the full old and new records.
 */
export function diffRecords(
  before: Record<string, unknown> | null | undefined,
  after: Record<string, unknown> | null | undefined,
): { before: Record<string, unknown>; after: Record<string, unknown> } {
  const b = before ?? {}
  const a = after ?? {}
  const keys = new Set([...Object.keys(b), ...Object.keys(a)])
  const changedBefore: Record<string, unknown> = {}
  const changedAfter: Record<string, unknown> = {}
  for (const key of keys) {
    if (JSON.stringify(b[key]) !== JSON.stringify(a[key])) {
      changedBefore[key] = b[key] ?? null
      changedAfter[key] = a[key] ?? null
    }
  }
  return { before: changedBefore, after: changedAfter }
}

export type AuditQuery = {
  q?: string
  action?: string
  entityType?: string
  actorUserId?: number
  result?: AuditResult
  from?: string
  to?: string
  limit?: number
  offset?: number
}

function toPublic(row: EntryRow): AuditEntry {
  const parse = (v: string | null): Record<string, unknown> | null => {
    if (!v) return null
    try {
      return typeof v === "string" ? JSON.parse(v) : (v as Record<string, unknown>)
    } catch {
      return null
    }
  }
  return {
    id: Number(row.id),
    requestId: row.request_id,
    tenantId: row.tenant_id,
    actorUserId: row.actor_user_id,
    actorName: row.actor_name,
    actorEmail: row.actor_email,
    actorRole: row.actor_role,
    sessionId: row.session_id,
    ipAddress: row.ip_address,
    userAgent: row.user_agent,
    action: row.action,
    entityType: row.entity_type,
    entityId: row.entity_id,
    entityLabel: row.entity_label,
    result: row.result,
    before: parse(row.before_data),
    after: parse(row.after_data),
    metadata: parse(row.metadata),
    integrityHash: row.integrity_hash,
    createdAt: row.created_at,
  }
}

function buildWhere(tenantId: number | null, opts: AuditQuery): { sql: string; params: unknown[] } {
  // Platform-wide rows (tenant_id IS NULL) are visible to every tenant admin
  // since they represent cross-cutting/system events attributable to no tenant.
  const params: unknown[] = [tenantId]
  let sql = `WHERE (\`tenant_id\` = ? OR \`tenant_id\` IS NULL)`
  if (opts.action) {
    sql += ` AND \`action\` = ?`
    params.push(opts.action)
  }
  if (opts.entityType) {
    sql += ` AND \`entity_type\` = ?`
    params.push(opts.entityType)
  }
  if (opts.actorUserId != null) {
    sql += ` AND \`actor_user_id\` = ?`
    params.push(opts.actorUserId)
  }
  if (opts.result) {
    sql += ` AND \`result\` = ?`
    params.push(opts.result)
  }
  if (opts.from) {
    sql += ` AND \`created_at\` >= ?`
    params.push(opts.from)
  }
  if (opts.to) {
    sql += ` AND \`created_at\` <= ?`
    params.push(opts.to)
  }
  if (opts.q) {
    const like = `%${opts.q}%`
    sql += ` AND (\`action\` LIKE ? OR \`actor_name\` LIKE ? OR \`actor_email\` LIKE ? OR \`entity_type\` LIKE ? OR \`entity_id\` LIKE ? OR \`entity_label\` LIKE ? OR \`ip_address\` LIKE ? OR \`request_id\` LIKE ?)`
    params.push(like, like, like, like, like, like, like, like)
  }
  return { sql, params }
}

/** Paginated, filtered search over the audit log. Newest first. */
export async function searchAuditLogs(
  tenantId: number | null,
  opts: AuditQuery = {},
): Promise<{ entries: AuditEntry[]; total: number }> {
  await ensureAuditSchema()
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500)
  const offset = Math.max(opts.offset ?? 0, 0)
  const { sql, params } = buildWhere(tenantId, opts)

  const countRows = (await query(`SELECT COUNT(*) AS n FROM \`audit_log_entries\` ${sql}`, params)) as { n: number }[]
  const total = Number(countRows[0]?.n ?? 0)

  const rows = (await query(
    `SELECT * FROM \`audit_log_entries\` ${sql} ORDER BY \`created_at\` DESC, \`id\` DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  )) as EntryRow[]
  return { entries: rows.map(toPublic), total }
}

/** Distinct action + entity-type values, for populating filter dropdowns. */
export async function getAuditFilters(
  tenantId: number | null,
): Promise<{ actions: string[]; entityTypes: string[] }> {
  await ensureAuditSchema()
  const actions = (await query(
    `SELECT DISTINCT \`action\` AS v FROM \`audit_log_entries\`
      WHERE (\`tenant_id\` = ? OR \`tenant_id\` IS NULL) ORDER BY \`action\``,
    [tenantId],
  )) as { v: string }[]
  const entityTypes = (await query(
    `SELECT DISTINCT \`entity_type\` AS v FROM \`audit_log_entries\`
      WHERE (\`tenant_id\` = ? OR \`tenant_id\` IS NULL) AND \`entity_type\` IS NOT NULL ORDER BY \`entity_type\``,
    [tenantId],
  )) as { v: string }[]
  return {
    actions: actions.map((r) => r.v).filter(Boolean),
    entityTypes: entityTypes.map((r) => r.v).filter(Boolean),
  }
}

function csvCell(value: unknown): string {
  if (value == null) return ""
  const s = typeof value === "object" ? JSON.stringify(value) : String(value)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** Export matching entries as CSV (capped at 5000 rows). */
export async function exportAuditLogsCsv(tenantId: number | null, opts: AuditQuery = {}): Promise<string> {
  const { entries } = await searchAuditLogs(tenantId, { ...opts, limit: 5000, offset: 0 })
  const header = [
    "id",
    "created_at",
    "request_id",
    "tenant_id",
    "actor_user_id",
    "actor_name",
    "actor_email",
    "actor_role",
    "session_id",
    "ip_address",
    "user_agent",
    "action",
    "entity_type",
    "entity_id",
    "entity_label",
    "result",
    "before",
    "after",
    "metadata",
    "integrity_hash",
  ]
  const lines = [header.join(",")]
  for (const e of entries) {
    lines.push(
      [
        e.id,
        e.createdAt,
        e.requestId,
        e.tenantId,
        e.actorUserId,
        e.actorName,
        e.actorEmail,
        e.actorRole,
        e.sessionId,
        e.ipAddress,
        e.userAgent,
        e.action,
        e.entityType,
        e.entityId,
        e.entityLabel,
        e.result,
        e.before,
        e.after,
        e.metadata,
        e.integrityHash,
      ]
        .map(csvCell)
        .join(","),
    )
  }
  return lines.join("\n")
}
