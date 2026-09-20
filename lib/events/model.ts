export const EVENT_CATALOG = {
  "employee.created": {module:"hr",entity:"employee",publisher:"planned"},
  "employee.updated": {module:"hr",entity:"employee",publisher:"planned"},
  "invoice.created": {module:"billing",entity:"invoice",publisher:"planned"},
  "payment.received": {module:"billing",entity:"payment",publisher:"planned"},
  "vendor.created": {module:"finance",entity:"vendor",publisher:"planned"},
  "leave.approved": {module:"hr",entity:"leave",publisher:"planned"},
  "deal.won": {module:"sales",entity:"lead",publisher:"active"},
  "subscription.renewed": {module:"billing",entity:"subscription",publisher:"planned"},
  "file.uploaded": {module:"storage",entity:"file",publisher:"active"},
} as const
export type EventType = keyof typeof EVENT_CATALOG
export type BusinessEvent = {tenantId:number;type:EventType;entityId:number;key:string;actorId:number|null}
export type Subscription = {name:string;eventType:EventType;handler:"notice"|"workflow";userId?:number;workflowId?:number}
export function validateEvent(e:BusinessEvent) {
  if(!e || !Number.isSafeInteger(e.tenantId) || e.tenantId<1 || !Object.hasOwn(EVENT_CATALOG,e.type) || !Number.isSafeInteger(e.entityId) || e.entityId<1 || typeof e.key!=="string" || !e.key.length || e.key.length>191 || (e.actorId!==null && (!Number.isSafeInteger(e.actorId) || e.actorId<1))) throw new Error("Invalid business event")
}
export function validateSubscription(input:unknown):Subscription {
  const s=input as Subscription
  if(!s || typeof s.name!=="string" || !s.name.trim() || s.name.length>120 || !Object.hasOwn(EVENT_CATALOG,s.eventType) || EVENT_CATALOG[s.eventType].publisher!=="active") throw new Error("Select an active event publisher and subscriber name")
  if(s.handler==="notice" && Number.isSafeInteger(s.userId) && s.userId!>0) return {name:s.name.trim(),eventType:s.eventType,handler:s.handler,userId:s.userId}
  if(s.handler==="workflow" && s.eventType==="deal.won" && Number.isSafeInteger(s.workflowId) && s.workflowId!>0) return {name:s.name.trim(),eventType:s.eventType,handler:s.handler,workflowId:s.workflowId}
  throw new Error("Choose a tenant recipient, or a Sales workflow for deal.won")
}
export function retryState(attempt:number) {return {status:attempt>=5 ? "failed":"queued",seconds:Math.min(3600,30*2**(attempt-1))}}
