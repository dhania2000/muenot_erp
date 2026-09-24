import "server-only"
import { query } from "@/lib/db"
import { hashPassword, verifyPassword } from "@/lib/password"
import { ensurePortalSchema } from "@/lib/portal/schema"
import { ensureDefaultClientResources } from "@/lib/portal/access"
import type { PortalItemResource } from "@/lib/portal/config"

/**
 * SPEC 118 — Client Portal · data access (Phase 2/3).
 * ---------------------------------------------------------------------------
 * The ONE place portal data is read/written. EVERY query is scoped to BOTH the
 * tenant AND the client. `tenantId` and `clientId` always come from the verified
 * portal session (lib/portal/auth.ts) or a staff-authenticated internal caller —
 * never from portal-user input. This is the client-isolation axis that the
 * tenant-id data-layer guard cannot enforce on its own.
 */

export type PortalUser = {
  id: number
  tenant_id: number
  client_id: number
  email: string
  name: string
  status: "invited" | "active" | "disabled"
  must_change_password: number
  last_login_at: string | null
}

export type PortalUserWithHash = PortalUser & { password_hash: string | null; locked_until: string | null; failed_attempts: number }

// ---------------------------------------------------------------------------
// Portal users / authentication
// ---------------------------------------------------------------------------

/**
 * Look up active portal login candidates by email across tenants. Email is
 * unique per tenant, so this returns at most one row per tenant. The caller
 * (login) verifies the password against each to pick the correct account.
 */
export async function findPortalLoginCandidates(email: string): Promise<PortalUserWithHash[]> {
  await ensurePortalSchema()
  return query<PortalUserWithHash[]>(
    `SELECT id, tenant_id, client_id, email, name, status, must_change_password,
            last_login_at, password_hash, locked_until, failed_attempts
       FROM client_portal_users
      WHERE email = ? AND status = 'active'`,
    [String(email).toLowerCase().trim()],
  )
}

/** Authenticate a portal user by email + password. Returns the user or null. */
export async function authenticatePortalUser(
  email: string,
  password: string,
): Promise<{ ok: true; user: PortalUser } | { ok: false; reason: "invalid" | "locked" }> {
  const candidates = await findPortalLoginCandidates(email)
  const now = Date.now()
  for (const candidate of candidates) {
    if (candidate.locked_until && new Date(candidate.locked_until).getTime() > now) {
      return { ok: false, reason: "locked" }
    }
    if (!candidate.password_hash) continue
    const valid = await verifyPassword(password, candidate.password_hash)
    if (valid) {
      await query(
        `UPDATE client_portal_users
            SET last_login_at = NOW(), failed_attempts = 0, locked_until = NULL
          WHERE id = ? AND tenant_id = ?`,
        [candidate.id, candidate.tenant_id],
      )
      return {
        ok: true,
        user: {
          id: candidate.id,
          tenant_id: candidate.tenant_id,
          client_id: candidate.client_id,
          email: candidate.email,
          name: candidate.name,
          status: candidate.status,
          must_change_password: candidate.must_change_password,
          last_login_at: candidate.last_login_at,
        },
      }
    }
    // Wrong password: increment the lockout counter, lock after 10 failures.
    await query(
      `UPDATE client_portal_users
          SET failed_attempts = failed_attempts + 1,
              locked_until = IF(failed_attempts + 1 >= 10, DATE_ADD(NOW(), INTERVAL 15 MINUTE), locked_until)
        WHERE id = ? AND tenant_id = ?`,
      [candidate.id, candidate.tenant_id],
    )
  }
  return { ok: false, reason: "invalid" }
}

