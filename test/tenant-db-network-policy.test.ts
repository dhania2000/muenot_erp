import { describe, expect, it } from "vitest"
import { resolveApprovedDbHost, TenantDbNetworkPolicyError } from "@/lib/tenant-db/network-policy"

const approvedHosts = ["db.customer.example.com"]
const resolve = (address: string, family: number) => async () => [{ address, family }]

describe("direct customer database network policy", () => {
  it("requires an exact deployment-approved DNS name", async () => {
    await expect(resolveApprovedDbHost({
      hostname: "other.example.com", port: 3306, approvedHosts,
      resolver: resolve("8.8.8.8", 4),
    })).rejects.toThrow(TenantDbNetworkPolicyError)
    await expect(resolveApprovedDbHost({
      hostname: "127.0.0.1", port: 3306, approvedHosts: ["127.0.0.1"],
      resolver: resolve("127.0.0.1", 4),
    })).rejects.toThrow(TenantDbNetworkPolicyError)
  })

  it.each(["127.0.0.1", "10.0.0.1", "169.254.169.254", "192.168.1.2", "::1", "fc00::1", "fe80::1", "::ffff:127.0.0.1"])(
    "rejects a private or special DNS answer %s",
    async (address) => {
      await expect(resolveApprovedDbHost({
        hostname: approvedHosts[0], port: 3306, approvedHosts,
        resolver: resolve(address, address.includes(":") ? 6 : 4),
      })).rejects.toThrow(TenantDbNetworkPolicyError)
    },
  )

  it("rejects mixed public/private DNS answers to prevent rebinding", async () => {
    await expect(resolveApprovedDbHost({
      hostname: approvedHosts[0], port: 3306, approvedHosts,
      resolver: async () => [
        { address: "8.8.8.8", family: 4 }, { address: "10.0.0.9", family: 4 },
      ],
    })).rejects.toThrow(TenantDbNetworkPolicyError)
  })

  it("returns a pinned public address while retaining the TLS hostname", async () => {
    expect(await resolveApprovedDbHost({
      hostname: "DB.Customer.Example.Com", port: 3306, approvedHosts,
      resolver: resolve("8.8.8.8", 4),
    })).toEqual({ hostname: approvedHosts[0], port: 3306, pinnedAddress: "8.8.8.8" })
  })
})
