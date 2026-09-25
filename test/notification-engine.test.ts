import { beforeEach, describe, expect, it, vi } from "vitest"
const mock=vi.hoisted(()=>({sql:vi.fn(),query:vi.fn(),provider:vi.fn(),lookup:vi.fn(),meter:vi.fn()}))
vi.mock("@/lib/db",()=>({query:mock.query,withTransaction:async(fn:any)=>fn({query:mock.sql})}))
vi.mock("@/lib/notification-engine/schema",()=>({ensureNotificationEngineSchema:async()=>{}}))
vi.mock("@/lib/notification-engine/providers",()=>({providerFor:mock.lookup}))
vi.mock("@/lib/billing/usage-guard",()=>({meterUsage:mock.meter}))
import { enqueueNotification, processNotification, retryNotification, savePreference, saveModulePreference, ownModulePreferences, notificationOverview } from "@/lib/notification-engine/service"
import { CHANNELS, defaultEnabled, escapeHtml, renderTemplate, validateNotice, resolveDelivery, nextDigestSlot } from "@/lib/notification-engine/model"
import { fingerprint } from "@/lib/job-idempotency"
const notice={tenantId:7,userId:5,channel:"in_app" as const,key:"test:1",title:"Hello",body:"World"}
let d:any,member:boolean,pref:any,modPref:any,due:boolean
beforeEach(()=>{
  vi.clearAllMocks()
  d={id:8,tenant_id:7,user_id:5,channel:"in_app",title:"Hello",body:"World",link:null,status:"queued",attempts:0}
  member=true;pref=undefined;modPref=undefined;due=true
  mock.lookup.mockReturnValue(mock.provider)
  mock.provider.mockResolvedValue({providerId:"receipt-1"})
  mock.query.mockResolvedValue([])
  mock.sql.mockImplementation(async(sql:string,args:any[]=[])=>{
    if(sql.startsWith("SELECT * FROM notification_deliveries"))return [[d]]
    if(sql.includes("available_at<=UTC_TIMESTAMP"))return [due?[{id:8}]:[]]
    if(sql.includes("FROM users"))return [member?[{id:5,email:"test@example.invalid"}]:[]]
    if(sql.includes("FROM notification_module_prefs"))return [modPref?[modPref]:[]]
    if(sql.includes("FROM notification_preferences"))return [pref?[pref]:[]]
    if(sql.includes("SELECT id,request_hash"))return [[{id:8,request_hash:fingerprint({userId:5,title:"Hello",body:"World",link:null,priority:5,at:null,context:null})}]]
    if(sql.startsWith("INSERT INTO notifications"))return [{insertId:99}]
    if(sql.includes("SET status='sending'")){d={...d,status:"sending",attempts:args[0],lease:args[1]}}
    if(sql.includes("SET status='delivered'")){d={...d,status:"delivered"}}
    if(sql.includes("SET status=?,error_code")){d={...d,status:args[0]}}
    return [[]]
  })
})
describe(" contracts",()=>{
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
describe(" transaction protocol (mock database)",()=>{
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
    expect(mock.sql).toHaveBeenCalledWith(expect.stringContaining("status='skipped'"),expect.arrayContaining([8]))
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
    expect(mock.meter).not.toHaveBeenCalled()
  })
  it("meters an accepted SMS send exactly once, scoped and idempotent",async()=>{
    d.channel="sms";pref={enabled:1,destination:"+919876543210"}
    mock.provider.mockResolvedValue({providerId:"sms-1"})
    await processNotification(8)
    expect(d.status).toBe("accepted")
    expect(mock.meter).toHaveBeenCalledTimes(1)
    expect(mock.meter.mock.calls[0][0]).toMatchObject({meterKey:"sms_messages",quantity:1,tenantId:7,idempotencyKey:"notif:7:sms:8"})
  })
  it("meters an accepted WhatsApp send under the whatsapp meter",async()=>{
    d.channel="whatsapp";pref={enabled:1,destination:"+919876543210"}
    mock.provider.mockResolvedValue({providerId:"wa-1"})
    await processNotification(8)
    expect(mock.meter).toHaveBeenCalledTimes(1)
    expect(mock.meter.mock.calls[0][0]).toMatchObject({meterKey:"whatsapp_messages",tenantId:7,idempotencyKey:"notif:7:whatsapp:8"})
  })
  it("does not meter in-app or email sends as billable communications",async()=>{
    d.channel="email";pref={enabled:1,destination:"ignored@example.invalid"}
    await processNotification(8)
    expect(mock.meter).not.toHaveBeenCalled()
  })
  it("does not meter a provider-skipped SMS send",async()=>{
    d.channel="sms";pref={enabled:1,destination:"+919876543210"}
    mock.provider.mockResolvedValue({skipped:true})
    await processNotification(8)
    expect(mock.meter).not.toHaveBeenCalled()
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
  it("persists frequency and priority when supplied, and validates them",async()=>{
    await savePreference(7,5,"email",true,null,{minPriority:10,frequency:"daily"})
    expect(mock.query).toHaveBeenCalledWith(expect.stringContaining("min_priority,frequency"),[7,5,"email",1,null,10,"daily"])
    await expect(savePreference(7,5,"email",true,null,{minPriority:3 as any})).rejects.toThrow("Priority")
    await expect(savePreference(7,5,"email",true,null,{frequency:"weekly" as any})).rejects.toThrow("frequency")
  })
  it("upserts and validates module preferences",async()=>{
    await saveModulePreference(7,5,"sales",false)
    expect(mock.query).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO notification_module_prefs"),[7,5,"sales",0])
    await expect(saveModulePreference(7,5,"",true)).rejects.toThrow("Invalid module preference")
    mock.query.mockResolvedValueOnce([{module_key:"sales",enabled:0}])
    expect(await ownModulePreferences(7,5)).toEqual([{moduleKey:"sales",enabled:false}])
  })
  it("silences an opt-in notice for a muted module group",async()=>{
    d.source_context={moduleKey:"sales.leads"};modPref={enabled:0}
    await processNotification(8)
    expect(mock.sql).toHaveBeenCalledWith(expect.stringContaining("status='skipped'"),expect.arrayContaining(["module_muted",8]))
    expect(mock.sql.mock.calls.some(([s])=>s.startsWith("INSERT INTO notifications"))).toBe(false)
  })
  it("delivers a mandatory notice even when the module group is muted",async()=>{
    d.mandatory=1;d.source_context={moduleKey:"sales.leads"};modPref={enabled:0}
    await processNotification(8)
    expect(mock.sql).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO notifications"),expect.anything())
    expect(d.status).toBe("delivered")
  })
  it("scopes all monitoring queries to the tenant",async()=>{
    await notificationOverview(7)
    expect(mock.query).toHaveBeenCalledTimes(3)
    for(const [sql,args] of mock.query.mock.calls){expect(sql).toContain("WHERE tenant_id=?");expect(args).toEqual([7])}
  })
})
describe(" delivery decision engine",()=>{
  const base={mandatory:false,priority:5,channelEnabled:true,moduleEnabled:true,minPriority:0,frequency:"immediate" as const,createdAt:new Date("2027-01-01T00:00:00Z"),now:new Date("2027-01-01T00:00:00Z")}
  it("always delivers mandatory notices regardless of every opt-out",()=>{
    for(const override of [{channelEnabled:false},{moduleEnabled:false},{minPriority:10,priority:0},{frequency:"off" as const}])
      expect(resolveDelivery({...base,mandatory:true,...override}).action).toBe("deliver")
  })
  it("delivers an ordinary notice when no filter blocks it",()=>expect(resolveDelivery(base).action).toBe("deliver"))
  it("skips when the channel is disabled",()=>expect(resolveDelivery({...base,channelEnabled:false})).toEqual({action:"skip",reason:"channel_disabled"}))
  it("skips when the module group is muted",()=>expect(resolveDelivery({...base,moduleEnabled:false})).toEqual({action:"skip",reason:"module_muted"}))
  it("skips a notice below the chosen minimum priority",()=>expect(resolveDelivery({...base,priority:5,minPriority:10})).toEqual({action:"skip",reason:"below_priority"}))
  it("skips when the channel frequency is off",()=>expect(resolveDelivery({...base,frequency:"off"})).toEqual({action:"skip",reason:"frequency_off"}))
  it("defers a daily-digest notice to the next digest slot, then delivers",()=>{
    const created=new Date("2027-01-01T09:00:00Z")
    const deferred=resolveDelivery({...base,frequency:"daily",createdAt:created,now:created})
    expect(deferred.action).toBe("defer")
    if(deferred.action==="defer")expect(deferred.at.getTime()).toBe(nextDigestSlot(created).getTime())
    expect(resolveDelivery({...base,frequency:"daily",createdAt:created,now:nextDigestSlot(created)}).action).toBe("deliver")
  })
})
