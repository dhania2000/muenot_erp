import "server-only"
/**
 * Security audit trail.
 * ---------------------------------------------------------------------------
 * A single, forensic log of security-relevant events: IP allowlist changes and
 * enforcement outcomes, emergency super-admin bypasses, and
 * access-policy changes and enforcement decisions. Writes are
 * best-effort — recording an event must never change or block the request's
 * own outcome (a sign-in decision, a settings save). Reads power the audit
 * panels shown on the security pages.
 *
 * Self-heals at runtime (same pattern as lib/session-store.ts) so existing
 * databases converge without a manual migration step.
 */
import { query } from "@/lib/db"

export type SecurityEventCategory =
  | "ip_allowlist"
  | "access_policy"
  | "emergency_bypass"
  | "temporary_access"
  | "break_glass"

export type SecurityEventOutcome =
  | "allowed"
  | "blocked"
  | "created"
  | "updated"
  | "deleted"
  | "bypassed"
  | "info"
  | "granted"
  | "approved"
  | "rejected"
  | "revoked"
  | "expired"
  | "activated"

export type SecurityAuditEvent = {
  id: number
  tenantId: number | null
  category: SecurityEventCategory
  action: string
  outcome: SecurityEventOutcome
  actorUserId: number | null
  actorName: string | null
  subjectEmail: string | null
  ipAddress: string | null
  detail: Record<string, unknown> | null
  createdAt: string
}

type EventRow = {
  id: number
  tenant_id: number | null
  category: SecurityEventCategory
  action: string
  outcome: SecurityEventOutcome
  actor_user_id: number | null
  actor_name: string | null
  subject_email: string | null
  ip_address: string | null
  detail: string | null
  created_at: string
}

let ensured: Promise<void> | null = null

async function runEnsure(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS \`security_audit_events\` (
      \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      \`tenant_id\` INT UNSIGNED DEFAULT NULL,
      \`category\` VARCHAR(32) NOT NULL,
      \`action\` VARCHAR(64) NOT NULL,
      \`outcome\` VARCHAR(16) NOT NULL,
      \`actor_user_id\` INT UNSIGNED DEFAULT NULL,
      \`actor_name\` VARCHAR(160) DEFAULT NULL,
      \`subject_email\` VARCHAR(190) DEFAULT NULL,
      \`ip_address\` VARCHAR(64) DEFAULT NULL,
      \`detail\` JSON DEFAULT NULL,
      \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (\`id\`),
      KEY \`idx_security_audit_tenant\` (\`tenant_id\`),
      KEY \`idx_security_audit_category\` (\`category\`),
      KEY \`idx_security_audit_created\` (\`created_at\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)
}

export function ensureSecurityAuditSchema(): Promise<void> {
  if (!ensured) {
    ensured = runEnsure().catch((err) => {
      ensured = null
      throw err
    })
  }
  return ensured
}

/**
 * Record a security event. Best-effort: never throws, so callers can log
 * without wrapping in try/catch and without risking the primary operation.
 */
export async function recordSecurityEvent(event: {
  tenantId: number | null
  category: SecurityEventCategory
  action: string
  outcome: SecurityEventOutcome
  actorUserId?: number | null
  actorName?: string | null
  subjectEmail?: string | null
  ipAddress?: string | null
  detail?: Record<string, unknown> | null
}): Promise<void> {
  try {
    await ensureSecurityAuditSchema()
    await query(
      `INSERT INTO \`security_audit_events\`
         (\`tenant_id\`, \`category\`, \`action\`, \`outcome\`, \`actor_user_id\`, \`actor_name\`, \`subject_email\`, \`ip_address\`, \`detail\`)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        event.tenantId,
        event.category,
        event.action.slice(0, 64),
        event.outcome,
        event.actorUserId ?? null,
        event.actorName ? event.actorName.slice(0, 160) : null,
        event.subjectEmail ? event.subjectEmail.slice(0, 190) : null,
        event.ipAddress ? event.ipAddress.slice(0, 64) : null,
        event.detail ? JSON.stringify(event.detail) : null,
      ],
    )
  } catch (err) {
    console.error("[v0] security audit write failed (ignored):", err)
  }
}

function toPublic(row: EventRow): SecurityAuditEvent {
  let detail: Record<string, unknown> | null = null
  if (row.detail) {
    try {
      detail = typeof row.detail === "string" ? JSON.parse(row.detail) : (row.detail as Record<string, unknown>)
    } catch {
      detail = null
    }
  }
  return {
    id: row.id,
    tenantId: row.tenant_id,
    category: row.category,
    action: row.action,
    outcome: row.outcome,
    actorUserId: row.actor_user_id,
    actorName: row.actor_name,
    subjectEmail: row.subject_email,
    ipAddress: row.ip_address,
    detail,
    createdAt: row.created_at,
  }
}

/** Recent security events for a tenant (plus platform-wide rows), newest first. */
export async function listSecurityEvents(
  tenantId: number | null,
  opts: { category?: SecurityEventCategory; limit?: number } = {},
): Promise<SecurityAuditEvent[]> {
  await ensureSecurityAuditSchema()
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200)
  const params: unknown[] = [tenantId]
  let sql = `SELECT * FROM \`security_audit_events\` WHERE (\`tenant_id\` = ? OR \`tenant_id\` IS NULL)`
  if (opts.category) {
    sql += ` AND \`category\` = ?`
    params.push(opts.category)
  }
  sql += ` ORDER BY \`created_at\` DESC, \`id\` DESC LIMIT ?`
  params.push(limit)
  const rows = await query<EventRow[]>(sql, params)
  return rows.map(toPublic)
}
