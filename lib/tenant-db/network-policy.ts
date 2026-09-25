import "server-only"
import { lookup } from "node:dns/promises"
import { BlockList, isIP } from "node:net"

/** The direct customer DB path is deny-by-default, including for super admins. */
export class TenantDbNetworkPolicyError extends Error {
  readonly code = "POLICY_BLOCKED"
  constructor() {
    super("Customer database endpoint is not approved by network policy.")
    this.name = "TenantDbNetworkPolicyError"
  }
}

const blocked = new BlockList()
for (const [subnet, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24],
  ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) blocked.addSubnet(subnet, prefix, "ipv4")
for (const [subnet, prefix] of [
  ["::", 128], ["::1", 128], ["64:ff9b::", 96], ["100::", 64],
  ["2001::", 32], ["2001:db8::", 32], ["2002::", 16],
  ["fc00::", 7], ["fe80::", 10], ["ff00::", 8],
] as const) blocked.addSubnet(subnet, prefix, "ipv6")
const globalIpv6 = new BlockList()
globalIpv6.addSubnet("2000::", 3, "ipv6")

function isPublicAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 4) return !blocked.check(address, "ipv4")
  if (family === 6) return globalIpv6.check(address, "ipv6") && !blocked.check(address, "ipv6")
  return false
}

type Address = { address: string; family: number }
export type DbHostResolver = (hostname: string) => Promise<Address[]>
const defaultResolver: DbHostResolver = (hostname) => lookup(hostname, { all: true, verbatim: true })

const DNS_LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/

/**
 * Validate a deployment-approved hostname and ALL DNS answers before opening
 * a socket. Return one address to pin for the pool's lifetime; TLS must still
 * verify the original hostname, not this address. Re-resolve on pool rotation.
 */
export async function resolveApprovedDbHost(input: {
  hostname: string
  port: number
  approvedHosts: readonly string[]
  resolver?: DbHostResolver
}): Promise<{ hostname: string; port: number; pinnedAddress: string }> {
  const hostname = input.hostname.trim().toLowerCase()
  const labels = hostname.split(".")
  if (
    hostname.length > 253 || labels.length < 2 || labels.some((label) => !DNS_LABEL.test(label)) ||
    isIP(hostname) !== 0 ||
    !Number.isInteger(input.port) || input.port < 1 || input.port > 65535 ||
    !input.approvedHosts.some((allowed) => allowed.toLowerCase() === hostname)
  ) throw new TenantDbNetworkPolicyError()

  const addresses = await (input.resolver ?? defaultResolver)(hostname)
  if (!addresses.length || addresses.some((entry) => entry.family !== isIP(entry.address) || !isPublicAddress(entry.address))) {
    throw new TenantDbNetworkPolicyError()
  }
  return { hostname, port: input.port, pinnedAddress: addresses[0].address }
}
