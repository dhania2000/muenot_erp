import "server-only"
/**
 * Spec28 (#127) — Customer → platform support desk with plan-based SLA.
 *
 * Tables:
 *   • platform_support_sla_policies — GLOBAL targets per support_level × priority
 *     (seeded from DEFAULT_SLA_POLICIES; editable by super admins).
 *   • platform_support_tickets / platform_support_ticket_events — TENANT-OWNED
 *     (registered in lib/tenant-tables.ts). Tenant-facing functions go through
 *     lib/tenant-scope helpers; platform-staff functions always carry an
 *     explicit `tenant_id` predicate/stamp from the ticket row itself.
 */
import { query } from "@/lib/db"
import { recordAuditLog } from "@/lib/audit-log-store"
import { tenantInsert, tenantSelect, currentTenantId } from "@/lib/tenant-scope"
import { getTenantEntitlements } from "@/lib/platform/entitlement-guard"
import { getSubscriptionForTenant } from "@/lib/platform-console"
import {
  DEFAULT_SLA_POLICIES,
  SUPPORT_LEVELS,
  TICKET_PRIORITIES,
  type SlaPolicyTable,
  type SlaTarget,
  type SupportLevel,
  type TicketInput,
  type TicketPriority,
  type TicketStatus,
  computeDueDates,
  evaluateSla,
  toDbDate,
  type SlaEvaluation,
} from "@/lib/support-sla/model"

export class SupportSlaError extends Error {
  status: number
  code: string
  constructor(message: string, code = "SUPPORT_ERROR", status = 400) {
    super(message)
    this.code = code
    this.status = status
  }
}

let ready: Promise<void> | null = null

