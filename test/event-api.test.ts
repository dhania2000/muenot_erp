import { beforeEach, describe, expect, it, vi } from "vitest"
const mock=vi.hoisted(()=>({guard:vi.fn(),overview:vi.fn(),subscribe:vi.fn(),retry:vi.fn(),toggle:vi.fn(),worker:vi.fn()}))
vi.mock("@/lib/platform-guard",()=>({requireTenantAdmin:mock.guard,effectiveTenantId:()=>7}))
vi.mock("@/lib/events/bus",()=>({eventOverview:mock.overview,subscribe:mock.subscribe,retryDelivery:mock.retry,setSubscriptionEnabled:mock.toggle,runEventWorker:mock.worker}))
import { GET, POST } from "@/app/api/admin/event-bus/route"
import { GET as worker } from "@/app/api/cron/business-events/route"
const request=(body:unknown,origin="https://erp.example")=>new Request("https://erp.example/api/admin/event-bus",{method:"POST",headers:{origin},body:JSON.stringify(body)})
beforeEach(()=>{vi.clearAllMocks();vi.stubEnv("APP_URL","https://erp.example");mock.guard.mockResolvedValue({ok:true,ctx:{},session:{userId:2}});mock.subscribe.mockResolvedValue(10)})
describe("business-event API boundary",()=>{
  it("denies non-admin reads and writes",async()=>{
    mock.guard.mockResolvedValue({ok:false,status:403,reason:"Forbidden"})
    expect((await GET()).status).toBe(403)
    expect((await POST(request({operation:"subscribe"}))).status).toBe(403)
    expect(mock.overview).not.toHaveBeenCalled();expect(mock.subscribe).not.toHaveBeenCalled()
  })
  it("uses session tenant and actor rather than client IDs",async()=>{
    const subscription={name:"Notice",eventType:"deal.won",handler:"notice",userId:4}
    expect((await POST(request({operation:"subscribe",tenantId:99,actorId:99,subscription}))).status).toBe(201)
    expect(mock.subscribe).toHaveBeenCalledWith(7,2,subscription)
  })
  it("rejects cross-origin requests and client event publication",async()=>{
    expect((await POST(request({operation:"subscribe"},"https://attacker.example"))).status).toBe(403)
    expect((await POST(request({operation:"publish",id:1,eventType:"deal.won"}))).status).toBe(400)
  })
  it("does not leak database errors",async()=>{
    mock.subscribe.mockRejectedValue(Object.assign(new Error("private SQL"),{code:"ER_BAD_FIELD_ERROR"}))
    const response=await POST(request({operation:"subscribe",subscription:{}}))
    expect(JSON.stringify(await response.json())).not.toContain("private")
  })
  it("requires cron authentication even in development",async()=>{
    vi.stubEnv("CRON_SECRET","")
    expect((await worker(new Request("https://erp.example/api/cron/business-events"))).status).toBe(401)
    expect(mock.worker).not.toHaveBeenCalled()
  })
})
