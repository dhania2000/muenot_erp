import "server-only"
import { query } from "@/lib/db"
import { hashPassword, verifyPassword } from "@/lib/password"
import { ensureVendorPortalSchema } from "@/lib/vendor-portal/schema"
import { ensureDefaultVendorResources } from "@/lib/vendor-portal/access"
import type { VendorPortalItemResource } from "@/lib/vendor-portal/config"

/**
 * SPEC 119 — Vendor Portal · data access (Phase 2/3).
 * ---------------------------------------------------------------------------
 * The ONE place vendor-portal data is read/written. EVERY query is scoped to
 * BOTH the tenant AND the vendor. `tenantId`/`vendorId` always come from the
 * verified vendor-portal session (lib/vendor-portal/auth.ts) or a
 * staff-authenticated internal caller — never from portal-user input. This is
 * the vendor-isolation axis the tenant-id data-layer guard cannot enforce on
 * its own.
 */

export type VendorPortalUser = {
  id: number
  tenant_id: number
  vendor_id: number
  email: string
  name: string
  status: "invited" | "active" | "disabled"
  must_change_password: number
  last_login_at: string | null
}

export type VendorPortalUserWithHash = VendorPortalUser & {
  password_hash: string | null
  locked_until: string | null
  failed_attempts: number
}

// ---------------------------------------------------------------------------
// Vendor directory (for the admin picker) — read from the finance master.
// ---------------------------------------------------------------------------
//
// Vendors live in `customers_vendors` (shared finance master). We surface only
// the identity fields the portal needs. `party_type` distinguishes vendors from
// customers; older rows may have it NULL, so those are included too.

export type VendorDirectoryRow = {
  id: number
  party_id: string | null
  name: string
  gstin: string | null
  status: string | null
}

/** List vendors a staff user can grant portal access to, with optional search. */
export async function listVendorDirectory(search?: string, limit = 200): Promise<VendorDirectoryRow[]> {
  const s = (search ?? "").trim()
  return query<VendorDirectoryRow[]>(
    `SELECT id, party_id, customer_name AS name, gstin, status
       FROM customers_vendors
      WHERE (party_type IS NULL OR party_type LIKE '%Vendor%' OR party_type LIKE '%Supplier%' OR party_type LIKE '%Both%')
        AND (? = '' OR customer_name LIKE ? OR party_id LIKE ? OR gstin LIKE ?)
      ORDER BY customer_name ASC
      LIMIT ?`,
    [s, `%${s}%`, `%${s}%`, `%${s}%`, limit],
  )
}

/** Fetch a single vendor's identity row, or null. */
export async function getVendorDirectoryRow(vendorId: number): Promise<VendorDirectoryRow | null> {
  const rows = await query<VendorDirectoryRow[]>(
    `SELECT id, party_id, customer_name AS name, gstin, status
       FROM customers_vendors WHERE id = ? LIMIT 1`,
    [vendorId],
  )
  return rows[0] ?? null
}

// ---------------------------------------------------------------------------
// Vendor portal users / authentication
// ---------------------------------------------------------------------------

/** Look up active vendor-portal login candidates by email across tenants. */
export async function findVendorLoginCandidates(email: string): Promise<VendorPortalUserWithHash[]> {
  await ensureVendorPortalSchema()
  return query<VendorPortalUserWithHash[]>(
    `SELECT id, tenant_id, vendor_id, email, name, status, must_change_password,
            last_login_at, password_hash, locked_until, failed_attempts
       FROM vendor_portal_users
      WHERE email = ? AND status = 'active'`,
    [String(email).toLowerCase().trim()],
  )
}

