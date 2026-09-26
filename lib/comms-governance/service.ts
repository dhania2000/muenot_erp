import "server-only"
/**
 * Spec41 — central, tenant-scoped communication governance used by every
 * outbound channel (notification engine, email engine, WhatsApp, calling).
 * Every statement carries an explicit tenant_id predicate.
 */
import { query } from "@/lib/db"
import { ensureCommsGovernanceSchema } from "./schema"
import {
  CONSENT_REASONS,
  GovernanceError,
  SOFT_BOUNCE_THRESHOLD,
  addressHash,
  decideSend,
  maskAddress,
  mysqlDateTime,
  nextWindow,
  parseEmailEvents,
  validateProviderConfig,
  windowStart,
  type CommChannel,
  type EmailEventProvider,
  type SendDecision,
  type SuppressionReason,
} from "./model"

export type ProviderConfig = {
  channel: CommChannel
  provider: string
  enabled: boolean
  credentialRef: string | null
  hourlyLimit: number | null
  dailyLimit: number | null
  settings: Record<string, unknown>
  version: number
  updatedAt: string | null
}

function tid(tenantId: number) {
  if (!Number.isSafeInteger(tenantId) || tenantId <= 0) throw new GovernanceError("invalid_tenant", "Tenant is required")
  return tenantId
}

function mapConfig(r: any): ProviderConfig {
  let settings: Record<string, unknown> = {}
  try {
    settings = typeof r.settings_json === "string" ? JSON.parse(r.settings_json) : (r.settings_json ?? {})
  } catch {
    settings = {}
  }
  return {
    channel: r.channel,
    provider: r.provider,
    enabled: Boolean(r.enabled),
    credentialRef: r.credential_ref ?? null,
    hourlyLimit: r.hourly_limit == null ? null : Number(r.hourly_limit),
    dailyLimit: r.daily_limit == null ? null : Number(r.daily_limit),
    settings,
    version: Number(r.version ?? 1),
    updatedAt: r.updated_at ? String(r.updated_at) : null,
  }
}

async function audit(tenantId: number, actorId: number | null, action: string, channel: string | null, detail: unknown) {
  await query("INSERT INTO tenant_comm_audit (tenant_id,actor_id,action,channel,detail) VALUES (?,?,?,?,?)", [
    tenantId,
    actorId,
    action,
    channel,
    JSON.stringify(detail ?? {}),
  ])
}

export async function listProviderConfigs(tenantId: number): Promise<ProviderConfig[]> {
  await ensureCommsGovernanceSchema()
  const rows = await query<any[]>("SELECT * FROM tenant_comm_providers WHERE tenant_id=? ORDER BY channel", [tid(tenantId)])
  return (rows ?? []).map(mapConfig)
}

/** No row = platform default: enabled, platform provider, no tenant limit. */
export async function getProviderConfig(tenantId: number, channel: CommChannel): Promise<ProviderConfig | null> {
  await ensureCommsGovernanceSchema()
  const rows = await query<any[]>("SELECT * FROM tenant_comm_providers WHERE tenant_id=? AND channel=? LIMIT 1", [tid(tenantId), channel])
  return rows?.[0] ? mapConfig(rows[0]) : null
}

/**
 * Upsert with optimistic concurrency: callers pass the version they read
 * (0 = creating). A stale version is rejected instead of silently overwriting.
 */