/** Create (or re-invite) a portal login for a client. Internal/staff use only. */
export async function createPortalUser(input: {
  tenantId: number
  clientId: number
  email: string
  name: string
  password: string
}): Promise<PortalUser> {
  await ensurePortalSchema()
  const email = String(input.email).toLowerCase().trim()
  const hash = await hashPassword(input.password)
  await query(
    `INSERT INTO client_portal_users (tenant_id, client_id, email, name, password_hash, status)
     VALUES (?, ?, ?, ?, ?, 'active')
     ON DUPLICATE KEY UPDATE
       client_id = VALUES(client_id),
       name = VALUES(name),
       password_hash = VALUES(password_hash),
       status = 'active'`,
    [input.tenantId, input.clientId, email, input.name.trim(), hash],
  )
  await ensureDefaultClientResources(input.tenantId, input.clientId)
  const rows = await query<PortalUser[]>(
    `SELECT id, tenant_id, client_id, email, name, status, must_change_password, last_login_at
       FROM client_portal_users WHERE tenant_id = ? AND email = ? LIMIT 1`,
    [input.tenantId, email],
  )
  return rows[0]
}

export async function listPortalUsers(tenantId: number): Promise<(PortalUser & { client_name: string | null })[]> {
  await ensurePortalSchema()
  return query<(PortalUser & { client_name: string | null })[]>(
    `SELECT u.id, u.tenant_id, u.client_id, u.email, u.name, u.status, u.must_change_password,
            u.last_login_at, c.client_name
       FROM client_portal_users u
       LEFT JOIN clients c ON c.id = u.client_id AND c.tenant_id = u.tenant_id
      WHERE u.tenant_id = ?
      ORDER BY u.created_at DESC`,
    [tenantId],
  )
}

export async function setPortalUserStatus(
  tenantId: number,
  userId: number,
  status: "active" | "disabled",
): Promise<void> {
  await ensurePortalSchema()
  await query(`UPDATE client_portal_users SET status = ? WHERE id = ? AND tenant_id = ?`, [status, userId, tenantId])
}

// ---------------------------------------------------------------------------
// Shared items (quotes / orders / invoices / payments / documents / projects)
// ---------------------------------------------------------------------------

export type PortalItem = {
  id: number
  resource: string
  reference: string | null
  title: string
  description: string | null
  status: string | null
  amount: number | null
  currency: string | null
  issue_date: string | null
  due_date: string | null
  file_url: string | null
  file_name: string | null
  created_at: string
}

export async function listItems(
  tenantId: number,
  clientId: number,
  resource: PortalItemResource,
): Promise<PortalItem[]> {
  await ensurePortalSchema()
  return query<PortalItem[]>(
    `SELECT id, resource, reference, title, description, status, amount, currency,
            issue_date, due_date, file_url, file_name, created_at
       FROM client_portal_items
      WHERE tenant_id = ? AND client_id = ? AND resource = ?
      ORDER BY COALESCE(issue_date, DATE(created_at)) DESC, id DESC`,
    [tenantId, clientId, resource],
  )
}

export async function countItemsByResource(
  tenantId: number,
  clientId: number,
): Promise<Record<string, number>> {
  await ensurePortalSchema()
  const rows = await query<{ resource: string; n: number }[]>(
    `SELECT resource, COUNT(*) AS n FROM client_portal_items
      WHERE tenant_id = ? AND client_id = ? GROUP BY resource`,
    [tenantId, clientId],
  )
  const out: Record<string, number> = {}
  for (const r of rows) out[r.resource] = Number(r.n)
  return out
}

