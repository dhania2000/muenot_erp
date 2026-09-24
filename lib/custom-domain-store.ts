import "server-only"
/**
 * SPEC 157 — Custom Domain persistence + live DNS verification.
 * ---------------------------------------------------------------------------
 * The tenant-scoped store for `tenant_domains`, plus the two operations that
 * must touch the outside world: a live DNS check (ownership verification) and
 * the pre-auth host → tenant resolution used to brand the login screen for a
 * customer's own domain.
 *
 * Isolation: every admin-facing operation derives the tenant from context
 * (lib/tenant-scope) and emits a `tenant_id` predicate, so one tenant can never
 * read, verify, activate or delete another's domain. The hostname column is
 * globally UNIQUE, so a domain can belong to exactly one tenant. The single
 * cross-tenant read — resolveTenantByHost — runs only in the pre-auth/system
 * context (no tenant bound) where the data-layer guard permits an unscoped
 * lookup, and it is read-only and fail-safe.
 *
 * Schema self-heals at runtime (same pattern as lib/sso-store.ts); the canonical
 * DDL also lives in database/migrations/2026-11-27-custom-domains.sql.
 */
import { promises as dns } from "node:dns"
import { query } from "@/lib/db"
import { currentTenantId, tenantFindById, tenantSelect } from "@/lib/tenant-scope"
import {
  validateCustomDomain,
  newVerificationToken,
  verificationTxtValue,
  normalizeHostname,
  dnsInstructions,
  canTransitionTo,
  type DomainStatus,
  type DnsRecord,
} from "@/lib/custom-domain"

export type TenantDomainRow = {
  id: number
  tenant_id: number
  hostname: string
  status: DomainStatus
  verification_token: string
  verified_at: string | null
  activated_at: string | null
  last_checked_at: string | null
  last_error: string | null
  created_by: number | null
  created_at: string
  updated_at: string
}

/** Client-facing projection: adds the DNS instructions, hides nothing sensitive
 * (the token is only meaningful to the domain's owning admin, who needs it to
 * publish the record). */
export type PublicTenantDomain = {
  id: number
  hostname: string
  status: DomainStatus
  verifiedAt: string | null
  activatedAt: string | null
  lastCheckedAt: string | null
  lastError: string | null
  createdAt: string
  dns: DnsRecord[]
}

export function toPublicDomain(row: TenantDomainRow): PublicTenantDomain {
  return {
    id: row.id,
    hostname: row.hostname,
    status: row.status,
    verifiedAt: row.verified_at,
    activatedAt: row.activated_at,
    lastCheckedAt: row.last_checked_at,
    lastError: row.last_error,
    createdAt: row.created_at,
    dns: dnsInstructions(row.hostname, row.verification_token),
  }
}

let ensured: Promise<void> | null = null

async function runEnsure(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS \`tenant_domains\` (
      \`id\` INT UNSIGNED NOT NULL AUTO_INCREMENT,
      \`tenant_id\` INT UNSIGNED NOT NULL,
      \`hostname\` VARCHAR(253) NOT NULL,
      \`status\` ENUM('pending','verified','active','disabled','failed') NOT NULL DEFAULT 'pending',
      \`verification_token\` VARCHAR(64) NOT NULL,
      \`verified_at\` DATETIME DEFAULT NULL,
      \`activated_at\` DATETIME DEFAULT NULL,
      \`last_checked_at\` DATETIME DEFAULT NULL,
      \`last_error\` VARCHAR(255) DEFAULT NULL,
      \`created_by\` INT UNSIGNED DEFAULT NULL,
      \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      \`updated_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (\`id\`),
      UNIQUE KEY \`uniq_tenant_domains_hostname\` (\`hostname\`),
      KEY \`idx_tenant_domains_tenant\` (\`tenant_id\`),
      KEY \`idx_tenant_domains_active\` (\`hostname\`, \`status\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)
}

export async function ensureCustomDomainSchema(): Promise<void> {
  if (!ensured) {
    ensured = runEnsure().catch((err) => {
      ensured = null
      throw err
    })
  }
  return ensured
}

/** Raised when a hostname is already claimed by another tenant. */
export class DomainConflictError extends Error {
  constructor(message = "That domain is already registered.") {
    super(message)
    this.name = "DomainConflictError"
  }
}

/** Raised when input fails validation; carries a user-facing message. */
export class DomainValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "DomainValidationError"
  }
}

export async function listDomains(): Promise<PublicTenantDomain[]> {
  await ensureCustomDomainSchema()
  const rows = await tenantSelect<TenantDomainRow[]>("tenant_domains", {
    tail: "ORDER BY `created_at` DESC",
  })
  return rows.map(toPublicDomain)
}

async function getDomainRow(id: number): Promise<TenantDomainRow | null> {
  await ensureCustomDomainSchema()
  return tenantFindById<TenantDomainRow>("tenant_domains", id)
}

export async function getDomain(id: number): Promise<PublicTenantDomain | null> {
  const row = await getDomainRow(id)
  return row ? toPublicDomain(row) : null
}

/**
 * Register a new custom domain for the current tenant (status `pending`).
 * Validates the hostname and enforces global uniqueness (a domain belongs to
 * one tenant only).
 */
export async function createDomain(input: string, createdBy: number): Promise<PublicTenantDomain> {
  await ensureCustomDomainSchema()
  const check = validateCustomDomain(input)
  if (!check.ok) throw new DomainValidationError(check.reason)

  const tenantId = currentTenantId()
  const token = newVerificationToken()
  try {
    const res = await query<{ insertId: number }>(
      `INSERT INTO \`tenant_domains\` (\`tenant_id\`, \`hostname\`, \`status\`, \`verification_token\`, \`created_by\`)
       VALUES (?, ?, 'pending', ?, ?)`,
      [tenantId, check.hostname, token, createdBy],
    )
    const row = await getDomainRow(Number((res as any).insertId))
    if (!row) throw new Error("Domain row not found after insert")
    return toPublicDomain(row)
  } catch (err: any) {
    if (err?.code === "ER_DUP_ENTRY") throw new DomainConflictError()
    throw err
  }
}

