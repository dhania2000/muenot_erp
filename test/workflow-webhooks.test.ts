import { beforeEach, describe, expect, it, vi } from "vitest"
const mock=vi.hoisted(()=>({lookup:vi.fn(),request:vi.fn()}))
vi.mock("node:dns/promises",()=>({lookup:mock.lookup}))
vi.mock("node:https",()=>({request:mock.request}))
import { deliverWebhook, publicAddress } from "@/lib/workflows/webhook"
beforeEach(()=>{vi.clearAllMocks();vi.stubEnv("WORKFLOW_WEBHOOK_TARGETS",JSON.stringify({7:{crm:"https://example.com/hook"}}))})
describe("workflow webhook egress",()=>{
  it.each(["127.0.0.1","10.1.2.3","172.16.1.1","192.168.1.1","169.254.169.254","100.64.0.1","0.0.0.0","224.0.0.1","::1","::ffff:127.0.0.1","999.1.1.1"])("rejects non-public address %s",address=>{expect(publicAddress(address)).toBe(false)})
  it("accepts public IPv4",()=>{expect(publicAddress("8.8.8.8")).toBe(true)})
  it("rejects targets not configured for the execution tenant",async()=>{
    await expect(deliverWebhook(8,"crm",1,0,2)).rejects.toThrow("not configured")
    expect(mock.lookup).not.toHaveBeenCalled()
  })
  it("rejects DNS responses containing private destinations before connecting",async()=>{
    mock.lookup.mockResolvedValue([{address:"8.8.8.8",family:4},{address:"127.0.0.1",family:4}])
    await expect(deliverWebhook(7,"crm",1,0,2)).rejects.toThrow("not public")
    expect(mock.request).not.toHaveBeenCalled()
  })
  it("rejects insecure URLs",async()=>{
    vi.stubEnv("WORKFLOW_WEBHOOK_TARGETS",JSON.stringify({7:{crm:"http://example.com/hook"}}))
    await expect(deliverWebhook(7,"crm",1,0,2)).rejects.toThrow("HTTPS")
  })
})
