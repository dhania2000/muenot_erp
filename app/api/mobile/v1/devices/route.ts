import { registerMobileDevice, unregisterMobileDevice } from "@/lib/mobile-devices"
import { mobileJson, withMobileAuth, isMobileResponse } from "@/lib/mobile-api"

async function save(request: Request) {
  const result = await withMobileAuth(request, async (principal) => {
    const body = await request.json().catch(() => ({}))
    if (typeof body.deviceId !== "string" || typeof body.pushToken !== "string") return mobileJson({ error: "deviceId and pushToken are required" }, { status: 400 })
    try {
      await registerMobileDevice({ tenantId: principal.tenantId,userId: principal.userId,sessionId: principal.sessionId,
        deviceId: body.deviceId,token: body.pushToken,provider: typeof body.pushProvider === "string" ? body.pushProvider : "fcm",
        platform: body.platform,appVersion: body.appVersion,deviceName: body.deviceName })
      return mobileJson({ ok: true, deviceId: body.deviceId })
    } catch (error) {
      const message = error instanceof Error ? error.message : ""
      return mobileJson({ error: message === "Push token belongs to a different installation" ? message : "Unable to register this device" }, { status: message === "Push token belongs to a different installation" ? 409 : 400 })
    }
  }, "mobile_app")
  return isMobileResponse(result) ? result : result
}

export const POST = save
export const PATCH = save // FCM token refresh updates the same device installation.

export async function DELETE(request: Request) {
  const result = await withMobileAuth(request, async (principal) => {
    const body = await request.json().catch(() => ({}))
    try {
      await unregisterMobileDevice({ tenantId: principal.tenantId,userId: principal.userId,sessionId: principal.sessionId,
        deviceId: typeof body.deviceId === "string" ? body.deviceId : undefined,
        token: typeof body.pushToken === "string" ? body.pushToken : undefined })
      return mobileJson({ ok: true })
    } catch { return mobileJson({ error: "deviceId or pushToken is required" }, { status: 400 }) }
  }, "mobile_app")
  return isMobileResponse(result) ? result : result
}
