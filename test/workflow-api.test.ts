import { beforeEach, describe, expect, it, vi } from "vitest"
const mock=vi.hoisted(()=>({guard:vi.fn(),start:vi.fn(),save:vi.fn(),decide:vi.fn(),cancel:vi.fn(),overview:vi.fn(),worker:vi.fn()}))
vi.mock("@/lib/platform-guard",()=>({requireTenantAdmin:mock.guard,effectiveTenantId:()=>7}))
vi.mock("@/lib/workflows/engine",()=>({WorkflowError:class extends Error{status=400},startWorkflow:mock.start,saveWorkflow:mock.save,decideWorkflow:mock.decide,cancelWorkflow:mock.cancel,workflowOverview:mock.overview,runWorkflowWorker:mock.worker}))
import { GET, POST } from "@/app/api/admin/workflows/route"
import { GET as worker } from "@/app/api/cron/workflows/route"
const request=(body:unknown,origin="https://erp.example")=>new Request("https://erp.example/api/admin/workflows",{method:"POST",headers:{origin,"content-type":"application/json"},body:JSON.stringify(body)})
beforeEach(()=>{
  vi.clearAllMocks();vi.stubEnv("APP_URL","https://erp.example")
  mock.guard.mockResolvedValue({ok:true,ctx:{},session:{userId:2}})
  mock.start.mockResolvedValue(8)
})
describe("workflow HTTP authorization",()=>{
  it("denies non-admin requests before touching data",async()=>{
    mock.guard.mockResolvedValue({ok:false,status:403,reason:"Forbidden"})
    expect((await GET()).status).toBe(403)
    expect((await POST(request({operation:"create"}))).status).toBe(403)
    expect(mock.overview).not.toHaveBeenCalled();expect(mock.save).not.toHaveBeenCalled()
  })
  it("ignores client-provided tenant and actor IDs",async()=>{
    const r=await POST(request({operation:"start",tenantId:99,actorId:99,workflowId:1,recordId:20,requestKey:"request-key"}))
    expect(r.status).toBe(200)
    expect(mock.start).toHaveBeenCalledWith(7,2,1,20,"request-key",undefined)
  })
  it("rejects cross-origin writes",async()=>{
    expect((await POST(request({operation:"create"},"https://attacker.example"))).status).toBe(403)
    expect(mock.save).not.toHaveBeenCalled()
  })
  it("validates approval input and strips database diagnostics",async()=>{
    expect((await POST(request({operation:"decide",runId:8,approve:"yes"}))).status).toBe(400)
    expect(mock.decide).not.toHaveBeenCalled()
    mock.start.mockRejectedValue(Object.assign(new Error("SQL includes sensitive input"),{code:"ER_BAD_FIELD_ERROR"}))
    const r=await POST(request({operation:"start",workflowId:1,recordId:20,requestKey:"request-key"}))
    expect(JSON.stringify(await r.json())).not.toContain("sensitive")
  })
  it("requires the cron secret even outside production",async()=>{
    vi.stubEnv("CRON_SECRET","")
    expect((await worker(new Request("https://erp.example/api/cron/workflows"))).status).toBe(401)
    vi.stubEnv("CRON_SECRET","test-only-secret")
    expect((await worker(new Request("https://erp.example/api/cron/workflows",{headers:{authorization:"Bearer wrong"}}))).status).toBe(401)
    expect(mock.worker).not.toHaveBeenCalled()
  })
})