export async function saveProviderConfig(tenantId: number, actorId: number, raw: unknown, expectedVersion: number) {
  tid(tenantId)
  const input = validateProviderConfig(raw)
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) throw new GovernanceError("invalid_version", "expectedVersion is required")
  await ensureCommsGovernanceSchema()
  const settings = JSON.stringify(input.settings)
  if (expectedVersion === 0) {
    const res = await query<any>(
      "INSERT IGNORE INTO tenant_comm_providers (tenant_id,channel,provider,enabled,credential_ref,settings_json,hourly_limit,daily_limit,version,updated_by) VALUES (?,?,?,?,?,?,?,?,1,?)",
      [tenantId, input.channel, input.provider, input.enabled ? 1 : 0, input.credentialRef, settings, input.hourlyLimit, input.dailyLimit, actorId],
    )
    if (Number(res?.affectedRows ?? 0) !== 1) throw new GovernanceError("version_conflict", "Configuration was changed by someone else; reload and retry")
  } else {
    const res = await query<any>(
      "UPDATE tenant_comm_providers SET provider=?,enabled=?,credential_ref=?,settings_json=?,hourly_limit=?,daily_limit=?,version=version+1,updated_by=? WHERE tenant_id=? AND channel=? AND version=?",
      [input.provider, input.enabled ? 1 : 0, input.credentialRef, settings, input.hourlyLimit, input.dailyLimit, actorId, tenantId, input.channel, expectedVersion],
    )
    if (Number(res?.affectedRows ?? 0) !== 1) throw new GovernanceError("version_conflict", "Configuration was changed by someone else; reload and retry")
  }
  await audit(tenantId, actorId, "provider.save", input.channel, {
    provider: input.provider,
    enabled: input.enabled,
    hasCredential: Boolean(input.credentialRef),
    hourlyLimit: input.hourlyLimit,
    dailyLimit: input.dailyLimit,
  })
  return getProviderConfig(tenantId, input.channel)
}

/* ------------------------------ suppression ------------------------------ */

export async function activeSuppressions(tenantId: number, channel: CommChannel, address: string) {
  await ensureCommsGovernanceSchema()
  const rows = await query<any[]>(
    "SELECT reason,hit_count FROM tenant_comm_suppressions WHERE tenant_id=? AND channel=? AND address_hash=? AND released_at IS NULL",
    [tid(tenantId), channel, addressHash(channel, address)],
  )
  return (rows ?? []).map((r) => ({ reason: r.reason as SuppressionReason, count: Number(r.hit_count ?? 1) }))
}

/**
 * Idempotent: a repeat suppression for the same (address, reason) bumps
 * hit_count and re-activates a previously released row, never duplicates.
 */
export async function addSuppression(
  tenantId: number,
  input: { channel: CommChannel; address: string; reason: SuppressionReason; source: string; providerEventId?: string | null; actorId?: number | null },
) {
  tid(tenantId)
  await ensureCommsGovernanceSchema()
  const hash = addressHash(input.channel, input.address)
  await query(
    `INSERT INTO tenant_comm_suppressions (tenant_id,channel,address_hash,address_masked,reason,source,provider_event_id,created_by)
     VALUES (?,?,?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE hit_count=IF(released_at IS NULL,hit_count+1,1),released_at=NULL,released_by=NULL,last_seen_at=CURRENT_TIMESTAMP,provider_event_id=VALUES(provider_event_id)`,
    [tenantId, input.channel, hash, maskAddress(input.channel, input.address), input.reason, input.source.slice(0, 40), input.providerEventId ?? null, input.actorId ?? null],
  )
  await audit(tenantId, input.actorId ?? null, "suppression.add", input.channel, { reason: input.reason, source: input.source, addressHash: hash })
}

/**
 * Admin release. Consent withdrawals (complaint / opt-out) can only be lifted
 * by the recipient opting back in, never by an admin.
 */
export async function releaseSuppression(tenantId: number, actorId: number, id: number) {
  tid(tenantId)
  if (!Number.isSafeInteger(id) || id <= 0) throw new GovernanceError("invalid_id", "Invalid suppression id")
  await ensureCommsGovernanceSchema()
  const rows = await query<any[]>("SELECT id,channel,reason FROM tenant_comm_suppressions WHERE tenant_id=? AND id=? AND released_at IS NULL LIMIT 1", [tenantId, id])
  const row = rows?.[0]
  if (!row) throw new GovernanceError("not_found", "Suppression not found")
  if (CONSENT_REASONS.includes(row.reason)) throw new GovernanceError("consent_locked", "Only the recipient can lift a complaint or opt-out")
  await query("UPDATE tenant_comm_suppressions SET released_at=UTC_TIMESTAMP(),released_by=? WHERE tenant_id=? AND id=? AND released_at IS NULL", [actorId, tenantId, id])
  await audit(tenantId, actorId, "suppression.release", row.channel, { id, reason: row.reason })
}

