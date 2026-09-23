import "server-only"
import { google } from "googleapis"
import { query } from "@/lib/db"
import { decryptToken } from "@/lib/token-crypto"
import type { NotificationProvider } from "@/lib/notification-engine/providers"
import { monitorLogger } from "@/lib/system-monitoring"

const permanent = (code: string, status = 400) => Object.assign(new Error("Push provider rejected a device delivery"), { code, status })

export const sendFcmNotification: NotificationProvider = async (input) => {
  const projectId = process.env.FCM_PROJECT_ID?.trim()
  const clientEmail = process.env.FCM_CLIENT_EMAIL?.trim()
  const privateKey = process.env.FCM_PRIVATE_KEY?.replace(/\\n/g, "\n")
  if (!projectId || !clientEmail || !privateKey) throw Object.assign(new Error("FCM server configuration is missing"), { code: "PROVIDER_UNCONFIGURED" })

  const devices = await query<any[]>(`SELECT id,token_encrypted FROM mobile_device_registrations
    WHERE tenant_id=? AND user_id=? AND provider='fcm' AND enabled=1`, [input.tenantId,input.userId])
  if (!devices.length) return { providerId: "no_active_devices", skipped: true }
  const auth = new google.auth.GoogleAuth({ credentials: { client_email: clientEmail, private_key: privateKey }, scopes: ["https://www.googleapis.com/auth/firebase.messaging"] })
  const client = await auth.getClient()
  const access = await client.getAccessToken()
  const accessToken = typeof access === "string" ? access : access?.token
  if (!accessToken) throw Object.assign(new Error("FCM authorization could not be acquired"), { code: "EAUTH" })

  let accepted = 0
  let invalid = 0
  for (const device of devices) {
    const token = decryptToken(String(device.token_encrypted ?? ""))
    if (!token) {
      await query("UPDATE mobile_device_registrations SET enabled=0 WHERE id=? AND tenant_id=? AND user_id=?", [device.id,input.tenantId,input.userId])
      invalid++
      continue
    }
    let response: Response
    try {
      response = await fetch(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/messages:send`, {
        method: "POST", signal: input.signal,
        headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
        body: JSON.stringify({ message: {
          token,
          notification: { title: input.title.slice(0, 120), body: input.body.slice(0, 240) },
          data: {
            type: String(input.context?.eventType ?? "notification").slice(0, 40),
            route: String(input.link ?? "/notifications").slice(0, 160),
            notificationKey: input.idempotencyKey.slice(0, 160),
            ...(input.context?.conversationId ? { conversationId: String(input.context.conversationId).slice(0, 24) } : {}),
            ...(input.context?.messageId ? { messageId: String(input.context.messageId).slice(0, 64) } : {}),
            ...(input.context?.contactName ? { contactName: String(input.context.contactName).slice(0, 80) } : {}),
            ...(input.context?.preview ? { preview: String(input.context.preview).slice(0, 160) } : {}),
            ...(input.context?.timestamp ? { timestamp: String(input.context.timestamp).slice(0, 32) } : {}),
          },
          android: { priority: "high", notification: { tag: input.idempotencyKey.slice(0, 64) } },
        } }),
      })
    } catch (error) {
      if (input.signal.aborted || (error && typeof error === "object" && "name" in error && error.name === "AbortError")) throw error
      throw Object.assign(new Error("FCM network request failed"), { code: "ECONNREFUSED" })
    }
    if (response.ok) { accepted++; continue }
    const payload = await response.json().catch(() => ({})) as any
    const fcmCode = String(payload?.error?.details?.find?.((detail: any) => detail?.errorCode)?.errorCode ?? payload?.error?.status ?? "")
    if (fcmCode === "UNREGISTERED" || fcmCode === "NOT_FOUND") {
      await query("UPDATE mobile_device_registrations SET enabled=0 WHERE id=? AND tenant_id=? AND user_id=?", [device.id,input.tenantId,input.userId])
      invalid++
      continue
    }
    console.warn("[mobile-push] fcm_delivery_failed", { tenantId: input.tenantId,userId: input.userId,deviceId: Number(device.id),httpStatus: response.status,providerCode: fcmCode || "unknown" })
    monitorLogger.error({ service: "notifications", component: "fcm", operation: "delivery", errorCode: "FCM_DELIVERY_FAILED", message: "Mobile push provider rejected a delivery", tenantId: input.tenantId, userId: input.userId, httpStatus: response.status, metadata: { providerCode: fcmCode || "unknown", deviceId: Number(device.id) } })
    if (response.status === 429 || response.status >= 500) {
      if (accepted === 0) throw Object.assign(new Error("FCM temporarily unavailable"), { code: "ECONNREFUSED", status: response.status })
      break // Partial acceptance: don't retry the whole fan-out and duplicate pushes.
    }
    if (accepted === 0) throw permanent("FCM_REJECTED", response.status)
  }
  console.info("[mobile-push] fcm_delivery_result", { tenantId: input.tenantId,userId: input.userId,attempted: devices.length,accepted,invalidTokensDeactivated: invalid })
  return accepted ? { providerId: `fcm:${accepted}` } : { providerId: "no_valid_devices", skipped: true }
}