/** Publish a shared record to a client. Internal/staff use only. */
export async function createItem(input: {
  tenantId: number
  clientId: number
  resource: PortalItemResource
  reference?: string | null
  title: string
  description?: string | null
  status?: string | null
  amount?: number | null
  currency?: string | null
  issueDate?: string | null
  dueDate?: string | null
  fileUrl?: string | null
  fileName?: string | null
  createdBy?: number | null
}): Promise<number> {
  await ensurePortalSchema()
  const result = await query<{ insertId: number }>(
    `INSERT INTO client_portal_items
       (tenant_id, client_id, resource, reference, title, description, status, amount, currency,
        issue_date, due_date, file_url, file_name, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.tenantId,
      input.clientId,
      input.resource,
      input.reference ?? null,
      input.title,
      input.description ?? null,
      input.status ?? null,
      input.amount ?? null,
      input.currency ?? null,
      input.issueDate ?? null,
      input.dueDate ?? null,
      input.fileUrl ?? null,
      input.fileName ?? null,
      input.createdBy ?? null,
    ],
  )
  return result.insertId
}

// ---------------------------------------------------------------------------
// Client-placed orders (SPEC 117 — Sales Order Management)
// ---------------------------------------------------------------------------
//
// An order a CLIENT submits from the portal is stored in client_portal_items
// with resource='orders' and meta.source='portal_request', so it is cleanly
// distinguishable from staff-published order records (meta = NULL). Sales staff
// review these under Sales → Sales Order Management.

/** Canonical lifecycle for a client-placed order. */
export const PORTAL_ORDER_STATUSES = [
  "Requested",
  "Confirmed",
  "In Progress",
  "Fulfilled",
  "Cancelled",
] as const
export type PortalOrderStatus = (typeof PORTAL_ORDER_STATUSES)[number]

export function isPortalOrderStatus(v: unknown): v is PortalOrderStatus {
  return typeof v === "string" && (PORTAL_ORDER_STATUSES as readonly string[]).includes(v)
}

/**
 * Create an order the client placed from the portal. tenantId/clientId ALWAYS
 * come from the verified portal session — never from request input. The record
 * is marked with meta.source='portal_request' so staff can list client-placed
 * orders separately from staff-published ones.
 */
export async function createClientOrder(input: {
  tenantId: number
  clientId: number
  portalUserId: number
  authorName: string
  title: string
  description?: string | null
  amount?: number | null
  currency?: string | null
}): Promise<number> {
  await ensurePortalSchema()
  const meta = JSON.stringify({
    source: "portal_request",
    portalUserId: input.portalUserId,
    placedBy: input.authorName,
  })
  // A short human reference unique enough for display; scoped per tenant.
  const countRows = await query<{ n: number }[]>(
    `SELECT COUNT(*) AS n FROM client_portal_items WHERE tenant_id = ? AND resource = 'orders'`,
    [input.tenantId],
  )
  const reference = `SO-${String(Number(countRows[0]?.n ?? 0) + 1).padStart(5, "0")}`
  const result = await query<{ insertId: number }>(
    `INSERT INTO client_portal_items
       (tenant_id, client_id, resource, reference, title, description, status, amount, currency, issue_date, meta, created_by)
     VALUES (?, ?, 'orders', ?, ?, ?, 'Requested', ?, ?, CURDATE(), ?, NULL)`,
    [
      input.tenantId,
      input.clientId,
      reference,
      input.title,
      input.description ?? null,
      input.amount ?? null,
      input.currency ?? null,
      meta,
    ],
  )
  return result.insertId
}

export type PortalPlacedOrder = {
  id: number
  client_id: number
  client_name: string | null
  reference: string | null
  title: string
  description: string | null
  status: string | null
  amount: number | null
  currency: string | null
  issue_date: string | null
  placed_by: string | null
  created_at: string
}

/**
 * List every order clients placed through the portal for a tenant. Scoped to
 * the tenant only (staff may see all of the tenant's clients); the client
 * isolation axis does not apply to internal staff. Joins clients for display.
 */
export async function listPortalPlacedOrders(
  tenantId: number,
  opts: { status?: string; clientId?: number } = {},
): Promise<PortalPlacedOrder[]> {
  await ensurePortalSchema()
  const where: string[] = [
    "i.tenant_id = ?",
    "i.resource = 'orders'",
    "JSON_UNQUOTE(JSON_EXTRACT(i.meta, '$.source')) = 'portal_request'",
  ]
  const params: (string | number)[] = [tenantId]
  if (opts.status) {
    where.push("i.status = ?")
    params.push(opts.status)
  }
  if (opts.clientId) {
    where.push("i.client_id = ?")
    params.push(opts.clientId)
  }
  return query<PortalPlacedOrder[]>(
    `SELECT i.id, i.client_id, c.client_name, i.reference, i.title, i.description, i.status,
            i.amount, i.currency, i.issue_date,
            JSON_UNQUOTE(JSON_EXTRACT(i.meta, '$.placedBy')) AS placed_by,
            i.created_at
       FROM client_portal_items i
       LEFT JOIN clients c ON c.id = i.client_id AND c.tenant_id = i.tenant_id
      WHERE ${where.join(" AND ")}
      ORDER BY i.created_at DESC, i.id DESC`,
    params,
  )
}

/** Aggregate counts per status for the tenant's client-placed orders. */
export async function countPortalPlacedOrdersByStatus(tenantId: number): Promise<Record<string, number>> {
  await ensurePortalSchema()
  const rows = await query<{ status: string | null; n: number }[]>(
    `SELECT i.status, COUNT(*) AS n
       FROM client_portal_items i
      WHERE i.tenant_id = ? AND i.resource = 'orders'
        AND JSON_UNQUOTE(JSON_EXTRACT(i.meta, '$.source')) = 'portal_request'
      GROUP BY i.status`,
    [tenantId],
  )
  const out: Record<string, number> = {}
  for (const r of rows) out[r.status ?? "Requested"] = Number(r.n)
  return out
}

/**
 * Update the status of a client-placed order. Tenant-scoped, and restricted to
 * portal-sourced order records so staff cannot mutate unrelated items through
 * this path. Returns true when a row was updated.
 */
export async function setPortalOrderStatus(
  tenantId: number,
  orderId: number,
  status: PortalOrderStatus,
): Promise<boolean> {
  await ensurePortalSchema()
  const result = await query<{ affectedRows: number }>(
    `UPDATE client_portal_items
        SET status = ?, updated_at = NOW()
      WHERE tenant_id = ? AND id = ? AND resource = 'orders'
        AND JSON_UNQUOTE(JSON_EXTRACT(meta, '$.source')) = 'portal_request'`,
    [status, tenantId, orderId],
  )
  return Number(result?.affectedRows ?? 0) > 0
}

// ---------------------------------------------------------------------------
// Tickets
// ---------------------------------------------------------------------------

export type PortalTicket = {
  id: number
  ticket_number: string
  subject: string
  priority: "low" | "normal" | "high" | "urgent"
  status: "open" | "pending" | "resolved" | "closed"
  created_at: string
  updated_at: string
}

export type PortalTicketMessage = {
  id: number
  ticket_id: number
  author_type: "client" | "staff"
  author_name: string
  body: string
  created_at: string
}

export async function listTickets(tenantId: number, clientId: number): Promise<PortalTicket[]> {
  await ensurePortalSchema()
  return query<PortalTicket[]>(
    `SELECT id, ticket_number, subject, priority, status, created_at, updated_at
       FROM client_portal_tickets
      WHERE tenant_id = ? AND client_id = ?
      ORDER BY updated_at DESC, id DESC`,
    [tenantId, clientId],
  )
}

export async function getTicket(
  tenantId: number,
  clientId: number,
  ticketId: number,
): Promise<{ ticket: PortalTicket; messages: PortalTicketMessage[] } | null> {
  await ensurePortalSchema()
  const rows = await query<PortalTicket[]>(
    `SELECT id, ticket_number, subject, priority, status, created_at, updated_at
       FROM client_portal_tickets
      WHERE tenant_id = ? AND client_id = ? AND id = ? LIMIT 1`,
    [tenantId, clientId, ticketId],
  )
  if (!rows[0]) return null
  const messages = await query<PortalTicketMessage[]>(
    `SELECT id, ticket_id, author_type, author_name, body, created_at
       FROM client_portal_ticket_messages
      WHERE tenant_id = ? AND client_id = ? AND ticket_id = ?
      ORDER BY created_at ASC, id ASC`,
    [tenantId, clientId, ticketId],
  )
  return { ticket: rows[0], messages }
}

async function nextTicketNumber(tenantId: number): Promise<string> {
  const rows = await query<{ n: number }[]>(
    `SELECT COUNT(*) AS n FROM client_portal_tickets WHERE tenant_id = ?`,
    [tenantId],
  )
  const seq = Number(rows[0]?.n ?? 0) + 1
  return `TKT-${String(seq).padStart(5, "0")}`
}

export async function createTicket(input: {
  tenantId: number
  clientId: number
  portalUserId: number
  authorName: string
  subject: string
  priority?: PortalTicket["priority"]
  body: string
}): Promise<PortalTicket> {
  await ensurePortalSchema()
  const ticketNumber = await nextTicketNumber(input.tenantId)
  const result = await query<{ insertId: number }>(
    `INSERT INTO client_portal_tickets
       (tenant_id, client_id, ticket_number, subject, priority, status, created_by_portal_user_id)
     VALUES (?, ?, ?, ?, ?, 'open', ?)`,
    [input.tenantId, input.clientId, ticketNumber, input.subject, input.priority ?? "normal", input.portalUserId],
  )
  await query(
    `INSERT INTO client_portal_ticket_messages
       (tenant_id, client_id, ticket_id, author_type, author_name, body)
     VALUES (?, ?, ?, 'client', ?, ?)`,
    [input.tenantId, input.clientId, result.insertId, input.authorName, input.body],
  )
  const created = await getTicket(input.tenantId, input.clientId, result.insertId)
  return created!.ticket
}

/** Add a client reply to an existing ticket. Reopens a resolved/closed ticket. */
export async function addTicketMessage(input: {
  tenantId: number
  clientId: number
  ticketId: number
  authorName: string
  body: string
}): Promise<PortalTicketMessage | null> {
  await ensurePortalSchema()
  const owns = await query<{ id: number }[]>(
    `SELECT id FROM client_portal_tickets WHERE tenant_id = ? AND client_id = ? AND id = ? LIMIT 1`,
    [input.tenantId, input.clientId, input.ticketId],
  )
  if (!owns[0]) return null
  const result = await query<{ insertId: number }>(
    `INSERT INTO client_portal_ticket_messages
       (tenant_id, client_id, ticket_id, author_type, author_name, body)
     VALUES (?, ?, ?, 'client', ?, ?)`,
    [input.tenantId, input.clientId, input.ticketId, input.authorName, input.body],
  )
  await query(
    `UPDATE client_portal_tickets
        SET status = IF(status IN ('resolved','closed'), 'open', status), updated_at = NOW()
      WHERE tenant_id = ? AND client_id = ? AND id = ?`,
    [input.tenantId, input.clientId, input.ticketId],
  )
  return {
    id: result.insertId,
    ticket_id: input.ticketId,
    author_type: "client",
    author_name: input.authorName,
    body: input.body,
    created_at: new Date().toISOString(),
  }
}

// ---------------------------------------------------------------------------
// Messages (direct thread with the account team)
// ---------------------------------------------------------------------------

export type PortalMessage = {
  id: number
  author_type: "client" | "staff"
  author_name: string
  body: string
  read_at: string | null
  created_at: string
}

export async function listMessages(tenantId: number, clientId: number): Promise<PortalMessage[]> {
  await ensurePortalSchema()
  return query<PortalMessage[]>(
    `SELECT id, author_type, author_name, body, read_at, created_at
       FROM client_portal_messages
      WHERE tenant_id = ? AND client_id = ?
      ORDER BY created_at ASC, id ASC`,
    [tenantId, clientId],
  )
}

export async function createMessage(input: {
  tenantId: number
  clientId: number
  portalUserId: number
  authorName: string
  body: string
}): Promise<PortalMessage> {
  await ensurePortalSchema()
  const result = await query<{ insertId: number }>(
    `INSERT INTO client_portal_messages
       (tenant_id, client_id, author_type, author_name, body, created_by_portal_user_id)
     VALUES (?, ?, 'client', ?, ?, ?)`,
    [input.tenantId, input.clientId, input.authorName, input.body, input.portalUserId],
  )
  return {
    id: result.insertId,
    author_type: "client",
    author_name: input.authorName,
    body: input.body,
    read_at: null,
    created_at: new Date().toISOString(),
  }
}