export function ensureSupportSlaSchema(): Promise<void> {
  if (!ready) {
    ready = (async () => {
      await query(`
        CREATE TABLE IF NOT EXISTS \`platform_support_sla_policies\` (
          \`support_level\` VARCHAR(16) NOT NULL,
          \`priority\` VARCHAR(16) NOT NULL,
          \`response_minutes\` INT UNSIGNED NOT NULL,
          \`resolution_minutes\` INT UNSIGNED NOT NULL,
          \`updated_by\` INT UNSIGNED DEFAULT NULL,
          \`updated_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          PRIMARY KEY (\`support_level\`, \`priority\`)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
      await query(`
        CREATE TABLE IF NOT EXISTS \`platform_support_tickets\` (
          \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
          \`tenant_id\` INT UNSIGNED NOT NULL,
          \`reference\` VARCHAR(40) NOT NULL,
          \`subject\` VARCHAR(200) NOT NULL,
          \`description\` TEXT,
          \`priority\` VARCHAR(16) NOT NULL DEFAULT 'normal',
          \`status\` VARCHAR(24) NOT NULL DEFAULT 'open',
          \`plan_code\` VARCHAR(64) DEFAULT NULL,
          \`support_level\` VARCHAR(16) NOT NULL,
          \`response_due_at\` DATETIME NOT NULL,
          \`resolution_due_at\` DATETIME NOT NULL,
          \`first_response_at\` DATETIME DEFAULT NULL,
          \`resolved_at\` DATETIME DEFAULT NULL,
          \`response_breached\` TINYINT(1) NOT NULL DEFAULT 0,
          \`resolution_breached\` TINYINT(1) NOT NULL DEFAULT 0,
          \`created_by\` INT UNSIGNED DEFAULT NULL,
          \`idempotency_key\` VARCHAR(100) DEFAULT NULL,
          \`created_at\` DATETIME NOT NULL,
          \`updated_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          PRIMARY KEY (\`id\`),
          UNIQUE KEY \`uniq_pst_ref\` (\`reference\`),
          UNIQUE KEY \`uniq_pst_idem\` (\`tenant_id\`, \`idempotency_key\`),
          KEY \`idx_pst_tenant\` (\`tenant_id\`, \`status\`),
          KEY \`idx_pst_due\` (\`status\`, \`response_due_at\`, \`resolution_due_at\`)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
      await query(`
        CREATE TABLE IF NOT EXISTS \`platform_support_ticket_events\` (
          \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
          \`tenant_id\` INT UNSIGNED NOT NULL,
          \`ticket_id\` BIGINT UNSIGNED NOT NULL,
          \`kind\` VARCHAR(24) NOT NULL,
          \`visibility\` VARCHAR(12) NOT NULL DEFAULT 'customer',
          \`message\` VARCHAR(5000) NOT NULL DEFAULT '',
          \`actor_user_id\` INT UNSIGNED DEFAULT NULL,
          \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (\`id\`),
          KEY \`idx_pste_ticket\` (\`tenant_id\`, \`ticket_id\`, \`created_at\`)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
      for (const level of SUPPORT_LEVELS) {
        for (const p of TICKET_PRIORITIES) {
          const t = DEFAULT_SLA_POLICIES[level][p]
          await query(
            "INSERT IGNORE INTO `platform_support_sla_policies` (`support_level`, `priority`, `response_minutes`, `resolution_minutes`) VALUES (?, ?, ?, ?)",
            [level, p, t.responseMinutes, t.resolutionMinutes],
          )
        }
      }
    })().catch((err) => {
      ready = null
      throw err
    })
  }
  return ready
}

export async function getSlaPolicies(): Promise<SlaPolicyTable> {
  await ensureSupportSlaSchema()
  const rows = await query<{ support_level: string; priority: string; response_minutes: number; resolution_minutes: number }[]>(
    "SELECT * FROM `platform_support_sla_policies`",
  )
  const table: SlaPolicyTable = JSON.parse(JSON.stringify(DEFAULT_SLA_POLICIES))
  for (const r of rows) {
    const level = r.support_level as SupportLevel
    const p = r.priority as TicketPriority
    if (table[level]?.[p]) table[level][p] = { responseMinutes: Number(r.response_minutes), resolutionMinutes: Number(r.resolution_minutes) }
  }
  return table
}

export async function updateSlaPolicy(level: SupportLevel, priority: TicketPriority, target: SlaTarget, actor: { userId: number }) {
  await ensureSupportSlaSchema()
  const before = (await getSlaPolicies())[level][priority]
  await query(
    `INSERT INTO \`platform_support_sla_policies\` (\`support_level\`, \`priority\`, \`response_minutes\`, \`resolution_minutes\`, \`updated_by\`)
     VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE \`response_minutes\` = VALUES(\`response_minutes\`), \`resolution_minutes\` = VALUES(\`resolution_minutes\`), \`updated_by\` = VALUES(\`updated_by\`)`,
    [level, priority, target.responseMinutes, target.resolutionMinutes, actor.userId],
  )
  await recordAuditLog({
    action: "support.sla_policy_update",
    entityType: "support_sla_policy",
    entityId: `${level}:${priority}`,
    result: "success",
    before,
    after: target,
  }).catch(() => {})
}

export type TicketRow = {
  id: number
  tenant_id: number
  reference: string
  subject: string
  description: string | null
  priority: TicketPriority
  status: TicketStatus
  plan_code: string | null
  support_level: SupportLevel
  response_due_at: string
  resolution_due_at: string
  first_response_at: string | null
  resolved_at: string | null
  response_breached: number
  resolution_breached: number
  created_at: string
  tenant_name?: string | null
}

export type Ticket = TicketRow & { sla: SlaEvaluation }

function withSla(r: TicketRow, now = new Date()): Ticket {
  return {
    ...r,
    sla: evaluateSla(
      {
        createdAt: r.created_at,
        responseDueAt: r.response_due_at,
        resolutionDueAt: r.resolution_due_at,
        firstResponseAt: r.first_response_at,
        resolvedAt: r.resolved_at,
      },
      now,
    ),
  }
}

// ---------------------------------------------------------------- tenant side

/**
 * Open a ticket for the CURRENT tenant. The SLA tier is resolved server-side
 * from the tenant's plan (never from the request) and snapshotted.
 */
export async function createTicket(
  input: TicketInput,
  actor: { userId: number },
  idempotencyKey: string | null,
  now = new Date(),
): Promise<{ ticket: Ticket; replayed: boolean }> {
  await ensureSupportSlaSchema()
  const tenantId = currentTenantId()
  if (idempotencyKey) {
    const prior = await tenantSelect<TicketRow[]>("platform_support_tickets", { where: "`idempotency_key` = ?", params: [idempotencyKey], tail: "LIMIT 1" })
    if (prior[0]) return { ticket: withSla(prior[0], now), replayed: true }
  }
  const [ent, sub, policies] = await Promise.all([
    getTenantEntitlements(tenantId),
    getSubscriptionForTenant(tenantId).catch(() => null),
    getSlaPolicies(),
  ])
  const level = ent.support_level
  const due = computeDueDates(now, policies[level][input.priority])
  const reference = `SUP-${now.getTime().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`
  let insertId: number
  try {
    const res = await tenantInsert("platform_support_tickets", {
      reference,
      subject: input.subject,
      description: input.description || null,
      priority: input.priority,
      status: "open",
      plan_code: sub?.plan_code ?? null,
      support_level: level,
      response_due_at: toDbDate(due.responseDueAt),
      resolution_due_at: toDbDate(due.resolutionDueAt),
      created_by: actor.userId,
      idempotency_key: idempotencyKey,
      created_at: toDbDate(now),
    })
    insertId = res.insertId
  } catch (err: any) {
    if (err?.code === "ER_DUP_ENTRY" && idempotencyKey) {
      const prior = await tenantSelect<TicketRow[]>("platform_support_tickets", { where: "`idempotency_key` = ?", params: [idempotencyKey], tail: "LIMIT 1" })
      if (prior[0]) return { ticket: withSla(prior[0], now), replayed: true }
    }
    throw err
  }
  await tenantInsert("platform_support_ticket_events", {
    ticket_id: insertId,
    kind: "created",
    message: `Ticket opened (${input.priority}, ${level} support)`,
    actor_user_id: actor.userId,
  })
  await recordAuditLog({
    action: "support.ticket_create",
    entityType: "platform_support_ticket",
    entityId: String(insertId),
    entityLabel: reference,
    result: "success",
    after: { priority: input.priority, supportLevel: level },
  }).catch(() => {})
  const rows = await tenantSelect<TicketRow[]>("platform_support_tickets", { where: "`id` = ?", params: [insertId] })
  return { ticket: withSla(rows[0], now), replayed: false }
}

export async function listMyTickets(): Promise<Ticket[]> {
  await ensureSupportSlaSchema()
  const rows = await tenantSelect<TicketRow[]>("platform_support_tickets", { tail: "ORDER BY `created_at` DESC LIMIT 200" })
  return rows.map((r) => withSla(r))
}

/** A ticket of the CURRENT tenant, with customer-visible events only. 404 for others. */
export async function getMyTicket(id: number) {
  await ensureSupportSlaSchema()
  const rows = await tenantSelect<TicketRow[]>("platform_support_tickets", { where: "`id` = ?", params: [id] })
  if (!rows[0]) throw new SupportSlaError("Ticket not found", "NOT_FOUND", 404)
  const events = await tenantSelect<any[]>(
    "platform_support_ticket_events",
    { where: "`ticket_id` = ? AND `visibility` = 'customer'", params: [id], tail: "ORDER BY `created_at` ASC" },
  )
  return { ticket: withSla(rows[0]), events: events.map(({ actor_user_id: _a, ...e }) => e) }
}

// -------------------------------------------------------------- platform side

/**
 * Persist breach flags for every running clock past its deadline. The
 * `= 0` guard makes each breach event fire exactly once, even under concurrency.
 * Returns the number of newly breached clocks.
 */
export async function sweepSlaBreaches(): Promise<number> {
  await ensureSupportSlaSchema()
  let count = 0
  const clocks = [
    { flag: "response_breached", due: "response_due_at", done: "first_response_at", label: "First-response SLA breached" },
    { flag: "resolution_breached", due: "resolution_due_at", done: "resolved_at", label: "Resolution SLA breached" },
  ] as const
  for (const c of clocks) {
    const due = await query<{ id: number; tenant_id: number; reference: string }[]>(
      `SELECT \`id\`, \`tenant_id\`, \`reference\` FROM \`platform_support_tickets\`
        WHERE \`tenant_id\` IS NOT NULL AND \`${c.flag}\` = 0
          AND ((\`${c.done}\` IS NULL AND \`${c.due}\` < UTC_TIMESTAMP()) OR (\`${c.done}\` IS NOT NULL AND \`${c.done}\` > \`${c.due}\`))
        LIMIT 500`,
    )
    for (const t of due) {
      const res = await query<any>(
        `UPDATE \`platform_support_tickets\` SET \`${c.flag}\` = 1 WHERE \`id\` = ? AND \`tenant_id\` = ? AND \`${c.flag}\` = 0`,
        [t.id, t.tenant_id],
      )
      if (Number(res?.affectedRows) !== 1) continue
      count++
      await query(
        "INSERT INTO `platform_support_ticket_events` (`tenant_id`, `ticket_id`, `kind`, `visibility`, `message`) VALUES (?, ?, 'sla_breach', 'internal', ?)",
        [t.tenant_id, t.id, c.label],
      )
      await recordAuditLog({
        action: "support.sla_breach",
        entityType: "platform_support_ticket",
        entityId: String(t.id),
        entityLabel: t.reference,
        result: "failure",
        metadata: { clock: c.flag, tenantId: t.tenant_id },
      }).catch(() => {})
    }
  }
  return count
}

export type PlatformTicketFilter = { status?: TicketStatus | null; tenantId?: number | null; breached?: boolean }

export async function listAllTickets(filter: PlatformTicketFilter = {}): Promise<Ticket[]> {
  await ensureSupportSlaSchema()
  const where = ["t.`tenant_id` IS NOT NULL"]
  const params: unknown[] = []
  if (filter.status) {
    where.push("t.`status` = ?")
    params.push(filter.status)
  }
  if (filter.tenantId) {
    where.push("t.`tenant_id` = ?")
    params.push(filter.tenantId)
  }
  if (filter.breached) where.push("(t.`response_breached` = 1 OR t.`resolution_breached` = 1)")
  const rows = await query<TicketRow[]>(
    `SELECT t.*, tn.name AS tenant_name FROM \`platform_support_tickets\` t
       LEFT JOIN \`tenants\` tn ON tn.id = t.tenant_id
      WHERE ${where.join(" AND ")} ORDER BY t.\`created_at\` DESC LIMIT 300`,
    params,
  )
  return rows.map((r) => withSla(r))
}

async function loadTicket(id: number): Promise<TicketRow> {
  const rows = await query<TicketRow[]>(
    "SELECT * FROM `platform_support_tickets` WHERE `id` = ? AND `tenant_id` IS NOT NULL LIMIT 1",
    [id],
  )
  if (!rows[0]) throw new SupportSlaError("Ticket not found", "NOT_FOUND", 404)
  return rows[0]
}

const TERMINAL: TicketStatus[] = ["resolved", "closed"]

/**
 * Staff reply. Stops the first-response clock the first time only (the
 * `IS NULL` guard makes retries harmless). Replies are customer-visible.
 */
export async function respondToTicket(id: number, message: string, actor: { userId: number }) {
  await ensureSupportSlaSchema()
  const t = await loadTicket(id)
  if (TERMINAL.includes(t.status)) throw new SupportSlaError("Ticket is already resolved", "TICKET_CLOSED", 409)
  await query(
    `UPDATE \`platform_support_tickets\`
        SET \`first_response_at\` = COALESCE(\`first_response_at\`, UTC_TIMESTAMP()),
            \`status\` = CASE WHEN \`status\` = 'open' THEN 'in_progress' ELSE \`status\` END
      WHERE \`id\` = ? AND \`tenant_id\` = ?`,
    [id, t.tenant_id],
  )
  await query(
    "INSERT INTO `platform_support_ticket_events` (`tenant_id`, `ticket_id`, `kind`, `visibility`, `message`, `actor_user_id`) VALUES (?, ?, 'response', 'customer', ?, ?)",
    [t.tenant_id, id, message, actor.userId],
  )
  await recordAuditLog({
    action: "support.ticket_respond",
    entityType: "platform_support_ticket",
    entityId: String(id),
    entityLabel: t.reference,
    result: "success",
    metadata: { tenantId: t.tenant_id, firstResponse: t.first_response_at == null },
  }).catch(() => {})
  return withSla((await loadTicket(id)) as TicketRow)
}

export async function setTicketStatus(id: number, status: TicketStatus, actor: { userId: number }) {
  await ensureSupportSlaSchema()
  const t = await loadTicket(id)
  if (t.status === status) return withSla(t)
  const resolving = TERMINAL.includes(status)
  await query(
    `UPDATE \`platform_support_tickets\`
        SET \`status\` = ?,
            \`resolved_at\` = CASE WHEN ? THEN COALESCE(\`resolved_at\`, UTC_TIMESTAMP()) ELSE NULL END
      WHERE \`id\` = ? AND \`tenant_id\` = ?`,
    [status, resolving ? 1 : 0, id, t.tenant_id],
  )
  await query(
    "INSERT INTO `platform_support_ticket_events` (`tenant_id`, `ticket_id`, `kind`, `visibility`, `message`, `actor_user_id`) VALUES (?, ?, 'status_change', 'customer', ?, ?)",
    [t.tenant_id, id, `Status changed from ${t.status} to ${status}`, actor.userId],
  )
  await recordAuditLog({
    action: "support.ticket_status",
    entityType: "platform_support_ticket",
    entityId: String(id),
    entityLabel: t.reference,
    result: "success",
    before: { status: t.status },
    after: { status },
  }).catch(() => {})
  return withSla(await loadTicket(id))
}