/**
 * Run a live DNS check for the domain's ownership TXT record and update its
 * status to `verified` or `failed`. Never throws on DNS/network failure — the
 * failure is recorded as `last_error` and surfaced to the admin.
 */
export async function verifyDomain(id: number): Promise<PublicTenantDomain | null> {
  const row = await getDomainRow(id)
  if (!row) return null

  const expected = verificationTxtValue(row.verification_token)
  const txtHost = `${"_muenot-challenge"}.${row.hostname}`
  let ok = false
  let error: string | null = null
  try {
    const records = await dns.resolveTxt(txtHost)
    const flattened = records.map((chunks) => chunks.join(""))
    ok = flattened.includes(expected)
    if (!ok) error = "Ownership TXT record not found yet. DNS changes can take time to propagate."
  } catch (e: any) {
    ok = false
    error =
      e?.code === "ENOTFOUND" || e?.code === "ENODATA"
        ? "No verification TXT record found yet. Add the record and try again."
        : "DNS lookup failed. Please try again shortly."
  }

  const nextStatus: DomainStatus = ok ? "verified" : "failed"
  const tenantId = currentTenantId()
  await query(
    `UPDATE \`tenant_domains\`
        SET \`status\` = ?, \`last_checked_at\` = CURRENT_TIMESTAMP, \`last_error\` = ?,
            \`verified_at\` = IF(?, CURRENT_TIMESTAMP, \`verified_at\`)
      WHERE \`id\` = ? AND \`tenant_id\` = ?`,
    [nextStatus, error, ok ? 1 : 0, id, tenantId],
  )
  return getDomain(id)
}

/**
 * Activate (start serving) or deactivate a domain. Activation is only allowed
 * once the domain has been verified — a domain can never go live without proven
 * ownership.
 */
export async function setDomainActive(id: number, active: boolean): Promise<PublicTenantDomain | null> {
  const row = await getDomainRow(id)
  if (!row) return null

  const target: DomainStatus = active ? "active" : "disabled"
  if (active && row.verified_at == null) {
    throw new DomainValidationError("Verify domain ownership before activating it.")
  }
  if (!canTransitionTo(row.status, target)) {
    throw new DomainValidationError(`Cannot ${active ? "activate" : "deactivate"} a domain that is ${row.status}.`)
  }

  const tenantId = currentTenantId()
  await query(
    `UPDATE \`tenant_domains\`
        SET \`status\` = ?, \`activated_at\` = IF(?, CURRENT_TIMESTAMP, \`activated_at\`)
      WHERE \`id\` = ? AND \`tenant_id\` = ?`,
    [target, active ? 1 : 0, id, tenantId],
  )
  return getDomain(id)
}

export async function deleteDomain(id: number): Promise<boolean> {
  await ensureCustomDomainSchema()
  const tenantId = currentTenantId()
  const res = await query<any>(`DELETE FROM \`tenant_domains\` WHERE \`id\` = ? AND \`tenant_id\` = ?`, [id, tenantId])
  return Number(res?.affectedRows ?? 0) > 0
}

/**
 * Pre-auth host → tenant resolution. Given the incoming request host, return
 * the tenant currently serving it via an ACTIVE custom domain, or null. Runs in
 * the system context (no tenant bound) so it is exempt from the tenant guard,
 * and is read-only + fail-safe: any error resolves to null (fall back to the
 * platform default).
 */
export async function resolveTenantByHost(host: unknown): Promise<{ tenantId: number; hostname: string } | null> {
  const h = normalizeHostname(host)
  if (!h) return null
  try {
    await ensureCustomDomainSchema()
    const rows = await query<Pick<TenantDomainRow, "tenant_id" | "hostname">[]>(
      `SELECT \`tenant_id\`, \`hostname\` FROM \`tenant_domains\` WHERE \`hostname\` = ? AND \`status\` = 'active' LIMIT 1`,
      [h],
    )
    const r = rows[0]
    return r ? { tenantId: r.tenant_id, hostname: r.hostname } : null
  } catch {
    return null
  }
}
