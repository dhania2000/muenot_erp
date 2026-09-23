import { revokeMobileSession } from "@/lib/mobile-auth"
import { mobileJson, withMobileAuth, isMobileResponse } from "@/lib/mobile-api"
export async function POST(request: Request) { const result = await withMobileAuth(request, async p => { await revokeMobileSession(p.sessionId, p.userId, "logout", p.tenantId); return mobileJson({ ok: true }) }); return isMobileResponse(result) ? result : result }
