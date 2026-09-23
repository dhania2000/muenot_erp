import "server-only"
import { createHash } from "node:crypto"
import { query, withTransaction } from "@/lib/db"
import { ensureMobileAuthSchema } from "@/lib/mobile-auth"
import { ensurePlatformRoleSchema } from "@/lib/platform-roles"
import { ensureNotificationEngineSchema } from "@/lib/notification-engine/schema"
import { enqueueNotification } from "@/lib/notification-engine/service"

/** Enqueue one in-app item and one FCM delivery per eligible tenant member. */
export async function enqueueWhatsAppMessageNotifications(input: {
  tenantId: number; wamid: string; conversationId: number; assignedAgentId: number | null
  contactName?: string | null; preview?: string | null; timestamp?: string | null
}) {
  await Promise.all([ensureMobileAuthSchema(),ensurePlatformRoleSchema(),ensureNotificationEngineSchema()])
  const admins = await query<{ id: number }[]>(`SELECT id FROM users WHERE tenant_id=? AND status='active'
    AND (role='admin' OR tenant_role IN ('tenant_owner','tenant_admin'))`, [input.tenantId])
  const recipients = new Set(admins.map((user) => Number(user.id)))
  if (input.assignedAgentId) recipients.add(Number(input.assignedAgentId))
  if (!recipients.size) return { recipients: 0 }

  const messages = await query<{ id: number }[]>("SELECT id FROM marketing_whatsapp_messages WHERE tenant_id=? AND wamid=? LIMIT 1", [input.tenantId,input.wamid])
  const messageId = messages[0]?.id
  const contactName = (input.contactName ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0,80)
  const preview = (input.preview ?? "Media message").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g," ").trim().slice(0,160) || "New message"
  const title = "New WhatsApp message"
  const body = `${contactName || "Customer"}: ${preview}`.slice(0,255)
  const link = `/modules/whatsapp?conversation=${encodeURIComponent(String(input.conversationId))}`
  const eventKey = `whatsapp-inbound:${createHash("sha256").update(input.wamid).digest("hex")}`
  const context = { eventType:"whatsapp_message",moduleKey:"whatsapp",action:"message",entityTable:"marketing_whatsapp_messages",
    entityId:String(messageId ?? input.wamid).slice(0,40),conversationId:String(input.conversationId),
    messageId:String(messageId ?? ""),contactName,preview,timestamp:input.timestamp ?? null }
  await withTransaction(async (connection) => {
    for (const userId of recipients) {
      const notice = { tenantId:input.tenantId,userId,key:eventKey,title,body,link,priority:5 as const,context }
      await enqueueNotification(connection,{...notice,channel:"in_app"})
      await enqueueNotification(connection,{...notice,channel:"push"})
    }
  })
  console.info("[mobile-push] whatsapp_event_queued", { tenantId:input.tenantId,conversationId:input.conversationId,messageId:messageId ?? null,recipientCount:recipients.size })
  return { recipients: recipients.size }
}
