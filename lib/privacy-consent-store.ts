import "server-only"
/**
 * Spec24 — Consent & notice store (DB-backed, tenant-scoped, audited).
 * ---------------------------------------------------------------------------
 * An append-only ledger of explicit consent / notice events for the marketing,
 * recruitment and screen-capture purposes. Consent is never mutated in place —
 * granting and withdrawing both append an event, and the CURRENT state is the
 * latest event for a (subject, purpose) pair (see effectiveConsent). This keeps
 * a defensible audit trail of exactly when and how a lawful basis was
 * established or revoked.
 *
 * Every mutation is tenant-scoped and written to the immutable audit log
 * (lib/audit-log-store.ts). Self-heals its schema at runtime, mirroring the
 * other governance stores so existing databases converge with no manual step.
 */
import { query } from "@/lib/db"
import { recordAuditLog, type AuditContext } from "@/lib/audit-log-store"
import {
  CONSENT_PURPOSE_LABELS,
  effectiveConsent,
  normalizeConsentInput,
  normalizeSubjectEmail,
  type ConsentMethod,
  type ConsentPurpose,
  type ConsentStatus,
} from "@/lib/privacy-model"

export type Actor = { userId: number; name?: string | null; email?: string | null; role?: string | null }

export type ConsentEvent = {
  id: number
  tenantId: number
  subjectEmail: string
  subjectName: string | null
  purpose: ConsentPurpose
  method: ConsentMethod
  status: ConsentStatus
  channel: string | null
  notes: string | null
  actorUserId: number | null
  actorName: string | null
  createdAt: string
}

export type ConsentState = {
  subjectEmail: string
  subjectName: string | null
  purpose: ConsentPurpose
  purposeLabel: string
  status: ConsentStatus
  method: ConsentMethod
  lastEventAt: string
  eventCount: number
}

let schemaReady: Promise<void> | null = null

export function ensureConsentSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = (async () => {
      await query(
        `CREATE TABLE IF NOT EXISTS \`privacy_consent_events\` (
          \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
          \`tenant_id\` INT NOT NULL,
          \`subject_email\` VARCHAR(190) NOT NULL,
          \`subject_name\` VARCHAR(160) NULL,
          \`purpose\` VARCHAR(32) NOT NULL,
          \`method\` VARCHAR(32) NOT NULL,
          \`status\` VARCHAR(16) NOT NULL,
          \`channel\` VARCHAR(96) NULL,
          \`notes\` VARCHAR(1000) NULL,
          \`actor_user_id\` INT NULL,
          \`actor_name\` VARCHAR(160) NULL,
          \`created_at\` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (\`id\`),
          KEY \`idx_pce_tenant_subject\` (\`tenant_id\`, \`subject_email\`, \`purpose\`),
          KEY \`idx_pce_tenant_purpose\` (\`tenant_id\`, \`purpose\`)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      )
    })().catch((err) => {
      schemaReady = null
      throw err
    })
  }
  return schemaReady
}

function mapRow(r: any): ConsentEvent {
  return {
    id: Number(r.id),
    tenantId: Number(r.tenant_id),
    subjectEmail: r.subject_email,
    subjectName: r.subject_name,
    purpose: r.purpose,
    method: r.method,
    status: r.status,
    channel: r.channel,
    notes: r.notes,
    actorUserId: r.actor_user_id == null ? null : Number(r.actor_user_id),
    actorName: r.actor_name,
    createdAt: r.created_at,
  }
}

/** Record an explicit consent (grant) event. */
export async function recordConsent(
  tenantId: number,
  input: unknown,
  actor: Actor,
  auditContext?: AuditContext,
): Promise<ConsentEvent> {
  await ensureConsentSchema()
  const data = normalizeConsentInput((input ?? {}) as Record<string, unknown>)
  const result = (await query(
    `INSERT INTO \`privacy_consent_events\`
       (\`tenant_id\`, \`subject_email\`, \`subject_name\`, \`purpose\`, \`method\`, \`status\`, \`channel\`, \`notes\`, \`actor_user_id\`, \`actor_name\`)
     VALUES (?, ?, ?, ?, ?, 'granted', ?, ?, ?, ?)`,
    [
      tenantId,
      data.subjectEmail,
      data.subjectName,
      data.purpose,
      data.method,
      data.channel,
      data.notes,
      actor.userId,
      actor.name ?? null,
    ],
  )) as any
  const id = Number(result.insertId)
  await recordAuditLog(
    {
      action: "privacy.consent.granted",
      entityType: "ConsentEvent",
      entityId: id,
      entityLabel: `${CONSENT_PURPOSE_LABELS[data.purpose]} — ${data.subjectEmail}`,
      after: { purpose: data.purpose, method: data.method, subjectEmail: data.subjectEmail },
      context: auditContext ? { ...auditContext, tenantId } : { tenantId },
    },
    auditContext,
  )
  const row = (await query(`SELECT * FROM \`privacy_consent_events\` WHERE \`id\` = ? AND \`tenant_id\` = ?`, [id, tenantId])) as any[]
  return mapRow(row[0])
}

