import { getPersonalDashboard } from "@/lib/personal-dashboard"
import { mobileJson, withMobileAuth, isMobileResponse } from "@/lib/mobile-api"
export async function GET(request: Request) { const result = await withMobileAuth(request, async p => mobileJson(await getPersonalDashboard(p.userId,p.name)), "mobile_app"); return isMobileResponse(result) ? result : result }
