import "server-only"
import { randomUUID } from "node:crypto"
import type { PoolConnection } from "mysql2/promise"
import { query, withTransaction } from "@/lib/db"
import { fingerprint } from "@/lib/job-idempotency"
import { classifyJobFailure } from "@/lib/job-retry-policy"
import { CHANNELS, defaultEnabled, defaultFrequency, FREQUENCIES, PRIORITIES, renderTemplate, resolveDelivery, validateNotice, type Channel, type Frequency, type Notice } from "./model"
import { ensureNotificationEngineSchema } from "./schema"
import { providerFor } from "./providers"
async function rows(c:PoolConnection,sql:string,args:unknown[]=[]):Promise<any[]>{const [r]=await c.query(sql,args);return r as any[]}
async function log(c:PoolConnection,d:any,status:string,actor:number|null=null){await c.query("INSERT INTO notification_delivery_log (tenant_id,delivery_id,attempt,status,actor_id) VALUES (?,?,?,?,?)",[d.tenant_id,d.id,d.attempts,status,actor])}
// Caller owns transaction; schema must be prepared before starting it.
export async function enqueueNotification(c:PoolConnection,n:Notice):Promise<number> {
  validateNotice(n)
  const [user]=await rows(c,"SELECT id FROM users WHERE tenant_id=? AND id=? AND status='active'",[n.tenantId,n.userId])
  if(!user)throw new Error("Recipient is not an active member of this tenant")
  const hash=fingerprint({userId:n.userId,title:n.title,body:n.body,link:n.link??null,priority:n.priority??5,at:n.at??null,context:n.context??null})
  await c.query("INSERT INTO notification_deliveries (tenant_id,user_id,channel,request_key,request_hash,title,body,link,priority,mandatory,available_at,source_context) VALUES (?,?,?,?,?,?,?,?,?,?,COALESCE(?,UTC_TIMESTAMP()),?) ON DUPLICATE KEY UPDATE id=LAST_INSERT_ID(id)",[n.tenantId,n.userId,n.channel,n.key,hash,n.title,n.body,n.link??null,n.priority??5,n.mandatory?1:0,n.at?new Date(n.at).toISOString().slice(0,19).replace("T"," "):null,n.context?JSON.stringify(n.context):null])
  const [d]=await rows(c,"SELECT id,request_hash FROM notification_deliveries WHERE tenant_id=? AND channel=? AND request_key=? FOR UPDATE",[n.tenantId,n.channel,n.key])
  if(d.request_hash!==hash)throw new Error("Notification key already used with different content")
  return Number(d.id)
}
export async function savePreference(tenant:number,user:number,channel:Channel,enabled:boolean,destination:string|null,options?:{minPriority?:number;frequency?:Frequency}) {
  if(!CHANNELS.includes(channel)||typeof enabled!=="boolean")throw new Error("Invalid preference")
  if(destination && (destination.length>512||(["sms","whatsapp"].includes(channel)&&!/^\+[1-9]\d{7,14}$/.test(destination))))throw new Error("Phone must be in international +country format")
  if(channel==="in_app"||channel==="email")destination=null // email always resolved from owned user profile
  await ensureNotificationEngineSchema()
  // Cadence/priority filters only apply to opt-in notices; mandatory security
  // notices bypass them entirely (see resolveDelivery). When the caller supplies
  // either filter we upsert all four columns, otherwise we preserve the legacy
  // channel-only upsert so existing callers keep their stored cadence.
  if(options && (options.minPriority!==undefined||options.frequency!==undefined)) {
    const minPriority=options.minPriority??0
    const frequency=options.frequency??defaultFrequency(channel)
    if(!PRIORITIES.includes(minPriority as any))throw new Error("Priority must be 0, 5 or 10")
    if(!FREQUENCIES.includes(frequency))throw new Error("Invalid frequency")
    await query("INSERT INTO notification_preferences (tenant_id,user_id,channel,enabled,destination,min_priority,frequency) VALUES (?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE enabled=VALUES(enabled),destination=VALUES(destination),min_priority=VALUES(min_priority),frequency=VALUES(frequency)",[tenant,user,channel,enabled?1:0,destination,minPriority,frequency])
    return
  }
  await query("INSERT INTO notification_preferences (tenant_id,user_id,channel,enabled,destination) VALUES (?,?,?,?,?) ON DUPLICATE KEY UPDATE enabled=VALUES(enabled),destination=VALUES(destination)",[tenant,user,channel,enabled?1:0,destination])
}
export async function ownPreferences(tenant:number,user:number) {
  await ensureNotificationEngineSchema()
  const list=await query<any[]>("SELECT channel,enabled,destination,min_priority,frequency FROM notification_preferences WHERE tenant_id=? AND user_id=?",[tenant,user])
  return CHANNELS.map(channel=>{const row=list.find(r=>r.channel===channel);return {channel,enabled:row?!!row.enabled:defaultEnabled(channel),destination:row?.destination??"",minPriority:row?Number(row.min_priority):0,frequency:(row?.frequency as Frequency)??defaultFrequency(channel)}})
}
// Per-module (app group) opt-out. Module preferences never override a mandatory
// notice; they only silence ordinary activity notices for that module group.
export async function saveModulePreference(tenant:number,user:number,moduleKey:string,enabled:boolean) {
  if(typeof moduleKey!=="string"||!moduleKey.trim()||moduleKey.length>80||typeof enabled!=="boolean")throw new Error("Invalid module preference")
  await ensureNotificationEngineSchema()
  await query("INSERT INTO notification_module_prefs (tenant_id,user_id,module_key,enabled) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE enabled=VALUES(enabled)",[tenant,user,moduleKey,enabled?1:0])
}
export async function ownModulePreferences(tenant:number,user:number) {
  await ensureNotificationEngineSchema()
  const list=await query<any[]>("SELECT module_key,enabled FROM notification_module_prefs WHERE tenant_id=? AND user_id=?",[tenant,user])
  return list.map(r=>({moduleKey:r.module_key,enabled:!!r.enabled}))
}
export async function saveTemplate(tenant:number,actor:number,name:string,title:string,body:string) {
  if(typeof name!=="string"||!name.trim()||name.length>120)throw new Error("Invalid template name")
  validateNotice({tenantId:tenant,userId:actor,channel:"in_app",key:"template",title,body})
  await ensureNotificationEngineSchema()
  const result=await query<any>("INSERT INTO notification_templates (tenant_id,name,title,body,created_by) VALUES (?,?,?,?,?)",[tenant,name,title,body,actor])
  return Number(result.insertId)
}
export async function sendTemplate(tenant:number,input:{templateId:number;userId:number;channel:Channel;key:string;variables:Record<string,string>;priority?:number;at?:string}) {
  await ensureNotificationEngineSchema()
  const [t]=await query<any[]>("SELECT title,body FROM notification_templates WHERE tenant_id=? AND id=?",[tenant,input.templateId])
  if(!t)throw new Error("Template not found")
  const title=renderTemplate(t.title,input.variables??{}),body=renderTemplate(t.body,input.variables??{})
  return withTransaction(c=>enqueueNotification(c,{tenantId:tenant,userId:input.userId,channel:input.channel,key:input.key,title,body,priority:input.priority,at:input.at}))
}
export async function processNotification(id:number) {
  const external=await withTransaction(async c=>{
    const [d]=await rows(c,"SELECT * FROM notification_deliveries WHERE id=? FOR UPDATE",[id])
    if(!d||d.status!=="queued")return null
    const [due]=await rows(c,"SELECT id FROM notification_deliveries WHERE id=? AND available_at<=UTC_TIMESTAMP()",[id])
    if(!due)return null
    const [user]=await rows(c,"SELECT id,email FROM users WHERE tenant_id=? AND id=? AND status='active'",[d.tenant_id,d.user_id])
    if(!user) {
      await c.query("UPDATE notification_deliveries SET status='skipped',error_code='recipient_or_preference' WHERE id=?",[id]);await log(c,d,"skipped");return null
    }
    const context=typeof d.source_context==="string"?JSON.parse(d.source_context):d.source_context??{}
    const moduleKey=typeof context.moduleKey==="string"?context.moduleKey:null
    // Module opt-outs are stored per app group (e.g. "hr", "sales"); resolve the
    // group from the notice's groupSlug, falling back to the module key prefix.
    const groupKey=(typeof context.groupSlug==="string"&&context.groupSlug)?context.groupSlug:(moduleKey?moduleKey.split(".")[0]:null)
    const [pref]=await rows(c,"SELECT enabled,destination,min_priority,frequency FROM notification_preferences WHERE tenant_id=? AND user_id=? AND channel=?",[d.tenant_id,d.user_id,d.channel])
    const [modPref]=groupKey?await rows(c,"SELECT enabled FROM notification_module_prefs WHERE tenant_id=? AND user_id=? AND module_key=?",[d.tenant_id,d.user_id,groupKey]):[undefined]
    const decision=resolveDelivery({
      mandatory:!!d.mandatory,
      priority:Number(d.priority),
      channelEnabled:pref?!!pref.enabled:defaultEnabled(d.channel),
      moduleEnabled:modPref?!!modPref.enabled:true,
      minPriority:pref?Number(pref.min_priority):0,
      frequency:(pref?.frequency as Frequency)??defaultFrequency(d.channel),
      createdAt:new Date(d.created_at),
      now:new Date(),
    })
    if(decision.action==="skip") {
      await c.query("UPDATE notification_deliveries SET status='skipped',error_code=? WHERE id=?",[decision.reason.slice(0,80),id]);await log(c,d,"skipped");return null
    }
    if(decision.action==="defer") {
      await c.query("UPDATE notification_deliveries SET available_at=? WHERE id=?",[decision.at.toISOString().slice(0,19).replace("T"," "),id]);await log(c,d,"deferred");return null
    }
    d.attempts=Number(d.attempts)+1
    if(d.channel==="in_app") {
      const [r]=await c.query<any>("INSERT INTO notifications (user_id,actor_id,actor_name,module_key,group_slug,action,title,body,link,entity_table,entity_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)",[d.user_id,context.actorId??null,context.actorName?.slice(0,150)??null,context.moduleKey?.slice(0,80)??"notifications",context.groupSlug?.slice(0,40)??null,context.action?.slice(0,20)??"create",d.title,d.body.slice(0,500),d.link,context.entityTable?.slice(0,80)??"notification_deliveries",context.entityId?.slice(0,40)??String(id)])
      await c.query("UPDATE notification_deliveries SET status='delivered',attempts=?,result_id=? WHERE id=?",[d.attempts,String(r.insertId),id]);await log(c,d,"delivered");return null
    }
    const destination=d.channel==="email"?user.email:d.channel==="push"?`user:${d.user_id}`:pref?.destination
    if(!providerFor(d.channel)||!destination) {
      await c.query("UPDATE notification_deliveries SET status='blocked',attempts=?,error_code='provider_or_destination_missing' WHERE id=?",[d.attempts,id]);await log(c,d,"blocked");return null
    }
    const lease=randomUUID()
    await c.query("UPDATE notification_deliveries SET status='sending',attempts=?,lease=?,started_at=UTC_TIMESTAMP() WHERE id=?",[d.attempts,lease,id]);await log(c,d,"sending")
    return {...d,lease,destination}
  })
  if(!external)return
  let status="accepted",errorCode:string|null=null,result:string|null=null
  const abort=new AbortController()
  let timer:ReturnType<typeof setTimeout>|undefined
  try {
    const resultData=await Promise.race([
      providerFor(external.channel as Channel)!({tenantId:Number(external.tenant_id),userId:Number(external.user_id),destination:external.destination,title:external.title,body:external.body,idempotencyKey:`notification:${external.tenant_id}:${id}`,signal:abort.signal,link:external.link,context:typeof external.source_context==="string"?JSON.parse(external.source_context):external.source_context??{}}),
      new Promise<never>((_,reject)=>{timer=setTimeout(()=>{abort.abort();reject(Object.assign(new Error("Timeout"),{code:"ETIMEDOUT"}))},20000)}),
    ])
    result=resultData.providerId?.slice(0,191)??null
    if(resultData.skipped)status="skipped"
  } catch(e) {
    const missing=e && typeof e==="object" && "code" in e && e.code==="PROVIDER_UNCONFIGURED"
    const kind=classifyJobFailure(e)
    status=missing?"blocked":kind==="transient"&&external.attempts<5?"queued":kind==="uncertain"?"uncertain":"failed"
    errorCode=missing?"provider_unconfigured":kind
  } finally {if(timer)clearTimeout(timer)}
  await withTransaction(async c=>{
    const [d]=await rows(c,"SELECT * FROM notification_deliveries WHERE id=? FOR UPDATE",[id])
    if(d?.status!=="sending"||d.lease!==external.lease)return
    await c.query("UPDATE notification_deliveries SET status=?,error_code=?,result_id=?,available_at=DATE_ADD(UTC_TIMESTAMP(),INTERVAL ? SECOND) WHERE id=?",[status,errorCode,result,Math.min(3600,30*2**(external.attempts-1)),id])
    await log(c,d,status)
  })
}
export async function runNotificationWorker() {
  await ensureNotificationEngineSchema()
  await query("UPDATE notification_deliveries SET status='uncertain',error_code='worker_interrupted' WHERE status='sending' AND started_at<UTC_TIMESTAMP()-INTERVAL 5 MINUTE")
  const due=await query<{id:number}[]>("SELECT id FROM notification_deliveries WHERE status='queued' AND available_at<=UTC_TIMESTAMP() ORDER BY priority DESC,available_at,id LIMIT 5")
  let failed=0
  for(const d of due)try{await processNotification(Number(d.id))}catch{failed++}
  return {processed:due.length,failed}
}
export async function retryNotification(tenant:number,actor:number,id:number,attempt:number) {
  await ensureNotificationEngineSchema()
  return withTransaction(async c=>{
    const [d]=await rows(c,"SELECT * FROM notification_deliveries WHERE tenant_id=? AND id=? FOR UPDATE",[tenant,id])
    if(!d||!["failed","blocked"].includes(d.status)||Number(d.attempts)!==attempt)throw new Error("Delivery changed or is not safe to retry")
    await c.query("UPDATE notification_deliveries SET status='queued',available_at=UTC_TIMESTAMP(),error_code=NULL WHERE tenant_id=? AND id=?",[tenant,id]);await log(c,d,"manual_retry",actor)
  })
}
export async function notificationOverview(tenant:number) {
  await ensureNotificationEngineSchema()
  const [templates,deliveries,history]=await Promise.all([
    query("SELECT id,name,title,body FROM notification_templates WHERE tenant_id=? ORDER BY id DESC LIMIT 100",[tenant]),
    query("SELECT id,user_id,channel,priority,status,attempts,error_code,result_id,available_at,created_at FROM notification_deliveries WHERE tenant_id=? ORDER BY id DESC LIMIT 200",[tenant]),
    query("SELECT delivery_id,attempt,status,actor_id,created_at FROM notification_delivery_log WHERE tenant_id=? ORDER BY id DESC LIMIT 200",[tenant]),
  ])
  return {templates,deliveries,history}
}