/**
 * Withdraw consent for a (subject, purpose). Appends a withdrawal event so the
 * ledger stays append-only. Returns the new event, or throws if there is no
 * standing grant to withdraw.
 */
export async function withdrawConsent(
  tenantId: number,
  input: { subjectEmail: unknown; purpose: unknown; notes?: unknown },
  actor: Actor,
  auditContext?: AuditContext,
): Promise<ConsentEvent> {
  await ensureConsentSchema()
  const subjectEmail = normalizeSubjectEmail(input.subjectEmail)
  const purpose = String(input.purpose ?? "")
  if (!subjectEmail) throw new Error("A valid subject email is required")
  if (!(purpose in CONSENT_PURPOSE_LABELS)) throw new Error("A valid consent purpose is required")

  const current = await getConsentState(tenantId, subjectEmail, purpose as ConsentPurpose)
  if (!current || current.status !== "granted") {
    throw new Error("There is no active consent to withdraw for this subject and purpose")
  }
  const notes = String(input.notes ?? "").trim().slice(0, 1000) || null
  const result = (await query(
    `INSERT INTO \`privacy_consent_events\`
       (\`tenant_id\`, \`subject_email\`, \`subject_name\`, \`purpose\`, \`method\`, \`status\`, \`channel\`, \`notes\`, \`actor_user_id\`, \`actor_name\`)
     VALUES (?, ?, ?, ?, ?, 'withdrawn', NULL, ?, ?, ?)`,
    [tenantId, subjectEmail, current.subjectName, purpose, current.method, notes, actor.userId, actor.name ?? null],
  )) as any
  const id = Number(result.insertId)
  await recordAuditLog(
    {
      action: "privacy.consent.withdrawn",
      entityType: "ConsentEvent",
      entityId: id,
      entityLabel: `${CONSENT_PURPOSE_LABELS[purpose as ConsentPurpose]} — ${subjectEmail}`,
      before: { status: "granted" },
      after: { status: "withdrawn", subjectEmail, purpose },
      context: auditContext ? { ...auditContext, tenantId } : { tenantId },
    },
    auditContext,
  )
  const row = (await query(`SELECT * FROM \`privacy_consent_events\` WHERE \`id\` = ? AND \`tenant_id\` = ?`, [id, tenantId])) as any[]
  return mapRow(row[0])
}

/** The full event history for a (subject, purpose), oldest first. */
export async function listConsentEvents(
  tenantId: number,
  subjectEmail: string,
  purpose: ConsentPurpose,
): Promise<ConsentEvent[]> {
  await ensureConsentSchema()
  const rows = (await query(
    `SELECT * FROM \`privacy_consent_events\`
      WHERE \`tenant_id\` = ? AND \`subject_email\` = ? AND \`purpose\` = ?
      ORDER BY \`created_at\` ASC, \`id\` ASC`,
    [tenantId, normalizeSubjectEmail(subjectEmail), purpose],
  )) as any[]
  return rows.map(mapRow)
}

/** The CURRENT effective consent state for one (subject, purpose), or null. */
export async function getConsentState(
  tenantId: number,
  subjectEmail: string,
  purpose: ConsentPurpose,
): Promise<ConsentState | null> {
  const events = await listConsentEvents(tenantId, subjectEmail, purpose)
  if (events.length === 0) return null
  const status = effectiveConsent(events.map((e) => ({ status: e.status, at: e.createdAt })))
  if (!status) return null
  const latest = events[events.length - 1]
  return {
    subjectEmail: latest.subjectEmail,
    subjectName: latest.subjectName,
    purpose,
    purposeLabel: CONSENT_PURPOSE_LABELS[purpose],
    status,
    method: latest.method,
    lastEventAt: latest.createdAt,
    eventCount: events.length,
  }
}

/**
 * The current consent state for every (subject, purpose) in the tenant — the
 * data the console lists. Collapses the event ledger to one row per pair.
 */
export async function listConsentStates(tenantId: number): Promise<ConsentState[]> {
  await ensureConsentSchema()
  const rows = (await query(
    `SELECT * FROM \`privacy_consent_events\`
      WHERE \`tenant_id\` = ?
      ORDER BY \`subject_email\` ASC, \`purpose\` ASC, \`created_at\` ASC, \`id\` ASC`,
    [tenantId],
  )) as any[]
  const byPair = new Map<string, ConsentEvent[]>()
  for (const r of rows) {
    const e = mapRow(r)
    const k = `${e.subjectEmail}::${e.purpose}`
    const list = byPair.get(k)
    if (list) list.push(e)
    else byPair.set(k, [e])
  }
  const states: ConsentState[] = []
  for (const events of byPair.values()) {
    const status = effectiveConsent(events.map((e) => ({ status: e.status, at: e.createdAt })))
    if (!status) continue
    const latest = events[events.length - 1]
    states.push({
      subjectEmail: latest.subjectEmail,
      subjectName: latest.subjectName,
      purpose: latest.purpose,
      purposeLabel: CONSENT_PURPOSE_LABELS[latest.purpose],
      status,
      method: latest.method,
      lastEventAt: latest.createdAt,
      eventCount: events.length,
    })
  }
  return states
}
