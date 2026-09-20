import "server-only"
import type { PoolConnection } from "mysql2/promise"
import { query, withTransaction } from "@/lib/db"
import { fingerprint } from "@/lib/job-idempotency"
import { ensureNotificationsSchema } from "@/lib/notifications"
import { ensureWorkflowSchema } from "@/lib/workflows/schema"
import { validateWorkflow } from "@/lib/workflows/model"
import { ensureEventSchema } from "./schema"
import { EVENT_CATALOG, retryState, validateEvent, validateSubscription, type BusinessEvent } from "./model"
const parse=(v:any)=>typeof v==="string"?JSON.parse(v):v
async function rows(c:PoolConnection,sql:string,args:unknown[]=[]):Promise<any[]> {const [r]=await c.query(sql,args);return r as any[]}
async function member(c:PoolConnection,tenant:number,id:number,admin=false) {
  const r=await rows(c,`SELECT id FROM users WHERE tenant_id=? AND id=? AND status='active' ${admin?"AND tenant_role IN ('tenant_admin','tenant_owner')":""}`,[tenant,id])
  if(!r.length) throw new Error("Active tenant member required")
}

// Called ONLY inside the business transaction, after schema preparation outside
// that transaction. Fan-out and source mutation commit/rollback together.
export async function publishEvent(c:PoolConnection,e:BusinessEvent):Promise<number> {
  validateEvent(e)
  const hash=fingerprint({type:e.type,entityId:e.entityId}) // actor can differ on an idempotent repeat
  await c.query("INSERT INTO erp_business_events (tenant_id,event_type,entity_id,event_key,request_hash,actor_id) VALUES (?,?,?,?,?,?) ON DUPLICATE KEY UPDATE id=LAST_INSERT_ID(id)",[e.tenantId,e.type,e.entityId,e.key,hash,e.actorId])
  const [event]=await rows(c,"SELECT id,request_hash FROM erp_business_events WHERE tenant_id=? AND event_type=? AND event_key=? FOR UPDATE",[e.tenantId,e.type,e.key])
  if(event.request_hash!==hash) throw new Error("Event key reused with different input")
  // Snapshot subscribers at first publication. A duplicate does not backfill
  // subscribers added later, including when the original event had zero listeners.
  const [marker]=await rows(c,"SELECT fanout_complete FROM erp_business_events WHERE id=?",[event.id])
  if(!Number(marker.fanout_complete)) {
    const subscribers=await rows(c,"SELECT id,config,created_by FROM erp_event_subscriptions WHERE tenant_id=? AND event_type=? AND enabled=1",[e.tenantId,e.type])
    for(const s of subscribers) await c.query("INSERT INTO erp_event_deliveries (tenant_id,event_id,subscriber_id,config,available_at) VALUES (?,?,?,?,UTC_TIMESTAMP())",[e.tenantId,event.id,s.id,JSON.stringify({...parse(s.config),actorId:Number(s.created_by)})])
    await c.query("UPDATE erp_business_events SET fanout_complete=1 WHERE id=?",[event.id])
  }
  return Number(event.id)
}

export async function subscribe(tenant:number,actor:number,input:unknown) {
  const s=validateSubscription(input)
  await ensureEventSchema()
  if(s.handler==="workflow") await ensureWorkflowSchema()
  return withTransaction(async c=>{
    await member(c,tenant,actor,true)
    let config:any=s
    if(s.handler==="notice") await member(c,tenant,s.userId!)
    else {
      const [row]=await rows(c,"SELECT id,definition FROM erp_workflows WHERE tenant_id=? AND id=? AND enabled=1",[tenant,s.workflowId])
      if(!row) throw new Error("Workflow unavailable")
      const saved=parse(row.definition)
      const w=validateWorkflow({...saved,description:saved.description??""})
      if(w.module!=="sales_leads" || w.trigger!=="manual") throw new Error("Select a manual Sales lead workflow")
      config={...s,definition:w}
    }
    const [result]=await c.query<any>("INSERT INTO erp_event_subscriptions (tenant_id,name,event_type,config,created_by) VALUES (?,?,?,?,?)",[tenant,s.name,s.eventType,JSON.stringify(config),actor])
    return Number(result.insertId)
  })
}
export async function setSubscriptionEnabled(tenant:number,actor:number,id:number,enabled:boolean) {
  await ensureEventSchema()
  return withTransaction(async c=>{
    await member(c,tenant,actor,true)
    const [result]=await c.query<any>("UPDATE erp_event_subscriptions SET enabled=? WHERE tenant_id=? AND id=?",[enabled?1:0,tenant,id])
    if(!result.affectedRows) throw new Error("Subscriber not found")
  })
}
async function log(c:PoolConnection,d:any,action:string,actor:number|null=null) {await c.query("INSERT INTO erp_event_delivery_log (tenant_id,delivery_id,action,attempt,actor_id) VALUES (?,?,?,?,?)",[d.tenant_id,d.id,action,d.attempts,actor])}

