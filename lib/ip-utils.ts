/**
 * Pure IP address / CIDR utilities shared by (IP allowlist) and
 * (access policies). Intentionally free of any server-only / DB
 * imports so it can be unit-tested directly and reused by the pure access
 * policy engine core as well as the server-only allowlist store.
 *
 * Supports BOTH IPv4 and IPv6. Every address is normalised to a
 * BigInt plus its family so a single mask/compare path works for both. An
 * IPv4-mapped IPv6 address (::ffff:a.b.c.d) is treated as its IPv4 form so a
 * range written in either notation matches consistently.
 */

export type IpFamily = 4 | 6

/** Parses an IPv4 dotted string into a 32-bit value, or null if invalid. */
export function ipv4ToBigInt(ip: string): bigint | null {
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
export function ipv6ToBigInt(input: string): bigint | null {
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
export function parseIp(input: string): { value: bigint; family: IpFamily } | null {
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
export function parseCidr(cidr: string): { value: bigint; prefix: number; family: IpFamily } | null {
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

/** Whether a string is a syntactically valid CIDR (or bare IP). */
export function isValidCidr(cidr: string): boolean {
  return parseCidr(cidr) !== null
}
