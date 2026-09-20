import { beforeEach, describe, expect, it, vi } from "vitest"
const mock=vi.hoisted(()=>({guard:vi.fn(),overview:vi.fn(),template:vi.fn(),send:vi.fn(),retry:vi.fn(),preferences:vi.fn(),save:vi.fn(),worker:vi.fn()}))
vi.mock("@/lib/platform-guard",()=>({requireTenantAdmin:mock.guard,requireTenantRole:mock.guard,effectiveTenantId:()=>7}))
vi.mock("@/lib/notification-engine/service",()=>({notificationOverview:mock.overview,saveTemplate:mock.template,sendTemplate:mock.send,retryNotification:mock.retry,ownPreferences:mock.preferences,savePreference:mock.save,runNotificationWorker:mock.worker}))
import { GET, POST } from "@/app/api/admin/notification-engine/route"
import { GET as preferences, POST as save } from "@/app/api/notification-preferences/route"
import { GET as worker } from "@/app/api/cron/notification-delivery/route"
const request=(body:unknown,origin="https://erp.example")=>new Request("https://erp.example/api/admin/notification-engine",{method:"POST",headers:{origin},body:JSON.stringify(body)})
beforeEach(()=>{vi.clearAllMocks();vi.stubEnv("APP_URL","https://erp.example");mock.guard.mockResolvedValue({ok:true,ctx:{},session:{userId:2}});mock.template.mockResolvedValue(10)})
describe("SPEC 49 API boundaries",()=>{
  it("denies unauthenticated reads and writes",async()=>{
    mock.guard.mockResolvedValue({ok:false,status:403,reason:"Forbidden"})
    for(const response of [await GET(),await POST(request({})),await preferences(),await save(request({}))])expect(response.status).toBe(403)
    expect(mock.overview).not.toHaveBeenCalled();expect(mock.save).not.toHaveBeenCalled()
  })
  it("uses session tenant and actor for templates",async()=>{
    expect((await POST(request({operation:"template",tenantId:99,actorId:99,name:"Greeting",title:"Hello",body:"World"}))).status).toBe(201)
    expect(mock.template).toHaveBeenCalledWith(7,2,"Greeting","Hello","World")
  })
  it("preferences cannot target another tenant or user",async()=>{
    expect((await save(request({tenantId:99,userId:99,channel:"email",enabled:true}))).status).toBe(200)
    expect(mock.save).toHaveBeenCalledWith(7,2,"email",true,null)
    await preferences();expect(mock.preferences).toHaveBeenCalledWith(7,2)
  })
  it("rejects cross-origin mutations and unsupported operations",async()=>{
    expect((await POST(request({operation:"template"},"https://attacker.example"))).status).toBe(403)
    expect((await save(request({},"https://attacker.example"))).status).toBe(403)
    expect((await POST(request({operation:"registerProvider",url:"https://attacker.example"}))).status).toBe(400)
  })
  it("does not expose database details",async()=>{
    mock.template.mockRejectedValue(Object.assign(new Error("private SQL"),{code:"ER_BAD_FIELD_ERROR"}))
    expect(JSON.stringify(await (await POST(request({operation:"template"}))).json())).not.toContain("private")
  })
  it("rejects oversized admin payloads",async()=>{
    expect((await POST(request({body:"x".repeat(33000)}))).status).toBe(413)
    expect(mock.send).not.toHaveBeenCalled()
  })
  it("requires configured cron authentication",async()=>{
    vi.stubEnv("CRON_SECRET","")
    expect((await worker(new Request("https://erp.example/api/cron/notification-delivery"))).status).toBe(401)
    vi.stubEnv("CRON_SECRET","test-only-secret")
    expect((await worker(new Request("https://erp.example/api/cron/notification-delivery",{headers:{authorization:"Bearer wrong"}}))).status).toBe(401)
    expect(mock.worker).not.toHaveBeenCalled()
    mock.worker.mockResolvedValue({processed:0,failed:0})
    expect((await worker(new Request("https://erp.example/api/cron/notification-delivery",{headers:{authorization:"Bearer test-only-secret"}}))).status).toBe(200)
  })
})
