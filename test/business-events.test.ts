import { beforeEach, describe, expect, it, vi } from "vitest"
const mock=vi.hoisted(()=>({sql:vi.fn(),query:vi.fn(),notice:vi.fn()}))
vi.mock("@/lib/notification-engine/service",()=>({enqueueNotification:mock.notice}))
vi.mock("@/lib/notification-engine/schema",()=>({ensureNotificationEngineSchema:async()=>{}}))
vi.mock("@/lib/db",()=>({query:mock.query,withTransaction:async(fn:any)=>fn({query:mock.sql})}))
vi.mock("@/lib/events/schema",()=>({ensureEventSchema:async()=>{}}))
vi.mock("@/lib/workflows/schema",()=>({ensureWorkflowSchema:async()=>{}}))
vi.mock("@/lib/notifications",()=>({ensureNotificationsSchema:async()=>{}}))
import { deliverEvent, eventOverview, publishEvent, retryDelivery, subscribe } from "@/lib/events/bus"
import { EVENT_CATALOG, retryState, validateEvent, validateSubscription } from "@/lib/events/model"
import { fingerprint } from "@/lib/job-idempotency"
const event={tenantId:7,type:"deal.won" as const,entityId:20,key:"lead:20:won:2",actorId:2}
let delivery:any
beforeEach(()=>{
  vi.clearAllMocks()
  mock.notice.mockResolvedValue(99)
  delivery={id:8,tenant_id:7,event_id:10,subscriber_id:4,attempts:0,status:"queued",config:{handler:"notice",userId:5,actorId:2}}
  mock.query.mockResolvedValue([])
  mock.sql.mockImplementation(async(sql:string)=>{
    if(sql.includes("SELECT * FROM erp_event_deliveries")) return [[delivery]]
    if(sql.includes("available_at<=UTC_TIMESTAMP")) return [[{id:8}]]
    if(sql.includes("SELECT * FROM erp_business_events")) return [[{id:10,event_type:"deal.won",entity_id:20}]]
    if(sql.includes("SELECT id FROM users")) return [[{id:2}]]
    if(sql.includes("SELECT id,request_hash")) return [[{id:10,request_hash:fingerprint({type:"deal.won",entityId:20})}]]
    if(sql.includes("SELECT fanout_complete")) return [[{fanout_complete:0}]]
    if(sql.includes("FROM erp_event_subscriptions")) return [[{id:4,created_by:2,config:delivery.config}]]
    if(sql.startsWith("INSERT INTO notifications")) return [{insertId:99}]
    return [[]]
  })
})
describe("SPEC 48 event contracts",()=>{
  it("inventories all nine event families with honest publisher status",()=>{
    expect(Object.keys(EVENT_CATALOG)).toHaveLength(9)
    expect(EVENT_CATALOG["deal.won"].publisher).toBe("active")
    expect(EVENT_CATALOG["invoice.created"].publisher).toBe("planned")
  })
  it("rejects invalid tenant, identity and unknown types",()=>{
    expect(()=>validateEvent({...event,tenantId:0})).toThrow()
    expect(()=>validateEvent({...event,type:"__proto__" as any})).toThrow()
    expect(()=>validateEvent({...event,key:""})).toThrow()
    expect(()=>validateEvent(event)).not.toThrow()
  })
  it("does not expose unconnected publishers or arbitrary handlers",()=>{
    expect(()=>validateSubscription({name:"x",eventType:"invoice.created",handler:"notice",userId:2})).toThrow()
    expect(()=>validateSubscription({name:"x",eventType:"file.uploaded",handler:"workflow",workflowId:2})).toThrow()
    expect(()=>validateSubscription({name:"x",eventType:"deal.won",handler:"shell",userId:2})).toThrow()
  })
  it("bounds automatic retries to five attempts",()=>{
    expect(retryState(1)).toEqual({status:"queued",seconds:30})
    expect(retryState(5).status).toBe("failed")
    expect(retryState(6).status).toBe("failed")
  })
})
describe("SPEC 48 outbox and delivery transaction protocol (mock DB)",()=>{
  it("publishes and snapshots subscriber deliveries on the supplied connection",async()=>{
    expect(await publishEvent({query:mock.sql} as any,event)).toBe(10)
    expect(mock.query).not.toHaveBeenCalled()
    expect(mock.sql).toHaveBeenCalledWith(expect.stringContaining("WHERE tenant_id=? AND event_type=? AND event_key=? FOR UPDATE"),[7,"deal.won","lead:20:won:2"])
    expect(mock.sql).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO erp_event_deliveries"),[7,10,4,expect.any(String)])
    expect(mock.sql).toHaveBeenCalledWith("UPDATE erp_business_events SET fanout_complete=1 WHERE id=?",[10])
  })
  it("duplicate publications do not fan out to new subscribers",async()=>{
    const base=mock.sql.getMockImplementation()!
    mock.sql.mockImplementation((sql:string,...args:any[])=>sql.includes("SELECT fanout_complete")?[[{fanout_complete:1}]]:base(sql,...args))
    await publishEvent({query:mock.sql} as any,event)
    expect(mock.sql.mock.calls.some(([sql])=>sql.startsWith("INSERT INTO erp_event_deliveries"))).toBe(false)
  })
  it("rejects a reused event key pointing at a different record",async()=>{
    await expect(publishEvent({query:mock.sql} as any,{...event,entityId:21})).rejects.toThrow("different input")
  })
  it("locks delivery and commits notice effect with delivery completion",async()=>{
    await deliverEvent(8)
    expect(mock.sql).toHaveBeenCalledWith("SELECT * FROM erp_event_deliveries WHERE id=? FOR UPDATE",[8])
    expect(mock.sql).toHaveBeenCalledWith(expect.stringContaining("status='delivered'"),[1,99,8])
    expect(mock.notice).toHaveBeenCalledWith(expect.anything(),expect.objectContaining({tenantId:7,userId:5,key:"event-delivery:8"}))
    expect(mock.sql).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO erp_event_delivery_log"),[7,8,"delivered",1,null])
  })
  it("never redelivers completed rows",async()=>{
    delivery.status="delivered";await deliverEvent(8)
    expect(mock.sql).toHaveBeenCalledTimes(1)
  })
  it("enqueues a workflow and its event history atomically without executing it",async()=>{
    delivery.config={handler:"workflow",actorId:2,workflowId:6,definition:{name:"Won follow-up",description:"",module:"sales_leads",trigger:"manual",conditions:[],actions:[{type:"delay",seconds:60}]}}
    const base=mock.sql.getMockImplementation()!
    mock.sql.mockImplementation((sql:string,...args:any[])=>{
      if(sql.includes("SELECT id FROM sales_leads") || sql.includes("SELECT id FROM erp_workflows")) return [[{id:20}]]
      if(sql.startsWith("INSERT INTO erp_workflow_runs"))return [{insertId:42}]
      return base(sql,...args)
    })
    await deliverEvent(8)
    expect(mock.sql).toHaveBeenCalledWith("SELECT id FROM sales_leads WHERE tenant_id=? AND id=?",[7,20])
    expect(mock.sql).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO erp_workflow_runs"),[7,6,expect.any(String),20,"event-10-subscriber-4",expect.any(String),2])
    expect(mock.sql).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO erp_workflow_events"),[7,42,2])
    expect(mock.sql).toHaveBeenCalledWith(expect.stringContaining("status='delivered'"),[1,42,8])
  })
  it("does not run a disabled or foreign workflow",async()=>{
    delivery.config={handler:"workflow",actorId:2,workflowId:6,definition:{name:"Won follow-up",description:"",module:"sales_leads",trigger:"manual",conditions:[],actions:[{type:"delay",seconds:60}]}}
    await deliverEvent(8)
    expect(mock.sql.mock.calls.some(([sql])=>sql.startsWith("INSERT INTO erp_workflow_runs"))).toBe(false)
    expect(mock.sql).toHaveBeenCalledWith("ROLLBACK TO SAVEPOINT event_effect")
  })
  it("rolls back subscriber effects before scheduling a retry",async()=>{
    const base=mock.sql.getMockImplementation()!
    mock.sql.mockImplementation((sql:string,...args:any[])=>{if(sql.includes("status='delivered'"))throw new Error("commit-state write failed");return base(sql,...args)})
    await deliverEvent(8)
    expect(mock.sql).toHaveBeenCalledWith("ROLLBACK TO SAVEPOINT event_effect")
    expect(mock.sql).toHaveBeenCalledWith(expect.stringContaining("error_code='subscriber_failed'"),["queued",1,30,8])
  })
  it("blocks foreign recipients and revoked subscriber owners",async()=>{
    mock.sql.mockImplementation(async(sql:string)=>{
      if(sql.includes("SELECT * FROM erp_event_deliveries"))return [[delivery]]
      if(sql.includes("available_at<=UTC_TIMESTAMP"))return [[{id:8}]]
      if(sql.includes("SELECT * FROM erp_business_events"))return [[{id:10,event_type:"deal.won",entity_id:20}]]
      return [[]]
    })
    await deliverEvent(8)
    expect(mock.sql.mock.calls.some(([sql])=>sql.startsWith("INSERT INTO notifications"))).toBe(false)
    expect(mock.sql).toHaveBeenCalledWith(expect.stringContaining("SELECT id FROM users WHERE tenant_id=?"),[7,2])
  })
  it("retries failed delivery once without erasing attempts and rejects stale requests",async()=>{
    delivery.status="failed";delivery.attempts=5
    await retryDelivery(7,2,8,5)
    expect(mock.sql).toHaveBeenCalledWith(expect.stringContaining("SET status='queued',available_at"),[7,8])
    expect(mock.sql).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO erp_event_delivery_log"),[7,8,"manual_retry",5,2])
    await expect(retryDelivery(7,2,8,4)).rejects.toThrow("changed")
  })
  it("scopes every monitoring query to the tenant",async()=>{
    await eventOverview(7)
    expect(mock.query.mock.calls.every(([sql,args])=>sql.includes("tenant_id") && args[0]===7)).toBe(true)
  })
  it("checks subscriber targets at save time",async()=>{
    const base=mock.sql.getMockImplementation()!
    mock.sql.mockImplementation((sql:string,args:any[])=>sql.includes("SELECT id FROM users")&&args[1]===999?[[]]:base(sql,args))
    await expect(subscribe(7,2,{name:"test",eventType:"deal.won",handler:"notice",userId:999})).rejects.toThrow("member")
  })
})
