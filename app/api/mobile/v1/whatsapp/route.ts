import { getConnectionHealth } from "@/lib/whatsapp-health"
import { resolveWhatsAppCaps } from "@/lib/whatsapp-platform"
import { mobileJson, withMobileAuth, isMobileResponse } from "@/lib/mobile-api"
export async function GET(request: Request) { const result = await withMobileAuth(request, async p => mobileJson({ health:await getConnectionHealth(), caps:await resolveWhatsAppCaps(p), role:p.role }), "whatsapp"); return isMobileResponse(result) ? result : result }