/** Authenticate a vendor-portal user by email + password. */
export async function authenticateVendorUser(
  email: string,
  password: string,
): Promise<{ ok: true; user: VendorPortalUser } | { ok: false; reason: "invalid" | "locked" }> {
  const candidates = await findVendorLoginCandidates(email)
  const now = Date.now()
  for (const candidate of candidates) {
    if (candidate.locked_until && new Date(candidate.locked_until).getTime() > now) {
      return { ok: false, reason: "locked" }
    }
    if (!candidate.password_hash) continue
    const valid = await verifyPassword(password, candidate.password_hash)
    if (valid) {
      await query(
        `UPDATE vendor_portal_users
            SET last_login_at = NOW(), failed_attempts = 0, locked_until = NULL
          WHERE id = ? AND tenant_id = ?`,
        [candidate.id, candidate.tenant_id],
      )
      return {
        ok: true,
        user: {
          id: candidate.id,
          tenant_id: candidate.tenant_id,
          vendor_id: candidate.vendor_id,
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
      `UPDATE vendor_portal_users
          SET failed_attempts = failed_attempts + 1,
              locked_until = IF(failed_attempts + 1 >= 10, DATE_ADD(NOW(), INTERVAL 15 MINUTE), locked_until)
        WHERE id = ? AND tenant_id = ?`,
      [candidate.id, candidate.tenant_id],
    )
  }
  return { ok: false, reason: "invalid" }
}

/** Create (or re-invite) a vendor-portal login. Internal/staff use only. */
export async function createVendorUser(input: {
  tenantId: number
  vendorId: number
  email: string
  name: string
  password: string
}): Promise<VendorPortalUser> {
  await ensureVendorPortalSchema()
  const email = String(input.email).toLowerCase().trim()
  const hash = await hashPassword(input.password)
  await query(
    `INSERT INTO vendor_portal_users (tenant_id, vendor_id, email, name, password_hash, status)
     VALUES (?, ?, ?, ?, ?, 'active')
     ON DUPLICATE KEY UPDATE
       vendor_id = VALUES(vendor_id),
       name = VALUES(name),
       password_hash = VALUES(password_hash),
       status = 'active'`,
    [input.tenantId, input.vendorId, email, input.name.trim(), hash],
  )
  await ensureDefaultVendorResources(input.tenantId, input.vendorId)
  const rows = await query<VendorPortalUser[]>(
    `SELECT id, tenant_id, vendor_id, email, name, status, must_change_password, last_login_at
       FROM vendor_portal_users WHERE tenant_id = ? AND email = ? LIMIT 1`,
    [input.tenantId, email],
  )
  return rows[0]
}

export async function listVendorUsers(
  tenantId: number,
  vendorId?: number,
): Promise<(VendorPortalUser & { vendor_name: string | null })[]> {
  await ensureVendorPortalSchema()
  const where = ["u.tenant_id = ?"]
  const params: (string | number)[] = [tenantId]
  if (vendorId) {
    where.push("u.vendor_id = ?")
    params.push(vendorId)
  }
  return query<(VendorPortalUser & { vendor_name: string | null })[]>(
    `SELECT u.id, u.tenant_id, u.vendor_id, u.email, u.name, u.status, u.must_change_password,
            u.last_login_at, v.customer_name AS vendor_name
       FROM vendor_portal_users u
       LEFT JOIN customers_vendors v ON v.id = u.vendor_id
      WHERE ${where.join(" AND ")}
      ORDER BY u.created_at DESC`,
    params,
  )
}

export async function setVendorUserStatus(
  tenantId: number,
  userId: number,
  status: "active" | "disabled",
): Promise<void> {
  await ensureVendorPortalSchema()
  await query(`UPDATE vendor_portal_users SET status = ? WHERE id = ? AND tenant_id = ?`, [status, userId, tenantId])
}

// ---------------------------------------------------------------------------
// Shared items (purchase-orders / invoices / payments / documents / compliance)
// ---------------------------------------------------------------------------

export type VendorPortalItem = {
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
  /** How this record entered the portal: staff-published or vendor-submitted. */
  source: "staff" | "vendor"
}

function readSource(meta: unknown): "staff" | "vendor" {
  if (!meta) return "staff"
  try {
    const parsed = typeof meta === "string" ? JSON.parse(meta) : meta
    return (parsed as { source?: string })?.source === "vendor_submission" ? "vendor" : "staff"
  } catch {
    return "staff"
  }
}

/** List the records of one resource visible to a vendor. Vendor-facing (scoped). */
export async function listItems(
  tenantId: number,
  vendorId: number,
  resource: VendorPortalItemResource,
): Promise<VendorPortalItem[]> {
  await ensureVendorPortalSchema()
  const rows = await query<(VendorPortalItem & { meta: unknown })[]>(
    `SELECT id, resource, reference, title, description, status, amount, currency,
            issue_date, due_date, file_url, file_name, created_at, meta
       FROM vendor_portal_items
      WHERE tenant_id = ? AND vendor_id = ? AND resource = ?
      ORDER BY COALESCE(issue_date, DATE(created_at)) DESC, id DESC`,
    [tenantId, vendorId, resource],
  )
  return rows.map(({ meta, ...row }) => ({ ...row, source: readSource(meta) }))
}

export async function countItemsByResource(tenantId: number, vendorId: number): Promise<Record<string, number>> {
  await ensureVendorPortalSchema()
  const rows = await query<{ resource: string; n: number }[]>(
    `SELECT resource, COUNT(*) AS n FROM vendor_portal_items
      WHERE tenant_id = ? AND vendor_id = ? GROUP BY resource`,
    [tenantId, vendorId],
  )
  const out: Record<string, number> = {}
  for (const r of rows) out[r.resource] = Number(r.n)
  return out
}

/** List every record published to / submitted by a vendor across all resources. Staff use only. */
export async function listVendorItems(tenantId: number, vendorId: number): Promise<VendorPortalItem[]> {
  await ensureVendorPortalSchema()
  const rows = await query<(VendorPortalItem & { meta: unknown })[]>(
    `SELECT id, resource, reference, title, description, status, amount, currency,
            issue_date, due_date, file_url, file_name, created_at, meta
       FROM vendor_portal_items
      WHERE tenant_id = ? AND vendor_id = ?
      ORDER BY COALESCE(issue_date, DATE(created_at)) DESC, id DESC`,
    [tenantId, vendorId],
  )
  return rows.map(({ meta, ...row }) => ({ ...row, source: readSource(meta) }))
}

/** Unpublish (delete) a shared record. Staff use only. Returns true when a row was removed. */
export async function deleteItem(tenantId: number, vendorId: number, itemId: number): Promise<boolean> {
  await ensureVendorPortalSchema()
  const result = await query<{ affectedRows: number }>(
    `DELETE FROM vendor_portal_items WHERE tenant_id = ? AND vendor_id = ? AND id = ?`,
    [tenantId, vendorId, itemId],
  )
  return Number(result?.affectedRows ?? 0) > 0
}

/** Publish a shared record to a vendor. Internal/staff use only. */
export async function createItem(input: {
  tenantId: number
  vendorId: number
  resource: VendorPortalItemResource
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
  await ensureVendorPortalSchema()
  const result = await query<{ insertId: number }>(
    `INSERT INTO vendor_portal_items
       (tenant_id, vendor_id, resource, reference, title, description, status, amount, currency,
        issue_date, due_date, file_url, file_name, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.tenantId,
      input.vendorId,
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

/**
 * Submit an invoice from the portal (vendor-authenticated). tenantId/vendorId
 * ALWAYS come from the verified session — never from request input. The record
 * is marked with meta.source='vendor_submission' and status 'Submitted' so
 * staff can distinguish vendor-submitted invoices from staff-published ones.
 */
export async function submitVendorInvoice(input: {
  tenantId: number
  vendorId: number
  portalUserId: number
  authorName: string
  reference?: string | null
  title: string
  description?: string | null
  amount?: number | null
  currency?: string | null
  issueDate?: string | null
  dueDate?: string | null
}): Promise<number> {
  await ensureVendorPortalSchema()
  const meta = JSON.stringify({
    source: "vendor_submission",
    portalUserId: input.portalUserId,
    submittedBy: input.authorName,
  })
  const result = await query<{ insertId: number }>(
    `INSERT INTO vendor_portal_items
       (tenant_id, vendor_id, resource, reference, title, description, status, amount, currency,
        issue_date, due_date, meta, created_by)
     VALUES (?, ?, 'invoices', ?, ?, ?, 'Submitted', ?, ?, ?, ?, ?, NULL)`,
    [
      input.tenantId,
      input.vendorId,
      input.reference ?? null,
      input.title,
      input.description ?? null,
      input.amount ?? null,
      input.currency ?? null,
      input.issueDate ?? null,
      input.dueDate ?? null,
      meta,
    ],
  )
  return result.insertId
}

// ---------------------------------------------------------------------------
// Messages (direct thread with the accounts-payable team)
// ---------------------------------------------------------------------------

export type VendorPortalMessage = {
  id: number
  author_type: "vendor" | "staff"
  author_name: string
  body: string
  read_at: string | null
  created_at: string
}

export async function listMessages(tenantId: number, vendorId: number): Promise<VendorPortalMessage[]> {
  await ensureVendorPortalSchema()
  return query<VendorPortalMessage[]>(
    `SELECT id, author_type, author_name, body, read_at, created_at
       FROM vendor_portal_messages
      WHERE tenant_id = ? AND vendor_id = ?
      ORDER BY created_at ASC, id ASC`,
    [tenantId, vendorId],
  )
}

export async function createMessage(input: {
  tenantId: number
  vendorId: number
  authorType: "vendor" | "staff"
  portalUserId?: number | null
  authorName: string
  body: string
}): Promise<VendorPortalMessage> {
  await ensureVendorPortalSchema()
  const result = await query<{ insertId: number }>(
    `INSERT INTO vendor_portal_messages
       (tenant_id, vendor_id, author_type, author_name, body, created_by_portal_user_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [input.tenantId, input.vendorId, input.authorType, input.authorName, input.body, input.portalUserId ?? null],
  )
  return {
    id: result.insertId,
    author_type: input.authorType,
    author_name: input.authorName,
    body: input.body,
    read_at: null,
    created_at: new Date().toISOString(),
  }
}
