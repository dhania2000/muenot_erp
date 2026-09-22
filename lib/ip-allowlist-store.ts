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

/**
 * IP parsing supports BOTH IPv4 and IPv6 (SPEC 62). Every address is normalised
 * to a BigInt plus its family so a single mask/compare path works for both. An
 * IPv4-mapped IPv6 address (::ffff:a.b.c.d) is treated as its IPv4 form so a
 * range written in either notation matches consistently.
 */
type IpFamily = 4 | 6

/** Parses an IPv4 dotted string into a 32-bit value, or null if invalid. */
function ipv4ToBigInt(ip: string): bigint | null {
  const parts = ip.split(".")
  if (parts.length !== 4) return null
  let result = 0n
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null
    const n = Number(part)
    if (n < 0 || n > 255) return null
    result = (result << 8n) | BigInt(n)
  }
  return result
}

/** Parses an IPv6 string (including `::` compression and embedded IPv4) into a 128-bit value. */
function ipv6ToBigInt(input: string): bigint | null {
  let ip = input.toLowerCase()
  if (ip.includes("%")) return null // reject zone identifiers

  // Fold an embedded IPv4 tail (e.g. ...:1.2.3.4) into two hex groups.
  const lastColon = ip.lastIndexOf(":")
  if (lastColon !== -1 && ip.slice(lastColon + 1).includes(".")) {
    const v4 = ipv4ToBigInt(ip.slice(lastColon + 1))
    if (v4 === null) return null
    ip = ip.slice(0, lastColon + 1) + ((v4 >> 16n) & 0xffffn).toString(16) + ":" + (v4 & 0xffffn).toString(16)
  }

  const halves = ip.split("::")
  if (halves.length > 2) return null
  const toGroups = (s: string): string[] => (s === "" ? [] : s.split(":"))

  let groups: string[]
  if (halves.length === 2) {
    const head = toGroups(halves[0])
    const tail = toGroups(halves[1])
    const missing = 8 - (head.length + tail.length)
    if (missing < 1) return null // `::` must compress at least one group
    groups = [...head, ...Array(missing).fill("0"), ...tail]
  } else {
    groups = toGroups(ip)
  }
  if (groups.length !== 8) return null

  let result = 0n
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null
    result = (result << 16n) | BigInt(parseInt(g, 16))
  }
  return result
}

/** Parses any IP string into its numeric value + family, or null if invalid. */
function parseIp(input: string): { value: bigint; family: IpFamily } | null {
  const ip = input.trim()
  if (!ip) return null
  const mapped = ip.toLowerCase().match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/)
  if (mapped) {
    const v4 = ipv4ToBigInt(mapped[1])
    return v4 === null ? null : { value: v4, family: 4 }
  }
  if (ip.includes(":")) {
    const v6 = ipv6ToBigInt(ip)
    return v6 === null ? null : { value: v6, family: 6 }
  }
  const v4 = ipv4ToBigInt(ip)
  return v4 === null ? null : { value: v4, family: 4 }
}

/** Parses a CIDR (or bare IP, treated as a full-length prefix) into value + prefix + family. */
function parseCidr(cidr: string): { value: bigint; prefix: number; family: IpFamily } | null {
  const [rangeIp, prefixStr, ...rest] = cidr.trim().split("/")
  if (rest.length > 0) return null
  const parsed = parseIp(rangeIp)
  if (!parsed) return null
  const maxPrefix = parsed.family === 4 ? 32 : 128
  let prefix = maxPrefix
  if (prefixStr !== undefined) {
    if (!/^\d{1,3}$/.test(prefixStr)) return null
    prefix = Number(prefixStr)
    if (prefix < 0 || prefix > maxPrefix) return null
  }
  return { value: parsed.value, prefix, family: parsed.family }
}

/**
 * Returns true when `ip` falls inside `cidr`. Handles IPv4 and IPv6; a bare IP
 * is treated as a full-length prefix (/32 or /128). Mismatched families never
 * match.
 */
export function ipMatchesCidr(ip: string, cidr: string): boolean {
  const addr = parseIp(ip)
  const range = parseCidr(cidr)
  if (!addr || !range || addr.family !== range.family) return false
  const bits = addr.family === 4 ? 32 : 128
  if (range.prefix === 0) return true
  const full = (1n << BigInt(bits)) - 1n
  const mask = (full << BigInt(bits - range.prefix)) & full
  return (addr.value & mask) === (range.value & mask)
}

function isValidCidr(cidr: string): boolean {
  return parseCidr(cidr) !== null
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