export async function deliverEvent(id:number) {
  return withTransaction(async c=>{
    const [d]=await rows(c,"SELECT * FROM erp_event_deliveries WHERE id=? FOR UPDATE",[id])
    if(!d || d.status!=="queued") return
    const [due]=await rows(c,"SELECT id FROM erp_event_deliveries WHERE id=? AND available_at<=UTC_TIMESTAMP()",[id])
    if(!due) return
    d.attempts=Number(d.attempts)+1
    await c.query("SAVEPOINT event_effect")
    try {
      const [event]=await rows(c,"SELECT * FROM erp_business_events WHERE tenant_id=? AND id=?",[d.tenant_id,d.event_id])
      if(!event) throw new Error("Missing event")
      const s=parse(d.config)
      await member(c,Number(d.tenant_id),s.actorId,true)
      let resultId:number
      if(s.handler==="notice") {
        await member(c,Number(d.tenant_id),s.userId)
        const [r]=await c.query<any>("INSERT INTO notifications (user_id,module_key,action,title,body,link,entity_table,entity_id) VALUES (?,'events','create',?,?,'/dashboard','erp_business_events',?)",[s.userId,`Business event: ${event.event_type}`,`Record #${event.entity_id}`,String(event.id)])
        resultId=Number(r.insertId)
      } else if(s.handler==="workflow" && event.event_type==="deal.won") {
        const w=validateWorkflow(s.definition)
        if(w.module!=="sales_leads" || w.trigger!=="manual") throw new Error("Invalid workflow subscriber")
        const [lead]=await rows(c,"SELECT id FROM sales_leads WHERE tenant_id=? AND id=?",[d.tenant_id,event.entity_id])
        const [active]=await rows(c,"SELECT id FROM erp_workflows WHERE tenant_id=? AND id=? AND enabled=1",[d.tenant_id,s.workflowId])
        if(!lead || !active) throw new Error("Workflow or source no longer available")
        const key=`event-${event.id}-subscriber-${d.subscriber_id}`
        const [r]=await c.query<any>("INSERT INTO erp_workflow_runs (tenant_id,workflow_id,snapshot,record_id,request_key,request_hash,requested_by,available_at) VALUES (?,?,?,?,?,?,?,UTC_TIMESTAMP())",[d.tenant_id,s.workflowId,JSON.stringify(w),event.entity_id,key,fingerprint({eventId:event.id,subscriberId:d.subscriber_id}),s.actorId])
        resultId=Number(r.insertId)
        await c.query("INSERT INTO erp_workflow_events (tenant_id,run_id,step,event_type,actor_id) VALUES (?,?,0,'business_event',?)",[d.tenant_id,resultId,s.actorId])
      } else throw new Error("Unsupported subscriber")
      await c.query("UPDATE erp_event_deliveries SET status='delivered',attempts=?,result_id=?,error_code=NULL,completed_at=UTC_TIMESTAMP() WHERE id=?",[d.attempts,resultId,id])
      await log(c,d,"delivered")
    } catch {
      await c.query("ROLLBACK TO SAVEPOINT event_effect")
      const retry=retryState(d.attempts)
      await c.query("UPDATE erp_event_deliveries SET status=?,attempts=?,error_code='subscriber_failed',available_at=DATE_ADD(UTC_TIMESTAMP(),INTERVAL ? SECOND) WHERE id=?",[retry.status,d.attempts,retry.seconds,id])
      await log(c,d,retry.status==="failed"?"failed":"retry_scheduled")
    }
  })
}
export async function runEventWorker() {
  await ensureEventSchema();await ensureNotificationsSchema();await ensureWorkflowSchema()
  const due=await query<{id:number}[]>("SELECT id FROM erp_event_deliveries WHERE status='queued' AND available_at<=UTC_TIMESTAMP() ORDER BY available_at,id LIMIT 30")
  for(const d of due) await deliverEvent(Number(d.id))
  return {processed:due.length}
}
export async function retryDelivery(tenant:number,actor:number,id:number,attempt:number) {
  await ensureEventSchema()
  return withTransaction(async c=>{
    await member(c,tenant,actor,true)
    const [d]=await rows(c,"SELECT * FROM erp_event_deliveries WHERE tenant_id=? AND id=? FOR UPDATE",[tenant,id])
    if(!d || d.status!=="failed" || Number(d.attempts)!==attempt) throw new Error("Delivery changed; refresh before retrying")
    await c.query("UPDATE erp_event_deliveries SET status='queued',available_at=UTC_TIMESTAMP(),error_code=NULL WHERE tenant_id=? AND id=?",[tenant,id])
    await log(c,d,"manual_retry",actor)
  })
}
export async function eventOverview(tenant:number) {
  await ensureEventSchema()
  const [events,subscriptions,deliveries,history]=await Promise.all([
    query("SELECT e.id,e.event_type,e.entity_id,e.actor_id,e.created_at,COUNT(d.id) AS subscribers,SUM(d.status='failed') AS failed,SUM(d.status='queued') AS pending FROM erp_business_events e LEFT JOIN erp_event_deliveries d ON d.event_id=e.id AND d.tenant_id=e.tenant_id WHERE e.tenant_id=? GROUP BY e.id ORDER BY e.id DESC LIMIT 100",[tenant]),
    query("SELECT id,name,event_type,enabled,created_at FROM erp_event_subscriptions WHERE tenant_id=? ORDER BY id DESC LIMIT 100",[tenant]),
    query("SELECT id,event_id,subscriber_id,status,attempts,result_id,error_code,available_at FROM erp_event_deliveries WHERE tenant_id=? ORDER BY id DESC LIMIT 200",[tenant]),
    query("SELECT delivery_id,action,attempt,actor_id,created_at FROM erp_event_delivery_log WHERE tenant_id=? ORDER BY id DESC LIMIT 100",[tenant]),
  ])
  return {catalog:EVENT_CATALOG,events,subscriptions,deliveries,history}
}
export async function eventSummary(tenant:number) {
  await ensureEventSchema()
  const [events,failures]=await Promise.all([
    query<{n:number}[]>("SELECT COUNT(*) AS n FROM erp_business_events WHERE tenant_id=? AND created_at>=CURRENT_TIMESTAMP()-INTERVAL 1 DAY",[tenant]),
    query<{n:number}[]>("SELECT COUNT(*) AS n FROM erp_event_deliveries WHERE tenant_id=? AND status='failed'",[tenant]),
  ])
  return {recent:Number(events[0]?.n??0),failed:Number(failures[0]?.n??0)}
}
