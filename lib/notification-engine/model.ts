export const CHANNELS=["in_app","email","sms","whatsapp","push"] as const
export type Channel=typeof CHANNELS[number]
// Delivery cadence a user may pick per channel. `daily` batches non-urgent
// notices into a once-a-day digest window; `off` silences the channel.
export const FREQUENCIES=["immediate","daily","off"] as const
export type Frequency=typeof FREQUENCIES[number]
// Allowed priority buckets: 0 low, 5 normal, 10 urgent. A per-channel
// `minPriority` lets a user receive only notices at or above a threshold.
export const PRIORITIES=[0,5,10] as const
export type NoticeContext={actorId?:number|null;actorName?:string|null;moduleKey?:string|null;groupSlug?:string|null;action?:string;entityTable?:string|null;entityId?:string|null;kind?:string;taskId?:number;alertId?:number;severity?:string}
// `mandatory` marks security/compliance notices that MUST reach the user
// regardless of their preferences — they bypass channel, module, priority and
// frequency filters. Use only for notices the user is not allowed to opt out of.
export type Notice={tenantId:number;userId:number;channel:Channel;key:string;title:string;body:string;link?:string|null;priority?:number;at?:string;mandatory?:boolean;context?:NoticeContext}
export function validateNotice(n:Notice) {
  if(!Number.isSafeInteger(n.tenantId)||n.tenantId<1||!Number.isSafeInteger(n.userId)||n.userId<1||!CHANNELS.includes(n.channel)||typeof n.key!=="string"||!n.key.length||n.key.length>191)throw new Error("Invalid notification recipient/channel/key")
  if(typeof n.title!=="string"||!n.title.trim()||n.title.length>255||typeof n.body!=="string"||n.body.length>4000)throw new Error("Invalid notification content")
  if(n.link && (!n.link.startsWith("/")||n.link.startsWith("//")||/[\\\r\n]/.test(n.link)||n.link.length>255))throw new Error("Use an internal link")
  if(n.priority!==undefined&&!PRIORITIES.includes(n.priority as any))throw new Error("Priority must be 0, 5 or 10")
  if(n.mandatory!==undefined&&typeof n.mandatory!=="boolean")throw new Error("Invalid mandatory flag")
  if(n.at!==undefined&&(!/^\d{4}-\d\d-\d\dT.*Z$/.test(n.at)||!Number.isFinite(Date.parse(n.at))))throw new Error("Schedule needs an ISO UTC date")
}
export function renderTemplate(text:string,variables:Record<string,string>) {
  return text.replace(/{{\s*([a-zA-Z][a-zA-Z0-9_]*)\s*}}/g,(_,key)=>{
    if(!Object.hasOwn(variables,key)||typeof variables[key]!=="string"||variables[key].length>1000)throw new Error("Missing or invalid variable: "+key)
    return variables[key]
  })
}
export function defaultEnabled(channel:Channel){return channel==="in_app"||channel==="push"}
export function defaultFrequency(_channel:Channel):Frequency{return "immediate"}
export function escapeHtml(s:string){return s.replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]!))}
// The daily digest window (UTC hour) that `frequency:"daily"` notices are held for.
export const DIGEST_HOUR_UTC=8
// Next occurrence of the digest hour strictly after `from`. Deterministic and
// monotonic, so a deferred notice always becomes due exactly once.
export function nextDigestSlot(from:Date,hourUtc=DIGEST_HOUR_UTC):Date {
  const slot=new Date(Date.UTC(from.getUTCFullYear(),from.getUTCMonth(),from.getUTCDate(),hourUtc,0,0,0))
  if(slot.getTime()<=from.getTime())slot.setUTCDate(slot.getUTCDate()+1)
  return slot
}
export type DeliveryDecision={action:"deliver"}|{action:"skip";reason:string}|{action:"defer";at:Date}
// Single, pure decision point for whether a queued notice should be delivered,
// skipped, or deferred, given the recipient's preferences. Mandatory notices
// always deliver; every other filter fails closed (silence over surprise).
export function resolveDelivery(input:{
  mandatory:boolean
  priority:number
  channelEnabled:boolean
  moduleEnabled:boolean
  minPriority:number
  frequency:Frequency
  createdAt:Date
  now:Date
  digestHourUtc?:number
}):DeliveryDecision {
  if(input.mandatory)return {action:"deliver"}
  if(!input.channelEnabled)return {action:"skip",reason:"channel_disabled"}
  if(!input.moduleEnabled)return {action:"skip",reason:"module_muted"}
  if(input.priority<input.minPriority)return {action:"skip",reason:"below_priority"}
  if(input.frequency==="off")return {action:"skip",reason:"frequency_off"}
  if(input.frequency==="daily") {
    const slot=nextDigestSlot(input.createdAt,input.digestHourUtc??DIGEST_HOUR_UTC)
    if(input.now.getTime()<slot.getTime())return {action:"defer",at:slot}
  }
  return {action:"deliver"}
}
