export const CHANNELS=["in_app","email","sms","whatsapp","push"] as const
export type Channel=typeof CHANNELS[number]
export type NoticeContext={actorId?:number|null;actorName?:string|null;moduleKey?:string|null;groupSlug?:string|null;action?:string;entityTable?:string|null;entityId?:string|null}
export type Notice={tenantId:number;userId:number;channel:Channel;key:string;title:string;body:string;link?:string|null;priority?:number;at?:string;context?:NoticeContext}
export function validateNotice(n:Notice) {
  if(!Number.isSafeInteger(n.tenantId)||n.tenantId<1||!Number.isSafeInteger(n.userId)||n.userId<1||!CHANNELS.includes(n.channel)||typeof n.key!=="string"||!n.key.length||n.key.length>191)throw new Error("Invalid notification recipient/channel/key")
  if(typeof n.title!=="string"||!n.title.trim()||n.title.length>255||typeof n.body!=="string"||n.body.length>4000)throw new Error("Invalid notification content")
  if(n.link && (!n.link.startsWith("/")||n.link.startsWith("//")||/[\\\r\n]/.test(n.link)||n.link.length>255))throw new Error("Use an internal link")
  if(n.priority!==undefined&&![0,5,10].includes(n.priority))throw new Error("Priority must be 0, 5 or 10")
  if(n.at!==undefined&&(!/^\d{4}-\d\d-\d\dT.*Z$/.test(n.at)||!Number.isFinite(Date.parse(n.at))))throw new Error("Schedule needs an ISO UTC date")
}
export function renderTemplate(text:string,variables:Record<string,string>) {
  return text.replace(/{{\s*([a-zA-Z][a-zA-Z0-9_]*)\s*}}/g,(_,key)=>{
    if(!Object.hasOwn(variables,key)||typeof variables[key]!=="string"||variables[key].length>1000)throw new Error("Missing or invalid variable: "+key)
    return variables[key]
  })
}
export function defaultEnabled(channel:Channel){return channel==="in_app"}
export function escapeHtml(s:string){return s.replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]!))}
