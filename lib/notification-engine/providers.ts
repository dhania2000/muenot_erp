import "server-only"
import { sendEmail, isEmailConfigured } from "@/lib/email"
import { getWhatsAppIntegrationForTenant, sendWhatsAppText } from "@/lib/whatsapp"
import { escapeHtml, type Channel } from "./model"
export type ProviderInput={tenantId:number;userId:number;destination:string;title:string;body:string;idempotencyKey:string;signal:AbortSignal}
export type NotificationProvider=(input:ProviderInput)=>Promise<{providerId?:string}>
// Reviewed server-side adapters only. No tenant-controlled URLs or executable code.
// SMS and push are extension points; production bootstrap must install a provider.
const providers:Partial<Record<Channel,NotificationProvider>>={
  email:async n=>{if(!isEmailConfigured())throw Object.assign(new Error("Email provider not configured"),{code:"PROVIDER_UNCONFIGURED"});const result=await sendEmail({to:n.destination,subject:n.title,html:"<p>"+escapeHtml(n.body).replace(/\n/g,"<br>")+"</p>",headers:{"X-Notification-Key":n.idempotencyKey}});return {providerId:result.messageId}},
  whatsapp:async n=>{
    const integration=await getWhatsAppIntegrationForTenant(n.tenantId)
    if(!integration)throw Object.assign(new Error("Provider not configured"),{code:"PROVIDER_UNCONFIGURED"})
    const result=await sendWhatsAppText({integration,to:n.destination,body:n.title+"\n"+n.body})
    if(!result.ok)throw new Error("WhatsApp acceptance not confirmed")
    return {}
  },
}
export function registerNotificationProvider(channel:"sms"|"push"|"whatsapp",provider:NotificationProvider){providers[channel]=provider}
export function providerFor(channel:Channel){return providers[channel]}
