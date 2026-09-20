import "server-only"
import { lookup } from "node:dns/promises"
import { BlockList, isIPv4 } from "node:net"
import { request } from "node:https"
// Deployment-managed, tenant-specific destinations only. Never accept a URL from a workflow.
const blocked = new BlockList()
for (const [address, prefix] of [["0.0.0.0",8],["10.0.0.0",8],["100.64.0.0",10],["127.0.0.0",8],["169.254.0.0",16],["172.16.0.0",12],["192.0.0.0",24],["192.0.2.0",24],["192.168.0.0",16],["198.18.0.0",15],["198.51.100.0",24],["203.0.113.0",24],["224.0.0.0",4],["240.0.0.0",4]] as const) blocked.addSubnet(address, prefix)
export function publicAddress(address: string) { return isIPv4(address) && !blocked.check(address) }
export async function deliverWebhook(tenant: number, target: string, runId: number, step: number, recordId: number) {
  const config = JSON.parse(process.env.WORKFLOW_WEBHOOK_TARGETS || "{}")
  const endpoint = config[String(tenant)]?.[target]
  if (typeof endpoint !== "string") throw new Error("Destination not configured")
  const url = new URL(endpoint)
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) throw new Error("HTTPS public destination required")
  const addresses = await lookup(url.hostname, { family: 4, all: true })
  if (!addresses.length || addresses.some(a => !publicAddress(a.address))) throw new Error("Destination is not public")
  // Pin the checked IP at connect time to prevent DNS rebinding. No redirects.
  await new Promise<void>((resolve, reject) => {
    const body = JSON.stringify({ tenantId: tenant, runId, step, recordId })
    const req = request(url, { method: "POST", family: 4, lookup: (_host, _opts, cb) => cb(null, addresses[0].address, 4), headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body), "idempotency-key": `workflow:${tenant}:${runId}:${step}` } }, res => {
      res.destroy()
      if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) resolve()
      else reject(new Error("Destination did not acknowledge delivery"))
    })
    const deadline = setTimeout(() => req.destroy(new Error("Webhook timeout")), 10000)
    req.on("close", () => clearTimeout(deadline))
    req.on("error", reject)
    req.end(body)
  })
}