/** Recipient-driven opt-in (e.g. WhatsApp "START"): clears opt-out only. */
export async function recordOptIn(tenantId: number, channel: CommChannel, address: string, source: string) {
  tid(tenantId)
  await ensureCommsGovernanceSchema()
  const hash = addressHash(channel, address)
  await query(
    "UPDATE tenant_comm_suppressions SET released_at=UTC_TIMESTAMP() WHERE tenant_id=? AND channel=? AND address_hash=? AND reason='opt_out' AND released_at IS NULL",
    [tenantId, channel, hash],
  )
  await audit(tenantId, null, "consent.opt_in", channel, { source, addressHash: hash })
}

export async function listSuppressions(tenantId: number, opts: { channel?: CommChannel; limit?: number } = {}) {
  await ensureCommsGovernanceSchema()
  const limit = Math.min(Math.max(Number(opts.limit) || 100, 1), 500)
  const args: unknown[] = [tid(tenantId)]
  let where = "tenant_id=? AND released_at IS NULL"
  if (opts.channel) {
    where += " AND channel=?"
    args.push(opts.channel)
  }
  return query<any[]>(
    `SELECT id,channel,address_masked,reason,hit_count,source,created_at,last_seen_at FROM tenant_comm_suppressions WHERE ${where} ORDER BY last_seen_at DESC LIMIT ${limit}`,
    args,
  )
}

/* ------------------------------ send limits ------------------------------ */

async function bump(tenantId: number, channel: CommChannel, kind: "hour" | "day", limit: number, at: Date): Promise<boolean> {
  const start = mysqlDateTime(windowStart(kind, at))
  await query("INSERT IGNORE INTO tenant_comm_send_counters (tenant_id,channel,window_kind,window_start,sent) VALUES (?,?,?,?,0)", [tenantId, channel, kind, start])
  const res = await query<any>(
    "UPDATE tenant_comm_send_counters SET sent=sent+1 WHERE tenant_id=? AND channel=? AND window_kind=? AND window_start=? AND sent<?",
    [tenantId, channel, kind, start, limit],
  )
  return Number(res?.affectedRows ?? 0) === 1
}

async function unbump(tenantId: number, channel: CommChannel, kind: "hour" | "day", at: Date) {
  await query(
    "UPDATE tenant_comm_send_counters SET sent=GREATEST(sent,1)-1 WHERE tenant_id=? AND channel=? AND window_kind=? AND window_start=?",
    [tenantId, channel, kind, mysqlDateTime(windowStart(kind, at))],
  )
}

/**
 * Atomically reserve one send in the tenant's hourly and daily windows. The
 * conditional UPDATE makes concurrent workers unable to overshoot the limit.
 */
export async function reserveSendSlot(tenantId: number, channel: CommChannel, cfg: ProviderConfig | null, at = new Date()) {
  if (!cfg) return { ok: true as const }
  if (cfg.hourlyLimit != null && !(await bump(tenantId, channel, "hour", cfg.hourlyLimit, at))) {
    return { ok: false as const, retryAt: nextWindow("hour", at) }
  }
  if (cfg.dailyLimit != null && !(await bump(tenantId, channel, "day", cfg.dailyLimit, at))) {
    if (cfg.hourlyLimit != null) await unbump(tenantId, channel, "hour", at)
    return { ok: false as const, retryAt: nextWindow("day", at) }
  }
  return { ok: true as const }
}

