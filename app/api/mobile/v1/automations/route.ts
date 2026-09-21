import { listAutomations } from "@/lib/whatsapp-automations"
import { mobileJson, withMobileAuth, isMobileResponse } from "@/lib/mobile-api"
export async function GET(request:Request){const result=await withMobileAuth(request,async()=>mobileJson({automations:await listAutomations()}),"automations");return isMobileResponse(result)?result:result}
