import { getConnectionHealth } from "@/lib/whatsapp-health"
import { getWhatsAppIntegration, toPublicIntegration } from "@/lib/whatsapp"
import { isMobileResponse, mobileJson, withMobileAuth } from "@/lib/mobile-api"
export const runtime = "nodejs"
export async function GET(request: Request) {
  const result = await withMobileAuth(request, async () => {
    const persisted = await getWhatsAppIntegration()
    if (!persisted) return mobileJson({ connected: false, status: "NOT_CONNECTED", messagingReady: false, webhookSubscribed: false,
      displayName: null, phoneNumber: null, connectedAt: null })
    const integration = toPublicIntegration(persisted)
    const health = await getConnectionHealth().catch(() => null)
    // Linked account and messaging readiness are distinct. A newly persisted
    // connection must be visible immediately even while Meta checks settle.
    const connected = true
    const messagingReady = health?.messagingReady === true
    const webhookSubscribed = health?.checks.find(c => c.id === "subscription")?.status === "ok"
    return mobileJson({ connected, messagingReady, webhookSubscribed,
      status: !connected ? "NOT_CONNECTED" : !messagingReady || !webhookSubscribed ? "ACTION_REQUIRED" : "CONNECTED",
      displayName: health?.phone?.verifiedName ?? integration.businessName ?? null,
      phoneNumber: health?.phone?.displayPhoneNumber ?? integration.displayPhoneNumber ?? null,
      connectedAt: integration.connectedAt ?? null })
  }, "whatsapp")
  return isMobileResponse(result) ? result : result
}
