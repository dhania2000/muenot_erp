import { beforeEach, describe, expect, it, vi } from "vitest"
import { approvalAllowed, matches, validateWorkflow, type Workflow } from "@/lib/workflows/model"
const mock = vi.hoisted(()=>({query:vi.fn(), sql:vi.fn(), webhook:vi.fn()}))
vi.mock("@/lib/db",()=>({query:mock.query,withTransaction:async(fn:any)=>fn({query:mock.sql})}))
vi.mock("@/lib/workflows/schema",()=>({ensureWorkflowSchema:async()=>{}}))
vi.mock("@/lib/workflows/webhook",()=>({deliverWebhook:mock.webhook}))
import { advanceWorkflow, decideWorkflow, startWorkflow, workflowOverview, runWorkflowWorker } from "@/lib/workflows/engine"
import { fingerprint } from "@/lib/job-idempotency"
const workflow = (actions:Workflow["actions"] = [{type:"update",field:"priority",value:"High"}]):Workflow=>({name:"Lead follow-up",module:"sales_leads",trigger:"manual",conditions:[],actions})
let run:any
beforeEach(()=>{
  vi.clearAllMocks()
  run={id:8,tenant_id:7,record_id:20,requested_by:2,cursor:0,status:"queued",snapshot:workflow()}
  mock.sql.mockImplementation(async(sql:string)=>{
    if(sql.includes("SELECT * FROM erp_workflow_runs")) return [[run]]
    if(sql.includes("available_at<=UTC_TIMESTAMP")) return [[{id:8}]]
    if(sql.includes("SELECT * FROM sales_leads")) return [[{id:20,tenant_id:7,priority:"Low",assigned_to:3}]]
    if(sql.includes("SELECT id FROM users")) return [[{id:4}]]
    return [[]]
  })
  mock.query.mockResolvedValue([])
})
describe("SPEC 46 workflow model",()=>{
  it("validates every supported action",()=>{
    const w=workflow([{type:"notify",userId:4,message:"Hello"},{type:"approval",userId:4,message:"Approve"},{type:"delay",seconds:60},{type:"schedule",at:"2030-01-01T00:00:00Z"},{type:"webhook",target:"crm"},{type:"assign",userId:4},{type:"create",title:"Follow up",description:"Call",userId:4}])
    expect(validateWorkflow(w)).toEqual(w)
  })
  it("rejects arbitrary modules and lifecycle/financial writes",()=>{
    expect(()=>validateWorkflow({...workflow(),module:"finance_expenses"})).toThrow()
    expect(()=>validateWorkflow(workflow([{type:"update",field:"status",value:"Won"} as any]))).toThrow()
    expect(()=>validateWorkflow(workflow([{type:"webhook",target:"https://localhost"}]))).toThrow()
  })
  it("bounds actions, conditions, delays and input sizes",()=>{
    expect(()=>validateWorkflow(workflow(Array(31).fill({type:"delay",seconds:1})))).toThrow()
    expect(()=>validateWorkflow(workflow([{type:"delay",seconds:0}]))).toThrow()
    expect(()=>validateWorkflow(workflow([{type:"delay",seconds:2592001}]))).toThrow()
    expect(()=>validateWorkflow({...workflow(),conditions:[{field:"password",op:"eq",value:"x"}]})).toThrow()
  })
  it("evaluates AND conditions deterministically",()=>{
    const w={...workflow(),conditions:[{field:"priority",op:"eq" as const,value:"High"},{field:"company_name",op:"contains" as const,value:"Acme"}]}
    expect(matches(w,{priority:"High",company_name:"Acme Ltd"})).toBe(true)
    expect(matches(w,{priority:"Low",company_name:"Acme Ltd"})).toBe(false)
    expect(matches(w,{})).toBe(false)
  })
  it("forbids self approval and non-designated approvers",()=>{
    expect(approvalAllowed(2,2,2)).toBe(false)
    expect(approvalAllowed(2,3,4)).toBe(false)
    expect(approvalAllowed(2,4,4)).toBe(true)
  })
})
describe("SPEC 46 durable execution protocol (mock DB)",()=>{
  it("locks a run and updates only its tenant's lead, preserving row version",async()=>{
    await advanceWorkflow(8)
    expect(mock.sql).toHaveBeenCalledWith(expect.stringContaining("FOR UPDATE"),[8])
    expect(mock.sql).toHaveBeenCalledWith(expect.stringContaining("UPDATE sales_leads SET priority=? ,row_version=row_version+1 WHERE tenant_id=? AND id=?"),["High",7,20])
    expect(mock.sql).toHaveBeenCalledWith(expect.stringContaining("cursor=cursor+1"),["queued",null,8])
  })
  it("does nothing for terminal runs",async()=>{
    run.status="completed"; await advanceWorkflow(8)
    expect(mock.sql).toHaveBeenCalledTimes(1)
  })
  it("does not execute a future run",async()=>{
    mock.sql.mockImplementation(async(sql:string)=>sql.includes("SELECT * FROM erp_workflow_runs")?[[run]]:[[]])
    await advanceWorkflow(8)
    expect(mock.sql.mock.calls.some(([sql])=>sql.includes("UPDATE" ) && !sql.startsWith("SELECT"))).toBe(false)
  })
  it("rolls back partial effects before marking action failed",async()=>{
    mock.sql.mockImplementation(async(sql:string)=>{
      if(sql.includes("SELECT id FROM users")) return [[{id:2}]]
      if(sql.includes("SELECT * FROM erp_workflow_runs")) return [[run]]
      if(sql.includes("available_at<=UTC_TIMESTAMP")) return [[{id:8}]]
      if(sql.includes("SELECT * FROM sales_leads")) return [[{id:20}]]
      if(sql.includes("UPDATE sales_leads")) throw new Error("DB rejected write")
      return [[]]
    })
    await advanceWorkflow(8)
    expect(mock.sql).toHaveBeenCalledWith(expect.stringContaining("UPDATE sales_leads"),["High",7,20])
    expect(mock.sql).toHaveBeenCalledWith("ROLLBACK TO SAVEPOINT workflow_action")
    expect(mock.sql).toHaveBeenCalledWith(expect.stringContaining("status='failed'"),[8])
    expect(mock.sql.mock.calls.some(([sql])=>sql.includes("cursor=cursor+1"))).toBe(false)
  })
  it("persists approval wait without advancing past it",async()=>{
    run.snapshot=workflow([{type:"approval",userId:4,message:"Check lead"}]);await advanceWorkflow(8)
    expect(mock.sql).toHaveBeenCalledWith("UPDATE erp_workflow_runs SET status='approval' WHERE id=?",[8])
    expect(mock.sql.mock.calls.some(([sql])=>sql.includes("cursor=cursor+1"))).toBe(false)
    expect(mock.sql.mock.calls.some(([sql])=>sql.includes("INSERT INTO notifications"))).toBe(true)
  })
  it("checks tenant and designated approver on decisions",async()=>{
    run.status="approval";run.snapshot=workflow([{type:"approval",userId:4,message:"Check"}])
    await expect(decideWorkflow(7,2,8,true)).rejects.toThrow("designated")
    await decideWorkflow(7,4,8,false)
    expect(mock.sql).toHaveBeenCalledWith(expect.stringContaining("WHERE tenant_id=? AND id=? FOR UPDATE"),[7,8])
    expect(mock.sql).toHaveBeenCalledWith(expect.stringContaining("cursor=cursor+1"),["rejected",7,8])
  })
  it("persists delay and next cursor together",async()=>{
    run.snapshot=workflow([{type:"delay",seconds:60}]);await advanceWorkflow(8)
    expect(mock.sql).toHaveBeenCalledWith(expect.stringContaining("cursor=cursor+1"),["waiting",expect.stringMatching(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/),8])
  })
  it("records intent before webhook and never retries ambiguous delivery",async()=>{
    run.snapshot=workflow([{type:"webhook",target:"crm"}])
    mock.webhook.mockRejectedValue(new Error("timeout"))
    const base=mock.sql.getMockImplementation()!
    mock.sql.mockImplementation(async(sql:string,...args:any[])=>{
      if(sql.includes("SET status='external'")) run.status="external"
      return base(sql,...args)
    })
    await advanceWorkflow(8)
    expect(mock.webhook).toHaveBeenCalledTimes(1)
    expect(mock.sql).toHaveBeenCalledWith(expect.stringContaining("cursor=cursor+?"),["failed",0,"webhook_delivery_uncertain",8])
    await advanceWorkflow(8);expect(mock.webhook).toHaveBeenCalledTimes(1)
  })
  it("replays the same request and rejects changed input",async()=>{
    const request_hash=fingerprint({recordId:20,actor:2,at:null})
    mock.sql.mockImplementation(async(sql:string)=>{
      if(sql.includes("SELECT id FROM users")) return [[{id:2}]]
      if(sql.includes("FROM erp_workflows")) return [[{enabled:1,definition:workflow()}]]
      if(sql.includes("request_key=?")) return [[{id:8,request_hash}]]
      return [[]]
    })
    expect(await startWorkflow(7,2,1,20,"request-key")).toBe(8)
    await expect(startWorkflow(7,2,1,21,"request-key")).rejects.toThrow("different input")
    expect(mock.sql.mock.calls.some(([sql])=>sql.startsWith("INSERT"))).toBe(false)
  })
  it("rejects foreign or missing source records",async()=>{
    mock.sql.mockImplementation(async(sql:string)=>sql.includes("SELECT id FROM users") ? [[{id:2}]] : sql.includes("FROM erp_workflows")?[[{enabled:1,definition:workflow()}]]:[[]])
    await expect(startWorkflow(7,2,1,20,"request-key")).rejects.toThrow("Record not found")
    expect(mock.sql).toHaveBeenCalledWith("SELECT id FROM sales_leads WHERE tenant_id=? AND id=?",[7,20])
  })
  it("scopes every console read and the personal notification inbox",async()=>{
    await workflowOverview(7,2)
    expect(mock.query.mock.calls.every(([sql,args])=>sql.includes("tenant_id=?") && args[0]===7)).toBe(true)
    expect(mock.query).toHaveBeenCalledWith(expect.stringContaining("user_id=?"),[7,2])
  })
  it("quarantines abandoned webhook dispatches and bounds worker batch size",async()=>{
    await runWorkflowWorker()
    expect(mock.query).toHaveBeenCalledWith(expect.stringContaining("webhook_delivery_uncertain"))
    expect(mock.query).toHaveBeenCalledWith(expect.stringContaining("LIMIT 20"))
  })
})
