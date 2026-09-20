import "server-only"
/**
 * SPEC 62 — IP allowlisting.
 * ---------------------------------------------------------------------------
 * Tenants can restrict sign-in to specific CIDR ranges. Enforcement is
 * opt-in per tenant (security.ip_allowlist_enabled) so adding entries never
 * silently locks anyone out — the toggle must be turned on explicitly once
 * ranges are configured. When enabled, app/api/auth/login checks the
 * request's source IP against this table before issuing a session.
 *
 * Self-heals at runtime (same pattern as lib/session-store.ts) so existing
 * databases converge without a manual migration step.
 */
import { query } from "@/lib/db"

export type IpAllowlistScope = "all" | "admin"

export type IpAllowlistEntry = {
  id: number
  tenantId: number | null
  label: string
  cidr: string
  mode: "allow" | "block"
  scope: IpAllowlistScope
  createdBy: number | null
  createdByName: string | null
  createdAt: string
  lastMatchedAt: string | null
}

type EntryRow = {
  id: number
  tenant_id: number | null
  label: string
  cidr: string
  mode: "allow" | "block"
  scope: IpAllowlistScope
  created_by: number | null
  created_by_name: string | null
  created_at: string
  last_matched_at: string | null
}

let ensured: Promise<void> | null = null

async function runEnsure(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS \`ip_allowlist_entries\` (
      \`id\` INT UNSIGNED NOT NULL AUTO_INCREMENT,
      \`tenant_id\` INT UNSIGNED DEFAULT NULL,
      \`label\` VARCHAR(120) NOT NULL,
      \`cidr\` VARCHAR(64) NOT NULL,
      \`mode\` ENUM('allow','block') NOT NULL DEFAULT 'allow',
      \`scope\` ENUM('all','admin') NOT NULL DEFAULT 'all',
      \`created_by\` INT UNSIGNED DEFAULT NULL,
      \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      \`last_matched_at\` DATETIME DEFAULT NULL,
      PRIMARY KEY (\`id\`),
      KEY \`idx_ip_allowlist_tenant\` (\`tenant_id\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `)
}

function ensureTable(): Promise<void> {
  if (!ensured) ensured = runEnsure().catch((err) => {
    ensured = null
    throw err
  })
  return ensured
}

/** Parses an IPv4 dotted string into a 32-bit unsigned integer, or null if invalid. */
function ipv4ToInt(ip: string): number | null {
  const parts = ip.trim().split(".")
  if (parts.length !== 4) return null
  let result = 0
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null
    const n = Number(part)
    if (n < 0 || n > 255) return null
    result = (result << 8) | n
  }
  return result >>> 0
}

/** Returns true when `ip` falls inside `cidr` (IPv4 only; a bare IP is treated as a /32). */
export function ipMatchesCidr(ip: string, cidr: string): boolean {
  const clean = ip.trim().replace(/^::ffff:/, "")
  const [rangeIp, prefixStr] = cidr.trim().split("/")
  const prefix = prefixStr !== undefined ? Number(prefixStr) : 32
  if (!Number.isFinite(prefix) || prefix < 0 || prefix > 32) return false

  const ipInt = ipv4ToInt(clean)
  const rangeInt = ipv4ToInt(rangeIp)
  if (ipInt === null || rangeInt === null) return false

  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0
  return (ipInt & mask) === (rangeInt & mask)
}

function isValidCidr(cidr: string): boolean {
  const [rangeIp, prefixStr] = cidr.trim().split("/")
  if (ipv4ToInt(rangeIp) === null) return false
  if (prefixStr === undefined) return true
  const prefix = Number(prefixStr)
  return Number.isInteger(prefix) && prefix >= 0 && prefix <= 32
}

function toPublic(row: EntryRow): IpAllowlistEntry {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    label: row.label,
    cidr: row.cidr,
    mode: row.mode,
    scope: row.scope,
    createdBy: row.created_by,
    createdByName: row.created_by_name,
    createdAt: row.created_at,
    lastMatchedAt: row.last_matched_at,
  }
}

export async function listIpAllowlistEntries(tenantId: number | null): Promise<IpAllowlistEntry[]> {
  await ensureTable()
  const rows = await query<EntryRow[]>(
    `SELECT e.*, u.name AS created_by_name
     FROM ip_allowlist_entries e
     LEFT JOIN users u ON u.id = e.created_by
     WHERE e.tenant_id = ? OR e.tenant_id IS NULL
     ORDER BY e.created_at DESC`,
    [tenantId],
  )
  return rows.map(toPublic)
}

export async function createIpAllowlistEntry(input: {
  tenantId: number | null
  label: string
  cidr: string
  mode: "allow" | "block"
  scope: IpAllowlistScope
  createdBy: number
}): Promise<IpAllowlistEntry> {
  await ensureTable()
  const label = input.label.trim()
  const cidr = input.cidr.trim()
  if (!label) throw new Error("Label is required")
  if (!isValidCidr(cidr)) throw new Error("Enter a valid CIDR range, e.g. 203.0.113.0/24")

  const result = await query<{ insertId: number }>(
    `INSERT INTO ip_allowlist_entries (tenant_id, label, cidr, mode, scope, created_by) VALUES (?, ?, ?, ?, ?, ?)`,
    [input.tenantId, label, cidr, input.mode, input.scope, input.createdBy],
  )
  const rows = await query<EntryRow[]>(
    `SELECT e.*, u.name AS created_by_name FROM ip_allowlist_entries e LEFT JOIN users u ON u.id = e.created_by WHERE e.id = ?`,
    [(result as any).insertId],
  )
  return toPublic(rows[0])
}

export async function deleteIpAllowlistEntry(tenantId: number | null, id: number): Promise<void> {
  await ensureTable()
  await query(`DELETE FROM ip_allowlist_entries WHERE id = ? AND (tenant_id = ? OR tenant_id IS NULL)`, [
    id,
    tenantId,
  ])
}

/**
 * Enforcement check called from the login route. Only evaluated when the
 * tenant has turned enforcement on. Rules are evaluated most-specific-first:
 * an explicit "block" match always wins; otherwise, if ANY "allow" entries
 * exist for the scope, the IP must match at least one of them.
 */
export async function checkIpAllowlist(
  tenantId: number | null,
  ip: string | null,
  scope: IpAllowlistScope,
): Promise<{ allowed: boolean; matchedEntryId?: number }> {
  const entries = await listIpAllowlistEntries(tenantId)
  const relevant = entries.filter((e) => e.scope === scope || e.scope === "all")
  if (relevant.length === 0) return { allowed: true }
  if (!ip) return { allowed: false }

  const blocked = relevant.find((e) => e.mode === "block" && ipMatchesCidr(ip, e.cidr))
  if (blocked) return { allowed: false, matchedEntryId: blocked.id }

  const allowEntries = relevant.filter((e) => e.mode === "allow")
  if (allowEntries.length === 0) return { allowed: true }

  const matched = allowEntries.find((e) => ipMatchesCidr(ip, e.cidr))
  if (matched) {
    await query(`UPDATE ip_allowlist_entries SET last_matched_at = NOW() WHERE id = ?`, [matched.id]).catch(
      () => {},
    )
    return { allowed: true, matchedEntryId: matched.id }
  }
  return { allowed: false }
}