/** Single gate every outbound channel calls before handing off to a provider. */
export async function guardOutbound(
  tenantId: number,
  channel: CommChannel,
  address: string | null,
  opts: { mandatory?: boolean; reserve?: boolean } = {},
): Promise<SendDecision> {
  tid(tenantId)
  const cfg = await getProviderConfig(tenantId, channel)
  const suppressions = address ? await activeSuppressions(tenantId, channel, address) : []
  const decision = decideSend({ providerEnabled: cfg ? cfg.enabled : true, suppressions, mandatory: opts.mandatory })
  if (!decision.ok) return decision
  if (opts.reserve === false) return decision
  const slot = await reserveSendSlot(tenantId, channel, cfg)
  return slot.ok ? { ok: true } : { ok: false, code: "rate_limited", retryAt: slot.retryAt }
}

export async function usageSnapshot(tenantId: number) {
  await ensureCommsGovernanceSchema()
  const now = new Date()
  return query<any[]>(
    "SELECT channel,window_kind,sent FROM tenant_comm_send_counters WHERE tenant_id=? AND ((window_kind='hour' AND window_start=?) OR (window_kind='day' AND window_start=?))",
    [tid(tenantId), mysqlDateTime(windowStart("hour", now)), mysqlDateTime(windowStart("day", now))],
  )
}

/* ------------------------- email provider events ------------------------- */

export type IngestResult = { processed: number; duplicates: number; unattributed: number }

/**
 * Apply bounce / complaint / delivery events. The tenant is derived ONLY from
 * the email the platform itself sent (provider_message_id or RFC message-id),
 * never from the payload. Duplicate provider retries are dropped by the
 * (tenant, provider, event id) unique key.
 */
export async function ingestEmailEvents(provider: EmailEventProvider, body: unknown): Promise<IngestResult> {
  const { ensureEmailEngineSchema } = await import("@/lib/email-engine/schema")
  await Promise.all([ensureCommsGovernanceSchema(), ensureEmailEngineSchema()])
  const result: IngestResult = { processed: 0, duplicates: 0, unattributed: 0 }
  for (const ev of parseEmailEvents(provider, body)) {
    if (!ev.providerMessageId) {
      result.unattributed++
      continue
    }
    const msgs = await query<any[]>(
      "SELECT id,tenant_id,to_email FROM tenant_email_messages WHERE provider_message_id=? OR message_id=? OR message_id=? LIMIT 2",
      [ev.providerMessageId, ev.providerMessageId, `<${ev.providerMessageId}>`],
    )
    // Ambiguous or unknown ids are never attributed to a tenant.
    if (!msgs || msgs.length !== 1 || String(msgs[0].to_email).toLowerCase() !== ev.address) {
      result.unattributed++
      continue
    }
    const tenantId = Number(msgs[0].tenant_id)
    const messageId = Number(msgs[0].id)
    const claim = await query<any>(
      "INSERT IGNORE INTO tenant_comm_provider_events (tenant_id,provider,provider_event_id,event_type,address_hash,email_message_id) VALUES (?,?,?,?,?,?)",
      [tenantId, provider, ev.eventId, ev.type, addressHash("email", ev.address), messageId],
    )
    if (Number(claim?.affectedRows ?? 0) !== 1) {
      result.duplicates++
      continue
    }
    if (ev.type === "delivered") {
      await query("UPDATE tenant_email_messages SET status='delivered',delivered_at=COALESCE(delivered_at,UTC_TIMESTAMP()) WHERE tenant_id=? AND id=? AND status IN ('accepted','sending')", [tenantId, messageId])
    } else {
      if (ev.type !== "soft_bounce") {
        await query("UPDATE tenant_email_messages SET status='bounced',last_error=? WHERE tenant_id=? AND id=?", [ev.type, tenantId, messageId])
      }
      await addSuppression(tenantId, { channel: "email", address: ev.address, reason: ev.type, source: `provider:${provider}`, providerEventId: ev.eventId })
    }
    await query("INSERT INTO tenant_email_events (tenant_id,message_id,event_type,detail) VALUES (?,?,?,?)", [
      tenantId,
      messageId,
      ev.type,
      JSON.stringify({ provider, eventId: ev.eventId }),
    ])
    result.processed++
  }
  return result
}

export { SOFT_BOUNCE_THRESHOLD }
