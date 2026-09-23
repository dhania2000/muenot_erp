import { getConnectionHealth } from "@/lib/whatsapp-health"
import { isMobileResponse, mobileJson, withMobileAuth } from "@/lib/mobile-api"
export const runtime = "nodejs"
export async function GET(request: Request) {
  const result = await withMobileAuth(request, async () => {
    const health = await getConnectionHealth()
    const connected = health.connected && health.messagingReady === true && health.checks.find(c => c.id === "subscription")?.status === "ok"
    return mobileJson({ connected, status: !health.integration ? "NOT_CONNECTED" : connected ? "CONNECTED" : health.overall === "down" ? "ACTION_REQUIRED" : "CONNECTING",
      displayName: health.phone?.verifiedName ?? health.integration?.businessName ?? null,
      phoneNumber: health.phone?.displayPhoneNumber ?? health.integration?.displayPhoneNumber ?? null,
      connectedAt: health.integration?.connectedAt ?? null })
  }, "whatsapp")
  return isMobileResponse(result) ? result : result
}
