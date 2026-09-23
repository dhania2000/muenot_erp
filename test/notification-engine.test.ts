import { beforeEach, describe, expect, it, vi } from "vitest"
const mock=vi.hoisted(()=>({sql:vi.fn(),query:vi.fn(),provider:vi.fn(),lookup:vi.fn()}))
vi.mock("@/lib/db",()=>({query:mock.query,withTransaction:async(fn:any)=>fn({query:mock.sql})}))
vi.mock("@/lib/notification-engine/schema",()=>({ensureNotificationEngineSchema:async()=>{}}))
vi.mock("@/lib/notification-engine/providers",()=>({providerFor:mock.lookup}))
import { enqueueNotification, processNotification, retryNotification, savePreference, notificationOverview } from "@/lib/notification-engine/service"
import { CHANNELS, defaultEnabled, escapeHtml, renderTemplate, validateNotice } from "@/lib/notification-engine/model"
import { fingerprint } from "@/lib/job-idempotency"
const notice={tenantId:7,userId:5,channel:"in_app" as const,key:"test:1",title:"Hello",body:"World"}
let d:any,member:boolean,pref:any,due:boolean
beforeEach(()=>{
  vi.clearAllMocks()
  d={id:8,tenant_id:7,user_id:5,channel:"in_app",title:"Hello",body:"World",link:null,status:"queued",attempts:0}
  member=true;pref=undefined;due=true
  mock.lookup.mockReturnValue(mock.provider)
  mock.provider.mockResolvedValue({providerId:"receipt-1"})
  mock.query.mockResolvedValue([])
  mock.sql.mockImplementation(async(sql:string,args:any[]=[])=>{
    if(sql.startsWith("SELECT * FROM notification_deliveries"))return [[d]]
    if(sql.includes("available_at<=UTC_TIMESTAMP"))return [due?[{id:8}]:[]]
    if(sql.includes("FROM users"))return [member?[{id:5,email:"test@example.invalid"}]:[]]
    if(sql.includes("FROM notification_preferences"))return [pref?[pref]:[]]
    if(sql.includes("SELECT id,request_hash"))return [[{id:8,request_hash:fingerprint({userId:5,title:"Hello",body:"World",link:null,priority:5,at:null,context:null})}]]
    if(sql.startsWith("INSERT INTO notifications"))return [{insertId:99}]
    if(sql.includes("SET status='sending'")){d={...d,status:"sending",attempts:args[0],lease:args[1]}}
    if(sql.includes("SET status='delivered'")){d={...d,status:"delivered"}}
    if(sql.includes("SET status=?,error_code")){d={...d,status:args[0]}}
    return [[]]
  })
})
describe("SPEC 49 contracts",()=>{
  it("defaults in-app and mobile push notifications to enabled",()=>expect(CHANNELS.filter(defaultEnabled)).toEqual(["in_app","push"]))
  it("renders literal variables, not expressions",()=>{
    expect(renderTemplate("Hello {{ name }}",{name:"<script>"})).toBe("Hello <script>")
    expect(()=>renderTemplate("{{name}}",Object.create({name:"inherited"}))).toThrow()
    expect(()=>renderTemplate("{{name}}",{})).toThrow()
    expect(escapeHtml("<b>&")).toBe("&lt;b&gt;&amp;")
  })
  it.each([{tenantId:0},{userId:0},{channel:"http"},{key:""},{priority:9},{at:"tomorrow"},{link:"//evil.test"},{link:"/\\evil.test"}])("rejects invalid input %j",change=>{
    expect(()=>validateNotice({...notice,...change} as any)).toThrow()
  })
  it("accepts internal links and UTC schedules",()=>expect(()=>validateNotice({...notice,link:"/dashboard",at:"2027-01-01T10:00:00Z",priority:10})).not.toThrow())
})
describe("SPEC 49 transaction protocol (mock database)",()=>{
  it("enqueues using caller transaction and tenant-scoped recipient and identity",async()=>{
    expect(await enqueueNotification({query:mock.sql} as any,notice)).toBe(8)
    expect(mock.sql).toHaveBeenCalledWith(expect.stringContaining("tenant_id=? AND id=? AND status='active'"),[7,5])
    expect(mock.sql).toHaveBeenCalledWith(expect.stringContaining("tenant_id=? AND channel=? AND request_key=? FOR UPDATE"),[7,"in_app","test:1"])
    expect(mock.query).not.toHaveBeenCalled()
  })
  it("rejects identity reuse with changed content",async()=>{
    await expect(enqueueNotification({query:mock.sql} as any,{...notice,body:"changed"})).rejects.toThrow("different content")
  })
  it("rejects a recipient outside this tenant",async()=>{
    member=false
    await expect(enqueueNotification({query:mock.sql} as any,notice)).rejects.toThrow("active member")
    expect(mock.sql.mock.calls.some(([s])=>s.startsWith("INSERT"))).toBe(false)
  })
  it("atomically writes bell and delivery receipt, retaining source metadata",async()=>{
    d.source_context={actorId:2,actorName:"Agent",moduleKey:"sales.leads",action:"update",entityTable:"leads",entityId:"12"}
    await processNotification(8)
    expect(mock.sql).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO notifications"),[5,2,"Agent","sales.leads",null,"update","Hello","World",null,"leads","12"])
    expect(d.status).toBe("delivered")
    await processNotification(8)
    expect(mock.sql.mock.calls.filter(([s])=>s.startsWith("INSERT INTO notifications"))).toHaveLength(1)
    expect(mock.provider).not.toHaveBeenCalled()
  })
  it.each(["uncertain","accepted","failed","sending"])("never auto-replays %s",async status=>{
    d.status=status;await processNotification(8);expect(mock.sql).toHaveBeenCalledTimes(1)
  })
  it("does not deliver a future schedule",async()=>{due=false;await processNotification(8);expect(mock.provider).not.toHaveBeenCalled();expect(mock.sql.mock.calls.some(([s])=>s.startsWith("INSERT"))).toBe(false)})
  it.each(["removed","optout","external-default"])("fails closed for %s",async kind=>{
    if(kind==="removed")member=false
    if(kind==="optout")pref={enabled:0}
    if(kind==="external-default")d.channel="email"
    await processNotification(8)
    expect(mock.sql).toHaveBeenCalledWith(expect.stringContaining("status='skipped'"),[8])
    expect(mock.provider).not.toHaveBeenCalled()
  })
  it("records external acceptance, not confirmed delivery",async()=>{
    d.channel="email";pref={enabled:1,destination:"ignored@example.invalid"}
    await processNotification(8)
    expect(mock.provider).toHaveBeenCalledWith(expect.objectContaining({tenantId:7,userId:5,destination:"test@example.invalid",idempotencyKey:"notification:7:8"}))
    expect(d.status).toBe("accepted")
  })
  it("blocks an unconfigured provider without pretending success",async()=>{
    d.channel="sms";pref={enabled:1,destination:"+919876543210"};mock.lookup.mockReturnValue(undefined)
    await processNotification(8)
    expect(mock.sql).toHaveBeenCalledWith(expect.stringContaining("status='blocked'"),[1,8])
    expect(mock.provider).not.toHaveBeenCalled()
  })
  it.each([
    [{code:"ECONNREFUSED"},0,"queued"],
    [{code:"ECONNREFUSED"},4,"failed"],
    [{code:"ETIMEDOUT"},0,"uncertain"],
    [{code:"EAUTH"},0,"failed"],
    [{code:"PROVIDER_UNCONFIGURED"},0,"blocked"],
  ])("classifies %j at attempt %s as %s",async(error,attempts,status)=>{
    d.channel="email";d.attempts=attempts;pref={enabled:1};mock.provider.mockRejectedValue(error)
    await processNotification(8);expect(d.status).toBe(status)
  })
  it("does not overwrite another worker lease",async()=>{
    d.channel="email";pref={enabled:1};mock.provider.mockImplementation(async()=>{d.lease="different";return {}})
    await processNotification(8)
    expect(mock.sql.mock.calls.some(([s])=>s.includes("SET status=?,error_code"))).toBe(false)
  })
  it("limits manual retry to tenant, safe state and expected attempt",async()=>{
    d.status="uncertain";await expect(retryNotification(7,2,8,0)).rejects.toThrow("not safe")
    d.status="failed";await expect(retryNotification(7,2,8,9)).rejects.toThrow("not safe")
    await retryNotification(7,2,8,0)
    expect(mock.sql).toHaveBeenCalledWith(expect.stringContaining("tenant_id=? AND id=? FOR UPDATE"),[7,8])
    expect(mock.sql).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO notification_delivery_log"),[7,8,0,"manual_retry",2])
  })
  it("uses profile email and validates phone preferences",async()=>{
    await savePreference(7,5,"email",true,"arbitrary@example.invalid")
    expect(mock.query).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO notification_preferences"),[7,5,"email",1,null])
    await expect(savePreference(7,5,"sms",true,"123")).rejects.toThrow("international")
  })
  it("scopes all monitoring queries to the tenant",async()=>{
    await notificationOverview(7)
    expect(mock.query).toHaveBeenCalledTimes(3)
    for(const [sql,args] of mock.query.mock.calls){expect(sql).toContain("WHERE tenant_id=?");expect(args).toEqual([7])}
  })
})
